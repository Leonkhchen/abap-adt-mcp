/**
 * 評測框架的單元測試(不需要 SAP、不呼叫模型)
 */
import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fillPlaceholders, loadTasks, parseTask } from "../../eval/lib/tasks.js";
import { parseStreamJson, writeMcpConfig } from "../../eval/lib/claude.js";
import { parseArgs } from "../../eval/lib/args.js";
import { ADAPTERS, parseModelSpecs } from "../../eval/lib/adapters.js";
import { CSV_HEADER, renderCsv, renderMarkdown, writeReports, type TaskResult } from "../../eval/lib/report.js";
import { bindingNameFromUri, deleteWithLock, unpublishBody } from "../../eval/lib/harness.js";
import { formatUnitTestResults } from "../../src/tools/formatters.js";
import * as os from "node:os";

const TASK_DIR = path.resolve("eval/tasks");

describe("評測執行器(F2)", () => {
  it("參數解析嚴格:--help / -h 只顯示說明;未知選項、缺值、非正數都報錯", () => {
    expect(parseArgs(["--help"]).flags.has("help")).toBe(true);
    expect(parseArgs(["-h"]).flags.has("help")).toBe(true);
    const p = parseArgs(["--model", "haiku", "--tasks", "01,07", "--dry-run", "--budget", "1.5"]);
    expect(p.values.get("model")).toBe("haiku");
    expect(p.values.get("tasks")).toBe("01,07");
    expect(p.flags.has("dry-run")).toBe(true);
    expect(() => parseArgs(["--modle", "haiku"])).toThrow(/未知的參數/);
    expect(() => parseArgs(["sonnet"])).toThrow(/未知的參數/);
    expect(() => parseArgs(["--model"])).toThrow(/需要一個值/);
    expect(() => parseArgs(["--model", "--dry-run"])).toThrow(/需要一個值/);
    expect(() => parseArgs(["--budget", "0"])).toThrow(/正數/);
  });

  it("解析 stream-json:回答、回合、耗時、費用;工具呼叫依名稱計數且不算 ToolSearch", () => {
    const lines = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "ToolSearch" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }, { type: "tool_use", name: "mcp__abap-a4h__read_source" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__abap-a4h__read_source" }, { type: "tool_use", name: "mcp__abap-a4h__run_class" }] } }),
      "not json",
      JSON.stringify({ type: "result", subtype: "success", result: "答案 42", num_turns: 5, duration_ms: 12345, total_cost_usd: 0.1234 }),
    ];
    expect(parseStreamJson("\uFEFF" + lines.join("\n"))).toEqual({
      status: "success",
      answer: "答案 42",
      turns: 5,
      durationMs: 12345,
      costUsd: 0.1234,
      toolCalls: 3,
      toolCallsByName: { read_source: 2, run_class: 1 },
      toolOrder: ["read_source", "read_source", "run_class"],
    });
    expect(parseStreamJson("").status).toBe("no_result");
  });

  it("臨時 MCP 設定檔:只有 abap-a4h,密碼以 ${SAP_PASSWORD} 展開、不寫入檔案", () => {
    const file = writeMcpConfig("C:\\repo", { SAP_URL: "http://localhost:50000", SAP_PASSWORD: "TOP-SECRET" });
    try {
      const text = fs.readFileSync(file, "utf8");
      expect(text).not.toContain("TOP-SECRET");
      const cfg = JSON.parse(text);
      expect(Object.keys(cfg.mcpServers)).toEqual(["abap-a4h"]);
      expect(cfg.mcpServers["abap-a4h"].env.SAP_PASSWORD).toBe("${SAP_PASSWORD}");
      expect(cfg.mcpServers["abap-a4h"].args[0]).toBe("C:/repo/dist/index.js");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("轉接器(F3)", () => {
  it("--model 逗號清單:預設 claude;未實作的 codex/gemini、未知 agent、重複都在連 SAP 前報錯", () => {
    expect(parseModelSpecs("opus, sonnet,haiku").map((s) => [s.adapter, s.model, s.label])).toEqual([
      ["claude", "opus", "opus"],
      ["claude", "sonnet", "sonnet"],
      ["claude", "haiku", "haiku"],
    ]);
    expect(parseModelSpecs("claude:claude-sonnet-5-5")[0]).toEqual({ adapter: "claude", model: "claude-sonnet-5-5", label: "claude-sonnet-5-5" });
    expect(() => parseModelSpecs("codex:gpt-5")).toThrow(/本版不實作/);
    expect(() => parseModelSpecs("gemini:pro")).toThrow(/本版不實作/);
    expect(() => parseModelSpecs("llama:x")).toThrow(/未知的 agent/);
    expect(() => parseModelSpecs("sonnet,sonnet")).toThrow(/重複/);
    expect(() => parseModelSpecs(" , ")).toThrow(/至少/);
    expect(() => parseModelSpecs("rm -rf")).toThrow(/格式錯誤/);
  });

  it("介面:claude 已實作,codex/gemini 只有介面、呼叫即拒絕", async () => {
    expect(ADAPTERS.claude.implemented).toBe(true);
    for (const id of ["codex", "gemini"] as const) {
      expect(ADAPTERS[id].implemented).toBe(false);
      await expect(ADAPTERS[id].run({} as never)).rejects.toThrow(/本版不實作/);
    }
  });

  it("--matrix 是旗標", () => {
    expect(parseArgs(["--model", "opus,haiku", "--matrix"]).flags.has("matrix")).toBe(true);
  });
});

describe("報表(F4)", () => {
  const mk = (task: string, model: string, passed: boolean, cost: number, extra: Partial<TaskResult> = {}): TaskResult => ({
    task,
    title: `題目${task}`,
    model,
    passed,
    details: passed ? [] : ["找不到 X"],
    cleanup: [],
    suffix: "AB12CD",
    run: { status: "success", turns: 4, durationMs: 30_400, costUsd: cost, toolCalls: 3, toolCallsByName: {}, timedOut: false, logFile: "x", answerPreview: "" },
    ...extra,
  });
  const input = {
    startedAt: new Date("2026-11-03T12:00:00Z"),
    stamp: "2026-11-03T12-00-00",
    dryRun: false,
    models: ["sonnet", "haiku"],
    results: [mk("01", "sonnet", true, 0.1), mk("02", "sonnet", false, 0.2), mk("01", "haiku", true, 0.01), mk("02", "haiku", true, 0.02, { cleanup: ["❌ 刪除失敗 /x"] })],
  };

  it("Markdown:題目 × 模型格子、總計列、失敗與清除問題區", () => {
    const md = renderMarkdown(input);
    expect(md).toContain("| 題目 | sonnet | haiku |");
    expect(md).toContain("| 01 題目01 | ✅ 4 回合 · 30s · $0.1000 · 3 工具 | ✅ 4 回合 · 30s · $0.0100 · 3 工具 |");
    expect(md).toContain("| **總計** | **1/2** · 8 回合 · 60s · **$0.3000** · 6 工具 | **2/2** · 8 回合 · 60s · **$0.0300** · 6 工具 |");
    expect(md).toContain("總費用 $0.3300");
    expect(md).toContain("### 02 × sonnet");
    expect(md).toContain("- 找不到 X");
    expect(md).toContain("### 02 × haiku");
    expect(md).toContain("❌ 刪除失敗 /x");
    expect(md).not.toContain("### 01 ×");
  });

  it("CSV:BOM、每題一列、每個模型一列 TOTAL;含逗號的欄位加引號", () => {
    const csv = renderCsv({ ...input, results: [...input.results, mk("03", "haiku", false, 0, { title: "a,b", run: undefined, setupError: "建立失敗" })] });
    expect(csv.startsWith("﻿" + CSV_HEADER.join(","))).toBe(true);
    const rows = csv.trim().split("\r\n");
    expect(rows).toHaveLength(1 + 5 + 2);
    expect(rows).toContain('03,"a,b",haiku,false,,0,,,,,建立失敗');
    expect(rows.at(-2)).toBe("TOTAL,1/2 passed,sonnet,false,8,60,0.3000,6,,,");
    expect(rows.at(-1)).toBe("TOTAL,2/3 passed,haiku,false,8,60,0.0300,6,,,");
  });

  it("同一天重跑不覆蓋:檔名依序加 -2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-report-"));
    try {
      const a = writeReports(dir, input);
      const b = writeReports(dir, { ...input, stamp: "2026-11-03T13-00-00" });
      expect(path.basename(a[0])).toMatch(/^2026-11-0[34]\.md$/);
      expect(path.basename(b[0])).toMatch(/^2026-11-0[34]-2\.md$/);
      expect(fs.readFileSync(a[2], "utf8")).toContain('"model": "sonnet"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("評測任務集(F1)", () => {
  it("8 題都能解析,id 01–08 不重複,每題都有判定條件", () => {
    const tasks = selectTasks(loadTasks(TASK_DIR, "AB12CD"), { explicit: false }); // ZINV 題組是 opt_in,預設不選
    expect(tasks.map((t) => t.id)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
    for (const t of tasks) {
      expect(t.prompt.length).toBeGreaterThan(10);
      expect(t.checks.length).toBeGreaterThan(0);
    }
  });

  it("ZINV 題組:9 題(zinv-01–09)都是 opt_in、限 $ZINV、有還原與基準測試;只有 zinv-09 開探針並要求先探針後寫入", () => {
    const z = loadTasks(TASK_DIR, "AB12CD", undefined, ["zinv"]);
    expect(z.map((t) => t.id)).toEqual(["zinv-01", "zinv-02", "zinv-03", "zinv-04", "zinv-05", "zinv-06", "zinv-07", "zinv-08", "zinv-09"]);
    for (const t of z) {
      expect(t.optIn, t.id).toBe(true);
      expect(t.allowedPackages, t.id).toEqual(["$ZINV"]);
      expect(t.restore.length, t.id).toBeGreaterThanOrEqual(2);
      expect(t.restoreVerify?.passed, t.id).toBe(36);
      expect(t.allowProbes, t.id).toBe(t.id === "zinv-09");
    }
    expect(z.find((t) => t.id === "zinv-09")!.requireToolOrder).toEqual(["probe_set", "write_source"]);
    expect(z.find((t) => t.id === "zinv-05")!.restore).toContain("/sap/bc/adt/oo/classes/zcl_inv_period/source/main");
    // 預設(沒有明確選取)不會跑 ZINV
    expect(selectTasks(loadTasks(TASK_DIR, "AB12CD"), { explicit: false }).some((t) => t.id.startsWith("zinv"))).toBe(false);
  });

  it("佔位符在解析前取代:物件名稱大寫、URI 小寫;不殘留 {{", () => {
    const tasks = selectTasks(loadTasks(TASK_DIR, "ab12cd"), { explicit: false });
    const t02 = tasks.find((t) => t.id === "02")!;
    expect(t02.prompt).toContain("ZCL_EVAL02_AB12CD");
    expect(t02.setup[0].args.name).toBe("ZCL_EVAL02_AB12CD");
    expect(t02.setup[1].args.object_url).toBe("/sap/bc/adt/oo/classes/zcl_eval02_ab12cd");
    expect(t02.cleanup).toEqual(["/sap/bc/adt/oo/classes/zcl_eval02_ab12cd"]);
    for (const t of tasks) expect(JSON.stringify(t)).not.toContain("{{");
  });

  it("有事前建立物件的題目都有清除;清除只允許 Z/Y 物件;RAP 題清除順序由外而內", () => {
    const tasks = loadTasks(TASK_DIR, "AB12CD");
    for (const t of tasks) {
      const creates = t.setup.filter((s) => s.tool === "create_object").length;
      if (creates > 0) expect(t.cleanup.length).toBeGreaterThanOrEqual(creates);
    }
    const rap = tasks.find((t) => t.id === "06")!;
    expect(rap.cleanup[0]).toContain("/businessservices/bindings/");
    expect(rap.cleanup[1]).toContain("/ddic/srvd/");
    expect(rap.cleanup.at(-1)).toBe("/sap/bc/adt/ddic/tables/zev6_ab12cd");
    expect(() =>
      parseTask("id: x\ntitle: t\nprompt: p\nchecks: [{kind: answer_contains, all: [a]}]\ncleanup: [/sap/bc/adt/oo/classes/cl_std]", "bad.yaml", "X")
    ).toThrow(/只能刪 Z\/Y/);
  });

  it("格式錯誤會被擋下", () => {
    expect(() => parseTask("id: x\ntitle: t\nprompt: p\nchecks: []", "a.yaml", "X")).toThrow(/至少要有一個 check/);
    expect(() => parseTask("id: x\ntitle: t\nprompt: p\nchecks: [{kind: magic}]", "a.yaml", "X")).toThrow(/未知的 check/);
    expect(fillPlaceholders("A_{{SFX}} a_{{sfx}}", "Ab1")).toBe("A_AB1 a_ab1");
  });
});

describe("評測清除:service binding 先取消發布", () => {
  it("只有 binding URI 會取出名稱(大寫),其他物件不處理", () => {
    expect(bindingNameFromUri("/sap/bc/adt/businessservices/bindings/zui_ev6_ab12cd_o4")).toBe("ZUI_EV6_AB12CD_O4");
    expect(bindingNameFromUri("/sap/bc/adt/ddic/srvd/sources/zui_ev6_ab12cd_o4")).toBeUndefined();
    expect(bindingNameFromUri("/sap/bc/adt/oo/classes/zcl_x")).toBeUndefined();
  });
  it("unpublish 本文含 SCGR 類型與大寫名稱", () => {
    const b = unpublishBody("zui_ev6_ab12cd_o4");
    expect(b).toContain('adtcore:type="SCGR"');
    expect(b).toContain('adtcore:name="ZUI_EV6_AB12CD_O4"');
  });
});

describe("第 03 題判定字串對得上 run_unit_tests 的實際輸出", () => {
  const t03 = loadTasks(TASK_DIR, "ab12cd").find((t) => t.id === "03")!;
  const check = t03.checks.find((c) => c.kind === "tool" && c.tool === "run_unit_tests") as { contains: string[] };
  const cls = (alerts: unknown[]) =>
    [{ testmethods: [{ alerts: [] }, { alerts }], alerts: [], uri: "u", type: "t", name: "LTC", durationCategory: "", riskLevel: "" }] as never;
  it("全綠通過;有失敗(含 10 失敗之類)不通過", () => {
    const green = formatUnitTestResults(cls([]));
    expect(check.contains.every((s) => green.includes(s)), green).toBe(true);
    const red = formatUnitTestResults(cls([{ kind: "failedAssertion", severity: "critical", title: "x", details: [] }]));
    expect(check.contains.every((s) => red.includes(s)), red).toBe(false);
  });
});

// ───────────────────────── v0.5.1 E1:刪除失敗也要解鎖(R5)─────────────────────────

describe("E1 deleteWithLock", () => {
  const URI = "/sap/bc/adt/oo/classes/zsafe_demo";
  const raw = (o: Partial<Record<"lock" | "unLock" | "deleteObject", () => Promise<unknown>>> = {}) => ({
    stateful: "stateless" as never,
    lock: vi.fn(o.lock ?? (async () => ({ LOCK_HANDLE: "LH-1" }))),
    unLock: vi.fn(o.unLock ?? (async () => undefined)),
    deleteObject: vi.fn(o.deleteObject ?? (async () => undefined)),
    dropSession: vi.fn(async () => undefined),
  });

  it("lock 成功、delete 失敗 → 送出 unLock,並回報刪除錯誤", async () => {
    const r = raw({ deleteObject: async () => { throw new Error("object has dependencies"); } });
    const out = await deleteWithLock(r, URI);
    expect(r.unLock).toHaveBeenCalledWith(URI, "LH-1");
    expect(out).toContain("刪除失敗");
    expect(out).toContain("object has dependencies");
    expect(r.stateful).toBe("stateless");
    expect(r.dropSession).toHaveBeenCalledTimes(1); // C0-10:失敗路徑也通知 SAP 結束 session
  });

  it("C0-10:刪除成功 → 也 dropSession 一次;lock 失敗 → 同樣收尾", async () => {
    const ok = raw();
    await deleteWithLock(ok, URI);
    expect(ok.dropSession).toHaveBeenCalledTimes(1);
    expect(ok.stateful).toBe("stateless");
    const bad = raw({ lock: async () => { throw new Error("locked by OTHER"); } });
    await deleteWithLock(bad, URI);
    expect(bad.dropSession).toHaveBeenCalledTimes(1);
  });

  it("lock 本身失敗 → 不呼叫 unLock", async () => {
    const r = raw({ lock: async () => { throw new Error("locked by OTHER"); } });
    const out = await deleteWithLock(r, URI);
    expect(r.unLock).not.toHaveBeenCalled();
    expect(out).toContain("locked by OTHER");
    expect(r.stateful).toBe("stateless");
  });

  it("delete 失敗且解鎖也失敗 → 兩個錯誤都回報", async () => {
    const r = raw({
      deleteObject: async () => { throw new Error("object has dependencies"); },
      unLock: async () => { throw new Error("unlock boom"); },
    });
    const out = await deleteWithLock(r, URI);
    expect(out).toContain("object has dependencies");
    expect(out).toContain("unlock boom");
  });

  it("刪除成功後解鎖回 not locked → 忽略;其他解鎖錯誤附註但仍算刪除成功", async () => {
    const a = raw({ unLock: async () => { throw new Error("Object is not locked"); } });
    expect(await deleteWithLock(a, URI)).toBe(`已刪除 ${URI}`);
    const b = raw({ unLock: async () => { throw new Error("unlock boom"); } });
    const out = await deleteWithLock(b, URI);
    expect(out).toContain("已刪除");
    expect(out).toContain("unlock boom");
    expect(out.startsWith("❌")).toBe(true); // 鎖可能殘留 → 報表要看見
  });

  it("C0-3:刪除回「不存在」但解鎖失敗 → 不吞掉解鎖錯誤(❌ 開頭)", async () => {
    const r = raw({
      deleteObject: async () => { throw new Error("Resource does not exist (404)"); },
      unLock: async () => { throw new Error("unlock boom"); },
    });
    const out = await deleteWithLock(r, URI);
    expect(out.startsWith("❌")).toBe(true);
    expect(out).toContain("unlock boom");
    expect(out).toContain("不存在");
  });

  it("C0-3:刪除失敗且解鎖也失敗 → 原本的刪除錯誤仍在最前面,沒被蓋掉", async () => {
    const r = raw({
      deleteObject: async () => { throw new Error("object has dependencies"); },
      unLock: async () => { throw new Error("unlock boom"); },
    });
    const out = await deleteWithLock(r, URI);
    expect(out.indexOf("object has dependencies")).toBeGreaterThan(-1);
    expect(out.indexOf("object has dependencies")).toBeLessThan(out.indexOf("unlock boom"));
  });

  it("物件不存在 → 略過;仍會解鎖(若有 handle)", async () => {
    const r = raw({ lock: async () => { throw new Error("Resource does not exist"); } });
    expect(await deleteWithLock(r, URI)).toContain("不存在(略過)");
  });
});

// ───────────────────────── v0.6 Z1:評測框架擴充(還原、注入、新判定、--tags)─────────────────────────

import { applyPatch, checkUnitTests, normalizeSource, parseUnitCounts, restoreSources, sameSource } from "../../eval/lib/baseline.js";
import { selectTasks } from "../../eval/lib/tasks.js";
import { baselineWarning } from "../../eval/lib/report.js";
import { evalEnv } from "../../eval/lib/harness.js";

const MIN_TASK = `id: "z1"
title: t
prompt: p
checks:
  - kind: answer_contains
    all: [x]
`;

describe("Z1-2 applyPatch(注入)", () => {
  it("唯一一處 → 取代;找不到 → count 0 且原樣回傳", () => {
    const src = "a = b - c.\nd = e.";
    const p = applyPatch(src, "b - c", "b + c");
    expect(p.count).toBe(1);
    expect(p.source).toBe("a = b + c.\nd = e.");
    const none = applyPatch(src, "zzz", "y");
    expect(none.count).toBe(0);
    expect(none.source).toBe(src);
  });
  it("出現多次:count 如實回報;all=false 只換第一處、all=true 全換", () => {
    const src = "x. x. x.";
    expect(applyPatch(src, "x.", "y.").count).toBe(3);
    expect(applyPatch(src, "x.", "y.").source).toBe("y. x. x.");
    expect(applyPatch(src, "x.", "y.", true).source).toBe("y. y. y.");
  });
  it("行尾 CRLF 與 LF 不影響比對;多行片段也能找到", () => {
    const sap = "IF a = 1.\r\n  b = 2.\r\nENDIF.\r\n";
    const p = applyPatch(sap, "IF a = 1.\n  b = 2.", "IF a = 1.\n  b = 3.");
    expect(p.count).toBe(1);
    expect(normalizeSource(p.source)).toBe("IF a = 1.\n  b = 3.\nENDIF.");
  });
  it("空的 find 不做事;replace 內含 $& 之類不被當成特殊樣式", () => {
    expect(applyPatch("abc", "", "x").count).toBe(0);
    expect(applyPatch("abc", "b", "$&$&").source).toBe("a$&$&c");
  });
});

describe("Z1-3 單元測試輸出的解析與判定", () => {
  const out = (m: number, p: number, f: number, extra = "") => `${f ? "❌" : "✅"} ABAP Unit:${m} 個測試方法,${p} 通過,${f} 失敗${extra}\n✅ x`;
  it("parseUnitCounts 取出 N / 通過 / 失敗 / 類別錯誤", () => {
    expect(parseUnitCounts(out(36, 36, 0))).toEqual({ methods: 36, passed: 36, failed: 0, classErrors: 0 });
    expect(parseUnitCounts(out(37, 36, 1, ";2 個測試類別本身有錯誤"))).toEqual({ methods: 37, passed: 36, failed: 1, classErrors: 2 });
    expect(parseUnitCounts("找不到可執行的 ABAP Unit 測試")).toBeUndefined();
  });
  it("checkUnitTests:失敗 0 且通過數 ≥ N 才算過", () => {
    expect(checkUnitTests(out(37, 37, 0), 37)).toBeUndefined();
    expect(checkUnitTests(out(36, 36, 0), 37)).toContain("少於要求的 37");
    expect(checkUnitTests(out(36, 35, 1), 1)).toContain("1 個失敗");
    expect(checkUnitTests(out(1, 1, 0, ";1 個測試類別本身有錯誤"), 1)).toContain("類別本身有錯誤");
    expect(checkUnitTests("找不到可執行的 ABAP Unit 測試", 1)).toContain("找不到測試結果");
  });
});

describe("Z1-1 restoreSources(還原流程)", () => {
  const URL_A = "/sap/bc/adt/oo/classes/zcl_a/source/main";
  const URL_B = "/sap/bc/adt/oo/classes/zcl_a/includes/testclasses";
  const ok36 = "✅ ABAP Unit:36 個測試方法,36 通過,0 失敗";

  /** 假系統:store 是目前內容;write 會更新(可指定失敗或寫壞) */
  function fakeSystem(initial: Record<string, string>, o: { failWrite?: string[]; corruptWrite?: string[]; tests?: string } = {}) {
    const store = new Map(Object.entries(initial));
    const deps = {
      read: vi.fn(async (u: string) => store.get(u) ?? ""),
      write: vi.fn(async (u: string, src: string) => {
        if (o.failWrite?.includes(u)) throw new Error("write boom");
        store.set(u, o.corruptWrite?.includes(u) ? src + "\n* corrupted" : src);
      }),
      runUnitTests: vi.fn(async () => o.tests ?? ok36),
    };
    return { store, deps };
  }

  it("成功:被改過的物件寫回、比對一致、基準測試 36/36 → 沒有問題", async () => {
    const { store, deps } = fakeSystem({ [URL_A]: "MODIFIED", [URL_B]: "ORIGINAL B" });
    const originals = new Map([[URL_A, "ORIGINAL A"], [URL_B, "ORIGINAL B"]]);
    const problems = await restoreSources(deps, originals, { object_url: "/sap/bc/adt/oo/classes/zcl_a", passed: 36 });
    expect(problems).toEqual([]);
    expect(store.get(URL_A)).toBe("ORIGINAL A");
    expect(deps.write).toHaveBeenCalledTimes(1); // B 沒被改,不重寫
    expect(deps.write).toHaveBeenCalledWith(URL_A, "ORIGINAL A");
    expect(deps.runUnitTests).toHaveBeenCalledTimes(1);
  });

  it("行尾不同不算被改(SAP 回 CRLF、基準是 LF)→ 不寫", async () => {
    const { deps } = fakeSystem({ [URL_A]: "line1\r\nline2\r\n" });
    const problems = await restoreSources(deps, new Map([[URL_A, "line1\nline2"]]));
    expect(problems).toEqual([]);
    expect(deps.write).not.toHaveBeenCalled();
  });

  it("寫回失敗 → 回報問題,但其他物件仍會還原、基準測試仍會跑", async () => {
    const { store, deps } = fakeSystem({ [URL_A]: "MOD A", [URL_B]: "MOD B" }, { failWrite: [URL_A] });
    const problems = await restoreSources(deps, new Map([[URL_A, "ORIG A"], [URL_B, "ORIG B"]]), { object_url: "/x", passed: 36 });
    expect(problems.some((p) => p.includes(URL_A) && p.includes("write boom"))).toBe(true);
    expect(store.get(URL_B)).toBe("ORIG B");
    expect(deps.runUnitTests).toHaveBeenCalledTimes(1);
  });

  it("寫回後比對不一致 → 回報", async () => {
    const { deps } = fakeSystem({ [URL_A]: "MOD" }, { corruptWrite: [URL_A] });
    const problems = await restoreSources(deps, new Map([[URL_A, "ORIG"]]));
    expect(problems).toEqual([expect.stringContaining("不一致")]);
  });

  it("基準測試不是 36/36(35 通過 1 失敗、或只有 35 個方法)→ 回報", async () => {
    const orig = new Map([[URL_A, "A"]]);
    const verify = { object_url: "/x", passed: 36 };
    const failing = await restoreSources(fakeSystem({ [URL_A]: "A" }, { tests: "❌ ABAP Unit:36 個測試方法,35 通過,1 失敗" }).deps, orig, verify);
    expect(failing).toEqual([expect.stringContaining("應為 36/36")]);
    const fewer = await restoreSources(fakeSystem({ [URL_A]: "A" }, { tests: "✅ ABAP Unit:35 個測試方法,35 通過,0 失敗" }).deps, orig, verify);
    expect(fewer).toEqual([expect.stringContaining("應為 36/36")]);
    const none = await restoreSources(fakeSystem({ [URL_A]: "A" }, { tests: "找不到可執行的 ABAP Unit 測試" }).deps, orig, verify);
    expect(none).toEqual([expect.stringContaining("找不到測試結果")]);
  });

  it("基準測試無法執行(丟例外)→ 回報,不丟出去", async () => {
    const { deps } = fakeSystem({ [URL_A]: "A" });
    deps.runUnitTests.mockRejectedValueOnce(new Error("503"));
    const problems = await restoreSources(deps, new Map([[URL_A, "A"]]), { object_url: "/x", passed: 36 });
    expect(problems).toEqual([expect.stringContaining("無法執行")]);
  });

  it("沒有 originals(不是還原題)→ 什麼都不做", async () => {
    const { deps } = fakeSystem({});
    expect(await restoreSources(deps, new Map())).toEqual([]);
    expect(deps.read).not.toHaveBeenCalled();
  });

  it("sameSource 忽略行尾與結尾空白", () => {
    expect(sameSource("a\r\nb\r\n", "a\nb")).toBe(true);
    expect(sameSource("a\nb", "a\nc")).toBe(false);
  });
});

describe("Z1 任務檔新欄位與驗證", () => {
  it("tags / opt_in / allowed_packages / 逾時 / restore / restore_verify 都能解析", () => {
    const t = parseTask(
      `${MIN_TASK}tags: [zinv, legacy]
opt_in: true
allowed_packages: ["$ZINV"]
timeout_min: 30
budget_usd: 4
tool_timeout_sec: 240
restore: [/sap/bc/adt/oo/classes/zcl_inv_posting/source/main]
restore_verify: { object_url: /sap/bc/adt/oo/classes/zcl_inv_posting, passed: 36 }
setup:
  - tool: patch
    args: { object_url: /sap/bc/adt/oo/classes/zcl_inv_posting/source/main, find: a, replace: b }
  - tool: expect_unit_tests
    args: { object_url: /sap/bc/adt/oo/classes/zcl_inv_posting }
`,
      "t.yaml",
      "ABC123"
    );
    expect(t.tags).toEqual(["zinv", "legacy"]);
    expect(t.optIn).toBe(true);
    expect(t.allowedPackages).toEqual(["$ZINV"]);
    expect([t.timeoutMin, t.budgetUsd, t.toolTimeoutSec]).toEqual([30, 4, 240]);
    expect(t.restore).toEqual(["/sap/bc/adt/oo/classes/zcl_inv_posting/source/main"]);
    expect(t.restoreVerify).toEqual({ object_url: "/sap/bc/adt/oo/classes/zcl_inv_posting", passed: 36 });
  });

  it("沒寫的欄位有安全預設(舊題不受影響)", () => {
    const t = parseTask(MIN_TASK, "t.yaml", "ABC123");
    expect(t.tags).toEqual([]);
    expect(t.optIn).toBe(false);
    expect(t.allowedPackages).toBeUndefined();
    expect(t.restore).toEqual([]);
    expect(t.restoreVerify).toBeUndefined();
  });

  it.each([
    ["patch 缺 find", "setup:\n  - tool: patch\n    args: { object_url: /sap/bc/adt/oo/classes/zx/source/main, replace: b }\n", /patch 需要 find/],
    ["patch object_url 不是 ADT URI", "setup:\n  - tool: patch\n    args: { object_url: https://evil/x, find: a, replace: b }\n", /patch 需要 object_url/],
    ["expect_unit_tests 缺 object_url", "setup:\n  - tool: expect_unit_tests\n    args: {}\n", /expect_unit_tests 需要 object_url/],
    ["restore 不是 ADT URI", "restore: [zcl_x]\n", /restore 必須是 ADT URI/],
    ["restore_verify 沒搭配 restore", "restore_verify: { object_url: /sap/bc/adt/oo/classes/zx, passed: 36 }\n", /必須搭配 restore/],
    ["restore_verify passed 不是正整數", "restore: [/sap/bc/adt/oo/classes/zx/source/main]\nrestore_verify: { object_url: /sap/bc/adt/oo/classes/zx, passed: 0 }\n", /restore_verify 需要/],
    ["unit_tests 缺 object_url", "checks:\n  - kind: unit_tests\n", /unit_tests 需要 object_url/],
    ["source_not_contains 缺清單", "checks:\n  - kind: source_not_contains\n    object_url: /sap/bc/adt/oo/classes/zx/source/main\n", /source_not_contains 需要/],
    ["atc_max 缺 max", "checks:\n  - kind: atc_max\n    object_url: /sap/bc/adt/oo/classes/zx\n", /atc_max 需要/],
    ["tags 不是字串陣列", "tags: zinv\n", /tags 必須是非空的字串陣列/],
    ["timeout_min 不是正數", "timeout_min: 0\n", /timeout_min 必須是正數/],
  ])("驗證:%s → 報錯", (_n, extra, re) => {
    // 把額外欄位接在最小任務後面;若 extra 自帶 checks 就取代最小任務的 checks
    const base = extra.startsWith("checks:") ? "id: z1\ntitle: t\nprompt: p\n" : MIN_TASK;
    expect(() => parseTask(base + extra, "t.yaml", "ABC123")).toThrow(re);
  });

  it("四種新判定 + unchanged 的格式都能解析", () => {
    const t = parseTask(
      `id: z1
title: t
prompt: p
checks:
  - { kind: unit_tests, object_url: /sap/bc/adt/oo/classes/zcl_inv_posting, min_passed: 37 }
  - { kind: source_contains, object_url: /sap/bc/adt/oo/classes/zcl_inv_posting/source/main, contains: [check_wh] }
  - { kind: source_not_contains, object_url: /sap/bc/adt/oo/classes/zcl_inv_posting/source/main, not_contains: [bug] }
  - { kind: atc_max, object_url: /sap/bc/adt/oo/classes/zcl_inv_posting, max: 0 }
  - { kind: unchanged, object_url: /sap/bc/adt/programs/programs/zinv_entry/source/main }
`,
      "t.yaml",
      "ABC123"
    );
    expect(t.checks.map((c) => c.kind)).toEqual(["unit_tests", "source_contains", "source_not_contains", "atc_max", "unchanged"]);
  });
});

describe("Z1-4 --tags 篩選與預設不跑 opt_in 題組", () => {
  function tmpTaskDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-tags-"));
    const w = (name: string, id: string, extra = "") =>
      fs.writeFileSync(path.join(dir, name), `id: "${id}"\ntitle: t${id}\nprompt: p\nchecks:\n  - { kind: answer_contains, all: [x] }\n${extra}`);
    w("01.yaml", "01");
    w("02.yaml", "02", "tags: [legacy]\n");
    w("zinv-01.yaml", "zinv-01", "tags: [zinv, legacy]\nopt_in: true\n");
    w("zinv-02.yaml", "zinv-02", "tags: [zinv]\nopt_in: true\n");
    return dir;
  }

  it("--tags 只留任一 tag 符合的題;--tasks 與 --tags 同時給 → 兩者都要符合", () => {
    const dir = tmpTaskDir();
    try {
      expect(loadTasks(dir, "ABC123", undefined, ["zinv"]).map((t) => t.id)).toEqual(["zinv-01", "zinv-02"]);
      expect(loadTasks(dir, "ABC123", undefined, ["legacy"]).map((t) => t.id)).toEqual(["02", "zinv-01"]);
      expect(loadTasks(dir, "ABC123", ["zinv-02"], ["zinv"]).map((t) => t.id)).toEqual(["zinv-02"]);
      expect(loadTasks(dir, "ABC123", ["01"], ["zinv"])).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("沒有 --tags / --tasks:不含 opt_in 題組(原本的題目照跑);明確選取時全部跑", () => {
    const dir = tmpTaskDir();
    try {
      const all = loadTasks(dir, "ABC123");
      expect(selectTasks(all, { explicit: false }).map((t) => t.id)).toEqual(["01", "02"]);
      expect(selectTasks(all, { explicit: true }).map((t) => t.id)).toEqual(["01", "02", "zinv-01", "zinv-02"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repo 內現有的題目都不是 opt_in(原本 8 題不受影響)", () => {
    const tasks = loadTasks(TASK_DIR, "ABC123");
    expect(tasks.length).toBeGreaterThanOrEqual(8);
    for (const t of tasks.filter((x) => /^0[1-8]$/.test(x.id))) {
      expect(t.optIn, t.id).toBe(false);
      expect(t.restore, t.id).toEqual([]);
    }
  });

  it("參數解析:--tags 需要值", () => {
    expect(parseArgs(["--tags", "zinv,legacy"]).values.get("tags")).toBe("zinv,legacy");
    expect(() => parseArgs(["--tags"])).toThrow(/需要一個值/);
  });
});

describe("Z1-4 evalEnv 與還原失敗的報表警告", () => {
  it("task 有 allowed_packages 才覆寫;沒有就沿用原本設定(舊題不受影響)", () => {
    const base = { ABAP_MCP_ALLOWED_PACKAGES: "$TMP,Z*,Y*" } as NodeJS.ProcessEnv;
    expect(evalEnv(base, { allowedPackages: ["$ZINV"] }).ABAP_MCP_ALLOWED_PACKAGES).toBe("$ZINV");
    expect(evalEnv(base, { allowedPackages: undefined }).ABAP_MCP_ALLOWED_PACKAGES).toBe("$TMP,Z*,Y*");
    expect(evalEnv(base).ABAP_MCP_ALLOWED_PACKAGES).toBe("$TMP,Z*,Y*");
    expect(evalEnv(base).ABAP_MCP_READONLY).toBe("false");
  });

  const result = (o: Partial<TaskResult> = {}): TaskResult => ({
    task: "zinv-03", title: "修 bug", model: "sonnet", passed: true, details: [], cleanup: [], suffix: "ABC123", ...o,
  });

  it("沒有還原問題 → 沒有警告;有 → 報表最上方標出,並列在失敗與清除問題", () => {
    expect(baselineWarning([result()])).toBeUndefined();
    const broken = [result(), result({ task: "zinv-04", baselineBroken: "ZCL_INV_POSTING:寫回失敗" })];
    expect(baselineWarning(broken)).toContain("baseline zip");
    expect(baselineWarning(broken)).toContain("zinv-04");
    const md = renderMarkdown({ startedAt: new Date("2026-11-06T00:00:00Z"), stamp: "s", dryRun: false, models: ["sonnet"], results: broken });
    const firstLines = md.split("\n").slice(0, 4).join("\n");
    expect(firstLines).toContain("ZINV 基準可能已損壞");
    expect(md).toContain("還原失敗:ZCL_INV_POSTING:寫回失敗");
    const clean = renderMarkdown({ startedAt: new Date("2026-11-06T00:00:00Z"), stamp: "s", dryRun: false, models: ["sonnet"], results: [result()] });
    expect(clean).not.toContain("ZINV 基準可能已損壞");
  });
});

// ───────────────────────── Z2 探針題:allow_probes / require_tool_order / --probes ─────────────────────────
import { checkToolOrder } from "../../eval/lib/tasks.js";

describe("探針評測支援", () => {
  it("checkToolOrder:都出現且第一次出現的順序正確才通過", () => {
    const req = ["probe_set", "write_source"];
    expect(checkToolOrder(["read_source", "probe_set", "probe_logs", "write_source"], req)).toBeUndefined();
    expect(checkToolOrder(["probe_set", "write_source", "probe_set"], req)).toBeUndefined(); // 以第一次出現為準
    expect(checkToolOrder(["read_source", "write_source"], req)).toMatch(/沒有呼叫 probe_set/);
    expect(checkToolOrder(["write_source", "probe_set"], req)).toMatch(/出現得太早/);
    expect(checkToolOrder(["probe_set"], req)).toMatch(/沒有呼叫 write_source/);
  });

  it("parseTask 讀 allow_probes 與 require_tool_order;預設關閉", () => {
    const base = "id: x\ntitle: t\nprompt: p\nchecks: [{kind: answer_contains, all: [a]}]\n";
    expect(parseTask(base, "a.yaml", "X").allowProbes).toBe(false);
    const t = parseTask(base + "allow_probes: true\nrequire_tool_order: [probe_set, write_source]\n", "a.yaml", "X");
    expect(t.allowProbes).toBe(true);
    expect(t.requireToolOrder).toEqual(["probe_set", "write_source"]);
    expect(() => parseTask(base + "require_tool_order: []\n", "a.yaml", "X")).toThrow(/require_tool_order/);
  });

  it("evalEnv:只有 allow_probes 或 --probes 才開 ABAP_MCP_ALLOW_PROBES,不改 .env 的設定", () => {
    const base = { ABAP_MCP_ALLOW_PROBES: "false" } as NodeJS.ProcessEnv;
    expect(evalEnv(base, { allowedPackages: undefined, allowProbes: false }).ABAP_MCP_ALLOW_PROBES).toBe("false");
    expect(evalEnv(base, { allowedPackages: undefined, allowProbes: true }).ABAP_MCP_ALLOW_PROBES).toBe("true");
    expect(evalEnv(base, { allowedPackages: undefined, allowProbes: false }, true).ABAP_MCP_ALLOW_PROBES).toBe("true");
    expect(base.ABAP_MCP_ALLOW_PROBES).toBe("false");
  });

  it("parseArgs 接受 --probes;parseStreamJson 回傳工具呼叫順序(不含 ToolSearch)", () => {
    expect(parseArgs(["--probes", "--dry-run"]).flags.has("probes")).toBe(true);
    const line = (name: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name }] } });
    const r = parseStreamJson([line("ToolSearch"), line("mcp__abap-a4h__read_source"), line("mcp__abap-a4h__probe_set"), line("mcp__abap-a4h__write_source")].join("\n"));
    expect(r.toolOrder).toEqual(["read_source", "probe_set", "write_source"]);
  });
});

describe("還原:inactive 殘留(zinv-05 注入語法錯誤時 active 版本沒變)", () => {
  const url = "/sap/bc/adt/oo/classes/zcl_x/source/main";
  const orig = new Map([[url, "A\nB\n"]]);
  it("active 內容相同但有 inactive 版本 → 仍會寫回(清掉草稿);寫回後沒有殘留 → 沒有問題", async () => {
    let inactive = true;
    const write = vi.fn(async () => {
      inactive = false;
    });
    const problems = await restoreSources({ read: async () => "A\nB\n", write, runUnitTests: async () => "", hasInactive: async () => inactive }, orig);
    expect(write).toHaveBeenCalledTimes(1);
    expect(problems).toEqual([]);
  });
  it("沒有 inactive 且內容相同 → 不重寫;寫回後仍有 inactive → 回報問題", async () => {
    const write = vi.fn(async () => undefined);
    expect(await restoreSources({ read: async () => "A\nB\n", write, runUnitTests: async () => "", hasInactive: async () => false }, orig)).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    const stuck = await restoreSources({ read: async () => "A\nB\n", write, runUnitTests: async () => "", hasInactive: async () => true }, orig);
    expect(write).toHaveBeenCalledTimes(1);
    expect(stuck.join("")).toContain("仍有 inactive 版本");
  });
});
