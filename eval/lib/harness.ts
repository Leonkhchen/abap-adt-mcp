/**
 * eval/lib/harness.ts — 事前準備、判定與清除
 *
 * 透過 in-process 的 MCP 工具(與實際使用相同的 registerTools + RealAdtService)執行 setup 與 checks,
 * 確保判定走的是同一套護欄與輸出格式;刪除物件(沒有對應的 MCP 工具)用 abap-adt-api 直接 lock + delete。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ADTClient, session_types } from "abap-adt-api";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { RealAdtService } from "../../src/adt/client.js";
import { AuditLogger } from "../../src/safety/audit.js";
import { registerTools } from "../../src/tools/registry.js";
import type { Check, EvalTask } from "./tasks.js";

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface CheckResult {
  passed: boolean;
  details: string[];
}

export interface Harness {
  cfg: AppConfig;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  setup(task: EvalTask): Promise<void>;
  check(task: EvalTask, answer: string): Promise<CheckResult>;
  cleanup(task: EvalTask): Promise<string[]>;
  close(): Promise<void>;
}

/** 評測用的設定:可讀寫、開啟 data_preview(第 7 題),其餘沿用 .env / 環境變數 */
export function evalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ABAP_MCP_READONLY: "false", ABAP_MCP_SYSTEM_ROLE: "dev", ABAP_MCP_ALLOW_DATA_PREVIEW: "true" };
}

const norm = (s: string) => s.toLowerCase();

const BINDING_URI = /^\/sap\/bc\/adt\/businessservices\/bindings\/([^/?]+)/i;

/** service binding 的 URI 取出名稱(大寫);不是 binding 回 undefined */
export function bindingNameFromUri(uri: string): string | undefined {
  const m = BINDING_URI.exec(uri);
  return m ? decodeURIComponent(m[1]).toUpperCase() : undefined;
}

/** 取消發布 OData V4 service binding 的請求本文(已發布的 binding 無法直接刪除) */
export function unpublishBody(name: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:objectReference adtcore:type="SCGR" adtcore:name="${name.toUpperCase()}"/></adtcore:objectReferences>`
  );
}

export async function createHarness(env: NodeJS.ProcessEnv = evalEnv(), auditPath = ""): Promise<Harness> {
  const cfg = loadConfig(env);
  const server = new McpServer({ name: "abap-adt-mcp-eval", version: "0" });
  registerTools(server, new RealAdtService(cfg), cfg, new AuditLogger(auditPath));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "eval-harness", version: "0" });
  await client.connect(clientT);
  const raw = new ADTClient(cfg.sap.url, cfg.sap.user, cfg.sap.password, cfg.sap.client, cfg.sap.language);

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 900_000 })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
  };

  const runCheck = async (c: Check, answer: string): Promise<string | undefined> => {
    if (c.kind === "answer_contains") {
      const missing = (c.all ?? []).filter((s) => !norm(answer).includes(norm(s)));
      if (missing.length) return `回答缺少:${missing.join("、")}`;
      if (c.any?.length && !c.any.some((s) => norm(answer).includes(norm(s)))) return `回答沒有提到任一:${c.any.join("、")}`;
      return undefined;
    }
    if (c.kind === "tool") {
      const r = await call(c.tool, c.args);
      if (r.isError) return `${c.tool} 出錯:${r.text.slice(0, 300)}`;
      const missing = (c.contains ?? []).filter((s) => !norm(r.text).includes(norm(s)));
      const present = (c.not_contains ?? []).filter((s) => norm(r.text).includes(norm(s)));
      if (missing.length || present.length) {
        return `${c.tool} 輸出` + (missing.length ? ` 缺少「${missing.join("、")}」` : "") + (present.length ? ` 不應有「${present.join("、")}」` : "");
      }
      return undefined;
    }
    // answer_contains_query:以 data_preview 查出正確值(表格第一列是欄名,以 | 分隔)
    const r = await call("data_preview", { sql: c.sql, max_rows: 100 });
    if (r.isError) return `判定查詢失敗:${r.text.slice(0, 300)}`;
    const lines = r.text.split("\n").filter((l) => l.includes("|") || /^\S+$/.test(l));
    const header = lines.findIndex((l) => l.split("|").map((x) => x.trim().toUpperCase()).includes(c.column.toUpperCase()));
    if (header < 0) return `判定查詢沒有欄位 ${c.column}`;
    const idx = lines[header].split("|").map((x) => x.trim().toUpperCase()).indexOf(c.column.toUpperCase());
    const values = lines.slice(header + 1).map((l) => (l.split("|")[idx] ?? "").trim()).filter(Boolean);
    const missing = values.filter((v) => !answer.replace(/,/g, "").includes(v));
    return missing.length ? `回答缺少正確值:${missing.join("、")}(正確值:${values.join("、")})` : undefined;
  };

  const deleteObject = async (uri: string): Promise<string> => {
    const binding = bindingNameFromUri(uri);
    if (binding) {
      // 已發布的 binding 刪除會被拒(Service endpoint … is published):先取消發布;尚未發布或失敗就照常嘗試刪除
      await raw.httpClient
        .request("/sap/bc/adt/businessservices/odatav4/unpublishjobs", {
          method: "POST",
          headers: { "Content-Type": "application/xml", Accept: "application/xml" },
          body: unpublishBody(binding),
        })
        .catch(() => undefined);
    }
    try {
      raw.stateful = session_types.stateful;
      const lock = await raw.lock(uri);
      await raw.deleteObject(uri, lock.LOCK_HANDLE);
      return `已刪除 ${uri}`;
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      // 物件不存在時 SAP 回 does not exist / not found,或「cannot be created without a package」
      if (/does not exist|not found|404|without a package/i.test(msg)) return `不存在(略過)${uri}`;
      return `❌ 刪除失敗 ${uri}:${msg}`;
    } finally {
      raw.stateful = session_types.stateless;
    }
  };

  return {
    cfg,
    call,
    async setup(task) {
      for (const s of task.setup) {
        const r = await call(s.tool, s.args);
        if (r.isError && !s.allow_error) throw new Error(`第 ${task.id} 題事前準備失敗(${s.tool}):${r.text.slice(0, 400)}`);
      }
    },
    async check(task, answer) {
      const details: string[] = [];
      for (const c of task.checks) {
        const problem = await runCheck(c, answer).catch((e) => `判定時出錯:${e instanceof Error ? e.message : String(e)}`);
        if (problem) details.push(problem);
      }
      return { passed: details.length === 0, details };
    },
    async cleanup(task) {
      const out: string[] = [];
      for (const u of task.cleanup) out.push(await deleteObject(u));
      return out;
    },
    async close() {
      await client.close();
    },
  };
}
