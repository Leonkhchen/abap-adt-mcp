/**
 * eval/run.ts — 跨模型評測執行器
 *
 * 用法(在專案根目錄,需先 npm run build;.env 提供 SAP 連線):
 *   npx tsx eval/run.ts --model sonnet                        # 8 題 × 1 個模型
 *   npx tsx eval/run.ts --model haiku --tasks 01,07           # 只跑指定題目
 *   npx tsx eval/run.ts --model opus,sonnet,haiku --matrix    # 多模型矩陣(需明確加 --matrix)
 *   npx tsx eval/run.ts --dry-run                             # 不呼叫模型:只驗證事前準備、判定與清除
 *   npx tsx eval/run.ts --help
 *
 * 每題流程:事前準備 → 模型作答 → 判定 → 清除(一定執行)。密碼只經環境變數傳給子行程,不寫進任何檔案。
 * 結束後寫出 eval/results/<日期>.md 與 .csv(F4)。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createHarness, evalEnv } from "./lib/harness.js";
import { loadTasks, type EvalTask } from "./lib/tasks.js";
import { USAGE, parseArgs } from "./lib/args.js";
import { ADAPTERS, parseModelSpecs, type ModelSpec } from "./lib/adapters.js";
import { writeReports, type TaskResult } from "./lib/report.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

interface RunOpts {
  dryRun: boolean;
  timeoutMs: number;
  budget: number;
  logDir: string;
  suffix: string;
}

async function runTask(task: EvalTask, spec: ModelSpec, opts: RunOpts): Promise<TaskResult> {
  const h = await createHarness(evalEnv());
  const result: TaskResult = { task: task.id, title: task.title, model: opts.dryRun ? "dry-run" : spec.label, passed: false, details: [], cleanup: [], suffix: opts.suffix };
  try {
    try {
      await h.setup(task);
    } catch (e) {
      result.setupError = e instanceof Error ? e.message : String(e);
      return result;
    }
    let answer = "";
    if (!opts.dryRun) {
      const run = await ADAPTERS[spec.adapter].run({
        prompt: task.prompt,
        model: spec.model,
        serverEnv: {
          SAP_URL: h.cfg.sap.url,
          SAP_USER: h.cfg.sap.user,
          SAP_CLIENT: h.cfg.sap.client,
          SAP_LANGUAGE: h.cfg.sap.language,
          ABAP_MCP_SYSTEM_ROLE: "dev",
          ABAP_MCP_READONLY: "false",
          ABAP_MCP_ALLOW_DATA_PREVIEW: "true",
          ABAP_MCP_ALLOWED_PREFIXES: h.cfg.safety.allowedPrefixes.join(","),
          ABAP_MCP_ALLOWED_PACKAGES: h.cfg.safety.allowedPackages.join(","),
          ABAP_MCP_AUDIT_LOG: "",
        },
        password: h.cfg.sap.password,
        repoDir: REPO,
        timeoutMs: opts.timeoutMs,
        budgetUsd: opts.budget,
        logFile: path.join(opts.logDir, `${task.id}-${spec.label.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`),
      });
      answer = run.answer;
      const { answer: _a, ...rest } = run;
      result.run = { ...rest, answerPreview: run.answer.slice(0, 500) };
      if (run.timedOut) result.details.push(`逾時(${Math.round(opts.timeoutMs / 60_000)} 分鐘)`);
    }
    const c = await h.check(task, answer);
    result.passed = c.passed && !result.run?.timedOut;
    result.details.push(...c.details);
    return result;
  } finally {
    result.cleanup = await h.cleanup(task).catch((e) => [`❌ 清除時出錯:${String(e)}`]);
    await h.close();
  }
}

async function main() {
  let parsed: ReturnType<typeof parseArgs>;
  let specs: ModelSpec[];
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed.flags.has("help")) {
      console.log(USAGE);
      return;
    }
    specs = parseModelSpecs(parsed.values.get("model") ?? "sonnet");
    // 費用控制:多模型矩陣一定要明確加 --matrix
    if (specs.length > 1 && !parsed.flags.has("matrix") && !parsed.flags.has("dry-run")) {
      throw new Error(`指定了 ${specs.length} 個模型;跑多模型矩陣需加 --matrix(會依模型數倍增費用)`);
    }
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    process.exit(2);
  }
  const v = parsed.values;
  const dryRun = parsed.flags.has("dry-run");
  if (dryRun) specs = specs.slice(0, 1); // dry-run 不呼叫模型,只跑一輪
  const ids = v.get("tasks")?.split(",").map((s) => s.trim()).filter(Boolean);
  const timeoutMs = Number(v.get("timeout-min") ?? "20") * 60_000;
  const budget = Number(v.get("budget") ?? "3");
  const outDir = path.resolve(v.get("out") ?? path.join(REPO, "eval", "results"));
  if (!fs.existsSync(path.join(REPO, "dist", "index.js"))) throw new Error("請先執行 npm run build(MCP server 從 dist/index.js 啟動)");

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDir = path.join(outDir, "logs", stamp);
  fs.mkdirSync(logDir, { recursive: true });
  const taskDir = path.join(REPO, "eval", "tasks");
  const tasks = loadTasks(taskDir, "XXXXXX", ids);
  const results: TaskResult[] = [];
  for (const spec of specs) {
    for (const t of tasks) {
      // 每題重新載入、換一組名稱尾碼,避免與上一題或上一次殘留衝突
      const suffix = randomBytes(3).toString("hex").toUpperCase();
      const task = loadTasks(taskDir, suffix, [t.id])[0];
      const t0 = Date.now();
      console.log(`▶ ${task.id} ${task.title}(${dryRun ? "dry-run" : spec.label},尾碼 ${suffix})`);
      const r = await runTask(task, spec, { dryRun, timeoutMs, budget, logDir, suffix });
      r.wallSeconds = Math.round((Date.now() - t0) / 1000);
      results.push(r);
      const cost = r.run ? ` $${r.run.costUsd.toFixed(4)}、${r.run.turns} 回合、${r.run.toolCalls} 次工具` : "";
      console.log(`  ${r.setupError ? "⚠️ 準備失敗" : r.passed ? "✅ 成功" : "❌ 失敗"}(${r.wallSeconds} 秒${cost})`);
      for (const d of [r.setupError, ...r.details].filter(Boolean)) console.log(`    - ${d}`);
      for (const c of r.cleanup.filter((x) => x.startsWith("❌"))) console.log(`    ${c}`);
    }
  }
  const files = writeReports(outDir, { startedAt, stamp, dryRun, models: dryRun ? ["dry-run"] : specs.map((s) => s.label), results });
  const total = results.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0);
  console.log(`\n共 ${results.length} 題次,成功 ${results.filter((r) => r.passed).length};總費用 $${total.toFixed(4)}`);
  for (const f of files) console.log(`結果:${f}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
