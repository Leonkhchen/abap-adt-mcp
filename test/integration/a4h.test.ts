/**
 * A4H 整合測試 — abap-adt-mcp（連真實 SAP 系統驗證所有工具）
 *
 * 透過 MCP Client + InMemoryTransport 呼叫真正註冊的工具，連到真實 SAP 系統。
 * 預設全部略過；需設定環境變數才會執行：
 *
 *   ABAP_MCP_IT=1          執行唯讀組（T01–T07、T14、T35–T36）
 *   ABAP_MCP_IT_WRITE=1    另外執行寫入組（T08–T13、T15–T16）、v0.3 開發循環組（T17–T22）、v0.4 診斷組（T23–T30）與 v0.5 RAP 組（T31–T34），
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
import type { RapObjectRef } from "../../src/adt/rapGenerator.js";

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

// ───────────────────────────── v0.4 診斷組（$TMP） ─────────────────────────────
describe.skipIf(!RUN_WRITE)("v0.4 診斷與資料工具（A4H，$TMP 暫存物件）", () => {
  const sfx = Date.now().toString(36).toUpperCase().slice(-6);
  const DMP = `ZCL_MCP_IT4D_${sfx}`; // T26 會短傾印
  const INA = `ZCL_MCP_IT4I_${sfx}`; // T28 inactive
  const REV = `ZCL_MCP_IT4R_${sfx}`; // T29 / T30 版本與並行
  const url = (n: string) => `/sap/bc/adt/oo/classes/${n.toLowerCase()}`;
  const simple = (n: string, marker: string) =>
    [
      `CLASS ${n.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS m RETURNING VALUE(r) TYPE string.`,
      `ENDCLASS.`,
      ``,
      `CLASS ${n.toLowerCase()} IMPLEMENTATION.`,
      `  METHOD m.`,
      `    r = '${marker}'.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
    ].join("\n");
  // 第 9 行除以零(dump_detail 應指出 source/main 第 9 行)
  const dumpSource = [
    `CLASS ${DMP.toLowerCase()} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    INTERFACES if_oo_adt_classrun.`,
    `ENDCLASS.`,
    ``,
    `CLASS ${DMP.toLowerCase()} IMPLEMENTATION.`,
    `  METHOD if_oo_adt_classrun~main.`,
    `    DATA(zero) = 0.`,
    `    DATA(result) = 10 / zero.`,
    `    out->write( result ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
  ].join("\n");

  let s: Awaited<ReturnType<typeof startServer>>;
  let raw: ADTClient;

  beforeAll(async () => {
    s = await startServer({
      ...process.env,
      ABAP_MCP_READONLY: "false",
      ABAP_MCP_SYSTEM_ROLE: "dev",
      ABAP_MCP_ALLOW_DATA_PREVIEW: "true",
    });
    raw = new ADTClient(s.cfg.sap.url, s.cfg.sap.user, s.cfg.sap.password, s.cfg.sap.client, s.cfg.sap.language);
    await raw.login();
    for (const n of [DMP, INA, REV]) {
      const r = await s.call("create_object", { object_type: "CLAS/OC", name: n, package_name: "$TMP", description: "abap-adt-mcp IT4" });
      if (r.isError) throw new Error(r.text);
    }
  }, 300_000);

  afterAll(async () => {
    for (const u of [DMP, INA, REV].map(url)) {
      try {
        raw.stateful = session_types.stateful;
        const lock = await raw.lock(u);
        await raw.deleteObject(u, lock.LOCK_HANDLE);
      } catch (e) {
        if (!/does not exist|not found|404/i.test(String(e))) {
          console.error(`清除暫存物件 ${u} 失敗,請在 Eclipse 的 $TMP 手動刪除:${String(e)}`);
        }
      } finally {
        raw.stateful = session_types.stateless;
      }
    }
    await s?.close();
  }, 300_000);

  it("T23 data_preview 未開啟時工具不存在", async () => {
    const off = await startServer({ ...process.env, ABAP_MCP_ALLOW_DATA_PREVIEW: "false" });
    try {
      const tools = (await off.client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("ddic_info");
      expect(tools).not.toContain("data_preview");
    } finally {
      await off.close();
    }
  }, 60_000);

  it("T24 data_preview 查 /DMO/TRAVEL 前 5 筆;UPDATE / 多語句 / 白名單外的表被拒", async () => {
    const r = await s.call("data_preview", { table: "/DMO/TRAVEL", max_rows: 5 });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("📊 5 筆");
    expect(r.text).toContain("TRAVEL_ID");
    const q = await s.call("data_preview", { sql: "SELECT status, COUNT(*) AS cnt FROM /dmo/travel GROUP BY status" });
    expect(q.isError, q.text).toBe(false);
    expect(q.text).toMatch(/STATUS \| CNT/);
    for (const bad of [
      { sql: "UPDATE /dmo/travel SET status = 'X'" },
      { sql: "SELECT * FROM /dmo/travel; DELETE FROM /dmo/travel" },
      { table: "USR02" },
      { sql: "SELECT bname FROM usr02" },
    ]) {
      const x = await s.call("data_preview", bad);
      expect(x.isError, JSON.stringify(bad)).toBe(true);
      expect(x.text).toContain("已拒絕");
    }
  }, 300_000);

  it("T25 ddic_info 讀 /DMO/TRAVEL 欄位", async () => {
    const r = await s.call("ddic_info", { name: "/DMO/TRAVEL" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("[TABL/DT 資料表]");
    expect(r.text).toContain("欄位(15 個)");
    expect(r.text).toContain("travel_id | key | /dmo/travel_id | numc | 8");
  }, 300_000);

  it("T26 run_class 觸發短傾印 → list_dumps 找得到 → dump_detail 指出第 9 行", async () => {
    const w = await s.call("write_source", { object_url: url(DMP), new_source: dumpSource, activate: true });
    expect(w.isError, w.text).toBe(false);
    const run = await s.call("run_class", { class_name: DMP });
    expect(run.isError).toBe(true);
    expect(run.text).toContain("執行時發生短傾印:COMPUTE_INT_ZERODIVIDE");
    const id = run.text.match(/dump_id:(\S+)/)?.[1] ?? "";
    expect(id).toMatch(/^\/sap\/bc\/adt\/runtime\/dump\//);
    const list = await s.call("list_dumps", { user: s.cfg.sap.user, max_results: 20 });
    expect(list.text).toContain(id);
    const d = await s.call("dump_detail", { dump_id: id });
    expect(d.isError, d.text).toBe(false);
    expect(d.text).toContain(`${url(DMP)}/source/main 第 9 行`);
    expect(d.text).toContain("CX_SY_ZERODIVIDE");
    expect(d.text).not.toContain("Selected Variables");
  }, 300_000);

  it("T27 pretty_print 回傳格式化結果且系統內容不變", async () => {
    const lower = simple(REV, "PP").replace("METHODS m", "methods m").replace("ENDMETHOD.", "endmethod.");
    const w = await s.call("write_source", { object_url: url(REV), new_source: lower, activate: true });
    expect(w.isError, w.text).toBe(false);
    const before = await s.call("read_source", { object_url: url(REV) });
    const p = await s.call("pretty_print", { object_url: url(REV) });
    expect(p.isError, p.text).toBe(false);
    expect(p.text).toContain("METHODS m RETURNING");
    expect(p.text).toContain("ENDMETHOD.");
    expect(p.text).toContain("尚未寫回系統");
    const after = await s.call("read_source", { object_url: url(REV) });
    expect(after.text).toBe(before.text);
    expect(after.text).toContain("methods m");
  }, 300_000);

  it("T28 list_inactive 列出 inactive 物件;activate_objects 白名單外整批拒絕、白名單內成功", async () => {
    const w = await s.call("write_source", { object_url: url(INA), new_source: simple(INA, "INACTIVE") });
    expect(w.isError, w.text).toBe(false);
    const l1 = await s.call("list_inactive");
    expect(l1.text).toContain(INA);
    const denied = await s.call("activate_objects", { object_urls: [url(INA), "/sap/bc/adt/oo/classes/cl_abap_char_utilities"] });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("整批拒絕");
    expect((await s.call("list_inactive")).text).toContain(INA);
    const okr = await s.call("activate_objects", { object_urls: [url(INA)] });
    expect(okr.isError, okr.text).toBe(false);
    expect(okr.text).toContain(`已啟用 1 個物件:${INA}`);
    expect((await s.call("list_inactive")).text).not.toContain(INA);
  }, 300_000);

  it("T29 write_source 兩次後 get_revisions 列得到版本並能比較", async () => {
    const v1 = await s.call("write_source", { object_url: url(REV), new_source: simple(REV, "V1"), activate: true });
    expect(v1.isError, v1.text).toBe(false);
    const v2 = await s.call("write_source", { object_url: url(REV), new_source: simple(REV, "V2") });
    expect(v2.isError, v2.text).toBe(false);
    const r = await s.call("get_revisions", { object_url: url(REV), compare_from: 2, compare_to: 1 });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("inactive");
    expect(r.text).toContain("active");
    expect(r.text).toContain("-    r = 'V1'.");
    expect(r.text).toContain("+    r = 'V2'.");
  }, 300_000);

  it("T30 回歸:write_source 鎖定期間並行執行 data_preview 與 read_source,三者都成功", async () => {
    const [w, dp, rd] = await Promise.all([
      s.call("write_source", { object_url: url(REV), new_source: simple(REV, "PARALLEL"), activate: true }),
      s.call("data_preview", { table: "/DMO/FLIGHT", max_rows: 3 }),
      s.call("read_source", { object_url: url(INA) }),
    ]);
    expect(w.isError, w.text).toBe(false);
    expect(w.text).toContain("已啟用");
    expect(dp.isError, dp.text).toBe(false);
    expect(dp.text).toContain("📊 3 筆");
    expect(rd.isError, rd.text).toBe(false);
    expect(rd.text).toContain("INACTIVE");
    // 寫入確實生效、沒有殘留鎖定
    expect((await s.call("read_source", { object_url: url(REV) })).text).toContain("PARALLEL");
    raw.stateful = session_types.stateful;
    try {
      const lock = await raw.lock(url(REV));
      await raw.unLock(url(REV), lock.LOCK_HANDLE);
    } finally {
      raw.stateful = session_types.stateless;
    }
  }, 300_000);
});

// ───────────────────────────── v0.5 唯讀:abapGit、prompts / resources ─────────────────────────────
describe.skipIf(!RUN)("v0.5 abapGit 與引導(A4H,唯讀)", () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    // 唯讀模式也要有 abapgit_repos、prompts 與 resources
    s = await startServer({ ...process.env, ABAP_MCP_READONLY: "true" });
  }, 120_000);
  afterAll(async () => s?.close());

  it("T35 abapgit_repos:A4H 沒有 abapGit ADT 後端時回報說明並指向 ZABAPGIT_STANDALONE", async () => {
    const r = await s.call("abapgit_repos");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("ℹ️ 此系統沒有 abapGit ADT 後端");
    expect(r.text).toContain("ZABAPGIT_STANDALONE");
    // 只讀:不提供 pull / push / stage 工具
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("abapgit_repos");
    expect(tools.filter((t) => /abapgit_(pull|push|stage)/.test(t))).toEqual([]);
  }, 120_000);

  it("T36 prompts / resources 列得出來且內容可讀", async () => {
    const prompts = (await s.client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["clean-abap-review", "fix-dump", "rap-bo-from-table"]);
    const resources = (await s.client.listResources()).resources.map((r) => r.uri).sort();
    expect(resources).toEqual(["abap-mcp://guides/clean-abap", "abap-mcp://guides/naming", "abap-mcp://guides/safety"]);
    const safety = ((await s.client.readResource({ uri: "abap-mcp://guides/safety" })).contents[0] as { text: string }).text;
    expect(safety).not.toContain(s.cfg.sap.password);
    const clean = ((await s.client.readResource({ uri: "abap-mcp://guides/clean-abap" })).contents[0] as { text: string }).text;
    expect(clean).toContain("https://github.com/SAP/styleguides");
    const p = await s.client.getPrompt({ name: "rap-bo-from-table", arguments: { table_name: "ZDEMO_TAB" } });
    expect((p.messages[0].content as { text: string }).text).toContain("ZDEMO_TAB");
  }, 120_000);
});

// ───────────────────────────── v0.5 寫入:TABL 與 RAP 產生器 ─────────────────────────────
describe.skipIf(!RUN_WRITE)("v0.5 TABL 與 RAP 產生器(A4H,$TMP 暫存物件)", () => {
  const sfx = Date.now().toString(36).toUpperCase().slice(-6);
  const TAB = `ZMI5${sfx}`; // 10 字元;產生器預設名稱 ZR_MI5…、ZUI_MI5…_O4、草稿表 ZMI5…_D
  const tableUri = `/sap/bc/adt/ddic/tables/${TAB.toLowerCase()}`;
  const tableSource = [
    `@EndUserText.label : 'abap-adt-mcp IT5 RAP source'`,
    `@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE`,
    `@AbapCatalog.tableCategory : #TRANSPARENT`,
    `@AbapCatalog.deliveryClass : #A`,
    `@AbapCatalog.dataMaintenance : #RESTRICTED`,
    `define table ${TAB.toLowerCase()} {`,
    `  key client            : abap.clnt not null;`,
    `  key uuid              : sysuuid_x16 not null;`,
    `  name                  : abap.char(40);`,
    `  amount                : abap.dec(15,2);`,
    `  local_created_by      : abp_creation_user;`,
    `  local_created_at      : abp_creation_tstmpl;`,
    `  local_last_changed_by : abp_locinst_lastchange_user;`,
    `  local_last_changed_at : abp_locinst_lastchange_tstmpl;`,
    `  last_changed_at       : abp_lastchange_tstmpl;`,
    `}`,
  ].join("\n");

  let s: Awaited<ReturnType<typeof startServer>>;
  let raw: ADTClient;
  /** 產生器預覽列出的物件(含 URI),清除時依相依關係由外而內刪除 */
  let planned: RapObjectRef[] = [];

  /** 刪除順序:binding → definition → metadata ext. → access control → behavior → BP class → CDS → SAP object type → 草稿表(projection 先於 base);來源表最後 */
  const RANK = ["SRVB", "SRVD", "DDLX", "DCLS", "BDEF", "CLAS", "DDLS", "RONT", "NONT", "TABL"];
  const deleteOrder = (objs: RapObjectRef[]) =>
    [...objs].sort((a, b) => {
      const ra = RANK.indexOf(a.type.split("/")[0]);
      const rb = RANK.indexOf(b.type.split("/")[0]);
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      const proj = (o: RapObjectRef) => (/^[ZY]C_|_C_/.test(o.name.toUpperCase()) ? 0 : 1);
      return proj(a) - proj(b);
    });

  const exists = async (name: string, type: string) =>
    (await raw.searchObject(name, type, 5)).some((h) => h["adtcore:name"].toUpperCase() === name.toUpperCase() && h["adtcore:type"] === type);

  async function deleteUri(u: string): Promise<void> {
    raw.stateful = session_types.stateful;
    try {
      const lock = await raw.lock(u);
      await raw.deleteObject(u, lock.LOCK_HANDLE);
    } finally {
      raw.stateful = session_types.stateless;
    }
  }

  beforeAll(async () => {
    s = await startServer({ ...process.env, ABAP_MCP_READONLY: "false", ABAP_MCP_SYSTEM_ROLE: "dev" });
    raw = new ADTClient(s.cfg.sap.url, s.cfg.sap.user, s.cfg.sap.password, s.cfg.sap.client, s.cfg.sap.language);
    await raw.login();
  }, 120_000);

  afterAll(async () => {
    // 預覽清單沒拿到時,至少試刪來源表
    const uris = [...deleteOrder(planned).map((o) => o.uri).filter((u) => u !== tableUri), tableUri];
    for (const u of uris) {
      try {
        await deleteUri(u);
      } catch (e) {
        if (/does not exist|not found|404/i.test(String(e))) continue;
        let err: unknown = e;
        if (u.includes("/businessservices/bindings/")) {
          // 已發佈的 binding 可能要先取消發佈
          try {
            const name = u.split("/").pop()!.toUpperCase();
            await raw.httpClient.request("/sap/bc/adt/businessservices/odatav4/unpublishjobs", {
              method: "POST",
              headers: { "Content-Type": "application/xml", Accept: "application/xml" },
              body:
                `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
                `<adtcore:objectReference adtcore:type="SCGR" adtcore:name="${name}"/></adtcore:objectReferences>`,
            });
            await deleteUri(u);
            continue;
          } catch (e2) {
            err = e2;
          }
        }
        console.error(`清除暫存物件 ${u} 失敗,請在 Eclipse 的 $TMP 手動刪除:${String(err)}`);
      }
    }
    await s?.close();
  }, 600_000);

  it("T31 create_object TABL/DT → write_source 定義欄位並啟用 → ddic_info 讀得到", async () => {
    const c = await s.call("create_object", { object_type: "TABL/DT", name: TAB, package_name: "$TMP", description: "abap-adt-mcp IT5" });
    expect(c.isError, c.text).toBe(false);
    const w = await s.call("write_source", { object_url: tableUri, new_source: tableSource, activate: true });
    expect(w.isError, w.text).toBe(false);
    expect(w.text).toContain("已啟用");
    const d = await s.call("ddic_info", { name: TAB, object_type: "TABL/DT" });
    expect(d.isError, d.text).toBe(false);
    expect(d.text).toContain("local_last_changed_at");
    const tooLong = await s.call("create_object", { object_type: "TABL/DT", name: "ZMCP_NAME_TOO_LONG_X", package_name: "$TMP", description: "x" });
    expect(tooLong.isError).toBe(true);
  }, 300_000);

  it("T32 rap_generate 預設只預覽:列出物件與 binding,系統裡沒有建立任何物件", async () => {
    const svc = new RealAdtService(s.cfg);
    const links = await svc.rapGeneratorLinks(tableUri);
    expect(links, "A4H 應有 ui-service 產生器").toBeDefined();
    planned = (await svc.rapPreview(links!, tableUri, "$TMP")).objects;
    expect(planned.length).toBeGreaterThanOrEqual(10);

    const r = await s.call("rap_generate", { source_table: TAB, package_name: "$TMP" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("🔍 預覽(尚未建立任何物件)");
    expect(r.text).toContain(`service binding:ZUI_${TAB.slice(1)}_O4`);
    expect(r.text).toContain("confirm=true");
    const binding = planned.find((o) => o.type === "SRVB/SVB");
    const rootView = planned.find((o) => o.type === "DDLS/DF" && /^ZR_/.test(o.name));
    expect(binding && rootView).toBeTruthy();
    expect(await exists(binding!.name, binding!.type)).toBe(false);
    expect(await exists(rootView!.name, rootView!.type)).toBe(false);
  }, 600_000);

  it("T33 白名單:名稱前綴或 package 不符時 confirm 也整批拒絕,不建立任何物件", async () => {
    const narrow = await startServer({
      ...process.env,
      ABAP_MCP_READONLY: "false",
      ABAP_MCP_SYSTEM_ROLE: "dev",
      // 只允許來源表自己的前綴 → 產生器預設的 ZR_ / ZC_ / ZBP_ / ZUI_ 名稱都不在白名單內
      ABAP_MCP_ALLOWED_PREFIXES: TAB,
    });
    try {
      const pv = await narrow.call("rap_generate", { source_table: TAB, package_name: "$TMP" });
      expect(pv.text).toContain("⚠️ 以下物件不在可寫入的名稱白名單內");
      const r = await narrow.call("rap_generate", { source_table: TAB, package_name: "$TMP", confirm: true });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("整批拒絕,沒有產生任何物件");
    } finally {
      await narrow.close();
    }
    const pkg = await s.call("rap_generate", { source_table: TAB, package_name: "ZNOT_ALLOWED_PKG", confirm: true, transport: "A4HK900001" });
    expect(pkg.isError).toBe(true);
    expect(pkg.text).toContain("不在允許的 package 白名單內");
    for (const o of planned.filter((x) => x.type === "SRVB/SVB" || x.type === "DDLS/DF")) {
      expect(await exists(o.name, o.type), o.name).toBe(false);
    }
  }, 600_000);

  it("T34 confirm=true 實際產生並發佈:物件都存在、回傳 OData V4 服務網址與 Fiori preview 說明", async () => {
    // A4H 熱機約 3–4 分鐘;剛啟動時可能超過 5 分鐘而回 5xx(工具會回報已存在/缺少的物件)
    const r = await s.call("rap_generate", { source_table: TAB, package_name: "$TMP", confirm: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain(`✅ 已在 package $TMP 由 ${TAB} 產生 ${planned.length} 個物件`);
    expect(r.text).toContain("✅ 已發佈");
    expect(r.text).toMatch(/OData V4 服務:http\S+\/sap\/opu\/odata4\//);
    expect(r.text).toContain("Fiori Elements preview");
    for (const o of planned.filter((x) => ["SRVB/SVB", "SRVD/SRV", "BDEF/BDO", "DDLS/DF"].includes(x.type))) {
      expect(await exists(o.name, o.type), o.name).toBe(true);
    }
  }, 900_000);
});
