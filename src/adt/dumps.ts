/**
 * adt/dumps.ts — ST22 短傾印(runtime dump)的解析
 *
 * A4H 實測的形狀:
 *  - 列表:/sap/bc/adt/runtime/dumps(atom feed);每筆的 self 連結是 /sap/bc/adt/runtime/dump/<id>,
 *    id 開頭為 UTC 時間戳 YYYYMMDDhhmmss;分類含「ABAP runtime error」(錯誤類型)與「Terminated ABAP program」
 *  - 單筆:self 連結(Accept application/vnd.sap.adt.runtime.dump.v1+xml)回 metadata、章節清單與連結;
 *    contents 連結(…/formatted,text/plain)是完整文字,常超過 1 MB(含變數內容、記憶體資訊)
 *  - termination 連結(adt://<SID>/…/source/main#start=9)是以 source/main 為準的出錯行號;
 *    文字內容裡的行號是相對於方法 include(例如 CM001 的第 3 行),不能直接拿來改 source/main
 */
import type { Dump } from "abap-adt-api";

export interface DumpSummary {
  /** dump_detail 用的 id(self 連結的路徑) */
  id: string;
  /** UTC ISO 時間;無法解析時為空字串 */
  datetime: string;
  error: string;
  program: string;
  user: string;
}

export interface DumpMeta {
  title: string;
  error: string;
  exception: string;
  program: string;
  datetime: string;
  author: string;
  /** 完整文字內容(…/formatted)的路徑 */
  contentsUri: string;
  /** 以 source/main 為準的出錯位置 */
  termination?: { uri: string; line: number };
  chapters: { title: string; line: number }[];
}

/** dump_detail 預設擷取的章節(除錯需要的部分) */
export const DUMP_CHAPTERS = [
  "Short Text",
  "What happened?",
  "Error analysis",
  "How to correct the error",
  "Chain of Exception Objects",
  "Information on where terminated",
  "Source Code Extract",
  "Active Calls/Events",
];

const DUMP_PATH = "/sap/bc/adt/runtime/dump/";

/** adt://A4H/sap/bc/… → /sap/bc/… */
function stripAdtScheme(uri: string): string {
  return uri.replace(/^adt:\/\/[^/]+/, "");
}

/** 由 dump id 的時間戳(UTC YYYYMMDDhhmmss)取得時間 */
export function dumpTime(id: string): Date | undefined {
  const m = id.match(/\/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return isNaN(t.getTime()) ? undefined : t;
}

export function summarizeDump(d: Dump): DumpSummary {
  const self = d.links.find((l) => l.rel === "self")?.href ?? d.id;
  const id = stripAdtScheme(self);
  const t = dumpTime(id);
  return {
    id,
    datetime: t ? t.toISOString().replace(".000Z", "Z") : "",
    error: d.categories.find((c) => c.label === "ABAP runtime error")?.term ?? "",
    program: d.categories.find((c) => c.label === "Terminated ABAP program")?.term ?? "",
    user: d.author ?? "",
  };
}

/** 檢查並正規化 dump_detail 的 id:只接受 /sap/bc/adt/runtime/dump/… 路徑 */
export function normalizeDumpId(id: string): string {
  const p = stripAdtScheme(id.trim());
  if (!p.startsWith(DUMP_PATH) || p.length <= DUMP_PATH.length || /\s|\.\.|[?#]/.test(p)) {
    throw new Error(`dump_id 格式不正確:必須是 list_dumps 回傳的 ${DUMP_PATH}… 路徑。`);
  }
  return p;
}

function attr(xml: string, name: string): string {
  return decode(xml.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? "");
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function parseDumpMeta(xml: string): DumpMeta {
  const root = xml.match(/<dump:dump\b[^>]*>/)?.[0] ?? "";
  const link = (rel: RegExp) => {
    for (const m of xml.matchAll(/<dump:link\b[^>]*\/?>/g)) {
      if (rel.test(attr(m[0], "relation"))) return attr(m[0], "uri");
    }
    return "";
  };
  const term = link(/\/termination$/);
  const termMatch = term.match(/^(.*)#start=(\d+)/);
  const chapters = [...xml.matchAll(/<dump:chapter\b[^>]*\/?>/g)]
    .map((m) => ({ title: attr(m[0], "title"), line: Number(attr(m[0], "line")) }))
    .filter((c) => c.title && c.line > 0)
    .sort((a, b) => a.line - b.line);
  return {
    title: attr(root, "title"),
    error: attr(root, "error"),
    exception: attr(root, "exception"),
    program: attr(root, "terminatedProgram"),
    datetime: attr(root, "datetime"),
    author: attr(root, "author"),
    contentsUri: stripAdtScheme(link(/^contents$/)),
    termination: termMatch ? { uri: stripAdtScheme(termMatch[1]), line: Number(termMatch[2]) } : undefined,
    chapters,
  };
}

/**
 * 依章節清單從完整文字擷取指定章節(章節的 line 是該框「|標題」那一行,1 起算)。
 * 開頭的摘要(Category、Runtime Errors、Program…)一律保留;每章最多 maxPerChapter 字元。
 */
export function extractDumpChapters(
  text: string,
  chapters: { title: string; line: number }[],
  wanted: string[] = DUMP_CHAPTERS,
  maxPerChapter = 4_000
): string {
  const lines = text.split(/\r?\n/);
  const clean = (ls: string[]) =>
    ls
      .map((l) => l.replace(/^\|/, "").replace(/\|\s*$/, "").trimEnd())
      .filter((l) => !/^-{10,}$/.test(l.trim()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const out: string[] = [];
  const first = chapters[0]?.line ?? lines.length + 1;
  out.push(clean(lines.slice(0, Math.max(0, first - 2))));
  chapters.forEach((c, i) => {
    if (!wanted.includes(c.title)) return;
    const end = (chapters[i + 1]?.line ?? lines.length + 1) - 2;
    let body = clean(lines.slice(c.line - 1, Math.max(c.line, end)));
    if (body.length > maxPerChapter) body = `${body.slice(0, maxPerChapter)}\n…(本章已截斷)`;
    out.push(`## ${body}`);
  });
  return out.filter(Boolean).join("\n\n");
}
