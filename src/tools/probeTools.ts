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
import type { AdtService, DlpKeyLog } from "../adt/client.js";
import { registerCleanup } from "../adt/cleanup.js";
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
import { buildProbeFile, probeFilePath, writeProbeFile, type ProbeFileMeta } from "./probeFile.js";
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
/** 模式 A(Dynamic Logpoints):預設有效 15 分鐘、最長 24 小時;標記在 logpoint 的描述,清除時只動自己建的 */
const DEFAULT_DLP_MINUTES = 15;
const MAX_DLP_MINUTES = 1440;
export const DLP_TAG = "abap-adt-mcp";
const MAX_VALUE_CHARS = 500;
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
  max_hits: z.number().int().positive().optional().describe(`最多記錄幾次(預設 ${DEFAULT_MAX_HITS},上限 ${MAX_MAX_HITS});模式 B 收滿就移除中斷點;模式 A 是最多讀幾個不同的值(logpoint 要 probe_delete 或到期才移除)`),
});

export type ProbeInput = z.infer<typeof probeSchema>;
export type TriggerInput = z.infer<typeof triggerSchema>;

export interface NormalizedProbe {
  id: string;
  sourceUrl: string;
  baseUrl: string;
  line: number;
  kind: "variables" | "stack" | "sql";
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
export function normalizeProbe(p: ProbeInput, index: number, allowSql = false): NormalizedProbe {
  const label = `探針 ${index + 1}`;
  if (p.kind === "sql" && !allowSql) throw new GuardViolationError(`${label}:kind=sql 只有 Dynamic Logpoints(模式 A)支援,debugger 快照模式(B)不支援。`);
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
  mode: "debugger" | "dlp";
  createdAt: string;
  status: EngineResult["status"] | "active";
  /** 模式 A:logpoint 有效到幾點 */
  activeUntil?: string;
  trigger: string;
  /** 使用者給的 trigger 參數(存檔用) */
  triggerInput?: unknown;
  triggerOutcome?: string;
  timeoutSeconds: number;
  probes: { id: string; location: string; sourceUrl: string; line: number; kind: string; fields: string[]; condition?: string; maxHits: number; hits: ProbeHit[]; full: boolean; error?: string; dlpId?: string; /** 模式 B:SAP 上的中斷點沒有確認刪除 */ bpLeftover?: boolean }[];
  notes: string[];
}

/** 建立時回傳解碼後的 id,清單回傳編碼過的 URL:統一成解碼後的 id 才能比對與去重 */
export function dlpKey(id: string): string {
  const raw = id.replace(/^\/sap\/bc\/adt\/dlp\/logpoints\//, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export class ProbeStore {
  private runs: ProbeRunRecord[] = [];
  private counter = 0;
  /** 已被淘汰的執行編號(歷史紀錄有容量上限) */
  private evicted = new Set<string>();
  /**
   * SAP 上仍啟用中的 logpoint(v0.6 第二次審查 P2-3):與有容量上限的歷史紀錄分開登錄,
   * 保留到確認刪除(或已不存在);淘汰歷史紀錄不影響它,shutdown 與 probe_delete 都從這裡清。
   */
  private live = new Map<string, string>();

  add(r: Omit<ProbeRunRecord, "id">): ProbeRunRecord {
    const rec = { ...r, id: `run-${++this.counter}` };
    this.runs.push(rec);
    while (this.runs.length > MAX_STORED_RUNS) {
      const old = this.runs.shift();
      if (old) this.evicted.add(old.id);
    }
    return rec;
  }
  wasEvicted(id: string): boolean {
    return this.evicted.has(id);
  }
  trackLive(id: string): void {
    this.live.set(dlpKey(id), id);
  }
  untrackLive(id: string): void {
    this.live.delete(dlpKey(id));
  }
  liveIds(): string[] {
    return [...this.live.values()];
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

const STATUS_TEXT: Record<EngineResult["status"] | "active", string> = {
  active: "探針已啟用,等待執行",
  completed: "觸發的執行已跑完",
  all_full: "所有探針都已收滿",
  timeout: "逾時",
  trigger_failed: "觸發執行失敗",
  error: "出錯",
};

const locationOf = (p: NormalizedProbe) => `${objectNameFromUrl(p.sourceUrl)}${/\/includes\/([^/]+)$/.test(p.sourceUrl) ? `(${p.sourceUrl.split("/").pop()})` : ""} 第 ${p.line} 行`;

export function formatHit(h: ProbeHit): string {
  const lines = [`  #${h.n}(${h.at}${h.calls !== undefined ? `,共執行 ${h.calls} 次` : ""})`];
  for (const v of h.variables ?? []) {
    lines.push(`    ${v.name} = ${v.note ? `(${v.note})` : v.value === "" ? "(空)" : v.value}${v.meta && v.meta !== "simple" && v.meta !== "string" ? `  [${v.meta}]` : ""}`);
  }
  for (const [i, f] of (h.stack ?? []).entries()) lines.push(`    ${i + 1}. ${f.program}${f.include && f.include !== f.program ? `/${f.include}` : ""} 第 ${f.line} 行${f.event ? `(${f.event})` : ""}`);
  return lines.join("\n");
}

export function formatRunSummary(r: ProbeRunRecord): string {
  const out = [
    `${r.probes.some((p) => p.bpLeftover) ? "⚠️" : r.status === "completed" || r.status === "all_full" || r.status === "active" ? "✅" : r.status === "timeout" ? "⏱️" : "❌"} 探針執行 ${r.id}(模式 ${r.mode === "dlp" ? "A:Dynamic Logpoints" : "B:debugger 快照"}):${STATUS_TEXT[r.status]}`,
    `觸發:${r.trigger}${r.triggerOutcome ? `;結果:${r.triggerOutcome}` : ""}`,
  ];
  for (const p of r.probes) {
    out.push(
      `- ${p.id} ${p.location}(${p.kind}${p.fields.length ? `:${p.fields.join(", ")}` : ""}${p.condition ? `;條件 ${p.condition}` : ""}):` +
        (p.error ? `❌ 中斷點設定失敗:${p.error}` : `命中 ${p.hits.length}/${p.maxHits} 次${p.bpLeftover ? "  ⚠️ SAP 上的中斷點沒有確認刪除(見下方說明)" : p.full ? (r.mode === "dlp" ? "(已讀滿 max_hits 個不同的值)" : "(已收滿並移除)") : ""}`)
    );
  }
  if (r.activeUntil) out.push(`有效到 ${r.activeUntil}。程式執行後用 probe_logs(run_id="${r.id}")讀取,用完請 probe_delete(run_id="${r.id}")移除 logpoint。`);
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
  "⚠️ 會在 SAP 上埋「探針」:程式跑到指定的那一行時自動記下變數值(或呼叫堆疊、SQL),不改程式、不改變數值。可以埋在 SAP 標準程式,用來確認問題出在標準程式還是呼叫端。" +
  "有兩種模式(ABAP_MCP_PROBE_MODE,預設 auto:系統有 Dynamic Logpoints 就用 A,否則用 B)。" +
  "模式 A(Dynamic Logpoints):在 SAP 設 logpoint(duration_minutes,預設 15、最長 1440 分鐘),只對 MCP 帳號自己的執行生效,程式不會被停住;" +
  "給 trigger(run_unit_tests / run_class)時由工具代為執行並立即讀取、移除;不給 trigger(或 manual)就立即回傳,等使用者用「同一個帳號」執行後,用 probe_logs 讀取,最後 probe_delete 移除。" +
  "模式 A 以「第一個 fields 變數的不同值」分組,每個不同的值算一筆(附執行次數);支援 kind=variables / stack / sql。" +
  "模式 B(debugger 快照):probe_set 在監聽期間同步等待(預設 3 分鐘、最長 5 分鐘),必須指定 trigger;{manual:true} 表示使用者在逾時前自己執行(例如 VA01),此時請先告訴使用者要在幾分鐘內執行什麼,再呼叫本工具。" +
  "參數可用單一探針(object_url + line + fields …)或完整 definition({probes:[…], trigger, timeout_seconds})。" +
  "已知限制:模式 B 的 update task、背景 RFC、背景作業裡的程式碼不會停下來;模式 A 目前支援 class 與程式(report / include)。探針的值可能含業務資料,用完請 probe_delete。";

/** 模式 A 一個 key 的紀錄 → 命中紀錄(每個不同的值算一筆,calls 是執行次數) */
export function keyLogsToHits(logs: DlpKeyLog[]): ProbeHit[] {
  return logs.map((l, i) => ({
    n: i + 1,
    at: l.lastCall,
    calls: l.calls,
    variables: l.fields.map((f) => ({ name: f.name, value: truncate(f.values.join(", "), MAX_VALUE_CHARS) })),
  }));
}

export function registerProbeTools(server: McpServer, adt: AdtService, cfg: AppConfig, audit: AuditLogger, writes: SerialQueue, deps: ProbeToolDeps = {}): void {
  if (!cfg.safety.probes.enabled) return;
  const store = deps.store ?? new ProbeStore();
  const portFactory = deps.portFactory ?? (() => new AdtDebugPort(cfg));
  const engineDeps = deps.engineDeps ?? realDeps;

  /** ABAP_MCP_PROBE_MODE:debugger = 模式 B;dlp = 模式 A(系統沒有端點就報錯);auto = 有 dlp 端點用 A,否則 B */
  const resolveMode = async (): Promise<"dlp" | "debugger"> => {
    const m = cfg.safety.probes.mode;
    if (m === "debugger") return "debugger";
    const avail = await adt.dlpAvailable();
    if (m === "dlp" && !avail) throw new GuardViolationError("ABAP_MCP_PROBE_MODE=dlp,但這個系統沒有 /sap/bc/adt/dlp 端點(Dynamic Logpoints)。請改用 auto 或 debugger。");
    return avail ? "dlp" : "debugger";
  };

  const saveProbeFile = (name: string, rec: ProbeRunRecord, meta: ProbeFileMeta): string => {
    let host = adt.baseUrl();
    try {
      host = new URL(host).host;
    } catch {
      /* 保留原字串 */
    }
    const file = writeProbeFile(cfg.safety.probes.dir, name, buildProbeFile(name, rec, meta, { host, client: cfg.sap.client }));
    return `\n📁 探針定義已存成 ${file}(只有位置、變數名稱、命中次數與結論,不含變數值)。`;
  };

  /** 排除清單要比對的額外名稱:include 的主程式、function group(沒有排除清單時不查 SAP) */
  const extraDenyNames = async (sourceUrl: string): Promise<string[]> => {
    if (cfg.safety.probes.deny.length === 0) return [];
    const names: string[] = [];
    const fg = /\/sap\/bc\/adt\/functions\/groups\/([^/]+)/i.exec(sourceUrl);
    if (fg) {
      const g = decodeURIComponent(fg[1]).toUpperCase();
      names.push(g, `SAPL${g}`);
    }
    if (fg || /\/sap\/bc\/adt\/programs\/includes\//i.test(sourceUrl)) {
      try {
        names.push(...(await adt.mainProgramNames(sourceUrl)));
      } catch (e) {
        if (!fg) throw new GuardViolationError(`無法判斷 include 所屬的主程式(${e instanceof Error ? e.message : String(e)}),排除清單啟用中,為安全起見拒絕。`);
      }
    }
    return names;
  };

  // MCP 結束時(stdin 關閉 / SIGINT / SIGTERM):移除這個 process 建立、還在 SAP 上啟用的 logpoint(紀錄在記憶體,重開後讀不到了)
  // 從「仍啟用的 logpoint 登錄」清,不依賴會被淘汰的歷史紀錄(第二次審查 P2-3)
  registerCleanup(async () => {
    await deleteLogpoints(store.liveIds());
  });

  const deleteLogpoints = async (ids: string[]): Promise<string[]> => {
    const errs: string[] = [];
    for (const id of [...new Map(ids.map((i) => [dlpKey(i), i])).values()]) {
      try {
        await adt.dlpDelete(id);
        store.untrackLive(id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/does not exist|not found|404/i.test(msg)) store.untrackLive(id); // 已逾期或被刪掉 = 目的已達成
        else errs.push(`${id}:${msg}`);
      }
    }
    return errs;
  };

  /** 從 SAP 重讀模式 A 這次執行的紀錄(probe_logs 用);失敗只記進 notes,保留舊資料 */
  const refreshDlp = async (r: ProbeRunRecord): Promise<void> => {
    for (const p of r.probes) {
      if (!p.dlpId) continue;
      try {
        p.hits = keyLogsToHits(await adt.dlpRead(p.dlpId, p.maxHits));
        p.full = p.hits.length >= p.maxHits;
      } catch (e) {
        r.notes.push(`重讀 ${p.id} 失敗(logpoint 可能已逾期或被刪除):${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  server.registerPrompt(
    "probe-debug",
    {
      title: "用探針找 bug 原因",
      description: "不改程式碼,在可疑的行埋探針取得執行時的變數值,判斷原因後再修正,最後清掉探針",
      argsSchema: {
        object_url: z.string().describe("可疑的物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo(也可以是標準程式)"),
        symptom: z.string().describe("症狀:哪裡不對、預期與實際各是什麼"),
        trigger: z.string().optional().describe("選填:怎麼觸發執行,例如「run_unit_tests ZCL_DEMO」或「使用者在 VA01 建單」"),
      },
    },
    ({ object_url, symptom, trigger }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `請用探針找出 ${object_url} 的問題原因(症狀:${symptom}):`,
              "1. 用 read_source 讀原始碼,找出最可疑的行(可執行的陳述式),判斷要看哪幾個變數;沒把握時先 kind=stack 看呼叫路徑。一次只埋少數幾個探針。",
              `2. 用 probe_set 在那一行記錄變數(fields;必要時加 condition 縮小範圍)。觸發方式:${trigger ?? "run_unit_tests 或 run_class(由工具代為執行);要使用者自己操作時用 trigger={manual:true},並先告訴使用者要做什麼"}。` +
                "模式 A(Dynamic Logpoints)沒給 trigger 時 logpoint 會保持啟用,等執行後再用 probe_logs 讀。",
              "3. 用 probe_logs 讀出收集到的值(模式 A 以第一個變數的不同值分組,附執行次數)。",
              "4. 判斷根本原因;值不夠就調整探針再來一輪。不要只靠推測。若問題出在標準程式本身,說明證據,不要修改標準程式。",
              "5. 是自己的程式才用 write_source(帶 expected_current_source、activate=true)修正,再用 run_unit_tests 驗證。",
              "6. **一定要**用 probe_delete 清掉探針與紀錄(忘了也會到期,但業務資料不該留著)。",
              "7. 若這個探針位置值得之後參考,在 probe_logs 帶 save_as、purpose、conclusion 存成 probes/*.json(不含變數值)。",
              "8. 回報:原因、證據(探針位置與觀察到的值的意義)、修正內容、驗證結果。",
            ].join("\n"),
          },
        },
      ],
    }),
  );

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
          .map((r) => `- ${r.id}(${r.createdAt},模式 ${r.mode === "dlp" ? "A" : "B"},${STATUS_TEXT[r.status]}):` + r.probes.map((p) => `${p.id} ${p.location} 命中 ${p.hits.length}/${p.maxHits}`).join(";"))
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
        save_as: z.string().optional().describe(`選填:把這次探針的定義與結論存成 ${"probes/<名稱>.json"}(只存位置、變數名稱、命中次數與結論,不存值);名稱只接受英數字、_、-`),
        purpose: z.string().optional().describe("save_as 用:這次要查什麼問題"),
        conclusion: z.string().optional().describe("save_as 用:結論(例如「標準程式正確,錯在呼叫端傳入的 qty」)"),
        system_version: z.string().optional().describe("save_as 用:系統版本,例如 A4H / ABAP Platform 2025"),
      },
    },
    async ({ run_id, probe_id, save_as, purpose, conclusion, system_version }) => {
      const r = store.get(run_id);
      if (!r) return fail(new GuardViolationError(`找不到探針執行 ${run_id}(可用 probe_list 查看)。`));
      if (r.mode === "dlp" && r.status === "active") await refreshDlp(r);
      let saved = "";
      if (save_as) {
        try {
          if (cfg.safety.readonly) throw new GuardViolationError("唯讀模式不寫檔(save_as 需要可讀寫模式)。");
          probeFilePath(cfg.safety.probes.dir, save_as);
          saved = saveProbeFile(save_as, r, { purpose, conclusion, systemVersion: system_version });
        } catch (e) {
          return fail(e);
        }
      }
      return ok(formatLogs(r, probe_id) + saved);
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
        kind: z.enum(["variables", "stack", "sql"]).optional().describe("單一探針:variables(預設)/ stack / sql(只有模式 A 支援)"),
        fields: z.array(z.string()).optional().describe("單一探針:要記錄的變數"),
        condition: z.string().optional().describe("單一探針:條件"),
        max_hits: z.number().int().positive().optional().describe("單一探針:最多記錄幾次"),
        trigger: triggerSchema.optional().describe("觸發執行的方式(模式 B 必填;模式 A 省略或 manual 表示 logpoint 開著等人執行)"),
        timeout_seconds: z.number().int().positive().optional().describe(`監聽逾時秒數(預設 ${DEFAULT_TIMEOUT_SEC},上限 ${MAX_TIMEOUT_SEC})`),
        save_as: z.string().optional().describe("選填:把探針定義存成 probes/<名稱>.json(不存變數值);結論通常要讀完 probe_logs 才知道,可改在 probe_logs 帶 save_as 與 conclusion"),
        purpose: z.string().optional().describe("save_as 用:這次要查什麼問題"),
        conclusion: z.string().optional().describe("save_as 用:結論"),
        system_version: z.string().optional().describe("save_as 用:系統版本,例如 A4H / ABAP Platform 2025"),
        duration_minutes: z.number().int().positive().optional().describe("只有模式 A(Dynamic Logpoints)用:探針有效分鐘數(預設 15,最長 1440);模式 B 忽略"),
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
          if (args.save_as) probeFilePath(cfg.safety.probes.dir, args.save_as); // 名稱不合法就在動 SAP 之前擋下
          const mode = await resolveMode();
          const probes = probeInputs.map((p, i) => normalizeProbe(p, i, mode === "dlp"));
          firstUrl = probes[0].baseUrl;
          const rawTrigger = args.definition ? args.definition.trigger ?? args.trigger : args.trigger;
          // 模式 A 的 logpoint 可以一直開著等人去執行,所以 trigger 可省略(等同 manual);模式 B 一定要有
          const trigger = mode === "dlp" && !rawTrigger ? ({ kind: "manual" } as const) : normalizeTrigger(rawTrigger);
          const timeoutSeconds = args.definition?.timeout_seconds ?? args.timeout_seconds ?? DEFAULT_TIMEOUT_SEC;
          if (!(timeoutSeconds >= MIN_TIMEOUT_SEC && timeoutSeconds <= MAX_TIMEOUT_SEC)) {
            throw new GuardViolationError(`timeout_seconds 必須是 ${MIN_TIMEOUT_SEC}–${MAX_TIMEOUT_SEC} 秒。`);
          }

          // 2. 位置檢查:探針範圍與排除清單(每個探針),觸發物件走寫入的兩道白名單(它會執行程式)
          for (const p of probes) assertProbeAllowed(cfg, p.sourceUrl, await adt.objectPackage(p.baseUrl), await extraDenyNames(p.sourceUrl));
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
            triggerText = mode === "dlp" ? `手動(用帳號 ${adt.username()} 執行)` : `手動(使用者在 ${timeoutSeconds} 秒內用帳號 ${adt.username()} 執行)`;
          }

          if (mode === "dlp") {
            // ───── 模式 A:Dynamic Logpoints ─────
            const minutes = args.duration_minutes ?? DEFAULT_DLP_MINUTES;
            if (!(minutes >= 1 && minutes <= MAX_DLP_MINUTES)) throw new GuardViolationError(`duration_minutes 必須是 1–${MAX_DLP_MINUTES}(預設 ${DEFAULT_DLP_MINUTES})。`);
            const mine = (await adt.dlpList()).filter((e) => e.description.startsWith(DLP_TAG));
            if (mine.length + probes.length > maxProbes) {
              throw new GuardViolationError(`本帳號已有 ${mine.length} 個由 MCP 建立的 logpoint,再加 ${probes.length} 個會超過上限 ${maxProbes}(ABAP_MCP_MAX_PROBES)。先用 probe_delete 清掉舊的。`);
            }
            const states = probes.map((p) => ({ p, dlpId: undefined as string | undefined, error: undefined as string | undefined }));
            const notes: string[] = [];
            let triggerOutcome: string | undefined;
            let status: ProbeRunRecord["status"] = "active";
            let hitsBy: ProbeHit[][] = probes.map(() => []);
            // 進行中被結束:建立到一半 / 正在觸發時 process 結束,finally 跑不到
            const unregisterRun = registerCleanup(async () => {
              await deleteLogpoints(states.filter((st) => st.dlpId).map((st) => st.dlpId!));
            });
            try {
              for (const st of states) {
                try {
                  st.dlpId = await adt.dlpCreate({
                    sourceUrl: st.p.sourceUrl,
                    line: st.p.line,
                    kind: st.p.kind,
                    fields: st.p.fields,
                    condition: st.p.condition,
                    description: DLP_TAG,
                    minutes,
                  });
                  store.trackLive(st.dlpId); // 登錄「SAP 上仍活著」的 logpoint,與會被淘汰的歷史紀錄分開(P2-3)
                } catch (e) {
                  st.error = e instanceof Error ? e.message : String(e);
                }
              }
              if (states.every((st) => !st.dlpId)) status = "error";
              else if (run) {
                // 有 trigger:執行 → 讀取 → 移除(finally),不留 logpoint
                try {
                  triggerOutcome = await run();
                  status = "completed";
                } catch (e) {
                  triggerOutcome = e instanceof Error ? e.message : String(e);
                  status = "trigger_failed";
                }
                hitsBy = [];
                for (const st of states) hitsBy.push(st.dlpId ? keyLogsToHits(await adt.dlpRead(st.dlpId, st.p.maxHits)) : []);
                notes.push("模式 A 以「第一個變數的不同值」分組:每個不同的值算一筆,「共執行 N 次」是該值出現的次數。");
              } else {
                notes.push("模式 A 以「第一個變數的不同值」分組:每個不同的值算一筆。");
              }
            } finally {
              unregisterRun(); // 之後由下面的清除或 store 層的 shutdown 清除接手
              if (run || status === "error") {
                const errs = await deleteLogpoints(states.filter((st) => st.dlpId).map((st) => st.dlpId!));
                for (const e of errs) notes.push(`⚠️ 移除 logpoint 失敗,請用 probe_delete 或 Eclipse 清除:${e}`);
                for (const st of states) if (!errs.some((x) => st.dlpId && x.startsWith(`${st.dlpId}:`))) st.dlpId = undefined;
              }
            }
            if (!run && status === "active") notes.push(`logpoint 在 SAP 上啟用到 ${new Date(Date.now() + minutes * 60_000).toISOString()} 為止(只對 ${adt.username()} 的執行生效)。`);
            const rec = store.add({
              mode: "dlp",
              createdAt: startedAt,
              status,
              activeUntil: !run && status === "active" ? new Date(Date.now() + minutes * 60_000).toISOString() : undefined,
              trigger: triggerText,
              triggerInput: rawTrigger,
              triggerOutcome,
              timeoutSeconds: 0,
              probes: states.map((st, i) => ({
                id: st.p.id,
                location: locationOf(st.p),
                sourceUrl: st.p.sourceUrl,
                line: st.p.line,
                kind: st.p.kind,
                fields: st.p.fields,
                condition: st.p.condition,
                maxHits: st.p.maxHits,
                hits: hitsBy[i] ?? [],
                full: (hitsBy[i]?.length ?? 0) >= st.p.maxHits,
                error: st.error,
                dlpId: st.dlpId,
              })),
              notes,
            });
            const total = rec.probes.reduce((a, p) => a + p.hits.length, 0);
            audit.log({
              timestamp: new Date().toISOString(),
              action: "probe_set",
              objectUrl: firstUrl,
              objectName: objectNameFromUrl(firstUrl),
              summary: `模式 A ${rec.id}:${probes.length} 個 logpoint、${run ? `觸發 ${triggerText}、` : ""}${STATUS_TEXT[status]}、共 ${total} 筆`,
              success: status !== "error",
              error: status === "error" ? states.map((st) => st.error).filter(Boolean).join(";") : undefined,
            });
            const text = formatRunSummary(rec) + (args.save_as ? saveProbeFile(args.save_as, rec, { purpose: args.purpose, conclusion: args.conclusion, systemVersion: args.system_version }) : "");
            return status === "error" || status === "trigger_failed" ? { content: [{ type: "text" as const, text }], isError: true } : ok(text);
          }

          // 3. 執行(同時只有一個監聽:經寫入佇列)
          let unregister: (() => void) | undefined;
          const result = await runDebuggerProbes(
            portFactory(),
            {
              registerAbort: (abort) => {
                unregister = registerCleanup(abort);
              },
              probes: probes.map<ProbeSpec>((p) => ({ id: p.id, objectUrl: p.sourceUrl, line: p.line, kind: p.kind as "variables" | "stack", variables: p.fields, condition: p.condition, maxHits: p.maxHits })),
              timeoutSeconds,
              trigger: run,
            },
            engineDeps
          ).finally(() => unregister?.());
          const rec = store.add({
            mode: "debugger",
            createdAt: startedAt,
            status: result.status,
            trigger: triggerText,
            triggerInput: rawTrigger,
            triggerOutcome: result.triggerOutcome,
            timeoutSeconds,
            probes: result.probes.map((s, i) => ({
              id: s.spec.id,
              location: locationOf(probes[i]),
              sourceUrl: probes[i].sourceUrl,
              line: probes[i].line,
              kind: s.spec.kind,
              fields: s.spec.variables,
              condition: s.spec.condition,
              maxHits: s.spec.maxHits,
              hits: s.hits,
              full: s.full,
              error: s.error,
              bpLeftover: !!(s.bpId && !s.bpDeleted),
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
          const text = formatRunSummary(rec) + (args.save_as ? saveProbeFile(args.save_as, rec, { purpose: args.purpose, conclusion: args.conclusion, systemVersion: args.system_version }) : "");
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
        "debugger 快照模式在 probe_set 結束時就已移除中斷點、關閉監聽,這裡只清記憶體裡的紀錄(避免業務資料留著);Dynamic Logpoints 模式還會移除 SAP 上的 logpoint(all=true 也清掉先前留下、帶 abap-adt-mcp 標記的)。",
      inputSchema: {
        run_id: z.string().optional().describe("要清除的執行編號,例如 run-1"),
        all: z.boolean().optional().describe("true = 清除全部"),
      },
    },
    ({ run_id, all }) =>
      writes.run(async () => {
        try {
          if (!!run_id === !!all) throw new GuardViolationError("run_id 與 all 必須擇一提供。");
          // 紀錄已被淘汰(只保留最近 MAX_STORED_RUNS 筆):對應不到它的 logpoint,明說並提示用 all=true,不假裝成功
          if (run_id && !store.get(run_id) && store.wasEvicted(run_id)) {
            throw new GuardViolationError(
              `${run_id} 的紀錄已被淘汰(只保留最近 ${MAX_STORED_RUNS} 筆),無法對應它的 logpoint。若 SAP 上還有這次建立的 logpoint,請用 probe_delete(all=true) 清除(也會清掉先前留下、帶 ${DLP_TAG} 標記的)。`
            );
          }
          // 模式 A:先移除 SAP 上的 logpoint(all 時連同「仍啟用的登錄」與先前 MCP process 留下、描述有 abap-adt-mcp 標記的)
          const errs: string[] = [];
          let removed = 0;
          const dlpRuns = (all ? store.list() : [store.get(run_id!)]).filter((r): r is ProbeRunRecord => !!r && r.mode === "dlp");
          const ids = dlpRuns.flatMap((r) => r.probes.map((p) => p.dlpId).filter((x): x is string => !!x));
          if (all) for (const id of store.liveIds()) if (!ids.some((i) => dlpKey(i) === dlpKey(id))) ids.push(id);
          if (all && (await adt.dlpAvailable().catch(() => false))) {
            for (const e of await adt.dlpList()) if (e.description.startsWith(DLP_TAG) && !ids.some((i) => dlpKey(i) === dlpKey(e.location))) ids.push(e.location);
          }
          errs.push(...(await deleteLogpoints(ids)));
          removed = new Set(ids.map(dlpKey)).size - errs.length;
          if (errs.length) throw new GuardViolationError(`移除 logpoint 失敗(紀錄保留,可重試):${errs.join(";")}`);
          const n = all ? store.clear() : store.delete(run_id!) ? 1 : 0;
          audit.log({
            timestamp: new Date().toISOString(),
            action: "probe_delete",
            objectUrl: "",
            objectName: all ? "(全部)" : run_id!,
            summary: `清除 ${n} 筆探針執行紀錄${removed ? `、移除 ${removed} 個 logpoint` : ""}`,
            success: true,
          });
          return ok(n === 0 ? `沒有符合的探針紀錄(${run_id ?? "全部"})。` : `✅ 已清除 ${n} 筆探針執行紀錄${removed ? `,並移除 SAP 上 ${removed} 個 logpoint` : ""}。`);
        } catch (e) {
          return fail(e);
        }
      })
  );
}
