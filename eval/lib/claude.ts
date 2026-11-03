/**
 * eval/lib/claude.ts — 以 headless Claude Code(claude -p)執行一題
 *
 * - --strict-mcp-config + 臨時 MCP 設定檔:只載入 abap-a4h,且只開放它的工具(--allowedTools mcp__abap-a4h)
 * - 密碼不寫進設定檔:設定檔寫 ${SAP_PASSWORD},由 claude 以子行程的環境變數展開
 * - 提示經 stdin 傳入(避免命令列引號與換行問題);輸出用 stream-json 以便計算工具呼叫次數
 *   (規格寫 --output-format json,但 json 只有最後結果、沒有工具呼叫明細)
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MCP_SERVER_NAME = "abap-a4h";

export interface RunResult {
  /** claude 回報的結束狀態(success / error_max_turns / error_during_execution …) */
  status: string;
  answer: string;
  turns: number;
  durationMs: number;
  costUsd: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  /** 逾時被終止 */
  timedOut: boolean;
  /** 原始 stream-json 輸出存放處 */
  logFile: string;
}

/** 寫一份只含 abap-a4h 的臨時 MCP 設定檔(密碼以環境變數展開,不落地) */
export function writeMcpConfig(repoDir: string, env: Record<string, string>): string {
  const cfg = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: "node",
        args: [path.join(repoDir, "dist", "index.js").replace(/\\/g, "/")],
        env: { ...env, SAP_PASSWORD: "${SAP_PASSWORD}" },
      },
    },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-eval-")), "mcp.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

/** 解析 stream-json:最後的 result 與 assistant 訊息中的工具呼叫 */
export function parseStreamJson(text: string): Omit<RunResult, "timedOut" | "logFile"> {
  let result: Record<string, unknown> | undefined;
  const byName: Record<string, number> = {};
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "assistant") {
      const content = ((m.message as { content?: unknown[] })?.content ?? []) as { type?: string; name?: string }[];
      for (const c of content) {
        // ToolSearch 只是載入工具定義,不算對 SAP 的工具呼叫
        if (c.type === "tool_use" && c.name && c.name !== "ToolSearch") {
          const n = c.name.replace(`mcp__${MCP_SERVER_NAME}__`, "");
          byName[n] = (byName[n] ?? 0) + 1;
        }
      }
    }
    if (m.type === "result") result = m;
  }
  return {
    status: String(result?.subtype ?? "no_result"),
    answer: String(result?.result ?? ""),
    turns: Number(result?.num_turns ?? 0),
    durationMs: Number(result?.duration_ms ?? 0),
    costUsd: Number(result?.total_cost_usd ?? 0),
    toolCalls: Object.values(byName).reduce((a, b) => a + b, 0),
    toolCallsByName: byName,
  };
}

export interface ClaudeRunOptions {
  prompt: string;
  model: string;
  mcpConfig: string;
  /** 子行程的環境變數(需含 SAP_PASSWORD) */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBudgetUsd?: number;
  logFile: string;
  claudeBin?: string;
  cwd?: string;
}

export function runClaude(o: ClaudeRunOptions): Promise<RunResult> {
  const args = [
    "-p",
    "--model", o.model,
    "--strict-mcp-config",
    "--mcp-config", o.mcpConfig,
    "--allowedTools", `mcp__${MCP_SERVER_NAME}`,
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));
  return new Promise((resolve, reject) => {
    const child = spawn(o.claudeBin ?? "claude", args, { env: o.env, cwd: o.cwd, windowsHide: true });
    const out = fs.createWriteStream(o.logFile);
    let buf = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, o.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      out.write(d);
    });
    child.stderr.on("data", (d: Buffer) => out.write(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      out.end();
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      out.end();
      resolve({ ...parseStreamJson(buf), timedOut, logFile: o.logFile });
    });
    child.stdin.end(o.prompt, "utf8");
  });
}
