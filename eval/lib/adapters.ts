/**
 * eval/lib/adapters.ts — 受測 agent 的轉接介面
 *
 * 本版只實作 Claude Code(claude -p,--model opus / sonnet / haiku / 完整模型 ID)。
 * Codex / Gemini 只保留介面:選到時在連 SAP 之前就報錯,不會半途失敗。
 *
 * 模型規格:`sonnet`(預設為 claude)或 `<adapter>:<model>`,例如 `claude:opus`、`codex:gpt-5`。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { MCP_SERVER_NAME, runClaude, writeMcpConfig, type RunResult } from "./claude.js";

export type AdapterId = "claude" | "codex" | "gemini";

export interface AgentRunInput {
  prompt: string;
  model: string;
  /** 給 MCP server 的環境變數(不含密碼) */
  serverEnv: Record<string, string>;
  /** 只放進子行程環境變數,不寫檔 */
  password: string;
  repoDir: string;
  timeoutMs: number;
  budgetUsd?: number;
  logFile: string;
}

export interface AgentAdapter {
  readonly id: AdapterId;
  readonly implemented: boolean;
  run(input: AgentRunInput): Promise<RunResult>;
}

export interface ModelSpec {
  adapter: AdapterId;
  model: string;
  /** 報表與檔名用的標籤:claude 只寫模型名,其他寫 adapter:model */
  label: string;
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  implemented: true,
  async run(i) {
    const mcpConfig = writeMcpConfig(i.repoDir, i.serverEnv);
    try {
      return await runClaude({
        prompt: `${i.prompt}\n(只使用 ${MCP_SERVER_NAME} 這個 MCP server 的工具。)`,
        model: i.model,
        mcpConfig,
        env: { ...process.env, SAP_PASSWORD: i.password },
        timeoutMs: i.timeoutMs,
        maxBudgetUsd: i.budgetUsd,
        logFile: i.logFile,
        // 空的工作目錄:避免受測模型讀到本專案的 CLAUDE.md 或原始碼
        cwd: fs.mkdtempSync(path.join(path.dirname(mcpConfig), "cwd-")),
      });
    } finally {
      fs.rmSync(path.dirname(mcpConfig), { recursive: true, force: true });
    }
  },
};

function notImplemented(id: AdapterId, hint: string): AgentAdapter {
  return {
    id,
    implemented: false,
    run() {
      return Promise.reject(new Error(`${id} 轉接器本版不實作(${hint})`));
    },
  };
}

/** Codex CLI:日後以 `codex exec` + MCP 設定實作 */
export const codexAdapter = notImplemented("codex", "預計以 codex exec 搭配 MCP 設定實作");
/** Gemini CLI:日後以 `gemini -p` + settings.json 的 mcpServers 實作 */
export const geminiAdapter = notImplemented("gemini", "預計以 gemini -p 搭配 mcpServers 設定實作");

export const ADAPTERS: Record<AdapterId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter, gemini: geminiAdapter };

/** 解析 `--model` 的逗號清單;未實作或格式錯誤在連 SAP 前就丟錯 */
export function parseModelSpecs(list: string): ModelSpec[] {
  const items = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error("--model 至少要指定一個模型");
  const specs = items.map((item): ModelSpec => {
    const m = /^(?:([a-z]+):)?([A-Za-z0-9._\-[\]]+)$/.exec(item);
    if (!m) throw new Error(`模型規格格式錯誤:${item}`);
    const adapter = (m[1] ?? "claude") as AdapterId;
    if (!(adapter in ADAPTERS)) throw new Error(`未知的 agent:${m[1]}(可用:${Object.keys(ADAPTERS).join(", ")})`);
    if (!ADAPTERS[adapter].implemented) throw new Error(`${adapter} 轉接器本版不實作;目前只能評測 Claude(opus / sonnet / haiku)`);
    return { adapter, model: m[2], label: adapter === "claude" ? m[2] : `${adapter}:${m[2]}` };
  });
  const labels = specs.map((s) => s.label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`模型重複:${dup}`);
  return specs;
}
