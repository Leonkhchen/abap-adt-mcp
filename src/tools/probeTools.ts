/**
 * tools/probeTools.ts — 除錯探針(v0.6):probe_set / probe_list / probe_logs / probe_delete
 *
 * 讓 AI 不改程式碼,就能在指定的程式行「埋探針」:程式跑到那一行時記下變數值或呼叫堆疊,
 * 觸發執行後讀回,找出 bug 原因,最後清除。主要用途是偵測 SAP 標準程式有沒有問題(所以可以埋在標準程式)。
 *
 * 預設關閉(ABAP_MCP_ALLOW_PROBES=true 才註冊);prod 一律不註冊;唯讀模式只註冊 probe_list / probe_logs。
 * 探針會把執行時的變數值記下來,可能讀到敏感資料 → 範圍與排除清單見 safety/probeGuards.ts,
 * 只對 MCP 的登入帳號自己的執行生效,輸出有筆數與字元上限。
 *
 * 目前實作模式 B(Debugger 快照,見 adt/probeB.ts):probe_set 在監聽期間同步等待觸發的執行並回傳結果,
 * 命中紀錄存在本 process 的記憶體(probe_logs 讀、probe_delete 清)。模式 A(Dynamic Logpoints)之後加入。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService } from "../adt/client.js";
import { AdtDebugPort } from "../adt/debugPort.js";
import { baseObjectUrl, isSourceUrl } from "../adt/objectTypes.js";
import {
  realDeps,
  runDebuggerProbes,
  type DebugPort,
  type EngineDeps,
  type EngineResult,
  type ProbeHit,
  type ProbeSpec,
} from "../adt/probeB.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import { assertPackageAllowed, assertWriteAllowed, GuardViolationError, objectNameFromUrl } from "../safety/guards.js";
import { assertProbeAllowed } from "../safety/probeGuards.js";
import type { SerialQueue } from "../safety/serialQueue.js";
import { assertAdtUri } from "../safety/uri.js";
import { formatUnitTestResults } from "./formatters.js";
import { fail, ok, truncate } from "./result.js";

/** probe_logs 最多回傳筆數與字元數 */
export const PROBE_LOGS_MAX_HITS = 100;
export const PROBE_LOGS_MAX_CHARS = 20_000;
/** 記憶體裡最多保留幾次探針執行的紀錄 */
const MAX_STORED_RUNS = 20;
const DEFAULT_MAX_HITS = 5;
const MAX_MAX_HITS = 50;
const DEFAULT_TIMEOUT_SEC = 180;
const MAX_TIMEOUT_SEC = 300;
const MIN_TIMEOUT_SEC = 10;
const MAX_FIELDS = 10;
const MAX_LINE = 1_000_000;

/** 變數名稱或運算式:ABAP 名稱、結構欄位、物件屬性、field symbol、類別屬性 */
const FIELD_RE = /^[A-Za-z0-9_/<>\-~=\[\].]{1,100}$/;

// ───────────────────────────── 輸入驗證 ─────────────────────────────

const triggerSchema = z.object({
  tool: z.enum(["run_unit_tests", "run_class"]).optional().describe("代為觸發執行的工具"),
  object_url: z.string().optional().describe("tool=run_unit_tests 時要執行測試的物件 URI"),
  class_name: z.string().optional().describe("tool=run_class 時要執行的 class 名稱"),
  manual: z.boolean().optional().describe("true = 由使用者自己在 SAP GUI 用同一個帳號執行(例如標準交易),工具在逾時前等待命中"),
});

const probeSchema = z.object({
  object_url: z.string().describe("物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo 或標準程式 /sap/bc/adt/programs/programs/sapmv45a"),
  include: z.string().optional().describe("class 的 include(main / testclasses …),預設 main;已經是 source URI 時忽略"),
  line: z.number().int().positive().describe("要埋探針的行號(1 起算,要是可執行的陳述式)"),
  kind: z.enum(["variables", "stack", "sql"]).optional().describe("variables 記錄變數(預設)/ stack 記錄呼叫堆疊 / sql(只有模式 A 支援)"),
  fields: z.array(z.string()).optional().describe("kind=variables 要記錄的變數或運算式,例如 [\"ls_stock-qty\", \"lv_amt\"]"),
  condition: z.string().optional().describe("選填:條件成立才記錄,例如 ls_stock-qty = 0"),
  max_hits: z.number().int().positive().optional().describe(`最多記錄幾次(預設 ${DEFAULT_MAX_HITS},上限 ${MAX_MAX_HITS});收滿就移除探針`),
});

export type ProbeInput = z.infer<typeof probeSchema>;
export type TriggerInput = z.infer<typeof triggerSchema>;

export interface NormalizedProbe {
  id: string;
  sourceUrl: string;
  baseUrl: string;
  line: number;
  kind: "variables" | "stack";
  fields: string[];
  condition?: string;
  maxHits: number;
}

export type NormalizedTrigger = { kind: "unit_tests"; objectUrl: string } | { kind: "class"; className: string } | { kind: "manual" };

/** object URI + include → 設中斷點用的 source URI */
export function probeSourceUrl(objectUrl: string, include?: string): string {
  const url = objectUrl.trim();
  if (isSourceUrl(url)) return url;
  const base = url.replace(/\/+$/, "");
  const inc = (include ?? "main").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(inc)) throw new GuardViolationError(`include 名稱不合法:${include}`);
  if (inc !== "main" && /\/oo\/classes\//.test(base)) return `${base}/includes/${inc}`;
  return `${base}/source/main`;
}

/** 驗證並正規化探針參數(不連 SAP);違反時丟 GuardViolationError */
export function normalizeProbe(p: ProbeInput, index: number): NormalizedProbe {
  const label = `探針 ${index + 1}`;
  if (p.kind === "sql") throw new GuardViolationError(`${label}:kind=sql 只有 Dynamic Logpoints(模式 A)支援,debugger 快照模式(B)不支援。`);
  const kind = p.kind ?? "variables";
  if (!(p.line > 0 && p.line <= MAX_LINE)) throw new GuardViolationError(`${label}:行號必須是 1–${MAX_LINE}。`);
  const fields = (p.fields ?? []).map((f) => f.trim()).filter(Boolean);
  if (kind === "variables") {
    if (fields.length === 0) throw new GuardViolationError(`${label}:kind=variables 需要 fields(要記錄的變數)。`);
    if (fields.length > MAX_FIELDS) throw new GuardViolationError(`${label}:一個探針最多記錄 ${MAX_FIELDS} 個變數。`);
    for (const f of fields) if (!FIELD_RE.test(f)) throw new GuardViolationError(`${label}:變數名稱「${f.slice(0, 40)}」不合法(只接受 ABAP 名稱、結構欄位、物件屬性)。`);
  }
  let condition: string | undefined;
  if (p.condition !== undefined && p.condition.trim()) {
    condition = p.condition.trim();
    if (condition.length > 200 || /[\u0000-\u001f\u007f]/.test(condition)) throw new GuardViolationError(`${label}:condition 太長(上限 200 字元)或含控制字元。`);
  }
  const maxHits = p.max_hits ?? DEFAULT_MAX_HITS;
  if (!(maxHits >= 1 && maxHits <= MAX_MAX_HITS)) throw new GuardViolationError(`${label}:max_hits 必須是 1–${MAX_MAX_HITS}。`);
  const url = assertAdtUri(p.object_url, undefined);
  const sourceUrl = probeSourceUrl(url, p.include);
  assertAdtUri(sourceUrl, undefined);
  return { id: `p${index + 1}`, sourceUrl, baseUrl: baseObjectUrl(sourceUrl), line: p.line, kind, fields: kind === "variables" ? fields : [], condition, maxHits };
}

export function normalizeTrigger(t: TriggerInput | undefined): NormalizedTrigger {
  if (!t || (t.manual && !t.tool)) {
    if (t?.manual) return { kind: "manual" };
    throw new GuardViolationError("模式 B(debugger 快照)需要 trigger:{tool:\"run_unit_tests\", object_url} / {tool:\"run_class\", class_name} / {manual:true}。");
  }
  if (t.manual) throw new GuardViolationError("trigger 不能同時指定 manual 與 tool。");
  if (t.tool === "run_unit_tests") {
    if (!t.object_url) throw new GuardViolationError("trigger.tool=run_unit_tests 需要 object_url。");
    return { kind: "unit_tests", objectUrl: assertAdtUri(t.object_url, undefined) };
  }
  if (t.tool === "run_class") {
    if (!t.class_name || !/^[A-Za-z0-9_/]{1,30}$/.test(t.class_name)) throw new GuardViolationError("trigger.tool=run_class 需要合法的 class_name。");
    return { kind: "class", className: t.class_name.toUpperCase() };
  }
  throw new GuardViolationError("trigger 需要 tool(run_unit_tests / run_class)或 manual:true。");
}

// ───────────────────────────── 紀錄存放 ─────────────────────────────

export interface ProbeRunRecord {
  id: string;
  mode: "debugger";
  createdAt: string;
  status: EngineResult["status"];
  trigger: string;
  triggerOutcome?: string;
  timeoutSeconds: number;
  probes: { id: string; location: string; kind: string; fields: string[]; condition?: string; maxHits: number; hits: ProbeHit[]; full: boolean; error?: string }[];
  notes: string[];
}

export class ProbeStore {
  private runs: ProbeRunRecord[] = [];
  private counter = 0;

  add(r: Omit<ProbeRunRecord, "id">): ProbeRunRecord {
    const rec = { ...r, id: `run-${++this.counter}` };
    this.runs.push(rec);
    while (this.runs.length > MAX_STORED_RUNS) this.runs.shift();
    return rec;
  }
  list(): ProbeRunRecord[] {
    return [...this.runs];
  }
  get(id: string): ProbeRunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }
  delete(id: string): boolean {
    const n = this.runs.length;
    this.runs = this.runs.filter((r) => r.id !== id);
    return this.runs.length < n;
  }
  clear(): number {
    const n = this.runs.length;
    this.runs = [];
    return n;
  }
}

// ───────────────────────────── 輸出格式 ─────────────────────────────

const STATUS_TEXT: Record<EngineResult["status"], string> = {
  completed: "觸發的執行已跑完",
  all_full: "所有探針都已收滿",
  timeout: "逾時",
  trigger_failed: "觸發執行失敗",
  error: "出錯",
};

const locationOf = (p: NormalizedProbe) => `${objectNameFromUrl(p.sourceUrl)}${/\/includes\/([^/]+)$/.test(p.sourceUrl) ? `(${p.sourceUrl.split("/").pop()})` : ""} 第 ${p.line} 行`;

export function formatHit(h: ProbeHit): string {
  const lines = [`  #${h.n}(${h.at})`];
  for (const v of h.variables ?? []) {
    lines.push(`    ${v.name} = ${v.note ? `(${v.note})` : v.value === "" ? "(空)" : v.value}${v.meta && v.meta !== "simple" && v.meta !== "string" ? `  [${v.meta}]` : ""}`);
  }
  for (const [i, f] of (h.stack ?? []).entries()) lines.push(`    ${i + 1}. ${f.program}${f.include && f.include !== f.program ? `/${f.include}` : ""} 第 ${f.line} 行${f.event ? `(${f.event})` : ""}`);
  return lines.join("\n");
}

export function formatRunSummary(r: ProbeRunRecord): string {
  const out = [
    `${r.status === "completed" || r.status === "all_full" ? "✅" : r.status === "timeout" ? "⏱️" : "❌"} 探針執行 ${r.id}(模式 B:debugger 快照):${STATUS_TEXT[r.status]}`,
    `觸發:${r.trigger}${r.triggerOutcome ? `;結果:${r.triggerOutcome}` : ""}`,
  ];
  for (const p of r.probes) {
    out.push(
      `- ${p.id} ${p.location}(${p.kind}${p.fields.length ? `:${p.fields.join(", ")}` : ""}${p.condition ? `;條件 ${p.condition}` : ""}):` +
        (p.error ? `❌ 中斷點設定失敗:${p.error}` : `命中 ${p.hits.length}/${p.maxHits} 次${p.full ? "(已收滿並移除)" : ""}`)
    );
  }
  for (const n of r.notes) out.push(`ℹ️ ${n}`);
  if (r.probes.some((p) => p.hits.length > 0)) out.push(`用 probe_logs(run_id="${r.id}")讀取每次命中的值;用完請 probe_delete(run_id="${r.id}")清掉紀錄。`);
  return out.join("\n");
}

export function formatLogs(r: ProbeRunRecord, probeId?: string): string {
  const probes = probeId ? r.probes.filter((p) => p.id === probeId) : r.probes;
  if (probes.length === 0) return `${r.id} 裡沒有探針 ${probeId}。`;
  const out = [`📋 ${r.id}(${r.createdAt},${STATUS_TEXT[r.status]})`];
  let shown = 0;
  let omitted = 0;
  for (const p of probes) {
    out.push(`\n## ${p.id} ${p.location}(命中 ${p.hits.length} 次)`);
    if (p.error) out.push(`❌ 中斷點設定失敗:${p.error}`);
    for (const h of p.hits) {
      if (shown >= PROBE_LOGS_MAX_HITS) {
        omitted++;
        continue;
      }
      out.push(formatHit(h));
      shown++;
    }
  }
  if (omitted) out.push(`\n…另有 ${omitted} 筆未顯示(上限 ${PROBE_LOGS_MAX_HITS} 筆)`);
  return truncate(out.join("\n"), PROBE_LOGS_MAX_CHARS);
}

// ───────────────────────────── 註冊 ─────────────────────────────

export interface ProbeToolDeps {
  /** 單元測試注入假的 port */
  portFactory?: () => DebugPort;
  engineDeps?: EngineDeps;
  store?: ProbeStore;
}

const SET_DESCRIPTION =
  "⚠️ 會在 SAP 上執行程式並暫時停住它:在指定程式行埋「探針」,程式跑到那一行時自動記下變數值或呼叫堆疊,然後立刻繼續執行(不改程式、不改變數值)。" +
  "可以埋在 SAP 標準程式,用來確認問題出在標準程式還是呼叫端。目前為 debugger 快照模式:probe_set 在監聽期間同步等待結果(預設 3 分鐘、最長 5 分鐘)," +
  "所以必須指定 trigger——run_unit_tests / run_class 由工具代為觸發;{manual:true} 表示由使用者自己在 SAP GUI 用「同一個帳號」執行(例如 VA01)," +
  "此時請先告訴使用者要在幾分鐘內執行什麼,再呼叫本工具。參數可用單一探針(object_url + line + fields …)或完整 definition({probes:[…], trigger, timeout_seconds})。" +
  "已知限制:update task、背景 RFC、背景作業裡的程式碼不會停下來。探針的值可能含業務資料,用完請 probe_delete。";

export function registerProbeTools(server: McpServer, adt: AdtService, cfg: AppConfig, audit: AuditLogger, writes: SerialQueue, deps: ProbeToolDeps = {}): void {
  if (!cfg.safety.probes.enabled) return;
  const store = deps.store ?? new ProbeStore();
  const portFactory = deps.portFactory ?? (() => new AdtDebugPort(cfg));
  const engineDeps = deps.engineDeps ?? realDeps;

  server.registerTool(
    "probe_list",
    {
      title: "列出探針執行紀錄",
      description: "列出本次 MCP 執行期間用 probe_set 做過的探針:位置、命中次數、狀態。紀錄只存在記憶體,MCP 重開就沒了。",
      inputSchema: {},
    },
    async () => {
      const runs = store.list();
      if (runs.length === 0) return ok("目前沒有探針紀錄。");
      return ok(
        runs
          .map((r) => `- ${r.id}(${r.createdAt},模式 B,${STATUS_TEXT[r.status]}):` + r.probes.map((p) => `${p.id} ${p.location} 命中 ${p.hits.length}/${p.maxHits}`).join(";"))
          .join("\n")
      );
    }
  );

  server.registerTool(
    "probe_logs",
    {
      title: "讀取探針收集到的值",
      description: `讀某次探針執行(run_id)收集到的變數值或堆疊,可指定單一探針(probe_id)。最多 ${PROBE_LOGS_MAX_HITS} 筆、${PROBE_LOGS_MAX_CHARS} 字元,超過會截斷。值可能含業務資料。`,
      inputSchema: {
        run_id: z.string().describe("probe_set / probe_list 回傳的執行編號,例如 run-1"),
        probe_id: z.string().optional().describe("只看某個探針,例如 p1"),
      },
    },
    async ({ run_id, probe_id }) => {
      const r = store.get(run_id);
      if (!r) return fail(new GuardViolationError(`找不到探針執行 ${run_id}(可用 probe_list 查看)。`));
      return ok(formatLogs(r, probe_id));
    }
  );

  if (cfg.safety.readonly) return; // 唯讀模式只有讀取類工具

  server.registerTool(
    "probe_set",
    {
      title: "埋探針並執行(debugger 快照)",
      description: SET_DESCRIPTION,
      inputSchema: {
        object_url: z.string().optional().describe("單一探針:物件 URI"),
        include: z.string().optional().describe("單一探針:class 的 include,預設 main"),
        line: z.number().int().positive().optional().describe("單一探針:行號"),
        kind: z.enum(["variables", "stack", "sql"]).optional().describe("單一探針:variables(預設)/ stack / sql(模式 B 不支援)"),
        fields: z.array(z.string()).optional().describe("單一探針:要記錄的變數"),
        condition: z.string().optional().describe("單一探針:條件"),
        max_hits: z.number().int().positive().optional().describe("單一探針:最多記錄幾次"),
        trigger: triggerSchema.optional().describe("觸發執行的方式(模式 B 必填)"),
        timeout_seconds: z.number().int().positive().optional().describe(`監聽逾時秒數(預設 ${DEFAULT_TIMEOUT_SEC},上限 ${MAX_TIMEOUT_SEC})`),
        duration_minutes: z.number().int().positive().optional().describe("只有模式 A(Dynamic Logpoints)用:探針有效分鐘數;模式 B 忽略"),
        definition: z
          .object({ probes: z.array(probeSchema).min(1), trigger: triggerSchema.optional(), timeout_seconds: z.number().int().positive().optional() })
          .optional()
          .describe("完整 JSON 定義:{probes:[{object_url,line,fields,condition,max_hits}], trigger, timeout_seconds}"),
      },
    },
    (args) =>
      writes.run(async () => {
        const startedAt = new Date().toISOString();
        let firstUrl = "";
        try {
          // 1. 參數:單一探針 xor definition
          const hasSingle = args.object_url !== undefined || args.line !== undefined || args.fields !== undefined;
          if (hasSingle && args.definition) throw new GuardViolationError("單一探針參數與 definition 只能擇一。");
          let probeInputs: ProbeInput[];
          if (args.definition) probeInputs = args.definition.probes;
          else {
            if (!args.object_url || !args.line) throw new GuardViolationError("需要 object_url 與 line(或改用 definition)。");
            probeInputs = [{ object_url: args.object_url, include: args.include, line: args.line, kind: args.kind, fields: args.fields, condition: args.condition, max_hits: args.max_hits }];
          }
          const maxProbes = cfg.safety.probes.maxProbes;
          if (probeInputs.length > maxProbes) throw new GuardViolationError(`一次最多 ${maxProbes} 個探針(ABAP_MCP_MAX_PROBES),這次給了 ${probeInputs.length} 個。`);
          const probes = probeInputs.map((p, i) => normalizeProbe(p, i));
          firstUrl = probes[0].baseUrl;
          const trigger = normalizeTrigger(args.definition ? args.definition.trigger ?? args.trigger : args.trigger);
          const timeoutSeconds = args.definition?.timeout_seconds ?? args.timeout_seconds ?? DEFAULT_TIMEOUT_SEC;
          if (!(timeoutSeconds >= MIN_TIMEOUT_SEC && timeoutSeconds <= MAX_TIMEOUT_SEC)) {
            throw new GuardViolationError(`timeout_seconds 必須是 ${MIN_TIMEOUT_SEC}–${MAX_TIMEOUT_SEC} 秒。`);
          }

          // 2. 位置檢查:探針範圍與排除清單(每個探針),觸發物件走寫入的兩道白名單(它會執行程式)
          for (const p of probes) assertProbeAllowed(cfg, p.sourceUrl, await adt.objectPackage(p.baseUrl));
          let triggerText: string;
          let run: (() => Promise<string>) | undefined;
          if (trigger.kind === "unit_tests") {
            const url = trigger.objectUrl;
            assertWriteAllowed(cfg, url);
            assertPackageAllowed(cfg, await adt.objectPackage(baseObjectUrl(url)));
            triggerText = `run_unit_tests ${objectNameFromUrl(url)}`;
            run = async () => formatUnitTestResults(await adt.runUnitTests(baseObjectUrl(url))).split("\n")[0];
          } else if (trigger.kind === "class") {
            const classUrl = `/sap/bc/adt/oo/classes/${encodeURIComponent(trigger.className.toLowerCase())}`;
            assertWriteAllowed(cfg, classUrl);
            assertPackageAllowed(cfg, await adt.objectPackage(classUrl));
            triggerText = `run_class ${trigger.className}`;
            run = async () => `輸出 ${(await adt.runClass(trigger.className)).length} 字元`;
          } else {
            triggerText = `手動(使用者在 ${timeoutSeconds} 秒內用帳號 ${adt.username()} 執行)`;
          }

          // 3. 執行(同時只有一個監聽:經寫入佇列)
          const result = await runDebuggerProbes(
            portFactory(),
            {
              probes: probes.map<ProbeSpec>((p) => ({ id: p.id, objectUrl: p.sourceUrl, line: p.line, kind: p.kind, variables: p.fields, condition: p.condition, maxHits: p.maxHits })),
              timeoutSeconds,
              trigger: run,
            },
            engineDeps
          );
          const rec = store.add({
            mode: "debugger",
            createdAt: startedAt,
            status: result.status,
            trigger: triggerText,
            triggerOutcome: result.triggerOutcome,
            timeoutSeconds,
            probes: result.probes.map((s, i) => ({
              id: s.spec.id,
              location: locationOf(probes[i]),
              kind: s.spec.kind,
              fields: s.spec.variables,
              condition: s.spec.condition,
              maxHits: s.spec.maxHits,
              hits: s.hits,
              full: s.full,
              error: s.error,
            })),
            notes: result.notes,
          });
          const total = rec.probes.reduce((a, p) => a + p.hits.length, 0);
          audit.log({
            timestamp: new Date().toISOString(),
            action: "probe_set",
            objectUrl: firstUrl,
            objectName: objectNameFromUrl(firstUrl),
            summary: `模式 B ${rec.id}:${probes.length} 個探針、觸發 ${triggerText}、${STATUS_TEXT[result.status]}、共命中 ${total} 次`,
            success: result.status !== "error",
            error: result.status === "error" ? result.notes.join(";") : undefined,
          });
          const text = formatRunSummary(rec);
          return result.status === "error" || result.status === "trigger_failed" ? { content: [{ type: "text" as const, text }], isError: true } : ok(text);
        } catch (e) {
          audit.log({
            timestamp: new Date().toISOString(),
            action: "probe_set",
            objectUrl: firstUrl,
            objectName: firstUrl ? objectNameFromUrl(firstUrl) : "",
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
          return fail(e);
        }
      })
  );

  server.registerTool(
    "probe_delete",
    {
      title: "清除探針紀錄",
      description:
        "清除探針執行紀錄(含收集到的值)。run_id 指定一次執行,或 all=true 清掉本次 MCP 建立的全部。" +
        "debugger 快照模式在 probe_set 結束時就已移除中斷點、關閉監聽,這裡只清記憶體裡的紀錄(避免業務資料留著)。",
      inputSchema: {
        run_id: z.string().optional().describe("要清除的執行編號,例如 run-1"),
        all: z.boolean().optional().describe("true = 清除全部"),
      },
    },
    ({ run_id, all }) =>
      writes.run(async () => {
        try {
          if (!!run_id === !!all) throw new GuardViolationError("run_id 與 all 必須擇一提供。");
          const n = all ? store.clear() : store.delete(run_id!) ? 1 : 0;
          audit.log({
            timestamp: new Date().toISOString(),
            action: "probe_delete",
            objectUrl: "",
            objectName: all ? "(全部)" : run_id!,
            summary: `清除 ${n} 筆探針執行紀錄`,
            success: true,
          });
          return ok(n === 0 ? `沒有符合的探針紀錄(${run_id ?? "全部"})。` : `✅ 已清除 ${n} 筆探針執行紀錄。`);
        } catch (e) {
          return fail(e);
        }
      })
  );
}
