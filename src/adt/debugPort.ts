/**
 * adt/debugPort.ts — 探針模式 B 的真正 DebugPort(用 abap-adt-api 的 debugger API)
 *
 * 兩個獨立的 ADT session(各自一個 ADTClient,SM04 看得到,用完一定登出):
 *  - listenClient:只做 debuggerListen(長輪詢,會一直等到有程式停下或被取消)
 *  - dbgClient:設中斷點、attach、堆疊、變數、繼續、刪除。attach 之後是 stateful,
 *    每個停駐結束就 releaseStateful(通知 SAP 結束 context),不留著占記憶體(C0-10)
 * 只監聽「自己」(debuggingMode=user、requestUser=MCP 的登入帳號)。不提供逐步執行與改變數值。
 */
import { randomUUID } from "node:crypto";
import { session_types, type ADTClient } from "abap-adt-api";
import type { AppConfig } from "../config.js";
import { createAdtClient } from "./client.js";
import { logoutClient, releaseStateful } from "./session.js";
import type { BreakpointRequest, BreakpointResult, DebugPort, StackFrame, VariableValue } from "./probeB.js";

const CLIENT_NAME = "abap-adt-mcp-probe";

/** 屬性值要放進 XML attribute:abap-adt-api 不會跳脫,這裡先處理 */
export function xmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 變數值最長字元數(單一值) */
const MAX_VALUE_CHARS = 300;
/** 結構展開的欄位數上限 */
const MAX_STRUCT_FIELDS = 30;

interface Reached {
  id: string;
}

export class AdtDebugPort implements DebugPort {
  private listenClient: ADTClient;
  private dbgClient: ADTClient;
  private readonly terminalId = randomUUID().toUpperCase();
  private readonly ideId = `${CLIENT_NAME}-${randomUUID().slice(0, 8)}`;
  private readonly user: string;

  constructor(cfg: AppConfig, clients?: { listen: ADTClient; dbg: ADTClient }) {
    this.user = cfg.sap.user.toUpperCase();
    this.listenClient = clients?.listen ?? createAdtClient(cfg);
    this.dbgClient = clients?.dbg ?? createAdtClient(cfg);
  }

  async setBreakpoints(requests: BreakpointRequest[]): Promise<BreakpointResult[]> {
    const bps = requests.map((r) => ({
      kind: "line",
      clientId: r.clientId,
      id: "",
      nonAbapFlavour: "",
      uri: { uri: r.uri, range: { start: { line: r.line, column: 0 }, end: { line: r.line, column: 0 } } },
      type: "",
      name: "",
      ...(r.condition ? { condition: xmlAttr(r.condition) } : {}),
    }));
    const out = await this.dbgClient.debuggerSetBreakpoints("user", this.terminalId, this.ideId, CLIENT_NAME, bps as never, this.user, "external");
    return out.map((o, i) => {
      const clientId = (o as { clientId?: string }).clientId || requests[i]?.clientId || "";
      if ("errorMessage" in o) return { clientId, error: String((o as { errorMessage: string }).errorMessage) };
      return { clientId, id: String((o as { id: string }).id) };
    });
  }

  async deleteBreakpoint(id: string): Promise<void> {
    await this.dbgClient.debuggerDeleteBreakpoints({ id } as never, "user", this.terminalId, this.ideId, this.user, "external");
  }

  async listen(): Promise<{ debuggeeId: string } | undefined> {
    // 先檢查有沒有別的 debugger 監聽(例如 Eclipse):有的話 SAP 只允許一個,直接說清楚
    const conflict = await this.dbgClient.debuggerListeners("user", this.terminalId, this.ideId, this.user, true);
    if (conflict) throw new Error(`已有其他 debugger 在監聽(${conflict.ideUser || "未知"} 的 ${conflict.conflictText || conflict.message?.text || "監聽"}),請先關閉(例如 Eclipse 的 debug 視角)。`);
    const r = await this.listenClient.debuggerListen("user", this.terminalId, this.ideId, this.user, false, false);
    if (!r) return undefined;
    if ("conflictText" in r || !("DEBUGGEE_ID" in r)) {
      const e = r as { conflictText?: string; message?: { text?: string } };
      throw new Error(`debugger 監聽被拒:${e.conflictText || e.message?.text || "未知原因"}`);
    }
    return { debuggeeId: r.DEBUGGEE_ID };
  }

  async cancelListen(): Promise<void> {
    await this.dbgClient.debuggerDeleteListener("user", this.terminalId, this.ideId, this.user);
  }

  async attach(debuggeeId: string): Promise<{ reachedBreakpointIds: string[] }> {
    this.dbgClient.stateful = session_types.stateful;
    const a = await this.dbgClient.debuggerAttach("user", debuggeeId, this.user, false);
    return { reachedBreakpointIds: ((a.reachedBreakpoints ?? []) as Reached[]).map((b) => String(b.id)) };
  }

  async stack(): Promise<StackFrame[]> {
    const s = await this.dbgClient.debuggerStackTrace(true);
    return (s.stack ?? []).map((f) => {
      const x = f as { programName?: string; includeName?: string | number; line?: number; eventType?: string; eventName?: string | number };
      return { program: String(x.programName ?? ""), include: String(x.includeName ?? ""), line: Number(x.line ?? 0), event: `${x.eventType ?? ""} ${x.eventName ?? ""}`.trim() };
    });
  }

  async variables(names: string[]): Promise<VariableValue[]> {
    const out: VariableValue[] = [];
    for (const name of names) {
      try {
        const vars = await this.dbgClient.debuggerVariables([name.toUpperCase()]);
        const v = vars.find((x) => x.NAME?.toUpperCase() === name.toUpperCase()) ?? vars[0];
        if (!v) {
          out.push({ name, value: "", note: "讀不到(名稱不在目前範圍內)" });
          continue;
        }
        const meta = String(v.META_TYPE ?? "");
        if (meta === "structure") {
          out.push({ name, value: await this.expandStructure(String(v.ID)), meta });
        } else if (meta === "table") {
          out.push({ name, value: `(內表 ${v.TABLE_LINES} 列)`, meta });
        } else if (meta === "objectref" || meta === "dataref" || meta === "class" || meta === "object") {
          out.push({ name, value: String(v.VALUE ?? ""), meta });
        } else {
          out.push({ name, value: String(v.VALUE ?? "").slice(0, MAX_VALUE_CHARS), meta: meta || undefined });
        }
      } catch (e) {
        out.push({ name, value: "", note: `讀取失敗:${e instanceof Error ? e.message : String(e)}` });
      }
    }
    return out;
  }

  /** 結構展開成「欄位=值」(最多 MAX_STRUCT_FIELDS 欄);展開不了就回說明文字 */
  private async expandStructure(id: string): Promise<string> {
    try {
      const info = await this.dbgClient.debuggerChildVariables([id]);
      const kids = info.variables.filter((c) => c.ID !== id).slice(0, MAX_STRUCT_FIELDS);
      if (kids.length === 0) return "(結構,無法展開)";
      return kids.map((c) => `${c.NAME}=${String(c.VALUE ?? "").slice(0, MAX_VALUE_CHARS)}`).join(", ");
    } catch (e) {
      return `(結構,展開失敗:${e instanceof Error ? e.message : String(e)})`;
    }
  }

  async continue(): Promise<{ reachedBreakpointIds: string[]; ended: boolean }> {
    const step = await this.dbgClient.debuggerStep("stepContinue");
    const reached = ((step.reachedBreakpoints ?? []) as Reached[]).map((b) => String(b.id));
    // 程式跑完或換了一個 debuggee:不能再單步;沒有新的停駐就視為結束
    const ended = reached.length === 0 || step.isSteppingPossible === false;
    if (ended) await releaseStateful(this.dbgClient);
    return { reachedBreakpointIds: reached, ended };
  }

  async terminate(): Promise<void> {
    try {
      await this.dbgClient.debuggerStep("terminateDebuggee");
    } finally {
      await releaseStateful(this.dbgClient);
    }
  }

  async close(): Promise<void> {
    await releaseStateful(this.dbgClient);
    await logoutClient(this.listenClient);
    await logoutClient(this.dbgClient);
  }
}
