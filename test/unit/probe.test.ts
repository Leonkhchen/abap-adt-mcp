/**
 * v0.6 探針模式 B(Debugger 快照)的單元測試:不連 SAP,用假的 DebugPort 與假的 AdtService。
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { AuditLogger } from "../../src/safety/audit.js";
import { SerialQueue } from "../../src/safety/serialQueue.js";
import { assertProbeAllowed } from "../../src/safety/probeGuards.js";
import { GuardViolationError } from "../../src/safety/guards.js";
import { registerTools } from "../../src/tools/registry.js";
import {
  PROBE_LOGS_MAX_CHARS,
  ProbeStore,
  formatLogs,
  normalizeProbe,
  normalizeTrigger,
  probeSourceUrl,
  registerProbeTools,
  type ProbeRunRecord,
} from "../../src/tools/probeTools.js";
import { xmlAttr } from "../../src/adt/debugPort.js";
import {
  ZERO_HIT_NOTE,
  runDebuggerProbes,
  type BreakpointRequest,
  type BreakpointResult,
  type DebugPort,
  type EngineDeps,
  type ProbeSpec,
} from "../../src/adt/probeB.js";
import type { AdtService } from "../../src/adt/client.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BASE_ENV = { SAP_URL: "https://sap.example.invalid:44300", SAP_USER: "DEVELOPER", SAP_PASSWORD: "x", SAP_CLIENT: "001" };
const cfgOf = (extra: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...extra } as NodeJS.ProcessEnv);

const URL_MAIN = "/sap/bc/adt/oo/classes/zcl_inv_posting/source/main";
const spec = (o: Partial<ProbeSpec> = {}): ProbeSpec => ({ id: "p1", objectUrl: URL_MAIN, line: 173, kind: "variables", variables: ["iv_qty"], maxHits: 2, ...o });

/** 假 engine deps:時間由測試控制,sleep 立即完成但推進假時鐘 */
function fakeClock(startMs = 1_000_000, opts: { timesOut?: boolean } = {}) {
  let t = startMs;
  const deps: EngineDeps = {
    now: () => t,
    // 暖機 / 寬限 / 清除時的短暫等待:立即完成,但推進假時鐘
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
    // 總逾時計時器:timesOut=true 時立刻逾時;否則永不逾時(測試靠事件結束)
    timer: (ms) => {
      if (!opts.timesOut) return new Promise<void>(() => {});
      t += ms;
      return Promise.resolve();
    },
    warmupMs: 10,
  };
  return { deps, advance: (ms: number) => (t += ms), get time() { return t; } };
}

/**
 * 假 DebugPort:`stops` 是依序出現的「停駐」,每個停駐是一串連續停下的中斷點(同一次執行,continue 後又碰到下一個)。
 * listen() 每次回傳下一個停駐;沒有了就一直等(直到 cancelListen)。
 */
function fakePort(o: { stops?: string[][]; bpErrors?: Record<string, string>; variablesFor?: (names: string[]) => { name: string; value: string }[]; failContinue?: boolean; listenError?: string; deleteFailures?: number; hangStack?: boolean } = {}) {
  let deleteFailuresLeft = o.deleteFailures ?? 0;
  let releaseStack: () => void = () => undefined;
  const stackGate = new Promise<void>((r) => (releaseStack = r));
  const calls: string[] = [];
  const stops = [...(o.stops ?? [])];
  let resolveListen: ((v: { debuggeeId: string } | undefined) => void) | undefined;
  let current: string[] = [];
  let attachedNow = false;
  const bpIds = new Map<string, string>(); // clientId → bp id
  const port: DebugPort & { calls: string[]; deleted: string[]; attachedNow: () => boolean; releaseStack: () => void } = {
    calls,
    releaseStack: () => releaseStack(),
    deleted: [],
    attachedNow: () => attachedNow,
    async setBreakpoints(reqs: BreakpointRequest[]): Promise<BreakpointResult[]> {
      calls.push("setBreakpoints");
      return reqs.map((r) => {
        if (o.bpErrors?.[r.clientId]) return { clientId: r.clientId, error: o.bpErrors[r.clientId] };
        const id = `BP-${r.clientId}`;
        bpIds.set(r.clientId, id);
        return { clientId: r.clientId, id };
      });
    },
    async deleteBreakpoint(id) {
      calls.push(`deleteBreakpoint:${id}`);
      if (deleteFailuresLeft > 0) {
        deleteFailuresLeft--;
        throw new Error("delete failed");
      }
      port.deleted.push(id);
    },
    listen() {
      calls.push("listen");
      if (o.listenError) return Promise.reject(new Error(o.listenError));
      const next = stops.shift();
      if (next) {
        current = [...next];
        return Promise.resolve({ debuggeeId: `DBG-${calls.length}` });
      }
      return new Promise((resolve) => {
        resolveListen = resolve;
      });
    },
    async cancelListen() {
      calls.push("cancelListen");
      resolveListen?.(undefined);
    },
    async attach() {
      calls.push("attach");
      attachedNow = true;
      return { reachedBreakpointIds: current.length ? [current[0]] : [] };
    },
    async stack() {
      calls.push("stack");
      if (o.hangStack) await stackGate;
      return [{ program: "ZCL_INV_POSTING=====CP", include: "ZCL_INV_POSTING=====CM00A", line: 173, event: "METHOD CALC_ISSUE_AMT" }];
    },
    async variables(names) {
      calls.push(`variables:${names.join(",")}`);
      return (o.variablesFor ?? ((ns) => ns.map((name) => ({ name, value: "42" }))))(names);
    },
    async continue() {
      calls.push("continue");
      if (o.failContinue) throw new Error("continue boom");
      current.shift();
      if (current.length) return { reachedBreakpointIds: [current[0]], ended: false };
      attachedNow = false;
      return { reachedBreakpointIds: [], ended: true };
    },
    async terminate() {
      calls.push("terminate");
      attachedNow = false;
    },
    async close() {
      calls.push("close");
    },
  };
  return port;
}

describe("probeB 引擎", () => {
  it("命中 → 讀值 → 自動繼續;觸發跑完就結束;一定 close", async () => {
    const port = fakePort({ stops: [["BP-p1"]] });
    const clock = fakeClock();
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: async () => "✅ ABAP Unit:36 個測試方法,36 通過,0 失敗" }, clock.deps);
    expect(r.status).toBe("completed");
    expect(r.probes[0].hits).toHaveLength(1);
    expect(r.probes[0].hits[0].variables).toEqual([{ name: "iv_qty", value: "42" }]);
    expect(r.triggerOutcome).toContain("36 通過");
    expect(port.calls).toContain("attach");
    expect(port.calls).toContain("continue");
    expect(port.calls[port.calls.length - 1]).toBe("close");
    expect(port.attachedNow()).toBe(false);
  });

  it("max_hits 收滿 → 刪掉自己的中斷點、之後不再為它停;全部收滿就結束", async () => {
    // 同一次執行連續停 3 次;max_hits=2 → 第 2 次後刪中斷點,第 3 次不記錄
    const port = fakePort({ stops: [["BP-p1", "BP-p1", "BP-p1"]] });
    const r = await runDebuggerProbes(port, { probes: [spec({ maxHits: 2 })], timeoutSeconds: 60, trigger: () => new Promise(() => {}) }, fakeClock().deps);
    expect(r.status).toBe("all_full");
    expect(r.probes[0].hits).toHaveLength(2);
    expect(r.probes[0].full).toBe(true);
    expect(port.deleted).toEqual(["BP-p1"]); // 只刪一次,不重複
  });

  it("多個探針:各自計數、各自收滿", async () => {
    const port = fakePort({ stops: [["BP-p1", "BP-p2", "BP-p1"]] });
    const r = await runDebuggerProbes(
      port,
      { probes: [spec({ id: "p1", maxHits: 2 }), spec({ id: "p2", line: 180, maxHits: 1, variables: ["lv_amt"] })], timeoutSeconds: 60, trigger: () => new Promise(() => {}) },
      fakeClock().deps
    );
    expect(r.status).toBe("all_full");
    expect(r.probes.map((p) => p.hits.length)).toEqual([2, 1]);
    expect(r.probes[1].hits[0].variables?.[0].name).toBe("lv_amt");
  });

  it("kind=stack 記錄堆疊、不讀變數", async () => {
    const port = fakePort({ stops: [["BP-p1"]] });
    const r = await runDebuggerProbes(port, { probes: [spec({ kind: "stack", variables: [] })], timeoutSeconds: 60, trigger: async () => "ok" }, fakeClock().deps);
    expect(r.probes[0].hits[0].stack?.[0].line).toBe(173);
    expect(r.probes[0].hits[0].variables).toBeUndefined();
    expect(port.calls.some((c) => c.startsWith("variables:"))).toBe(false);
  });

  it("沒有命中:觸發跑完 → completed,附上「命中 0 次」的提醒(update task / 背景)", async () => {
    const port = fakePort({ stops: [] });
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: async () => "✅" }, fakeClock().deps);
    expect(r.status).toBe("completed");
    expect(r.probes[0].hits).toHaveLength(0);
    expect(r.notes).toContain(ZERO_HIT_NOTE);
    expect(r.notes.join("")).toContain("update task");
    expect(port.deleted).toEqual(["BP-p1"]); // 沒收滿的中斷點在 finally 刪除
    expect(port.calls).toContain("cancelListen");
    expect(port.calls[port.calls.length - 1]).toBe("close");
  });

  it("逾時(觸發的程式沒有經過中斷點、一直不結束)→ timeout,清理乾淨:刪中斷點、關閉監聽、close", async () => {
    const port = fakePort({ stops: [] });
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 30, trigger: () => new Promise(() => {}) }, fakeClock(1_000_000, { timesOut: true }).deps);
    expect(r.status).toBe("timeout");
    expect(port.deleted).toEqual(["BP-p1"]);
    expect(port.calls).toContain("cancelListen");
    expect(port.calls[port.calls.length - 1]).toBe("close");
    expect(r.notes.join("")).toContain("仍未結束");
  });

  it("手動觸發(沒有 trigger):等到逾時,清理乾淨", async () => {
    const port = fakePort({ stops: [] });
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 30 }, fakeClock(1_000_000, { timesOut: true }).deps);
    expect(r.status).toBe("timeout");
    expect(r.triggerOutcome).toBeUndefined();
    expect(port.calls[port.calls.length - 1]).toBe("close");
  });

  it("手動觸發:使用者執行後命中 → 記錄,收滿就結束", async () => {
    const port = fakePort({ stops: [["BP-p1"]] });
    const r = await runDebuggerProbes(port, { probes: [spec({ maxHits: 1 })], timeoutSeconds: 30 }, fakeClock().deps);
    expect(r.status).toBe("all_full");
    expect(r.probes[0].hits).toHaveLength(1);
  });

  it("觸發失敗(例如 run_class 出錯)→ trigger_failed,仍然清理", async () => {
    const port = fakePort({ stops: [] });
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: async () => { throw new Error("class dump"); } }, fakeClock().deps);
    expect(r.status).toBe("trigger_failed");
    expect(r.notes.join("")).toContain("class dump");
    expect(port.deleted).toEqual(["BP-p1"]);
    expect(port.calls[port.calls.length - 1]).toBe("close");
  });

  it("所有中斷點都設定失敗 → error,不監聽、不觸發,仍 close", async () => {
    const port = fakePort({ bpErrors: { p1: "位置不存在" } });
    const trigger = vi.fn(async () => "x");
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger }, fakeClock().deps);
    expect(r.status).toBe("error");
    expect(r.probes[0].error).toBe("位置不存在");
    expect(trigger).not.toHaveBeenCalled();
    expect(port.calls).not.toContain("listen");
    expect(port.calls[port.calls.length - 1]).toBe("close");
  });

  it("部分中斷點失敗:其他探針照常運作", async () => {
    const port = fakePort({ stops: [["BP-p2"]], bpErrors: { p1: "不可設中斷點" } });
    const r = await runDebuggerProbes(port, { probes: [spec({ id: "p1" }), spec({ id: "p2", maxHits: 1 })], timeoutSeconds: 60, trigger: () => new Promise(() => {}) }, fakeClock().deps);
    expect(r.probes[0].error).toBe("不可設中斷點");
    expect(r.probes[1].hits).toHaveLength(1);
    expect(r.status).toBe("all_full");
  });

  it("監聽衝突(例如 Eclipse 已在監聽)→ error 並說明,不觸發執行", async () => {
    const port = fakePort({ listenError: "已有其他 debugger 在監聽" });
    const trigger = vi.fn(async () => "x");
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger }, fakeClock().deps);
    expect(r.status).toBe("error");
    expect(r.notes.join("")).toContain("已有其他 debugger 在監聽");
    expect(port.calls[port.calls.length - 1]).toBe("close");
  });

  it("繼續執行失敗 → 終止停住的程式(不讓它停在那裡),仍清理", async () => {
    const port = fakePort({ stops: [["BP-p1"]], failContinue: true });
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: () => new Promise(() => {}) }, fakeClock().deps);
    expect(r.status).toBe("error");
    expect(port.calls).toContain("terminate");
    expect(port.attachedNow()).toBe(false);
    expect(port.calls[port.calls.length - 1]).toBe("close");
  });

  it("變數讀取失敗 → 記成 note,不中斷整個流程", async () => {
    const port = fakePort({ stops: [["BP-p1"]] });
    port.variables = async () => { throw new Error("no access"); };
    const r = await runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: async () => "ok" }, fakeClock().deps);
    expect(r.probes[0].hits[0].variables?.[0].note).toContain("讀取失敗");
    expect(r.status).toBe("completed");
  });

  it("SAP 沒回中斷點編號時,以最上層堆疊的行號對應探針", async () => {
    const port = fakePort({ stops: [["x"]] });
    port.attach = async () => ({ reachedBreakpointIds: [] });
    const r = await runDebuggerProbes(port, { probes: [spec({ line: 173 })], timeoutSeconds: 60, trigger: async () => "ok" }, fakeClock().deps);
    expect(r.probes[0].hits).toHaveLength(1);
  });
});

describe("探針參數驗證", () => {
  const ok = { object_url: "/sap/bc/adt/oo/classes/zcl_x", line: 10, fields: ["lv_a"] };
  it("正常:class 預設 main;include=testclasses;source URI 原樣保留;程式用 source/main", () => {
    expect(normalizeProbe(ok, 0)).toMatchObject({ id: "p1", sourceUrl: "/sap/bc/adt/oo/classes/zcl_x/source/main", baseUrl: "/sap/bc/adt/oo/classes/zcl_x", maxHits: 5, kind: "variables" });
    expect(probeSourceUrl("/sap/bc/adt/oo/classes/zcl_x", "testclasses")).toBe("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses");
    expect(probeSourceUrl("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", "main")).toBe("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses");
    expect(probeSourceUrl("/sap/bc/adt/programs/programs/sapmv45a", "main")).toBe("/sap/bc/adt/programs/programs/sapmv45a/source/main");
    expect(normalizeProbe({ ...ok, kind: "stack", fields: undefined }, 2).id).toBe("p3");
  });
  it.each([
    ["行號 0", { ...ok, line: 0 }, /行號/],
    ["行號太大", { ...ok, line: 2_000_000 }, /行號/],
    ["variables 沒有 fields", { ...ok, fields: [] }, /需要 fields/],
    ["fields 太多", { ...ok, fields: Array.from({ length: 11 }, (_, i) => `v${i}`) }, /最多記錄 10/],
    ["變數名稱含引號", { ...ok, fields: ['a" injected="1'] }, /不合法/],
    ["變數名稱含空白", { ...ok, fields: ["a b"] }, /不合法/],
    ["kind=sql(模式 B 不支援)", { ...ok, kind: "sql" as const }, /只有 Dynamic Logpoints/],
    ["max_hits 超過上限", { ...ok, max_hits: 51 }, /max_hits/],
    ["condition 太長", { ...ok, condition: "x".repeat(201) }, /condition/],
    ["URI 不是 ADT 路徑", { ...ok, object_url: "https://evil.example.invalid/x" }, /只接受 \/sap\/bc\/adt\//],
    ["URI 路徑穿越", { ...ok, object_url: "/sap/bc/adt/oo/classes/%2e%2e/zx" }, /路徑穿越/],
    ["include 含斜線", { ...ok, include: "../x" }, /include/],
  ])("拒絕:%s", (_n, input, re) => {
    expect(() => normalizeProbe(input as never, 0)).toThrow(re);
  });
  it("允許常見的 ABAP 運算式:結構欄位、物件屬性、field symbol、類別屬性、表格索引", () => {
    const p = normalizeProbe({ ...ok, fields: ["ls_stock-qty", "me->mv_x", "<fs>-a", "zcl_x=>gv_y", "lt_tab[1]"] }, 0);
    expect(p.fields).toHaveLength(5);
  });
  it("trigger:run_unit_tests / run_class / manual;缺少必要欄位或同時指定都拒絕", () => {
    expect(normalizeTrigger({ tool: "run_unit_tests", object_url: "/sap/bc/adt/oo/classes/zcl_x" })).toEqual({ kind: "unit_tests", objectUrl: "/sap/bc/adt/oo/classes/zcl_x" });
    expect(normalizeTrigger({ tool: "run_class", class_name: "zcl_x" })).toEqual({ kind: "class", className: "ZCL_X" });
    expect(normalizeTrigger({ manual: true })).toEqual({ kind: "manual" });
    expect(() => normalizeTrigger(undefined)).toThrow(/需要 trigger/);
    expect(() => normalizeTrigger({})).toThrow(/需要 tool/);
    expect(() => normalizeTrigger({ tool: "run_unit_tests" })).toThrow(/object_url/);
    expect(() => normalizeTrigger({ tool: "run_class", class_name: "bad name" })).toThrow(/class_name/);
    expect(() => normalizeTrigger({ tool: "run_class", class_name: "zcl_x", manual: true })).toThrow(/不能同時/);
    expect(() => normalizeTrigger({ tool: "run_unit_tests", object_url: "//evil/x" })).toThrow();
  });
  it("xmlAttr 跳脫 condition 裡的 XML 特殊字元", () => {
    expect(xmlAttr('a < b AND c = "x" & d > e')).toBe("a &lt; b AND c = &quot;x&quot; &amp; d &gt; e");
  });
});

describe("探針範圍與排除清單(probeGuards)", () => {
  const STD = "/sap/bc/adt/programs/programs/sapmv45a/source/main";
  const CUSTOM = "/sap/bc/adt/oo/classes/zcl_inv_posting/source/main";
  it("scope=all(預設):標準與自訂程式都可以", () => {
    const cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true" });
    expect(() => assertProbeAllowed(cfg, STD, "VA")).not.toThrow();
    expect(() => assertProbeAllowed(cfg, CUSTOM, "$ZINV")).not.toThrow();
  });
  it("scope=custom:只限寫入白名單(名稱前綴 + package);標準程式被拒", () => {
    const cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_PROBE_SCOPE: "custom", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV" });
    expect(() => assertProbeAllowed(cfg, CUSTOM, "$ZINV")).not.toThrow();
    expect(() => assertProbeAllowed(cfg, STD, "VA")).toThrow(/custom/);
    expect(() => assertProbeAllowed(cfg, CUSTOM, "$TMP")).toThrow(/package/);
    expect(() => assertProbeAllowed(cfg, CUSTOM, "")).toThrow(/無法判斷/);
  });
  it("PROBE_DENY:物件名稱或 package 符合就拒絕(* 結尾為前綴),任何範圍都適用", () => {
    const cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_PROBE_DENY: "SAPMV45A, SUSR*, $SECRET" });
    expect(() => assertProbeAllowed(cfg, STD, "VA")).toThrow(/排除清單/);
    expect(() => assertProbeAllowed(cfg, "/sap/bc/adt/programs/programs/susr_dummy", "X")).toThrow(/排除清單/);
    expect(() => assertProbeAllowed(cfg, CUSTOM, "$SECRET")).toThrow(/排除清單/);
    expect(() => assertProbeAllowed(cfg, CUSTOM, "$ZINV")).not.toThrow();
  });
  it("一律先過 assertAdtUri", () => {
    const cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true" });
    expect(() => assertProbeAllowed(cfg, "https://evil.example.invalid/x", "")).toThrow(GuardViolationError);
    expect(() => assertProbeAllowed(cfg, "/sap/bc/adt/oo/classes/%252e%252e/zx", "")).toThrow(GuardViolationError);
  });
});

// ───────────────────────── 工具層 ─────────────────────────

function fakeAdt(o: { pkg?: (url: string) => string } = {}): AdtService {
  const unit = [{ "adtcore:name": "LTC", alerts: [], testmethods: [{ "adtcore:name": "T1", alerts: [], executionTime: "0", unit: "s" }] }];
  return {
    username: () => "DEVELOPER",
    baseUrl: () => "http://localhost:50000",
    dlpAvailable: vi.fn(async () => false),
    objectPackage: vi.fn(async (u: string) => (o.pkg ? o.pkg(u) : "$ZINV")),
    runUnitTests: vi.fn(async () => unit as never),
    runClass: vi.fn(async () => "out"),
  } as unknown as AdtService;
}

async function connect(adt: AdtService, cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP" }), deps?: Parameters<typeof registerProbeTools>[5], audit = new AuditLogger("")) {
  const server = new McpServer({ name: "unit", version: "0" });
  registerProbeTools(server, adt, cfg, audit, new SerialQueue(), deps);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(c);
  // 沒有註冊任何工具時 SDK 的 listTools 會回 Method not found
  const tools = await client.listTools().then((r) => r.tools.map((t) => t.name), () => [] as string[]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: r.content.map((x) => x.text ?? "").join("\n"), isError: !!r.isError };
  };
  return { tools, call };
}

const SET_ARGS = { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 173, fields: ["iv_qty"], trigger: { tool: "run_unit_tests", object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting" } };

describe("探針工具:註冊條件", () => {
  const adt = () => fakeAdt();
  it("預設(ABAP_MCP_ALLOW_PROBES 未設)→ 4 個工具都不註冊", async () => {
    const { tools } = await connect(adt(), cfgOf());
    expect(tools.filter((t) => t.startsWith("probe_"))).toEqual([]);
  });
  it("開啟且可讀寫 → 4 個工具;唯讀模式 → 只有 probe_list / probe_logs", async () => {
    expect((await connect(adt())).tools.filter((t) => t.startsWith("probe_")).sort()).toEqual(["probe_delete", "probe_list", "probe_logs", "probe_set"]);
    const ro = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_READONLY: "true" });
    expect((await connect(adt(), ro)).tools.filter((t) => t.startsWith("probe_")).sort()).toEqual(["probe_list", "probe_logs"]);
  });
  it("prod 一律不註冊(即使 ABAP_MCP_ALLOW_PROBES=true)", async () => {
    const prod = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_SYSTEM_ROLE: "prod" });
    expect(prod.safety.probes.enabled).toBe(false);
    expect((await connect(adt(), prod)).tools.filter((t) => t.startsWith("probe_"))).toEqual([]);
  });
  it("經 registerTools 整合:開關關閉時完全看不到 probe_*", async () => {
    const server = new McpServer({ name: "unit", version: "0" });
    registerTools(server, adt(), cfgOf(), new AuditLogger(""));
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(c);
    expect((await client.listTools()).tools.some((t) => t.name.startsWith("probe_"))).toBe(false);
  });
});

describe("探針工具:probe_set / probe_logs / probe_list / probe_delete", () => {
  const stops = [["BP-p1"]];
  const portFactory = () => fakePort({ stops: stops.map((x) => [...x]) });
  const engineDeps = fakeClock().deps;

  it("完整流程:set → 摘要 → list → logs → delete,且 audit 有紀錄", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-probe-"));
    try {
      const auditPath = path.join(dir, "audit.jsonl");
      const adt = fakeAdt();
      const { call } = await connect(adt, undefined, { portFactory, engineDeps }, new AuditLogger(auditPath));
      const set = await call("probe_set", SET_ARGS);
      expect(set.isError, set.text).toBe(false);
      expect(set.text).toContain("run-1");
      expect(set.text).toContain("命中 1/5 次");
      expect(adt.runUnitTests).toHaveBeenCalledTimes(1);

      expect((await call("probe_list")).text).toContain("run-1");
      const logs = await call("probe_logs", { run_id: "run-1" });
      expect(logs.text).toContain("iv_qty = 42");
      expect(logs.text).toContain("ZCL_INV_POSTING 第 173 行");
      expect((await call("probe_logs", { run_id: "run-9" })).isError).toBe(true);

      const del = await call("probe_delete", { run_id: "run-1" });
      expect(del.text).toContain("已清除 1 筆");
      expect((await call("probe_list")).text).toContain("沒有探針紀錄");

      const entries = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(entries.some((e) => e.action === "probe_set" && e.success && /模式 B run-1/.test(e.summary))).toBe(true);
      expect(entries.some((e) => e.action === "probe_delete" && e.success)).toBe(true);
      // audit 不含變數值
      expect(JSON.stringify(entries)).not.toContain("= 42");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("definition(JSON)與單一探針參數不能並用;缺 trigger、超過探針數上限、逾時範圍都拒絕,且不連 SAP", async () => {
    const adt = fakeAdt();
    const { call } = await connect(adt, cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_MAX_PROBES: "2", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV" }), { portFactory, engineDeps });
    const one = { object_url: SET_ARGS.object_url, line: 10, fields: ["a"] };
    expect((await call("probe_set", { ...SET_ARGS, definition: { probes: [one] } })).text).toContain("只能擇一");
    expect((await call("probe_set", { object_url: SET_ARGS.object_url, line: 10, fields: ["a"] })).text).toContain("需要 trigger");
    expect((await call("probe_set", { definition: { probes: [one, one, one], trigger: SET_ARGS.trigger } })).text).toContain("最多 2 個探針");
    expect((await call("probe_set", { ...SET_ARGS, timeout_seconds: 301 })).text).toContain("timeout_seconds");
    expect((await call("probe_set", { ...SET_ARGS, timeout_seconds: 5 })).text).toContain("timeout_seconds");
    expect(adt.runUnitTests).not.toHaveBeenCalled();
  });

  it("definition 的格式可用:多個探針 + trigger + timeout_seconds", async () => {
    const adt = fakeAdt();
    const { call } = await connect(adt, undefined, { portFactory: () => fakePort({ stops: [["BP-p1", "BP-p2"]] }), engineDeps });
    const r = await call("probe_set", {
      definition: {
        probes: [
          { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 173, fields: ["iv_qty"], max_hits: 1 },
          { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 176, fields: ["rv_amt"], condition: "iv_qty > 0", max_hits: 1 },
        ],
        trigger: SET_ARGS.trigger,
        timeout_seconds: 60,
      },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("p1");
    expect(r.text).toContain("p2");
    expect(r.text).toContain("條件 iv_qty > 0");
  });

  it("探針範圍:PROBE_DENY 內的位置被拒,不設中斷點也不觸發", async () => {
    const adt = fakeAdt();
    const factory = vi.fn(portFactory);
    const { call } = await connect(adt, cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_PROBE_DENY: "ZCL_INV_POSTING", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV" }), { portFactory: factory, engineDeps });
    const r = await call("probe_set", SET_ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("排除清單");
    expect(factory).not.toHaveBeenCalled();
    expect(adt.runUnitTests).not.toHaveBeenCalled();
  });

  it("scope=custom:標準程式的探針被拒;觸發物件走寫入白名單(白名單外的 class 不能當 trigger)", async () => {
    const adt = fakeAdt({ pkg: (u) => (u.includes("cl_std") ? "SAP_STD" : "$ZINV") });
    const { call } = await connect(adt, cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_PROBE_SCOPE: "custom", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV" }), { portFactory, engineDeps });
    const std = await call("probe_set", { ...SET_ARGS, object_url: "/sap/bc/adt/oo/classes/cl_std", fields: ["a"] });
    expect(std.isError).toBe(true);
    expect(std.text).toContain("custom");
    // scope=all 時,標準程式可以埋,但 trigger 仍要符合寫入白名單
    const adt2 = fakeAdt({ pkg: (u) => (u.includes("cl_std") ? "SAP_STD" : "$ZINV") });
    const { call: call2 } = await connect(adt2, cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV" }), { portFactory, engineDeps });
    const trig = await call2("probe_set", { ...SET_ARGS, trigger: { tool: "run_unit_tests", object_url: "/sap/bc/adt/oo/classes/cl_std" } });
    expect(trig.isError).toBe(true);
    expect(trig.text).toContain("白名單");
    expect(adt2.runUnitTests).not.toHaveBeenCalled();
  });

  it("引擎回 error / trigger_failed → 工具回 isError,但紀錄仍存(可以 probe_logs 看原因)", async () => {
    const adt = fakeAdt();
    const { call } = await connect(adt, undefined, { portFactory: () => fakePort({ bpErrors: { p1: "位置不存在" } }), engineDeps });
    const r = await call("probe_set", SET_ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("中斷點設定失敗:位置不存在");
    expect((await call("probe_logs", { run_id: "run-1" })).text).toContain("位置不存在");
  });

  it("probe_delete:run_id 與 all 必須擇一;all 清全部", async () => {
    const adt = fakeAdt();
    const { call } = await connect(adt, undefined, { portFactory, engineDeps });
    await call("probe_set", SET_ARGS);
    await call("probe_set", SET_ARGS);
    expect((await call("probe_delete", {})).isError).toBe(true);
    expect((await call("probe_delete", { run_id: "run-1", all: true })).isError).toBe(true);
    expect((await call("probe_delete", { all: true })).text).toContain("已清除 2 筆");
  });
});

describe("探針紀錄存放與輸出上限", () => {
  const rec = (n: number, hits: number, valueLen = 10): Omit<ProbeRunRecord, "id"> => ({
    mode: "debugger",
    createdAt: "t",
    status: "completed",
    trigger: "x",
    timeoutSeconds: 60,
    notes: [],
    probes: [{ id: "p1", location: "ZCL_X 第 1 行", kind: "variables", fields: ["a"], maxHits: 100, full: false, hits: Array.from({ length: hits }, (_, i) => ({ n: i + 1, at: "t", variables: [{ name: "a", value: "v".repeat(valueLen) }] })) }],
  });
  it("最多保留 20 筆,舊的先丟", () => {
    const s = new ProbeStore();
    for (let i = 0; i < 25; i++) s.add(rec(i, 1));
    expect(s.list()).toHaveLength(20);
    expect(s.get("run-1")).toBeUndefined();
    expect(s.get("run-25")).toBeDefined();
  });
  it("probe_logs 最多 100 筆(超過註明未顯示)", () => {
    const s = new ProbeStore();
    const r = s.add(rec(1, 130));
    const text = formatLogs(r);
    expect(text).toContain("另有 30 筆未顯示");
    expect(text.split("\n").filter((l) => /^ {2}#\d+/.test(l))).toHaveLength(100);
  });
  it("probe_logs 輸出字元上限 20,000(超過截斷)", () => {
    const s = new ProbeStore();
    const r = s.add(rec(1, 100, 1000));
    const text = formatLogs(r);
    expect(text.length).toBeLessThanOrEqual(PROBE_LOGS_MAX_CHARS + 200);
    expect(text).toContain("已截斷");
  });
});

// ───────────────────────── 模式 A:Dynamic Logpoints ─────────────────────────

function dlpAdt(o: { available?: boolean; existing?: { location: string; description: string }[]; readError?: boolean } = {}) {
  const base = fakeAdt() as unknown as Record<string, unknown>;
  const live = new Map<string, string>(); // location → description
  for (const e of o.existing ?? []) live.set(e.location, e.description);
  let n = 0;
  const api = {
    ...base,
    dlpAvailable: vi.fn(async () => o.available ?? true),
    dlpList: vi.fn(async () => [...live].map(([location, description]) => ({ location, description, sourceUri: "", executions: 0, activeUntil: "", state: "A" }))),
    dlpCreate: vi.fn(async (i: { description: string }) => {
      const id = `LP${++n}`;
      live.set(id, i.description);
      return id;
    }),
    dlpDelete: vi.fn(async (id: string) => {
      live.delete(id);
    }),
    dlpRead: vi.fn(async () => {
      if (o.readError) throw new Error("read boom");
      return [
        { key: "1", calls: 6, lastCall: "t1", fields: [{ name: "iv_qty", values: ["1"] }, { name: "iv_stqty", values: ["3"] }] },
        { key: "2", calls: 1, lastCall: "t2", fields: [{ name: "iv_qty", values: ["2"] }, { name: "iv_stqty", values: ["10"] }] },
      ];
    }),
  };
  return { adt: api as unknown as AdtService, api, live };
}

describe("探針模式 A(Dynamic Logpoints)", () => {
  const env = { ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP" };
  const args = { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 176, fields: ["iv_qty", "iv_stqty"], max_hits: 5 };

  it("auto + 有端點 + trigger:建立 → 觸發 → 讀取 → 移除,結果存進紀錄", async () => {
    const { adt, api, live } = dlpAdt();
    const { call } = await connect(adt, cfgOf(env));
    const r = await call("probe_set", { ...args, trigger: SET_ARGS.trigger });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("模式 A");
    expect(r.text).toContain("命中 2/5 次");
    expect(api.dlpCreate).toHaveBeenCalledTimes(1);
    expect(live.size).toBe(0); // 讀完就移除,不留 logpoint
    const logs = await call("probe_logs", { run_id: "run-1" });
    expect(logs.text).toContain("共執行 6 次");
    expect(logs.text).toContain("iv_stqty = 10");
  });

  it("沒給 trigger:立即回傳,logpoint 保持啟用;probe_logs 重讀;probe_delete 移除 SAP 上的 logpoint", async () => {
    const { adt, api, live } = dlpAdt();
    const { call } = await connect(adt, cfgOf(env));
    const r = await call("probe_set", args);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("探針已啟用");
    expect(r.text).toContain("有效到");
    expect(live.size).toBe(1);
    expect(api.dlpRead).not.toHaveBeenCalled();
    const logs = await call("probe_logs", { run_id: "run-1" });
    expect(api.dlpRead).toHaveBeenCalledTimes(1);
    expect(logs.text).toContain("iv_qty = 2");
    const d = await call("probe_delete", { run_id: "run-1" });
    expect(d.isError, d.text).toBe(false);
    expect(live.size).toBe(0);
  });

  it("描述帶 abap-adt-mcp 標記:上限只算自己建的;probe_delete all 只清自己的(含先前 process 留下的)", async () => {
    const { adt, live } = dlpAdt({
      existing: [
        { location: "OLD1", description: "abap-adt-mcp" },
        { location: "ECLIPSE1", description: "someone else" },
      ],
    });
    const { call } = await connect(adt, cfgOf({ ...env, ABAP_MCP_MAX_PROBES: "2" }));
    expect((await call("probe_set", args)).isError).toBe(false); // 1 個自己的 + 1 個新的 = 2 ≤ 2
    const over = await call("probe_set", args); // 2 + 1 > 2
    expect(over.isError).toBe(true);
    expect(over.text).toContain("上限");
    await call("probe_delete", { all: true });
    expect([...live.keys()]).toEqual(["ECLIPSE1"]);
  });

  it("讀取失敗:例外照樣往上報,但 logpoint 一定被移除", async () => {
    const { adt, live } = dlpAdt({ readError: true });
    const { call } = await connect(adt, cfgOf(env));
    const r = await call("probe_set", { ...args, trigger: SET_ARGS.trigger });
    expect(r.isError).toBe(true);
    expect(live.size).toBe(0);
  });

  it("ABAP_MCP_PROBE_MODE=dlp 但系統沒有端點 → 報錯;=debugger 完全不碰 dlp;auto 沒端點 → 走模式 B(要 trigger)", async () => {
    const none = dlpAdt({ available: false });
    const a = await connect(none.adt, cfgOf({ ...env, ABAP_MCP_PROBE_MODE: "dlp" }));
    const r1 = await a.call("probe_set", args);
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain("沒有 /sap/bc/adt/dlp");
    const some = dlpAdt();
    const b = await connect(some.adt, cfgOf({ ...env, ABAP_MCP_PROBE_MODE: "debugger" }));
    const r2 = await b.call("probe_set", args); // 模式 B 沒有 trigger → 參數錯誤
    expect(r2.isError).toBe(true);
    expect(r2.text).toContain("trigger");
    expect(some.api.dlpAvailable).not.toHaveBeenCalled();
    expect(some.api.dlpCreate).not.toHaveBeenCalled();
    const c = await connect(none.adt, cfgOf(env));
    expect((await c.call("probe_set", args)).text).toContain("trigger"); // auto 沒端點 → 模式 B
  });

  it("kind=sql 只有模式 A 接受;範圍檢查與 trigger 白名單照常", async () => {
    const { adt, api } = dlpAdt();
    const { call } = await connect(adt, cfgOf(env));
    const r = await call("probe_set", { object_url: args.object_url, line: 176, kind: "sql" });
    expect(r.isError, r.text).toBe(false);
    expect(api.dlpCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: "sql" }));
    const bad = await call("probe_set", { ...args, trigger: { tool: "run_unit_tests", object_url: "/sap/bc/adt/oo/classes/zcl_x" } });
    // 觸發物件的 package 由 fakeAdt 回 $ZINV(在白名單),所以是 custom 範圍以外的情況才擋;這裡只確認 trigger 有被執行路徑接受
    expect(bad.isError, bad.text).toBe(false);
  });
});

// ───────────────────────── 探針定義存檔與 probe-debug prompt ─────────────────────────

describe("探針定義存檔(save_as)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probes-"));
  const env = { ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP", ABAP_MCP_PROBES_DIR: dir };
  const args = { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 176, fields: ["iv_qty", "iv_stqty"], max_hits: 5, trigger: SET_ARGS.trigger };

  it("probe_set 帶 save_as:寫出定義、模式、命中次數、結論,但不含任何變數值", async () => {
    const { adt } = dlpAdt();
    const { call } = await connect(adt, cfgOf(env));
    const r = await call("probe_set", { ...args, save_as: "inv-issue-amt", purpose: "查發料金額", conclusion: "呼叫端傳錯 qty", system_version: "A4H" });
    expect(r.isError, r.text).toBe(false);
    const raw = fs.readFileSync(path.join(dir, "inv-issue-amt.json"), "utf8");
    const f = JSON.parse(raw);
    expect(f).toMatchObject({ name: "inv-issue-amt", purpose: "查發料金額", conclusion: "呼叫端傳錯 qty", mode: "A", hit_count: 2 });
    expect(f.system.version).toBe("A4H");
    expect(f.definition.probes[0]).toMatchObject({ object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting/source/main", line: 176, fields: ["iv_qty", "iv_stqty"], max_hits: 5 });
    expect(f.definition.trigger).toEqual(SET_ARGS.trigger);
    // 假資料的值是 1 / 3 / 2 / 10:檔案裡不能有任何 value 欄位或命中內容
    expect(raw).not.toMatch(/"values?"/);
    expect(raw).not.toContain("lastCall");
    expect(r.text).toContain("已存成");
  });

  it("名稱不合法(路徑、副檔名、空白)→ 在動 SAP 之前就拒絕", async () => {
    const { adt, api } = dlpAdt();
    const { call } = await connect(adt, cfgOf(env));
    for (const bad of ["../evil", "a/b", "a\b", "x.json", "", " x", "a".repeat(61)]) {
      if (bad === "") continue; // 空字串視為沒給
      const r = await call("probe_set", { ...args, save_as: bad });
      expect(r.isError, bad).toBe(true);
    }
    expect(api.dlpCreate).not.toHaveBeenCalled();
  });

  it("probe_logs 可事後帶 save_as + conclusion;唯讀模式拒絕寫檔", async () => {
    const { adt } = dlpAdt();
    const rw = await connect(adt, cfgOf(env));
    await rw.call("probe_set", args);
    const r = await rw.call("probe_logs", { run_id: "run-1", save_as: "later", conclusion: "標準程式正常" });
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "later.json"), "utf8")).conclusion).toBe("標準程式正常");
    const ro = await connect(adt, cfgOf({ ...env, ABAP_MCP_READONLY: "true" }));
    const r2 = await ro.call("probe_logs", { run_id: "run-1", save_as: "ro" });
    expect(r2.isError).toBe(true);
    expect(fs.existsSync(path.join(dir, "ro.json"))).toBe(false);
  });

  it("probe-debug prompt 只在探針開啟時存在,內容包含 probe_delete 與 save_as", async () => {
    const mk = async (cfg: ReturnType<typeof cfgOf>) => {
      const server = new McpServer({ name: "unit", version: "0" });
      registerProbeTools(server, fakeAdt(), cfg, new AuditLogger(""), new SerialQueue());
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(c);
      return client;
    };
    const on = await mk(cfgOf(env));
    const list = await on.listPrompts();
    expect(list.prompts.map((p) => p.name)).toContain("probe-debug");
    const p = await on.getPrompt({ name: "probe-debug", arguments: { object_url: "/sap/bc/adt/oo/classes/zcl_x", symptom: "金額錯" } });
    const text = (p.messages[0].content as { text: string }).text;
    expect(text).toContain("probe_delete");
    expect(text).toContain("save_as");
    expect(text).toContain("金額錯");
    const off = await mk(cfgOf());
    await expect(off.listPrompts()).rejects.toThrow();
  });
});

// ───────────────────────── 獨立審查修正(v0.6 review #1–#4)─────────────────────────
import { pendingCleanups, registerCleanup, runCleanups } from "../../src/adt/cleanup.js";

describe("審查 #1:process 被結束時清掉進行中的探針", () => {
  it("registerCleanup / runCleanups:平行執行、單一失敗不影響其他、取消登錄後不再執行", async () => {
    const ran: string[] = [];
    const u1 = registerCleanup(async () => void ran.push("a"));
    registerCleanup(async () => {
      throw new Error("boom");
    });
    registerCleanup(async () => void ran.push("c"));
    expect(await runCleanups()).toBeGreaterThanOrEqual(3);
    expect(ran.sort()).toEqual(["a", "c"]);
    u1();
    ran.length = 0;
    await runCleanups();
    expect(ran).toEqual(["c"]);
    await runCleanups();
  });

  it("引擎交出 abort:呼叫它會刪中斷點、取消監聽、關閉 session(模擬監聽中 process 結束)", async () => {
    const port = fakePort();
    let abort: (() => Promise<void>) | undefined;
    const run = runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: () => new Promise(() => {}), registerAbort: (f) => (abort = f) }, fakeClock().deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(abort).toBeTypeOf("function");
    await abort!();
    expect(port.deleted).toEqual(["BP-p1"]);
    expect(port.calls).toContain("cancelListen");
    expect(port.calls).toContain("close"); // abort 後引擎可能還會重新監聽一次,真實情況下 process 已結束
    void run.catch(() => undefined);
  });

  it("probe_set(模式 B)跑完就取消登錄;模式 A 不給 trigger 的 logpoint 在 shutdown 時被移除", async () => {
    const before = pendingCleanups();
    const b = await connect(fakeAdt(), cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP", ABAP_MCP_PROBE_MODE: "debugger" }), {
      portFactory: () => fakePort({ stops: [["BP-p1"]] }),
      engineDeps: fakeClock().deps,
    });
    const rb = await b.call("probe_set", SET_ARGS);
    expect(rb.isError, rb.text).toBe(false);
    // 每個 connect 會多一個 store 層的清除登錄(模式 A 用);B 的 per-run abort 不應留下
    expect(pendingCleanups()).toBe(before + 1);

    const { adt, live } = dlpAdt();
    const a = await connect(adt, cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP" }));
    const ra = await a.call("probe_set", { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 176, fields: ["iv_qty"] });
    expect(ra.isError, ra.text).toBe(false);
    expect(live.size).toBe(1);
    await runCleanups();
    expect(live.size).toBe(0);
  });
});

describe("審查 #2/#3:排除清單涵蓋 include 的主程式;custom 在白名單為空時拒絕", () => {
  const INC = "/sap/bc/adt/programs/includes/lhrpayu01/source/main";
  it("assertProbeAllowed:extraNames 命中排除清單就拒絕", () => {
    const cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_PROBE_DENY: "SAPLHRPAY*" });
    expect(() => assertProbeAllowed(cfg, INC, "HR")).not.toThrow(); // 只看 include 名稱擋不住(舊行為)
    expect(() => assertProbeAllowed(cfg, INC, "HR", ["SAPLHRPAY"])).toThrow(/排除清單/);
  });

  it("probe_set:function group / program include 會查主程式再比對排除清單;查不到主程式的 include 拒絕", async () => {
    const env = { ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP", ABAP_MCP_PROBE_MODE: "dlp", ABAP_MCP_PROBE_DENY: "SAPLHRPAY*" };
    const { adt, api } = dlpAdt();
    (api as Record<string, unknown>).mainProgramNames = vi.fn(async () => ["SAPLHRPAY"]);
    const c = await connect(adt, cfgOf(env));
    const r = await c.call("probe_set", { object_url: "/sap/bc/adt/programs/includes/lhrpayu01", line: 5, fields: ["x"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("排除清單");
    expect(api.dlpCreate).not.toHaveBeenCalled();
    // function group:名稱 SAPL<群組> 直接由 URI 推得,不用查 SAP
    const fg = await c.call("probe_set", { object_url: "/sap/bc/adt/functions/groups/hrpay/includes/lhrpayu01", line: 5, fields: ["x"] });
    expect(fg.isError).toBe(true);
    // 查主程式失敗的 program include → fail-closed
    (api as Record<string, unknown>).mainProgramNames = vi.fn(async () => {
      throw new Error("404");
    });
    const bad = await c.call("probe_set", { object_url: "/sap/bc/adt/programs/includes/lzfoo", line: 5, fields: ["x"] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("無法判斷");
  });

  it("scope=custom 且名稱前綴與 package 白名單都空 → 拒絕(不退化成 all)", () => {
    const cfg = cfgOf({ ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_PROBE_SCOPE: "custom", ABAP_MCP_ALLOWED_PREFIXES: "", ABAP_MCP_ALLOWED_PACKAGES: "" });
    if (cfg.safety.allowedPrefixes.length === 0 && cfg.safety.allowedPackages.length === 0) {
      expect(() => assertProbeAllowed(cfg, "/sap/bc/adt/oo/classes/zcl_x/source/main", "$TMP")).toThrow(/白名單都是空的/);
    }
  });
});

// ───────────────────────── 第二次審查(v06review.md)P2-1 / P2-2 / P2-3 ─────────────────────────
import { DELETE_ATTEMPTS } from "../../src/adt/probeB.js";
import { formatRunSummary } from "../../src/tools/probeTools.js";

describe("P2-1:收滿後刪除中斷點失敗 → finally 重試、不宣稱已移除", () => {
  const run = (port: ReturnType<typeof fakePort>) =>
    runDebuggerProbes(port, { probes: [spec({ maxHits: 1 })], timeoutSeconds: 60, trigger: () => new Promise(() => {}) }, fakeClock().deps);

  it("持續失敗:收滿當下試 1 次 + finally 重試 DELETE_ATTEMPTS 次;結果警告、bpDeleted 不為 true", async () => {
    const port = fakePort({ stops: [["BP-p1"]], deleteFailures: Infinity });
    const r = await run(port);
    expect(r.status).toBe("all_full");
    expect(r.probes[0].full).toBe(true);
    expect(r.probes[0].bpDeleted).toBeFalsy();
    expect(port.calls.filter((c) => c === "deleteBreakpoint:BP-p1")).toHaveLength(1 + DELETE_ATTEMPTS);
    expect(r.notes.join("\n")).toMatch(/BP-p1.*沒有成功刪除.*delete failed/);
    expect(port.calls[port.calls.length - 1]).toBe("close"); // 失敗也照樣清理完、登出
    // 摘要不能說「已收滿並移除」
    const text = formatRunSummary({
      id: "run-1",
      mode: "debugger",
      createdAt: "t",
      status: r.status,
      trigger: "x",
      timeoutSeconds: 60,
      notes: r.notes,
      probes: [{ id: "p1", location: "L", sourceUrl: URL_MAIN, line: 173, kind: "variables", fields: ["iv_qty"], maxHits: 1, hits: r.probes[0].hits, full: true, bpLeftover: true }],
    });
    expect(text).not.toContain("已收滿並移除");
    expect(text).toContain("沒有確認刪除");
    expect(text.startsWith("⚠️")).toBe(true);
  });

  it("收滿當下失敗、finally 重試成功:正常(已刪除、沒有警告、不重複刪)", async () => {
    const port = fakePort({ stops: [["BP-p1"]], deleteFailures: 1 });
    const r = await run(port);
    expect(r.probes[0].bpDeleted).toBe(true);
    expect(port.calls.filter((c) => c === "deleteBreakpoint:BP-p1")).toHaveLength(2); // 1 次失敗 + 1 次重試成功
    expect(r.notes.join("\n")).not.toContain("沒有成功刪除");
    expect(port.deleted).toEqual(["BP-p1"]);
  });

  it("abort(shutdown)也重試尚未確認刪除的中斷點", async () => {
    const port = fakePort({ deleteFailures: 1 });
    let abort: (() => Promise<void>) | undefined;
    void runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: () => new Promise(() => {}), registerAbort: (f) => (abort = f) }, fakeClock().deps).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await abort!();
    expect(port.deleted).toEqual(["BP-p1"]); // 第 1 次失敗、第 2 次成功
  });
});

describe("P2-2:總逾時涵蓋停駐處理(handleStop)", () => {
  /** 可控制的計時器:所有 deps.timer 先掛著,測試一次放行 = 期限到 */
  function controlledDeps() {
    const base = fakeClock().deps;
    const fire: (() => void)[] = [];
    const deps: EngineDeps = { ...base, timer: () => new Promise<void>((r) => fire.push(r)) };
    return { deps, expire: () => fire.splice(0).forEach((f) => f()) };
  }
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it("stack() 卡住:期限到就返回 timeout、進入清理;卡住的請求之後釋放也不再有新的 port 呼叫", async () => {
    const port = fakePort({ stops: [["BP-p1"]], hangStack: true });
    const { deps, expire } = controlledDeps();
    const p = runDebuggerProbes(port, { probes: [spec()], timeoutSeconds: 60, trigger: () => new Promise(() => {}) }, deps);
    let done = false;
    void p.then(() => (done = true));
    await waitFor(() => port.calls.includes("stack"));
    expect(done).toBe(false); // 卡在 stack(),還沒到期限
    expire(); // 期限到
    const r = await p;
    expect(r.status).toBe("timeout");
    expect(r.notes.join("\n")).toContain("超過總逾時");
    // 清理:刪中斷點 → 繼續(或終止)→ 關閉
    expect(port.calls).toContain("deleteBreakpoint:BP-p1");
    expect(port.calls.includes("continue") || port.calls.includes("terminate")).toBe(true);
    expect(port.calls[port.calls.length - 1]).toBe("close");
    // 放開卡住的請求:handleStop 不得再對 port 發任何請求(不讀變數、不再 continue / stack)
    const n = port.calls.length;
    port.releaseStack();
    await new Promise((r) => setTimeout(r, 30));
    expect(port.calls.length).toBe(n);
    expect(port.calls.some((c) => c.startsWith("variables:"))).toBe(false);
    expect(r.probes[0].hits).toHaveLength(0);
  });

  it("清理本身有獨立上限:close() 卡住也會返回(不無限等)", async () => {
    const port = fakePort({ stops: [["BP-p1"]] });
    (port as { close: () => Promise<void> }).close = () => new Promise(() => {});
    const stepFire: (() => void)[] = [];
    const deps: EngineDeps = { ...fakeClock().deps, cleanupTimer: () => new Promise<void>((r) => stepFire.push(r)) };
    const p = runDebuggerProbes(port, { probes: [spec({ maxHits: 1 })], timeoutSeconds: 60, trigger: async () => "ok" }, deps);
    // 讓所有清理步驟的上限計時器陸續到期(close 一直卡住)
    for (let i = 0; i < 60; i++) {
      stepFire.splice(0).forEach((f) => f());
      await new Promise((r) => setTimeout(r, 2));
    }
    const r = await Promise.race([p, new Promise<"hung">((res) => setTimeout(() => res("hung"), 500))]);
    expect(r).not.toBe("hung");
  });
});

describe("P2-3:仍啟用的 logpoint 登錄與歷史紀錄分開", () => {
  const env = { ABAP_MCP_ALLOW_PROBES: "true", ABAP_MCP_ALLOWED_PACKAGES: "$ZINV,$TMP", ABAP_MCP_PROBE_MODE: "dlp" };
  const manual = { object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", line: 176, fields: ["iv_qty"] };
  const trig = { ...manual, trigger: SET_ARGS.trigger };

  async function setup() {
    const { adt, live } = dlpAdt();
    const c = await connect(adt, cfgOf(env));
    expect((await c.call("probe_set", manual)).isError).toBe(false); // run-1:手動模式,logpoint 保持啟用
    expect(live.size).toBe(1);
    for (let i = 0; i < 20; i++) expect((await c.call("probe_set", trig)).isError).toBe(false); // 再 20 筆已完成:run-1 被淘汰
    return { c, live };
  }

  it("ProbeStore:淘汰歷史紀錄不影響 live 登錄;確認刪除後才移除登錄(編碼後的 URL 也對得上)", () => {
    const store = new ProbeStore();
    const base = { mode: "dlp" as const, createdAt: "t", status: "active" as const, trigger: "x", timeoutSeconds: 0, probes: [], notes: [] };
    store.add(base);
    store.trackLive("ZCL_X=====CP/INC/5/%_ABC");
    for (let i = 0; i < 20; i++) store.add({ ...base, status: "completed" });
    expect(store.get("run-1")).toBeUndefined();
    expect(store.wasEvicted("run-1")).toBe(true);
    expect(store.liveIds()).toEqual(["ZCL_X=====CP/INC/5/%_ABC"]);
    store.untrackLive("/sap/bc/adt/dlp/logpoints/ZCL_X%3d%3d%3d%3d%3dCP/INC/5/%25_ABC");
    expect(store.liveIds()).toEqual([]);
  });

  it("run-1 被淘汰後,shutdown 清理(runCleanups)仍會刪掉那個 logpoint", async () => {
    const { live } = await setup();
    expect(live.size).toBe(1);
    await runCleanups();
    expect(live.size).toBe(0);
  });

  it("run-1 被淘汰後,probe_delete(all=true) 仍會刪掉它;probe_delete(run_id) 說明紀錄已淘汰並提示 all=true", async () => {
    const { c, live } = await setup();
    const one = await c.call("probe_delete", { run_id: "run-1" });
    expect(one.isError).toBe(true);
    expect(one.text).toContain("已被淘汰");
    expect(one.text).toContain("all=true");
    expect(live.size).toBe(1); // 沒有假裝刪掉
    const all = await c.call("probe_delete", { all: true });
    expect(all.isError, all.text).toBe(false);
    expect(live.size).toBe(0);
  });
});
