/**
 * eval/lib/tasks.ts — 評測任務(eval/tasks/*.yaml)的載入與驗證
 *
 * 任務檔欄位:
 *   id / title / prompt
 *   setup:   [{ tool, args, allow_error? }]        事前以 MCP 工具在 $TMP 建立物件
 *   checks:  判定成功的條件(全部通過才算成功)
 *     - { kind: answer_contains, all?: [], any?: [] }                模型最後回答包含字串(不分大小寫)
 *     - { kind: tool, tool, args, contains?: [], not_contains?: [] }  呼叫 MCP 工具,不得出錯,輸出包含 / 不包含
 *     - { kind: answer_contains_query, sql, column }                 以 data_preview 即時查出正確值,回答要包含每一個
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
  | { kind: "answer_contains_query"; sql: string; column: string };

export interface EvalTask {
  id: string;
  title: string;
  prompt: string;
  setup: ToolStep[];
  checks: Check[];
  cleanup: string[];
  file: string;
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
  for (const s of setup) if (!s || typeof s.tool !== "string") fail(file, "setup 每一步都要有 tool");
  for (const c of checks) {
    if (c.kind === "answer_contains") {
      if (!(c.all?.length || c.any?.length)) fail(file, "answer_contains 需要 all 或 any");
    } else if (c.kind === "tool") {
      if (!c.tool || !(c.contains?.length || c.not_contains?.length)) fail(file, "tool check 需要 tool 與 contains / not_contains");
    } else if (c.kind === "answer_contains_query") {
      if (!c.sql || !c.column) fail(file, "answer_contains_query 需要 sql 與 column");
    } else {
      fail(file, `未知的 check kind:${(c as { kind?: string }).kind}`);
    }
  }
  for (const u of cleanup) if (typeof u !== "string" || !u.startsWith("/sap/bc/adt/")) fail(file, `cleanup 必須是 ADT URI:${u}`);
  // 清除只允許暫存命名空間,避免任務檔誤刪其他物件
  for (const u of cleanup) if (!/\/(z|y)[^/]*$/i.test(u)) fail(file, `cleanup 只能刪 Z/Y 物件:${u}`);
  return { id: str("id"), title: str("title"), prompt: str("prompt"), setup, checks, cleanup, file };
}

/** 載入任務目錄下的全部任務(依檔名排序);ids 給定時只載入這些 id */
export function loadTasks(dir: string, sfx: string, ids?: string[]): EvalTask[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const tasks = files.map((f) => parseTask(fs.readFileSync(path.join(dir, f), "utf8"), path.join(dir, f), sfx));
  return ids?.length ? tasks.filter((t) => ids.includes(t.id)) : tasks;
}
