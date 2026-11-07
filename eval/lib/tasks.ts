/**
 * eval/lib/tasks.ts — 評測任務(eval/tasks/*.yaml)的載入與驗證
 *
 * 任務檔欄位:
 *   id / title / prompt
 *   tags?:             [zinv, legacy …]   `--tags` 篩選用
 *   opt_in?:           true   預設不跑;要用 --tags / --tasks 明確選到才跑(會動共用物件的題組用)
 *   allowed_packages?: [$ZINV]            這題的 MCP 設定 ABAP_MCP_ALLOWED_PACKAGES(沒寫就用 .env / 預設,舊題不受影響)
 *   allow_probes?:     true   這題的 MCP 設定開啟探針工具(ABAP_MCP_ALLOW_PROBES);其他題用 --probes 一次打開
 *   require_tool_order?: [probe_set, write_source]   模型的工具呼叫要依這個順序(各取第一次出現)都出現過;例如「先用探針取值再修」
 *   timeout_min? / budget_usd? / tool_timeout_sec?   這題的逾時、費用上限、MCP 工具逾時(大檔案讀取較慢時調高)
 *   restore?:          [source URL …]     這題可能被修改的共用物件:作答前讀出、作答後(不論成敗)寫回並比對
 *   restore_verify?:   { object_url, passed }   還原後必須跑出 passed/passed 的基準單元測試
 *   setup:   [{ tool, args, allow_error? }]        事前以 MCP 工具準備;另有兩個特殊步驟:
 *     - { tool: patch, args: { object_url, find, replace, all? } }   找到 find 換成 replace 並啟用(注入 bug);找不到、或不是唯一一處(未設 all)就準備失敗
 *     - { tool: expect_unit_tests, args: { object_url, failed_min? } }   確認單元測試確實失敗(預設至少 1 個),確保注入有效
 *   checks:  判定成功的條件(全部通過才算成功)
 *     - { kind: answer_contains, all?: [], any?: [] }                模型最後回答包含字串(不分大小寫)
 *     - { kind: tool, tool, args, contains?: [], not_contains?: [] }  呼叫 MCP 工具,不得出錯,輸出包含 / 不包含
 *     - { kind: answer_contains_query, sql, column }                 以 data_preview 即時查出正確值,回答要包含每一個
 *     - { kind: unit_tests, object_url, min_passed? }                失敗數 = 0 且通過數 ≥ min_passed(預設 1)
 *     - { kind: source_contains, object_url, contains: [] }          物件原始碼包含字串(不分大小寫)
 *     - { kind: source_not_contains, object_url, not_contains: [] }  物件原始碼不得包含字串
 *     - { kind: atc_max, object_url, max }                           ATC 優先級 1–2 的 finding 數 ≤ max
 *     - { kind: unchanged, object_url }                              作答後原始碼與作答前(事前準備之後)相同
 *   cleanup: [物件 URI…]                                           依序刪除(物件不存在不算失敗)
 * 名稱佔位符 {{SFX}} / {{sfx}}(每次執行不同的 6 碼)在 YAML 解析前以文字取代。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

export interface ToolStep {
  tool: string;
  args: Record<string, unknown>;
  allow_error?: boolean;
}

export type Check =
  | { kind: "answer_contains"; all?: string[]; any?: string[] }
  | { kind: "tool"; tool: string; args: Record<string, unknown>; contains?: string[]; not_contains?: string[] }
  | { kind: "answer_contains_query"; sql: string; column: string }
  | { kind: "unit_tests"; object_url: string; min_passed?: number }
  | { kind: "source_contains"; object_url: string; contains: string[] }
  | { kind: "source_not_contains"; object_url: string; not_contains: string[] }
  | { kind: "atc_max"; object_url: string; max: number }
  | { kind: "unchanged"; object_url: string };

export interface EvalTask {
  id: string;
  title: string;
  prompt: string;
  setup: ToolStep[];
  checks: Check[];
  cleanup: string[];
  file: string;
  tags: string[];
  optIn: boolean;
  allowedPackages?: string[];
  allowProbes: boolean;
  requireToolOrder?: string[];
  timeoutMin?: number;
  budgetUsd?: number;
  toolTimeoutSec?: number;
  restore: string[];
  restoreVerify?: { object_url: string; passed: number };
}

/** 工具呼叫順序檢查:required 的每個工具都要出現過,而且第一次出現的先後符合 required 的順序;回傳問題(沒問題回 undefined) */
export function checkToolOrder(order: string[], required: string[]): string | undefined {
  let last = -1;
  for (const t of required) {
    const i = order.indexOf(t);
    if (i < 0) return `模型沒有呼叫 ${t}(要求的順序:${required.join(" → ")})`;
    if (i < last) return `${t} 出現得太早:要求的順序是 ${required.join(" → ")},實際第一次呼叫順序是 ${required.map((x) => `${x}@${order.indexOf(x) + 1}`).join("、")}`;
    last = i;
  }
  return undefined;
}

/** 名稱佔位符:6 碼英數(大寫版給物件名稱、小寫版給 URI) */
export function makeSuffix(): string {
  return Date.now().toString(36).toUpperCase().slice(-6).padStart(6, "0");
}

export function fillPlaceholders(text: string, sfx: string): string {
  return text.replace(/\{\{SFX\}\}/g, sfx.toUpperCase()).replace(/\{\{sfx\}\}/g, sfx.toLowerCase());
}

function fail(file: string, msg: string): never {
  throw new Error(`任務檔 ${path.basename(file)} 格式錯誤:${msg}`);
}

const isAdtUri = (u: unknown): u is string => typeof u === "string" && u.startsWith("/sap/bc/adt/");
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.length > 0);

/** 解析並驗證一個任務檔的內容 */
export function parseTask(text: string, file: string, sfx: string): EvalTask {
  const raw = parse(fillPlaceholders(text, sfx)) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") fail(file, "不是 YAML 物件");
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v !== "string" || !v.trim()) fail(file, `缺少 ${k}`);
    return v.trim();
  };
  const setup = (raw.setup ?? []) as ToolStep[];
  const checks = (raw.checks ?? []) as Check[];
  const cleanup = (raw.cleanup ?? []) as string[];
  if (!Array.isArray(setup) || !Array.isArray(checks) || !Array.isArray(cleanup)) fail(file, "setup / checks / cleanup 必須是陣列");
  if (checks.length === 0) fail(file, "至少要有一個 check");
  for (const s of setup) {
    if (!s || typeof s.tool !== "string") fail(file, "setup 每一步都要有 tool");
    const a = (s.args ?? {}) as Record<string, unknown>;
    if (s.tool === "patch") {
      if (!isAdtUri(a.object_url)) fail(file, "patch 需要 object_url(/sap/bc/adt/…)");
      if (typeof a.find !== "string" || !a.find) fail(file, "patch 需要 find");
      if (typeof a.replace !== "string") fail(file, "patch 需要 replace");
    } else if (s.tool === "expect_unit_tests") {
      if (!isAdtUri(a.object_url)) fail(file, "expect_unit_tests 需要 object_url(/sap/bc/adt/…)");
    }
  }
  for (const c of checks) {
    if (c.kind === "answer_contains") {
      if (!(c.all?.length || c.any?.length)) fail(file, "answer_contains 需要 all 或 any");
    } else if (c.kind === "tool") {
      if (!c.tool || !(c.contains?.length || c.not_contains?.length)) fail(file, "tool check 需要 tool 與 contains / not_contains");
    } else if (c.kind === "answer_contains_query") {
      if (!c.sql || !c.column) fail(file, "answer_contains_query 需要 sql 與 column");
    } else if (c.kind === "unit_tests") {
      if (!isAdtUri(c.object_url)) fail(file, "unit_tests 需要 object_url");
      if (c.min_passed !== undefined && !(Number.isInteger(c.min_passed) && c.min_passed >= 0)) fail(file, "unit_tests 的 min_passed 必須是非負整數");
    } else if (c.kind === "source_contains") {
      if (!isAdtUri(c.object_url) || !isStrList(c.contains)) fail(file, "source_contains 需要 object_url 與 contains");
    } else if (c.kind === "source_not_contains") {
      if (!isAdtUri(c.object_url) || !isStrList(c.not_contains)) fail(file, "source_not_contains 需要 object_url 與 not_contains");
    } else if (c.kind === "atc_max") {
      if (!isAdtUri(c.object_url) || !(Number.isInteger(c.max) && c.max >= 0)) fail(file, "atc_max 需要 object_url 與非負整數 max");
    } else if (c.kind === "unchanged") {
      if (!isAdtUri(c.object_url)) fail(file, "unchanged 需要 object_url");
    } else {
      fail(file, `未知的 check kind:${(c as { kind?: string }).kind}`);
    }
  }
  for (const u of cleanup) if (typeof u !== "string" || !u.startsWith("/sap/bc/adt/")) fail(file, `cleanup 必須是 ADT URI:${u}`);
  // 清除只允許暫存命名空間,避免任務檔誤刪其他物件
  for (const u of cleanup) if (!/\/(z|y)[^/]*$/i.test(u)) fail(file, `cleanup 只能刪 Z/Y 物件:${u}`);

  const strList = (k: string): string[] | undefined => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (!isStrList(v)) fail(file, `${k} 必須是非空的字串陣列`);
    return v;
  };
  const posNum = (k: string): number | undefined => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !(v > 0)) fail(file, `${k} 必須是正數`);
    return v;
  };
  const restore = strList("restore") ?? [];
  for (const u of restore) if (!isAdtUri(u)) fail(file, `restore 必須是 ADT URI:${u}`);
  let restoreVerify: EvalTask["restoreVerify"];
  if (raw.restore_verify !== undefined) {
    const rv = raw.restore_verify as { object_url?: unknown; passed?: unknown };
    if (!rv || !isAdtUri(rv.object_url) || !(typeof rv.passed === "number" && Number.isInteger(rv.passed) && rv.passed > 0)) {
      fail(file, "restore_verify 需要 object_url 與正整數 passed");
    }
    restoreVerify = { object_url: rv.object_url as string, passed: rv.passed as number };
    if (restore.length === 0) fail(file, "restore_verify 必須搭配 restore");
  }
  return {
    id: str("id"),
    title: str("title"),
    prompt: str("prompt"),
    setup,
    checks,
    cleanup,
    file,
    tags: strList("tags") ?? [],
    optIn: raw.opt_in === true,
    allowedPackages: strList("allowed_packages"),
    allowProbes: raw.allow_probes === true,
    requireToolOrder: strList("require_tool_order"),
    timeoutMin: posNum("timeout_min"),
    budgetUsd: posNum("budget_usd"),
    toolTimeoutSec: posNum("tool_timeout_sec"),
    restore,
    restoreVerify,
  };
}

/** 載入任務目錄下的全部任務(依檔名排序);ids / tags 給定時都要符合(tags 是「任一個符合」) */
export function loadTasks(dir: string, sfx: string, ids?: string[], tags?: string[]): EvalTask[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const tasks = files.map((f) => parseTask(fs.readFileSync(path.join(dir, f), "utf8"), path.join(dir, f), sfx));
  return tasks
    .filter((t) => !ids?.length || ids.includes(t.id))
    .filter((t) => !tags?.length || tags.some((g) => t.tags.includes(g)));
}

/**
 * 預設選取:標了 opt_in 的題組(會動共用物件)沒有明確用 --tags / --tasks 選到就不跑;
 * 明確選取時,已經在 loadTasks 篩過,全部都跑。
 */
export function selectTasks(tasks: EvalTask[], o: { explicit: boolean }): EvalTask[] {
  return o.explicit ? tasks : tasks.filter((t) => !t.optIn);
}
