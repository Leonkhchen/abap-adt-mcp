/**
 * 評測框架的單元測試(不需要 SAP、不呼叫模型)
 */
import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fillPlaceholders, loadTasks, parseTask } from "../../eval/lib/tasks.js";

const TASK_DIR = path.resolve("eval/tasks");

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
