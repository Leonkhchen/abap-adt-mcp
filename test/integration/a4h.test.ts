/**
 * A4H 整合測試 — abap-adt-mcp（連真實 SAP 系統驗證所有工具）
 *
 * 透過 MCP Client + InMemoryTransport 呼叫真正註冊的工具，連到真實 SAP 系統。
 * 預設全部略過；需設定環境變數才會執行：
 *
 *   ABAP_MCP_IT=1          執行唯讀組（T01–T07、T14）
 *   ABAP_MCP_IT_WRITE=1    另外執行寫入組（T08–T13、T15–T16）與 v0.3 開發循環組（T17–T22），
 *                          只在 $TMP 建立暫存物件，測完全部刪除
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
    // MCP SDK 預設請求逾時 60 秒;ATC / 首次啟用 CDS 在 A4H 可能更久
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as {
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

// ───────────────────────────── v0.3 開發循環組（$TMP） ─────────────────────────────
describe.skipIf(!RUN_WRITE)("v0.3 開發循環工具（A4H，$TMP 暫存物件）", () => {
  const sfx = Date.now().toString(36).toUpperCase().slice(-6);
  const CLS = `ZCL_MCP_IT3_${sfx}`;
  const INTF = `ZIF_MCP_IT3_${sfx}`;
  const PROG = `ZMCP_IT3_${sfx}`;
  const CDS = `ZI_MCP_IT3_${sfx}`;
  const url = {
    cls: `/sap/bc/adt/oo/classes/${CLS.toLowerCase()}`,
    intf: `/sap/bc/adt/oo/interfaces/${INTF.toLowerCase()}`,
    prog: `/sap/bc/adt/programs/programs/${PROG.toLowerCase()}`,
    cds: `/sap/bc/adt/ddic/ddl/sources/${CDS.toLowerCase()}`,
    bdef: `/sap/bc/adt/bo/behaviordefinitions/${CDS.toLowerCase()}`,
  };
  const n = CLS.toLowerCase();
  const mainSource = [
    `CLASS ${n} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    INTERFACES if_oo_adt_classrun.`,
    `    METHODS add IMPORTING a TYPE i b TYPE i RETURNING VALUE(r) TYPE i.`,
    `    METHODS ping_remote.`,
    `ENDCLASS.`,
    ``,
    `CLASS ${n} IMPLEMENTATION.`,
    `  METHOD if_oo_adt_classrun~main.`,
    `    out->write( |MCP-IT3-RUN-{ add( a = 2 b = 3 ) }| ).`,
    `  ENDMETHOD.`,
    ``,
    `  METHOD add.`,
    `    r = a + b.`,
    `  ENDMETHOD.`,
    ``,
    `  METHOD ping_remote.`,
    `    " T19:故意使用未釋出的 API,讓 ATC 有東西可抓`,
    `    CALL FUNCTION 'RFC_PING'.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
  ].join("\n");
  const testSource = [
    `CLASS ltc_it3 DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.`,
    `  PRIVATE SECTION.`,
    `    METHODS green FOR TESTING.`,
    `    METHODS red FOR TESTING.`,
    `ENDCLASS.`,
    ``,
    `CLASS ltc_it3 IMPLEMENTATION.`,
    `  METHOD green.`,
    `    cl_abap_unit_assert=>assert_equals( act = NEW ${n}( )->add( a = 1 b = 2 ) exp = 3 ).`,
    `  ENDMETHOD.`,
    ``,
    `  METHOD red.`,
    `    cl_abap_unit_assert=>assert_equals( act = NEW ${n}( )->add( a = 1 b = 2 ) exp = 4 msg = 'MCP-IT3-RED' ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
  ].join("\n");
  const cdsSource = [
    `@EndUserText.label: 'abap-adt-mcp IT3'`,
    `define root view entity ${CDS} as select from t000 {`,
    `  key mandt as Client,`,
    `      mtext as Name`,
    `}`,
  ].join("\n");
  /** 1 起算的行與欄:第一個含 needle 的行,欄位指向 needle 開頭(再加 offset) */
  const pos = (source: string, needle: string, offset = 0) => {
    const lines = source.split("\n");
    const i = lines.findIndex((l) => l.includes(needle));
    return { line: i + 1, column: lines[i].indexOf(needle) + 1 + offset };
  };

  let s: Awaited<ReturnType<typeof startServer>>;
  let raw: ADTClient;

  beforeAll(async () => {
    s = await startServer({ ...process.env, ABAP_MCP_READONLY: "false", ABAP_MCP_SYSTEM_ROLE: "dev" });
    raw = new ADTClient(s.cfg.sap.url, s.cfg.sap.user, s.cfg.sap.password, s.cfg.sap.client, s.cfg.sap.language);
    await raw.login();
  }, 60_000);

  afterAll(async () => {
    // BDEF 須先於其 root entity(CDS)刪除;每個物件個別處理,一個失敗不影響其他
    for (const u of [url.bdef, url.cds, url.prog, url.intf, url.cls]) {
      try {
        raw.stateful = session_types.stateful;
        const lock = await raw.lock(u);
        await raw.deleteObject(u, lock.LOCK_HANDLE);
      } catch (e) {
        const msg = String(e);
        // 物件本來就沒建立成功時不算清除失敗
        if (!/does not exist|not found|404/i.test(msg)) {
          console.error(`清除暫存物件 ${u} 失敗,請在 Eclipse 的 $TMP 手動刪除:${msg}`);
        }
      } finally {
        raw.stateful = session_types.stateless;
      }
    }
    await s?.close();
  }, 300_000);

  it("T17 create_object 五種類型(CLAS/OC、INTF/OI、PROG/P、DDLS/DF、BDEF/BDO)", async () => {
    for (const [object_type, name] of [["CLAS/OC", CLS], ["INTF/OI", INTF], ["PROG/P", PROG], ["DDLS/DF", CDS]]) {
      const r = await s.call("create_object", { object_type, name, package_name: "$TMP", description: "abap-adt-mcp IT3" });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toContain(`已建立 ${object_type} ${name}`);
    }
    // BDEF 的名稱必須是已啟用的 root view entity:先寫入並啟用 CDS(也驗證 DDLS 的語法檢查與啟用)
    const w = await s.call("write_source", { object_url: url.cds, new_source: cdsSource, activate: true });
    expect(w.isError, w.text).toBe(false);
    expect(w.text).toContain("已啟用");
    const b = await s.call("create_object", { object_type: "BDEF/BDO", name: CDS, package_name: "$TMP", description: "abap-adt-mcp IT3" });
    expect(b.isError, b.text).toBe(false);
    expect(b.text).toContain(`已建立 BDEF/BDO ${CDS}`);
    // 名稱重複會被 validation 擋下
    const dup = await s.call("create_object", { object_type: "CLAS/OC", name: CLS, package_name: "$TMP", description: "dup" });
    expect(dup.text).toContain("無法建立");
  }, 600_000);

  it("T18 run_unit_tests 一綠一紅(含寫入測試 include)", async () => {
    const m = await s.call("write_source", { object_url: url.cls, new_source: mainSource });
    expect(m.isError, m.text).toBe(false);
    const t = await s.call("write_source", { object_url: `${url.cls}/includes/testclasses`, new_source: testSource, activate: true });
    expect(t.isError, t.text).toBe(false);
    expect(t.text).toContain("已啟用");
    const r = await s.call("run_unit_tests", { object_url: url.cls });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("2 個測試方法,1 通過,1 失敗");
    expect(r.text).toContain("LTC_IT3->RED");
    expect(r.text).toContain("Expected [4] Actual [3]");
    expect(r.text).toContain("✅ ");
  }, 600_000);

  it("T19 run_atc 抓到故意放的問題(未釋出 API RFC_PING)", async () => {
    const r = await s.call("run_atc", { object_url: url.cls });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("優先級 1");
    expect(r.text).toMatch(/not released/i);
  }, 600_000);

  it("T20 where_used 找到方法 ADD 在測試 include 的使用處", async () => {
    const r = await s.call("where_used", { object_url: url.cls, ...pos(mainSource, "METHODS add", "METHODS ".length) });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("includes/testclasses");
    expect(r.text).toMatch(/第 \d+ 行:.*->add\(/);
  }, 600_000);

  it("T21 find_definition / class_components", async () => {
    const d = await s.call("find_definition", { object_url: `${url.cls}/includes/testclasses`, ...pos(testSource, "->add(", 2) });
    expect(d.isError, d.text).toBe(false);
    expect(d.text).toContain(`${url.cls}/source/main`);
    expect(d.text).toContain("METHODS add");
    const c = await s.call("class_components", { object_url: url.cls });
    expect(c.isError, c.text).toBe(false);
    expect(c.text).toContain("ADD(方法,public,instance)");
    expect(c.text).toContain("LTC_IT3(本地類別)");
  }, 600_000);

  it("T22 run_class 讀到 marker", async () => {
    const r = await s.call("run_class", { class_name: CLS });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("MCP-IT3-RUN-5");
  }, 600_000);
});
