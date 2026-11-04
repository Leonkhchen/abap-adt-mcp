/**
 * 評測框架的單元測試(不需要 SAP、不呼叫模型)
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fillPlaceholders, loadTasks, parseTask } from "../../eval/lib/tasks.js";
import { parseStreamJson, writeMcpConfig } from "../../eval/lib/claude.js";
import { parseArgs } from "../../eval/lib/args.js";
import { ADAPTERS, parseModelSpecs } from "../../eval/lib/adapters.js";
import { CSV_HEADER, renderCsv, renderMarkdown, writeReports, type TaskResult } from "../../eval/lib/report.js";
import { bindingNameFromUri, unpublishBody } from "../../eval/lib/harness.js";
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
    const tasks = loadTasks(TASK_DIR, "AB12CD");
    expect(tasks.map((t) => t.id)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
    for (const t of tasks) {
      expect(t.prompt.length).toBeGreaterThan(10);
      expect(t.checks.length).toBeGreaterThan(0);
    }
  });

  it("佔位符在解析前取代:物件名稱大寫、URI 小寫;不殘留 {{", () => {
    const tasks = loadTasks(TASK_DIR, "ab12cd");
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
