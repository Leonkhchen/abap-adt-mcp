/**
 * A4H 整合測試 — abap-adt-mcp（連真實 SAP 系統驗證 9 個工具）
 *
 * 透過 MCP Client + InMemoryTransport 呼叫真正註冊的工具，連到真實 SAP 系統。
 * 預設全部略過；需設定環境變數才會執行：
 *
 *   ABAP_MCP_IT=1          執行唯讀組（T01–T07、T14）
 *   ABAP_MCP_IT_WRITE=1    另外執行寫入組（T08–T13、T15–T16），只在 $TMP 建立暫存 class，測完刪除
 *
 * 一般用 npm 指令即可（PowerShell / bash 皆可）：
 *   npm run test:it          唯讀組
 *   npm run test:it:write    唯讀 + 寫入組
 *
 * 連線設定沿用 SAP_URL / SAP_USER / SAP_PASSWORD / SAP_CLIENT（見 .env.example）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ADTClient, session_types } from "abap-adt-api";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { RealAdtService } from "../../src/adt/client.js";
import { AuditLogger } from "../../src/safety/audit.js";
import { registerTools } from "../../src/tools/registry.js";
import { VERSION } from "../../src/version.js";

const RUN = process.env.ABAP_MCP_IT === "1";
const RUN_WRITE = RUN && process.env.ABAP_MCP_IT_WRITE === "1";

/** SAP 標準 class，任何系統都有，用於唯讀測試 */
const STD_CLASS = "/sap/bc/adt/oo/classes/cl_abap_char_utilities";

type ToolResult = { text: string; isError: boolean };

async function startServer(env: NodeJS.ProcessEnv, auditPath = "") {
  const cfg = loadConfig(env);
  const server = new McpServer({ name: "abap-adt-mcp-it", version: VERSION });
  registerTools(server, new RealAdtService(cfg), cfg, new AuditLogger(auditPath));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "it-client", version: "1.0.0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
  };
  return { cfg, client, call, close: () => client.close() };
}

function classSource(name: string, marker: string) {
  const n = name.toLowerCase();
  return [
    `CLASS ${n} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    INTERFACES if_oo_adt_classrun.`,
    `ENDCLASS.`,
    ``,
    `CLASS ${n} IMPLEMENTATION.`,
    `  METHOD if_oo_adt_classrun~main.`,
    `    out->write( '${marker}' ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
  ].join("\n");
}

// ───────────────────────────── 唯讀組 ─────────────────────────────
describe.skipIf(!RUN)("唯讀工具（A4H）", () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer({ ...process.env, ABAP_MCP_READONLY: "true" });
  }, 60_000);
  afterAll(async () => s?.close());

  it("T01 ping_system 回報連線正常", async () => {
    const r = await s.call("ping_system");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("SAP 連線正常");
  }, 60_000);

  it("T02 search_objects 找得到標準 class", async () => {
    const r = await s.call("search_objects", { query: "CL_ABAP_CHAR_UTIL*", max_results: 5 });
    expect(r.isError, r.text).toBe(false);
    expect(r.text.toUpperCase()).toContain("CL_ABAP_CHAR_UTILITIES");
  }, 60_000);

  it("T03 browse_package 可瀏覽 $TMP", async () => {
    const r = await s.call("browse_package", { package_name: "$TMP" });
    expect(r.isError, r.text).toBe(false);
  }, 60_000);

  it("T04 get_object_structure 回傳 source URI", async () => {
    const r = await s.call("get_object_structure", { object_url: STD_CLASS });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("/source/main");
  }, 60_000);

  it("T05 read_source 分段讀取含行號", async () => {
    const r = await s.call("read_source", { object_url: STD_CLASS, start_line: 1, end_line: 10 });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/\s+1\| /);
    expect(r.text).toContain("顯示 1–10");
  }, 60_000);

  it("T06 syntax_check 對系統現行版本可執行", async () => {
    const r = await s.call("syntax_check", { object_url: STD_CLASS });
    expect(r.isError, r.text).toBe(false);
  }, 60_000);

  it("T07 list_transports 可執行", async () => {
    const r = await s.call("list_transports");
    expect(r.isError, r.text).toBe(false);
  }, 60_000);

  it("T14 唯讀模式下不註冊寫入工具", async () => {
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("read_source");
    expect(tools).not.toContain("write_source");
    expect(tools).not.toContain("activate_object");
  }, 60_000);
});

// ───────────────────────────── 寫入組（$TMP） ─────────────────────────────
describe.skipIf(!RUN_WRITE)("寫入工具（A4H，$TMP 暫存物件）", () => {
  const name = `ZCL_MCP_IT_${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const objUrl = `/sap/bc/adt/oo/classes/${name.toLowerCase()}`;
  const auditPath = path.join(os.tmpdir(), `abap-mcp-it-${Date.now()}.jsonl`);
  let s: Awaited<ReturnType<typeof startServer>>;
  let raw: ADTClient;
  let cfg: AppConfig;

  beforeAll(async () => {
    s = await startServer({ ...process.env, ABAP_MCP_READONLY: "false", ABAP_MCP_SYSTEM_ROLE: "dev" }, auditPath);
    cfg = s.cfg;
    raw = new ADTClient(cfg.sap.url, cfg.sap.user, cfg.sap.password, cfg.sap.client, cfg.sap.language);
    await raw.login();
    await raw.createObject({
      objtype: "CLAS/OC",
      name,
      parentName: "$TMP",
      description: "abap-adt-mcp v0.1 IT",
      parentPath: "/sap/bc/adt/packages/%24tmp",
      responsible: cfg.sap.user.toUpperCase(),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      raw.stateful = session_types.stateful;
      const lock = await raw.lock(objUrl);
      await raw.deleteObject(objUrl, lock.LOCK_HANDLE);
    } catch (e) {
      console.error(`清除暫存物件 ${name} 失敗，請在 SE80 / Eclipse 手動刪除：${String(e)}`);
    } finally {
      raw.stateful = session_types.stateless;
      await s?.close();
    }
  }, 60_000);

  it("T08 write_source 寫入並啟用", async () => {
    const r = await s.call("write_source", {
      object_url: objUrl,
      new_source: classSource(name, "MCP-IT-1"),
      activate: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("已寫入");
    expect(r.text).toContain("已啟用");
  }, 60_000);

  it("T09 read_source 讀回剛寫入的內容", async () => {
    const r = await s.call("read_source", { object_url: objUrl });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("MCP-IT-1");
  }, 60_000);

  it("T10 語法錯誤時拒絕寫入，系統內容不變", async () => {
    const bad = classSource(name, "MCP-IT-BAD").replace("ENDMETHOD.", "ENDMETHOD");
    const r = await s.call("write_source", { object_url: objUrl, new_source: bad });
    expect(r.text).toContain("寫入已中止");
    const after = await s.call("read_source", { object_url: objUrl });
    expect(after.text).toContain("MCP-IT-1");
    expect(after.text).not.toContain("MCP-IT-BAD");
  }, 60_000);

  it("T11 expected_current_source 不符時中止（並行保護）", async () => {
    const r = await s.call("write_source", {
      object_url: objUrl,
      new_source: classSource(name, "MCP-IT-2"),
      expected_current_source: "這不是目前的內容",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("不一致");
  }, 60_000);

  it("T12 activate_object 可單獨啟用", async () => {
    const r = await s.call("activate_object", { object_url: objUrl });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("啟用成功");
  }, 60_000);

  it("T13 白名單外的標準物件被擋下，不會鎖定或寫入", async () => {
    const r = await s.call("write_source", { object_url: STD_CLASS, new_source: "* should never be written" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("白名單");
  });

  it("T15 前面各步驟沒有留下殘留鎖定", async () => {
    raw.stateful = session_types.stateful;
    try {
      const lock = await raw.lock(objUrl);
      await raw.unLock(objUrl, lock.LOCK_HANDLE);
    } finally {
      raw.stateful = session_types.stateless;
    }
  }, 60_000);

  it("T16 audit log 有寫入與啟用紀錄，且不含密碼", async () => {
    const log = fs.readFileSync(auditPath, "utf8");
    const entries = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.some((e) => e.action === "write_source" && e.success && e.objectName === name)).toBe(true);
    expect(entries.some((e) => e.action === "activate" && e.objectName === name)).toBe(true);
    expect(log).not.toContain(cfg.sap.password);
  });
});
