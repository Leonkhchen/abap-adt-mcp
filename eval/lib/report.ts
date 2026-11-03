/**
 * eval/lib/report.ts — 評測報表(F4)
 *
 * 產出 eval/results/<日期>.md 與 .csv:題目 × 模型的格子(成敗、回合、秒數、費用、工具呼叫次數)加總計列;
 * 另存一份原始 JSON(<時間戳>-<模型>.json,不入版控)。同一天重跑時檔名加 -2、-3…,不覆蓋舊報表。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunResult } from "./claude.js";

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
  /** 含事前準備、判定與清除的總耗時 */
  wallSeconds?: number;
}

export interface ReportInput {
  startedAt: Date;
  stamp: string;
  dryRun: boolean;
  models: string[];
  results: TaskResult[];
}

interface Totals {
  passed: number;
  count: number;
  turns: number;
  seconds: number;
  cost: number;
  toolCalls: number;
}

/** 秒數:有模型執行時取模型自己的耗時,否則取整題耗時 */
function seconds(r: TaskResult): number {
  return r.run ? Math.round(r.run.durationMs / 1000) : (r.wallSeconds ?? 0);
}

function verdict(r: TaskResult): string {
  if (r.setupError) return "⚠️";
  return r.passed ? "✅" : "❌";
}

export function totalsFor(results: TaskResult[], model: string): Totals {
  const rs = results.filter((r) => r.model === model);
  return {
    passed: rs.filter((r) => r.passed).length,
    count: rs.length,
    turns: rs.reduce((a, r) => a + (r.run?.turns ?? 0), 0),
    seconds: rs.reduce((a, r) => a + seconds(r), 0),
    cost: rs.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0),
    toolCalls: rs.reduce((a, r) => a + (r.run?.toolCalls ?? 0), 0),
  };
}

function cell(r: TaskResult | undefined): string {
  if (!r) return "—";
  if (!r.run) return `${verdict(r)} ${seconds(r)}s`;
  return `${verdict(r)} ${r.run.turns} 回合 · ${seconds(r)}s · $${r.run.costUsd.toFixed(4)} · ${r.run.toolCalls} 工具`;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderMarkdown(input: ReportInput): string {
  const { results, models } = input;
  const taskIds = [...new Set(results.map((r) => r.task))];
  const title = (id: string) => results.find((r) => r.task === id)?.title ?? "";
  const lines: string[] = [];
  lines.push(`# abap-adt-mcp 評測結果 ${input.startedAt.toISOString().slice(0, 10)}`, "");
  lines.push(`- 開始:${input.startedAt.toISOString()}`);
  lines.push(`- 模型:${models.join(", ")}${input.dryRun ? "(dry-run:未呼叫模型,只驗證準備/判定/清除)" : ""}`);
  const grand = results.reduce((a, r) => a + (r.run?.costUsd ?? 0), 0);
  lines.push(`- 題次:${results.length},成功 ${results.filter((r) => r.passed).length};總費用 $${grand.toFixed(4)}`, "");
  lines.push("格子內容:成敗 · 回合 · 模型耗時 · 費用 · 工具呼叫次數(⚠️ = 事前準備失敗)", "");
  lines.push(`| 題目 | ${models.map(esc).join(" | ")} |`);
  lines.push(`|---|${models.map(() => "---").join("|")}|`);
  for (const id of taskIds) {
    const row = models.map((m) => cell(results.find((r) => r.task === id && r.model === m)));
    lines.push(`| ${id} ${esc(title(id))} | ${row.join(" | ")} |`);
  }
  const tot = models.map((m) => {
    const t = totalsFor(results, m);
    return `**${t.passed}/${t.count}** · ${t.turns} 回合 · ${t.seconds}s · **$${t.cost.toFixed(4)}** · ${t.toolCalls} 工具`;
  });
  lines.push(`| **總計** | ${tot.join(" | ")} |`, "");

  const problems = results.filter((r) => !r.passed || r.cleanup.some((c) => c.startsWith("❌")));
  if (problems.length > 0) {
    lines.push("## 失敗與清除問題", "");
    for (const r of problems) {
      lines.push(`### ${r.task} × ${r.model}(尾碼 ${r.suffix})`);
      if (r.setupError) lines.push(`- 事前準備失敗:${esc(r.setupError)}`);
      if (r.run && r.run.status !== "success") lines.push(`- 結束狀態:${r.run.status}`);
      for (const d of r.details) lines.push(`- ${esc(d)}`);
      for (const c of r.cleanup.filter((x) => x.startsWith("❌"))) lines.push(`- ${esc(c)}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function csvField(v: string | number | boolean | undefined): string {
  const s = v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ["task", "title", "model", "passed", "turns", "seconds", "cost_usd", "tool_calls", "status", "timed_out", "setup_error"];

export function renderCsv(input: ReportInput): string {
  const rows: (string | number | boolean | undefined)[][] = [CSV_HEADER];
  for (const r of input.results) {
    rows.push([r.task, r.title, r.model, r.passed, r.run?.turns, seconds(r), r.run ? r.run.costUsd.toFixed(4) : undefined, r.run?.toolCalls, r.run?.status ?? (input.dryRun ? "dry-run" : undefined), r.run?.timedOut, r.setupError]);
  }
  for (const m of input.models) {
    const t = totalsFor(input.results, m);
    rows.push(["TOTAL", `${t.passed}/${t.count} passed`, m, t.passed === t.count, t.turns, t.seconds, t.cost.toFixed(4), t.toolCalls, "", "", ""]);
  }
  // 加 BOM,Excel 直接開啟才不會中文亂碼
  return "﻿" + rows.map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** 找一個不會覆蓋既有報表的檔名基底:2026-11-03、2026-11-03-2… */
export function reportBase(outDir: string, date: string): string {
  for (let n = 1; ; n++) {
    const base = path.join(outDir, n === 1 ? date : `${date}-${n}`);
    if (!fs.existsSync(`${base}.md`) && !fs.existsSync(`${base}.csv`)) return base;
  }
}

/** 寫出 .md / .csv / 原始 .json,回傳檔案路徑 */
export function writeReports(outDir: string, input: ReportInput): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  // 用本地日期命名(報表給人看)
  const d = input.startedAt;
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const base = reportBase(outDir, input.dryRun ? `${date}-dryrun` : date);
  const md = `${base}.md`;
  const csv = `${base}.csv`;
  const json = path.join(outDir, `${input.stamp}-${input.models.join("_").replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  fs.writeFileSync(md, renderMarkdown(input));
  fs.writeFileSync(csv, renderCsv(input));
  fs.writeFileSync(json, JSON.stringify({ ...input, startedAt: input.startedAt.toISOString() }, null, 2));
  return [md, csv, json];
}
