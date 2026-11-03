/**
 * eval/run.ts — 跨模型評測執行器
 *
 * 用法(在專案根目錄,需先 npm run build;.env 提供 SAP 連線):
 *   npx tsx eval/run.ts --model sonnet                 # 8 題 × 1 個模型
 *   npx tsx eval/run.ts --model haiku --tasks 01,07    # 只跑指定題目
 *   npx tsx eval/run.ts --dry-run                      # 不呼叫模型:只驗證事前準備、判定與清除
 * 選項:--timeout-min(每題逾時,預設 20)、--budget(每題費用上限 USD,預設 3)、--out(結果目錄,預設 eval/results)
 *
 * 每題流程:事前準備 → 模型作答 → 判定 → 清除(一定執行)。密碼只經環境變數傳給子行程,不寫進任何檔案。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createHarness, evalEnv } from "./lib/harness.js";
import { MCP_SERVER_NAME, runClaude, writeMcpConfig, type RunResult } from "./lib/claude.js";
import { loadTasks, type EvalTask } from "./lib/tasks.js";
import { USAGE, parseArgs } from "./lib/args.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

export interface TaskResult {
  task: string;
  title: string;
  model: string;
  passed: boolean;
  details: string[];
  run?: Omit<RunResult, "answer"> & { answerPreview: string };
  setupError?: string;
  cleanup: string[];
  suffix: string;
}

async function runTask(task: EvalTask, model: string, opts: { dryRun: boolean; timeoutMs: number; budget: number; logDir: string; suffix: string }): Promise<TaskResult> {
  const env = evalEnv();
  const h = await createHarness(env);
  const result: TaskResult = { task: task.id, title: task.title, model, passed: false, details: [], cleanup: [], suffix: opts.suffix };
  try {
    try {
      await h.setup(task);
    } catch (e) {
      result.setupError = e instanceof Error ? e.message : String(e);
      return result;
    }
    let answer = "";
    if (!opts.dryRun) {
      const mcpConfig = writeMcpConfig(REPO, {
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
      });
      try {
        const run = await runClaude({
          prompt: `${task.prompt}\n(只使用 ${MCP_SERVER_NAME} 這個 MCP server 的工具。)`,
          model,
          mcpConfig,
          env: { ...process.env, SAP_PASSWORD: h.cfg.sap.password },
          timeoutMs: opts.timeoutMs,
          maxBudgetUsd: opts.budget,
          logFile: path.join(opts.logDir, `${task.id}-${model}.jsonl`),
          cwd: fs.mkdtempSync(path.join(path.dirname(mcpConfig), "cwd-")),
        });
        answer = run.answer;
        const { answer: _a, ...rest } = run;
        result.run = { ...rest, answerPreview: run.answer.slice(0, 500) };
        if (run.timedOut) result.details.push(`逾時(${Math.round(opts.timeoutMs / 60_000)} 分鐘)`);
      } finally {
        fs.rmSync(path.dirname(mcpConfig), { recursive: true, force: true });
      }
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
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.flags.has("help")) {
    console.log(USAGE);
    return;
  }
  const v = parsed.values;
  const dryRun = parsed.flags.has("dry-run");
  const model = v.get("model") ?? "sonnet";
  const ids = v.get("tasks")?.split(",").map((s) => s.trim()).filter(Boolean);
  const timeoutMs = Number(v.get("timeout-min") ?? "20") * 60_000;
  const budget = Number(v.get("budget") ?? "3");
  const outDir = path.resolve(v.get("out") ?? path.join(REPO, "eval", "results"));
  if (!fs.existsSync(path.join(REPO, "dist", "index.js"))) throw new Error("請先執行 npm run build(MCP server 從 dist/index.js 啟動)");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDir = path.join(outDir, "logs", stamp);
  fs.mkdirSync(logDir, { recursive: true });
  const tasks = loadTasks(path.join(REPO, "eval", "tasks"), "XXXXXX", ids);
  const results: TaskResult[] = [];
  for (const t of tasks) {
    // 每題重新載入、換一組名稱尾碼,避免與上一題或上一次殘留衝突
    const suffix = randomBytes(3).toString("hex").toUpperCase();
    const task = loadTasks(path.join(REPO, "eval", "tasks"), suffix, [t.id])[0];
    const t0 = Date.now();
    console.log(`▶ ${task.id} ${task.title}(${dryRun ? "dry-run" : model},尾碼 ${suffix})`);
    const r = await runTask(task, model, { dryRun, timeoutMs, budget, logDir, suffix });
    results.push(r);
    const cost = r.run ? ` $${r.run.costUsd.toFixed(4)}、${r.run.turns} 回合、${r.run.toolCalls} 次工具` : "";
    console.log(`  ${r.setupError ? "⚠️ 準備失敗" : r.passed ? "✅ 成功" : "❌ 失敗"}(${Math.round((Date.now() - t0) / 1000)} 秒${cost})`);
    for (const d of [r.setupError, ...r.details].filter(Boolean)) console.log(`    - ${d}`);
    for (const c of r.cleanup.filter((x) => x.startsWith("❌"))) console.log(`    ${c}`);
  }
  const file = path.join(outDir, `${stamp}${dryRun ? "-dryrun" : `-${model}`}.json`);
  fs.writeFileSync(file, JSON.stringify({ model: dryRun ? "dry-run" : model, startedAt: stamp, results }, null, 2));
  const total = results.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0);
  console.log(`\n共 ${results.length} 題,成功 ${results.filter((r) => r.passed).length};總費用 $${total.toFixed(4)}\n結果:${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
