/**
 * eval/lib/harness.ts — 事前準備、判定與清除
 *
 * 透過 in-process 的 MCP 工具(與實際使用相同的 registerTools + RealAdtService)執行 setup 與 checks,
 * 確保判定走的是同一套護欄與輸出格式;刪除物件(沒有對應的 MCP 工具)用 abap-adt-api 直接 lock + delete。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ADTClient, session_types } from "abap-adt-api";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { RealAdtService } from "../../src/adt/client.js";
import { logoutClient, releaseStateful } from "../../src/adt/session.js";
import { AuditLogger } from "../../src/safety/audit.js";
import { registerTools } from "../../src/tools/registry.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyPatch, checkUnitTests, normalizeSource, parseUnitCounts as parseUnitCountsFromText, restoreSources, sameSource } from "./baseline.js";
import type { Check, EvalTask } from "./tasks.js";

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface CheckResult {
  passed: boolean;
  details: string[];
}

export interface Harness {
  cfg: AppConfig;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** opts.restoreDir:把還原基準(作答前的原始碼)另存一份,萬一還原失敗可手動救回 */
  setup(task: EvalTask, opts?: { restoreDir?: string }): Promise<void>;
  check(task: EvalTask, answer: string): Promise<CheckResult>;
  cleanup(task: EvalTask): Promise<string[]>;
  /** 把 task.restore 的物件寫回事前準備之前的原始碼、比對、跑基準單元測試;回傳問題清單(空 = 成功) */
  restore(task: EvalTask): Promise<string[]>;
  close(): Promise<void>;
}

/** 評測用的設定:可讀寫、開啟 data_preview(第 7 題),其餘沿用 .env / 環境變數 */
export function evalEnv(base: NodeJS.ProcessEnv = process.env, task?: Pick<EvalTask, "allowedPackages" | "allowProbes">, probes = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ABAP_MCP_READONLY: "false", ABAP_MCP_SYSTEM_ROLE: "dev", ABAP_MCP_ALLOW_DATA_PREVIEW: "true" };
  // ZINV 題:只開 $ZINV 的寫入範圍(這題才開,原本的題目不受影響)
  if (task?.allowedPackages?.length) env.ABAP_MCP_ALLOWED_PACKAGES = task.allowedPackages.join(",");
  // 探針工具預設關閉:題目標了 allow_probes 或命令列帶 --probes 才開(只影響這個 MCP 設定,不動 .env)
  if (task?.allowProbes || probes) env.ABAP_MCP_ALLOW_PROBES = "true";
  return env;
}

const norm = (s: string) => s.toLowerCase();

const BINDING_URI = /^\/sap\/bc\/adt\/businessservices\/bindings\/([^/?]+)/i;

/** service binding 的 URI 取出名稱(大寫);不是 binding 回 undefined */
export function bindingNameFromUri(uri: string): string | undefined {
  const m = BINDING_URI.exec(uri);
  return m ? decodeURIComponent(m[1]).toUpperCase() : undefined;
}

/** 取消發布 OData V4 service binding 的請求本文(已發布的 binding 無法直接刪除) */
export function unpublishBody(name: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
    `<adtcore:objectReference adtcore:type="SCGR" adtcore:name="${name.toUpperCase()}"/></adtcore:objectReferences>`
  );
}

/** deleteWithLock 需要的 ADTClient 部分(單元測試可用假物件) */
export interface LockableClient {
  stateful: session_types;
  lock(uri: string): Promise<{ LOCK_HANDLE: string }>;
  unLock(uri: string, lockHandle: string): Promise<unknown>;
  deleteObject(uri: string, lockHandle: string, transport?: string): Promise<unknown>;
}

/** 解鎖回「沒有鎖」:刪除成功時 SAP 常已釋放鎖,不算錯誤 */
const NOT_LOCKED = /not locked|no lock|nicht gesperrt|is not locked|does not exist|not found|404/i;

/**
 * lock → delete,失敗也一定解鎖(v0.5.1 E1)。
 *  - lock handle 放在 try 外;lock 本身失敗時沒有 handle,不呼叫 unLock
 *  - finally 先在同一個 stateful session 嘗試 unLock,再切回 stateless
 *  - 刪除成功後的「not locked」類解鎖錯誤忽略;
 *    解鎖失敗不蓋掉刪除錯誤,兩個都回報
 */
export async function deleteWithLock(raw: LockableClient, uri: string): Promise<string> {
  let lockHandle: string | undefined;
  let deleted = false;
  let failure: string | undefined;
  try {
    raw.stateful = session_types.stateful;
    lockHandle = (await raw.lock(uri)).LOCK_HANDLE;
    await raw.deleteObject(uri, lockHandle);
    deleted = true;
  } catch (e) {
    failure = String(e instanceof Error ? e.message : e);
  }
  let unlockError: string | undefined;
  if (lockHandle !== undefined) {
    try {
      await raw.unLock(uri, lockHandle);
    } catch (e) {
      const m = String(e instanceof Error ? e.message : e);
      if (!(deleted && NOT_LOCKED.test(m))) unlockError = m;
    }
  }
  // 結束 stateful session(C0-10):通知 SAP 放掉 context、回 stateless、丟掉失效的 sap-contextid(不丟例外)
  await releaseStateful(raw as unknown as ADTClient);

  if (failure !== undefined) {
    // 物件不存在時 SAP 回 does not exist / not found,或「cannot be created without a package」
    if (/does not exist|not found|404|without a package/i.test(failure)) {
      // 解鎖失敗不能被「不存在」蓋掉(N6):殘留的鎖要被報表看見(❌ 開頭)
      return unlockError ? `❌ 不存在(略過刪除),但解鎖失敗 ${uri}:${unlockError}` : `不存在(略過)${uri}`;
    }
    return `❌ 刪除失敗 ${uri}:${failure}` + (unlockError ? `;另外解鎖也失敗:${unlockError}` : "");
  }
  // 刪除成功但解鎖失敗:鎖可能殘留,以 ❌ 開頭讓報表列為清除問題
  return unlockError ? `❌ 已刪除 ${uri},但解鎖失敗:${unlockError}` : `已刪除 ${uri}`;
}

export async function createHarness(env: NodeJS.ProcessEnv = evalEnv(), auditPath = ""): Promise<Harness> {
  const cfg = loadConfig(env);
  const server = new McpServer({ name: "abap-adt-mcp-eval", version: "0" });
  const adt = new RealAdtService(cfg);
  registerTools(server, adt, cfg, new AuditLogger(auditPath));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "eval-harness", version: "0" });
  await client.connect(clientT);
  const raw = new ADTClient(cfg.sap.url, cfg.sap.user, cfg.sap.password, cfg.sap.client, cfg.sap.language);

  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const r = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 900_000 })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
  };

  /** 還原基準:事前準備「之前」的原始碼(注入會改物件,所以要在 patch 之前讀) */
  const originals = new Map<string, string>();
  /** unchanged 判定的基準:事前準備「之後」、作答之前的原始碼 */
  const preAnswer = new Map<string, string>();

  const runCheck = async (c: Check, answer: string): Promise<string | undefined> => {
    if (c.kind === "answer_contains") {
      const missing = (c.all ?? []).filter((s) => !norm(answer).includes(norm(s)));
      if (missing.length) return `回答缺少:${missing.join("、")}`;
      if (c.any?.length && !c.any.some((s) => norm(answer).includes(norm(s)))) return `回答沒有提到任一:${c.any.join("、")}`;
      return undefined;
    }
    if (c.kind === "tool") {
      const r = await call(c.tool, c.args);
      if (r.isError) return `${c.tool} 出錯:${r.text.slice(0, 300)}`;
      const missing = (c.contains ?? []).filter((s) => !norm(r.text).includes(norm(s)));
      const present = (c.not_contains ?? []).filter((s) => norm(r.text).includes(norm(s)));
      if (missing.length || present.length) {
        return `${c.tool} 輸出` + (missing.length ? ` 缺少「${missing.join("、")}」` : "") + (present.length ? ` 不應有「${present.join("、")}」` : "");
      }
      return undefined;
    }
    if (c.kind === "unit_tests") {
      const r = await call("run_unit_tests", { object_url: c.object_url });
      if (r.isError) return `run_unit_tests 出錯:${r.text.slice(0, 300)}`;
      return checkUnitTests(r.text, c.min_passed ?? 1, `單元測試 ${c.object_url}`);
    }
    if (c.kind === "source_contains" || c.kind === "source_not_contains") {
      const src = norm(normalizeSource(await adt.getObjectSource(c.object_url)));
      if (c.kind === "source_contains") {
        const missing = c.contains.filter((x) => !src.includes(norm(x.replace(/\r\n/g, "\n"))));
        return missing.length ? `${c.object_url} 原始碼缺少:${missing.join("、")}` : undefined;
      }
      const present = c.not_contains.filter((x) => src.includes(norm(x.replace(/\r\n/g, "\n"))));
      return present.length ? `${c.object_url} 原始碼不應有:${present.join("、")}` : undefined;
    }
    if (c.kind === "atc_max") {
      const r = await adt.runAtc(c.object_url);
      const n = r.findings.filter((f) => f.priority <= 2).length;
      return n > c.max ? `ATC 優先級 1–2 有 ${n} 筆,超過上限 ${c.max}(${c.object_url})` : undefined;
    }
    if (c.kind === "unchanged") {
      const before = preAnswer.get(c.object_url);
      if (before === undefined) return `unchanged:沒有 ${c.object_url} 的作答前基準(事前準備沒有記錄到)`;
      const now = await adt.getObjectSource(c.object_url);
      return sameSource(before, now) ? undefined : `${c.object_url} 被修改了(這題不應該改任何程式)`;
    }
    // answer_contains_query:以 data_preview 查出正確值(表格第一列是欄名,以 | 分隔)
    const r = await call("data_preview", { sql: c.sql, max_rows: 100 });
    if (r.isError) return `判定查詢失敗:${r.text.slice(0, 300)}`;
    const lines = r.text.split("\n").filter((l) => l.includes("|") || /^\S+$/.test(l));
    const header = lines.findIndex((l) => l.split("|").map((x) => x.trim().toUpperCase()).includes(c.column.toUpperCase()));
    if (header < 0) return `判定查詢沒有欄位 ${c.column}`;
    const idx = lines[header].split("|").map((x) => x.trim().toUpperCase()).indexOf(c.column.toUpperCase());
    const values = lines.slice(header + 1).map((l) => (l.split("|")[idx] ?? "").trim()).filter(Boolean);
    const missing = values.filter((v) => !answer.replace(/,/g, "").includes(v));
    return missing.length ? `回答缺少正確值:${missing.join("、")}(正確值:${values.join("、")})` : undefined;
  };

  const deleteObject = async (uri: string): Promise<string> => {
    const binding = bindingNameFromUri(uri);
    if (binding) {
      // 已發布的 binding 刪除會被拒(Service endpoint … is published):先取消發布;尚未發布或失敗就照常嘗試刪除
      await raw.httpClient
        .request("/sap/bc/adt/businessservices/odatav4/unpublishjobs", {
          method: "POST",
          headers: { "Content-Type": "application/xml", Accept: "application/xml" },
          body: unpublishBody(binding),
        })
        .catch(() => undefined);
    }
    return deleteWithLock(raw, uri);
  };

  return {
    cfg,
    call,
    async setup(task, opts) {
      // 還原基準:先讀、先存檔(事前準備可能注入 bug);讀不到就在動任何東西之前失敗
      originals.clear();
      for (const u of task.restore) originals.set(u, await adt.getObjectSource(u));
      if (opts?.restoreDir && originals.size) {
        fs.mkdirSync(opts.restoreDir, { recursive: true });
        let i = 0;
        for (const [u, src] of originals) {
          fs.writeFileSync(path.join(opts.restoreDir, `${task.id}-${++i}-${u.split("/").slice(-3).join("_")}.abap`), src, "utf8");
        }
      }
      for (const s of task.setup) {
        if (s.tool === "patch") {
          const a = s.args as { object_url: string; find: string; replace: string; all?: boolean; inactive?: boolean };
          const cur = await adt.getObjectSource(a.object_url);
          const p = applyPatch(cur, a.find, a.replace, a.all === true);
          if (p.count === 0) throw new Error(`第 ${task.id} 題事前準備失敗(patch):${a.object_url} 找不到要換掉的字串`);
          if (p.count > 1 && !a.all) throw new Error(`第 ${task.id} 題事前準備失敗(patch):要換掉的字串出現 ${p.count} 次,不是唯一一處(要全部換請加 all: true)`);
          // inactive: true = 注入語法錯誤用:略過語法檢查、不啟用(留下 inactive 版本,active 版本不變)
          const inactive = a.inactive === true;
          const w = await call("write_source", { object_url: a.object_url, new_source: p.source, ...(inactive ? { activate: false, skip_syntax_check: true } : { activate: true }) });
          if (w.isError || (!inactive && !w.text.includes("已啟用"))) throw new Error(`第 ${task.id} 題事前準備失敗(patch ${inactive ? "寫入" : "後未啟用"}):${w.text.slice(0, 400)}`);
          continue;
        }
        if (s.tool === "expect_unit_tests") {
          const a = s.args as { object_url: string; failed_min?: number };
          const r = await call("run_unit_tests", { object_url: a.object_url });
          const c = parseUnitCountsFromText(r.text);
          const need = a.failed_min ?? 1;
          if (r.isError || !c || c.failed + c.classErrors < need) {
            throw new Error(`第 ${task.id} 題事前準備失敗:注入後單元測試沒有失敗(要求至少 ${need} 個失敗,實際:${r.text.slice(0, 200).replace(/\n/g, " ")})`);
          }
          continue;
        }
        const r = await call(s.tool, s.args);
        if (r.isError && !s.allow_error) throw new Error(`第 ${task.id} 題事前準備失敗(${s.tool}):${r.text.slice(0, 400)}`);
      }
      // unchanged 判定的基準
      preAnswer.clear();
      for (const c of task.checks) {
        if (c.kind === "unchanged" && !preAnswer.has(c.object_url)) preAnswer.set(c.object_url, await adt.getObjectSource(c.object_url));
      }
    },
    async check(task, answer) {
      const details: string[] = [];
      for (const c of task.checks) {
        const problem = await runCheck(c, answer).catch((e) => `判定時出錯:${e instanceof Error ? e.message : String(e)}`);
        if (problem) details.push(problem);
      }
      return { passed: details.length === 0, details };
    },
    async cleanup(task) {
      const out: string[] = [];
      for (const u of task.cleanup) out.push(await deleteObject(u));
      return out;
    },
    async restore(task) {
      if (originals.size === 0) return [];
      return restoreSources(
        {
          read: (u) => adt.getObjectSource(u),
          write: async (u, src) => {
            const w = await call("write_source", { object_url: u, new_source: src, activate: true });
            if (w.isError || !w.text.includes("已啟用")) throw new Error(w.text.slice(0, 300));
          },
          hasInactive: async (u) => {
            const base = u.replace(/\/(source\/main|includes\/[^/]+)$/i, "").toLowerCase();
            return (await adt.inactiveObjects()).some((e) => e.uri.toLowerCase().startsWith(base));
          },
          runUnitTests: async (u) => {
            const r = await call("run_unit_tests", { object_url: u });
            if (r.isError) throw new Error(r.text.slice(0, 300));
            return r.text;
          },
        },
        originals,
        task.restoreVerify
      );
    },
    async close() {
      await client.close();
      // 登出評測用的所有 ADT client(C0-10):MCP 用的 RealAdtService 兩個 + 清除用的 raw
      await adt.close();
      await logoutClient(raw);
    },
  };
}
