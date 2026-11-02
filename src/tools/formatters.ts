/**
 * tools/formatters.ts — 把 ADT 回傳的結構整理成 AI 好讀的文字
 */
import type { ClassComponent, QueryResult, UnitTestAlert, UnitTestClass } from "abap-adt-api";
import type { AtcResult } from "../adt/client.js";
import type { UsageObject, UsageSnippet } from "../adt/whereUsed.js";
import { objectNameFromUrl } from "../safety/guards.js";

/** 測試類別名稱前加上所屬物件,例如 ZCL_DEMO / LTC_TEST(package 模式下才分得出來) */
function testClassLabel(c: UnitTestClass): string {
  const owner = objectNameFromUrl((c["adtcore:uri"] ?? "").split("#")[0]);
  return owner ? `${owner} / ${c["adtcore:name"]}` : c["adtcore:name"];
}

/** ADT 位置 URI(…#start=13,0;end=…)→「/…/includes/testclasses 第 13 行」 */
export function describeLocation(uri: string): string {
  const [path, fragment = ""] = uri.split("#");
  const start = fragment.match(/start=(\d+)(?:,(\d+))?/);
  return start ? `${path} 第 ${start[1]} 行` : path;
}

function formatAlert(a: UnitTestAlert, indent: string): string[] {
  const lines = [`${indent}- [${a.severity}] ${a.title}`];
  for (const d of a.details ?? []) {
    // 細節常含換行與 tab(例如 "Different values\n\tExpected [4] Actual [3]")
    lines.push(`${indent}  ${d.replace(/\s*\n\s*/g, " / ")}`);
  }
  const loc = a.stack?.[0]?.["adtcore:uri"];
  if (loc) lines.push(`${indent}  位置:${describeLocation(loc)}`);
  return lines;
}

/** ABAP Unit 結果:摘要 + 每個測試方法的結果、失敗訊息與位置(失敗的排前面) */
export function formatUnitTestResults(classes: UnitTestClass[]): string {
  const methods = classes.flatMap((c) => c.testmethods.map((m) => ({ c, m })));
  if (classes.length === 0 || (methods.length === 0 && classes.every((c) => c.alerts.length === 0))) {
    return "找不到可執行的 ABAP Unit 測試(只執行 RISK LEVEL HARMLESS、DURATION SHORT/MEDIUM 的測試類別)。";
  }
  const failed = methods.filter(({ m }) => m.alerts.length > 0);
  const classAlerts = classes.filter((c) => c.alerts.length > 0);
  const allGreen = failed.length === 0 && classAlerts.length === 0;

  const out: string[] = [
    `${allGreen ? "✅" : "❌"} ABAP Unit:${methods.length} 個測試方法,` +
      `${methods.length - failed.length} 通過,${failed.length} 失敗` +
      (classAlerts.length ? `;${classAlerts.length} 個測試類別本身有錯誤` : ""),
  ];
  for (const c of classAlerts) {
    out.push(`❌ 測試類別 ${testClassLabel(c)}(類別層級錯誤,例如 setup 失敗)`);
    for (const a of c.alerts) out.push(...formatAlert(a, "   "));
  }
  for (const { c, m } of failed) {
    out.push(`❌ ${testClassLabel(c)}->${m["adtcore:name"]}(${m.executionTime} ${m.unit})`);
    for (const a of m.alerts) out.push(...formatAlert(a, "   "));
  }
  for (const { c, m } of methods.filter(({ m }) => m.alerts.length === 0)) {
    out.push(`✅ ${testClassLabel(c)}->${m["adtcore:name"]}(${m.executionTime} ${m.unit})`);
  }
  return out.join("\n");
}

/** where-used 結果:依使用處物件分組列出程式碼行,最多 max 筆 */
export function formatWhereUsed(
  target: string,
  r: { objects: UsageObject[]; snippets: UsageSnippet[] },
  max = 50
): string {
  if (r.objects.length === 0) return `找不到 ${target} 的使用處。`;
  const total = Math.max(r.snippets.length, r.objects.length);
  const out = [`🔎 ${target} 的使用處:共 ${r.snippets.length} 處(${r.objects.length} 個物件)` + (total > max ? `,僅顯示前 ${max} 筆` : "")];
  let shown = 0;
  for (const o of r.objects) {
    if (shown >= max) break;
    out.push(`- ${o.name}${o.type ? ` [${o.type}]` : ""}${o.packageName ? `(package ${o.packageName})` : ""}\n  uri:${o.uri}`);
    const snips = r.snippets.filter((s) => s.objectIdentifier === o.objectIdentifier);
    if (snips.length === 0) shown++;
    for (const s of snips) {
      if (shown >= max) break;
      out.push(`    ${describeLocation(s.uri).replace(/^.* (第 \d+ 行)$/, "$1")}:${s.content}`);
      shown++;
    }
  }
  return out.join("\n");
}

/** class 元件類型 → 中文說明 */
const COMPONENT_LABEL: Record<string, string> = {
  "CLAS/OM": "方法",
  "CLAS/OA": "屬性",
  "CLAS/OT": "型別",
  "CLAS/OE": "事件",
  "CLAS/OR": "實作的介面",
  "CLAS/OK": "常數",
  "CLAS/OCL": "本地類別",
  "CLAS/OLD": "本地類別方法",
  "CLAS/OCX": "文字元素",
  "INTF/IO": "方法",
  "INTF/IA": "屬性",
  "INTF/IT": "型別",
  "INTF/IE": "事件",
};

/**
 * 由元件的 definitionIdentifier 連結取出定義位置:
 * ./source/main#start=4,12 →「第 4 行」;./includes/testclasses#start=3,12 →「testclasses include 第 3 行」
 */
function definitionLocation(c: ClassComponent): string {
  const href = c.links?.find((l) => l.rel.endsWith("/definitionIdentifier"))?.href ?? "";
  const m = href.match(/^\.\/(source\/main|includes\/([^#]+))#start=(\d+)/);
  if (!m) return "";
  return m[2] ? `${m[2]} include 第 ${m[3]} 行` : `第 ${m[3]} 行`;
}

/** class_components 結果:類別資訊 + 元件樹(含可見性、static/instance、定義行號) */
export function formatClassComponents(root: ClassComponent): string {
  const head = [root["adtcore:type"], root.visibility, (root as { final?: boolean }).final ? "final" : ""].filter(Boolean).join(",");
  const out = [`${root["adtcore:name"]}(${head})`];
  const walk = (list: ClassComponent[], indent: string) => {
    for (const c of list) {
      const type = c["adtcore:type"];
      const attrs = [
        COMPONENT_LABEL[type] ?? type,
        c.visibility,
        c.level === "static" ? "static" : c.level === "instance" ? "instance" : "",
        c.constant ? "constant" : "",
        c.readOnly ? "read-only" : "",
      ].filter(Boolean);
      const loc = definitionLocation(c);
      out.push(`${indent}- ${c["adtcore:name"]}(${attrs.join(",")})${loc ? ` 定義於${loc}` : ""}`);
      if (c.components?.length) walk(c.components, indent + "  ");
    }
  };
  walk(root.components ?? [], "");
  if ((root.components ?? []).length === 0) out.push("(沒有任何元件)");
  return out.join("\n");
}

/**
 * Data Preview 結果 → 以 | 分隔的文字表格;每格截斷 maxCell 字元,整體超過 maxTotal 字元時停止並標註。
 * 換行與 | 會被替換,避免破壞表格。
 */
export function formatQueryResult(
  r: QueryResult,
  opts: { maxCell?: number; maxTotal?: number } = {}
): { text: string; rows: number; truncatedRows: boolean } {
  const maxCell = opts.maxCell ?? 200;
  const maxTotal = opts.maxTotal ?? 20_000;
  const cols = r.columns.map((c) => c.name);
  const cell = (v: unknown) => {
    // abap-adt-api 會把 DATS 解成 Date(UTC 午夜);印成 YYYY-MM-DD,不要變成本機時區的長字串
    if (v instanceof Date) {
      const iso = isNaN(v.getTime()) ? "" : v.toISOString();
      v = iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
    }
    const s = v === null || v === undefined ? "" : String(v).replace(/[\r\n]+/g, " ").replace(/\|/g, "¦").trimEnd();
    return s.length > maxCell ? `${s.slice(0, maxCell)}…` : s;
  };
  const lines = [cols.join(" | ")];
  let total = lines[0].length;
  let shown = 0;
  for (const row of r.values) {
    const line = cols.map((c) => cell((row as Record<string, unknown>)[c])).join(" | ");
    if (total + line.length + 1 > maxTotal) break;
    lines.push(line);
    total += line.length + 1;
    shown++;
  }
  return { text: lines.join("\n"), rows: shown, truncatedRows: shown < r.values.length };
}

/** ATC 優先級說明(1 最嚴重) */
const PRIORITY_LABEL: Record<number, string> = { 1: "優先級 1(錯誤)", 2: "優先級 2(警告)", 3: "優先級 3(資訊)" };

/** ATC 結果:依優先級分組,最多顯示 max 筆;附上執行資訊(例如部分檢查無法執行) */
export function formatAtcResult(r: AtcResult, max = 100): string {
  const out: string[] = [];
  const shown = [...r.findings].sort((a, b) => a.priority - b.priority).slice(0, max);
  const errors = r.findings.filter((f) => f.priority === 1).length;
  out.push(
    r.findings.length === 0
      ? `✅ ATC(check variant ${r.checkVariant}):沒有任何 finding。`
      : `${errors > 0 ? "❌" : "⚠️"} ATC(check variant ${r.checkVariant}):共 ${r.findings.length} 筆 finding` +
          `(優先級 1:${errors} 筆)` +
          (r.findings.length > max ? `,僅顯示前 ${max} 筆` : "")
  );
  for (const p of [...new Set(shown.map((f) => f.priority))]) {
    out.push(`\n## ${PRIORITY_LABEL[p] ?? `優先級 ${p}`}`);
    for (const f of shown.filter((x) => x.priority === p)) {
      // ATC 的位置 URI 不一定帶 #start,行號另在 range 裡
      const loc = f.location.includes("#start=") || !f.line ? describeLocation(f.location) : `${f.location} 第 ${f.line} 行`;
      out.push(`- ${f.objectName}:${f.messageTitle}(檢查:${f.checkTitle})\n  位置:${loc}`);
    }
  }
  const notes = r.infos.filter((i) => i.type !== "FINDING_STATS");
  if (notes.length > 0) {
    out.push(`\nℹ️ ATC 執行資訊:`);
    for (const i of notes) out.push(`- ${i.type}:${i.description}`);
  }
  return out.join("\n");
}
