/**
 * 評測框架的單元測試(不需要 SAP、不呼叫模型)
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fillPlaceholders, loadTasks, parseTask } from "../../eval/lib/tasks.js";
import { parseStreamJson, writeMcpConfig } from "../../eval/lib/claude.js";
import { parseArgs } from "../../eval/lib/args.js";

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
