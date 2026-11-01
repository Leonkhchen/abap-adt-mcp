/**
 * tools/formatters.ts — 把 ADT 回傳的結構整理成 AI 好讀的文字
 */
import type { UnitTestAlert, UnitTestClass } from "abap-adt-api";
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
