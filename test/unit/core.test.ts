/**
 * 單元測試 — 不需要真實 SAP 系統
 * 重點驗證:
 *  1. 安全護欄(唯讀/prod/前綴白名單)
 *  2. lockedWrite 的鎖定釋放保證(成功、寫入失敗、並行衝突)
 *  3. 設定載入(prod 強制唯讀)
 *  4. 錯誤翻譯
 */
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, hasUnquotedHashPassword, warnIfPasswordUnquoted } from "../../src/config.js";
import {
  assertWriteAllowed,
  assertPackageAllowed,
  packageMatches,
  objectNameFromUrl,
  GuardViolationError,
} from "../../src/safety/guards.js";
import { lockedWrite, ConcurrentModificationError } from "../../src/workflows/lockedWrite.js";
import { translateAdtError, AuthCircuitOpenError } from "../../src/adt/errors.js";
import { diffSummary } from "../../src/safety/audit.js";
import * as https from "node:https";
import {
  RealAdtService,
  adtClientOptions,
  identifierAt,
  packageFromObjectXml,
  type AdtService,
} from "../../src/adt/client.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { session_types, type ADTClient } from "abap-adt-api";
import { registerTools } from "../../src/tools/registry.js";
import { AuditLogger } from "../../src/safety/audit.js";
import { VERSION } from "../../src/version.js";
import { SerialQueue } from "../../src/safety/serialQueue.js";
import {
  baseObjectUrl,
  bdefCreateBody,
  isSourceUrl,
  isTestClassesInclude,
  newObjectUrl,
  parseValidation,
} from "../../src/adt/objectTypes.js";
import {
  formatAtcResult,
  formatClassComponents,
  formatDataElement,
  formatDdicFields,
  formatDomain,
  formatQueryResult,
  formatUnitTestResults,
  formatWhereUsed,
} from "../../src/tools/formatters.js";
import { assertTablesAllowed, validateSelectSql } from "../../src/safety/sql.js";
import { parseUsageReferences, parseUsageSnippets, usageSnippetsBody } from "../../src/adt/whereUsed.js";
import type { UnitTestClass } from "abap-adt-api";

// ───────────────────────── 測試用假物件 ─────────────────────────

const baseEnv = {
  SAP_URL: "https://sap.example.com:44300",
  SAP_USER: "DEVELOPER",
  SAP_PASSWORD: "secret",
};

function makeConfig(extra: Record<string, string> = {}) {
  return loadConfig({ ...baseEnv, ...extra } as NodeJS.ProcessEnv);
}

/** 建立 mock AdtService,可注入各方法行為 */
function mockAdt(overrides: Partial<AdtService> = {}): AdtService {
  return {
    login: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ elapsedMs: 12 })),
    searchObject: vi.fn(async () => []),
    objectStructure: vi.fn(async () => ({} as never)),
    objectPackage: vi.fn(async () => "$TMP"),
    mainInclude: vi.fn(() => "/sap/bc/adt/oo/classes/zcl_demo/source/main"),
    getObjectSource: vi.fn(async () => "old source"),
    setObjectSource: vi.fn(async () => {}),
    lock: vi.fn(async () => ({ LOCK_HANDLE: "LH-123" } as never)),
    unLock: vi.fn(async () => {}),
    createTestInclude: vi.fn(async () => {}),
    activate: vi.fn(async () => ({ success: true, messages: [] } as never)),
    syntaxCheck: vi.fn(async () => []),
    nodeContents: vi.fn(async () => ({ nodes: [] } as never)),
    transportInfo: vi.fn(async () => ({} as never)),
    userTransports: vi.fn(async () => ({ workbench: [] } as never)),
    validateNewObject: vi.fn(async () => ({ ok: true, message: "" })),
    createObject: vi.fn(async () => {}),
    runUnitTests: vi.fn(async () => []),
    runAtc: vi.fn(async () => ({ checkVariant: "V", infos: [], findings: [] })),
    whereUsed: vi.fn(async () => ({ objects: [], snippets: [] })),
    findDefinition: vi.fn(async () => ({ identifier: "x", url: "", line: 0, column: 0, sourceLine: "" })),
    runClass: vi.fn(async () => ""),
    createTransport: vi.fn(async () => ""),
    tableContents: vi.fn(async () => ({ columns: [], values: [] }) as never),
    ddicElement: vi.fn(async () => ({ type: "", name: "", properties: { elementProps: false, annotations: [] }, children: [] }) as never),
    dataElementProperties: vi.fn(async () => ({ metaData: { name: "" }, properties: {} })),
    domainProperties: vi.fn(async () => ({ metaData: { name: "" }, properties: {} })),
    runQuery: vi.fn(async () => ({ columns: [], values: [] }) as never),
    classComponents: vi.fn(async () => ({ "adtcore:name": "ZCL_X", "adtcore:type": "CLAS/OC", visibility: "public", links: [], components: [] }) as never),
    username: () => "DEVELOPER",
    baseUrl: () => "https://sap.example.com:44300",
    ...overrides,
  };
}

/** 建立假的 ADTClient(只實作 RealAdtService 會用到的部分) */
function fakeAdtClient(overrides: Record<string, unknown> = {}) {
  const fake = {
    stateful: session_types.stateless as string,
    loggedin: true,
    httpClient: { request: vi.fn(async () => ({ status: 200 })) },
    login: vi.fn(async () => {}),
    searchObject: vi.fn(async () => []),
    lock: vi.fn(async () => ({ LOCK_HANDLE: "LH-1" })),
    unLock: vi.fn(async () => {}),
    ...overrides,
  };
  return fake;
}

function realAdt(fake: ReturnType<typeof fakeAdtClient>, cfg = makeConfig()) {
  return new RealAdtService(cfg, fake as unknown as ADTClient);
}

/** 以 InMemoryTransport 連上 registerTools,回傳呼叫工具的函式 */
async function connectTools(adt: AdtService, cfg = makeConfig()) {
  const server = new McpServer({ name: "unit", version: "0.0.0" });
  registerTools(server, adt, cfg, new AuditLogger(""));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "unit-client", version: "0.0.0" });
  await client.connect(clientT);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { text: r.content.map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
  };
}

// ───────────────────────── ping(A1)─────────────────────────

describe("ping", () => {
  it("每次 ping 都實際發出請求,不因先前成功而略過", async () => {
    const fake = fakeAdtClient();
    const adt = realAdt(fake);
    await adt.ping();
    await adt.ping();
    expect(fake.httpClient.request).toHaveBeenCalledTimes(2);
  });

  it("SAP 連不上時 ping 丟出錯誤(即使先前成功過)", async () => {
    const fake = fakeAdtClient();
    const adt = realAdt(fake);
    await adt.ping();
    fake.httpClient.request.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:50000"));
    await expect(adt.ping()).rejects.toThrow("ECONNREFUSED");
  });

  it("ping_system 回報回應時間", async () => {
    const call = await connectTools(mockAdt());
    const r = await call("ping_system");
    expect(r.isError).toBe(false);
    expect(r.text).toContain("SAP 連線正常");
    expect(r.text).toContain("12 ms");
  });

  it("ping_system 顯示版本,且版本取自 package.json(E2;v0.3 起為 0.3.0)", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toBe("0.3.1");
    const call = await connectTools(mockAdt());
    const r = await call("ping_system");
    expect(r.text).toContain(`版本:${VERSION}`);
  });

  it("ping_system 連線失敗時回傳錯誤", async () => {
    const adt = mockAdt({ ping: vi.fn(async () => { throw new Error("fetch failed"); }) });
    const call = await connectTools(adt);
    const r = await call("ping_system");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("無法連線");
  });
});

// ───────────────────────── 登入狀態(A2)─────────────────────────

describe("登入狀態交給 abap-adt-api", () => {
  it("login() 依 ADTClient.loggedin 判斷:session 失效後會重新登入", async () => {
    const fake = fakeAdtClient({ loggedin: false });
    const adt = realAdt(fake);
    await adt.login();
    expect(fake.login).toHaveBeenCalledTimes(1);
    fake.loggedin = true;
    await adt.login();
    expect(fake.login).toHaveBeenCalledTimes(1);
    fake.loggedin = false; // 例如 SAP 重啟後 library 清掉了 CSRF token
    await adt.login();
    expect(fake.login).toHaveBeenCalledTimes(2);
  });

  it("一般方法直接交給 ADTClient(由其自動登入/重登),不自行快取登入狀態", async () => {
    const fake = fakeAdtClient({ loggedin: false });
    const adt = realAdt(fake);
    await adt.searchObject("ZCL_*");
    await adt.searchObject("ZCL_*");
    expect(fake.searchObject).toHaveBeenCalledTimes(2);
    expect(fake.login).not.toHaveBeenCalled();
  });
});

// ───────────────────────── stateful 恢復(A3)─────────────────────────

describe("lock / unLock 的 session 模式", () => {
  it("lock 成功時切換為 stateful,unLock 後恢復 stateless", async () => {
    const fake = fakeAdtClient();
    const adt = realAdt(fake);
    await adt.lock("/sap/bc/adt/oo/classes/zcl_demo");
    expect(fake.stateful).toBe(session_types.stateful);
    await adt.unLock("/sap/bc/adt/oo/classes/zcl_demo", "LH-1");
    expect(fake.stateful).toBe(session_types.stateless);
  });

  it("lock 失敗時恢復 stateless 並拋出原始錯誤", async () => {
    const fake = fakeAdtClient({
      lock: vi.fn(async () => {
        throw new Error("Object is locked by user OTHER");
      }),
    });
    const adt = realAdt(fake);
    await expect(adt.lock("/sap/bc/adt/oo/classes/zcl_demo")).rejects.toThrow("locked by user OTHER");
    expect(fake.stateful).toBe(session_types.stateless);
  });

  it("unLock 失敗時也恢復 stateless", async () => {
    const fake = fakeAdtClient({
      unLock: vi.fn(async () => {
        throw new Error("500 unlock failed");
      }),
    });
    const adt = realAdt(fake);
    await adt.lock("/sap/bc/adt/oo/classes/zcl_demo");
    await expect(adt.unLock("/sap/bc/adt/oo/classes/zcl_demo", "LH-1")).rejects.toThrow("unlock failed");
    expect(fake.stateful).toBe(session_types.stateless);
  });
});

// ───────────────────────── 自簽憑證(C1)─────────────────────────

describe("ALLOW_SELF_SIGNED 只作用於 ADTClient", () => {
  it("預設不帶 httpsAgent", () => {
    expect(adtClientOptions(makeConfig()).httpsAgent).toBeUndefined();
  });

  it("開啟時以 httpsAgent(rejectUnauthorized: false)傳給 ADTClient,且不修改 process 環境變數", () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const cfg = makeConfig({ ABAP_MCP_ALLOW_SELF_SIGNED: "true" });
    const agent = adtClientOptions(cfg).httpsAgent as https.Agent & { options: https.AgentOptions };
    expect(agent).toBeInstanceOf(https.Agent);
    expect(agent.options.rejectUnauthorized).toBe(false);

    // 實際建立 ADTClient(不連線):agent 要進到底層 axios instance
    const svc = new RealAdtService(cfg) as unknown as {
      client: { httpClient: { httpclient: { axios: { defaults: { httpsAgent?: https.Agent } } } } };
    };
    const used = svc.client.httpClient.httpclient.axios.defaults.httpsAgent as typeof agent;
    expect(used.options.rejectUnauthorized).toBe(false);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });
});

// ───────────────────────── 401 斷路(F2)─────────────────────────

describe("401 斷路器", () => {
  const http = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { status });

  it("連續 2 次認證失敗後不再連 SAP,並提示修正密碼後重開 MCP", async () => {
    const fake = fakeAdtClient();
    fake.httpClient.request.mockRejectedValue(http(401));
    const adt = realAdt(fake);
    await expect(adt.ping()).rejects.toThrow("401");
    await expect(adt.ping()).rejects.toThrow("401");
    await expect(adt.ping()).rejects.toBeInstanceOf(AuthCircuitOpenError);
    await expect(adt.searchObject("Z*")).rejects.toBeInstanceOf(AuthCircuitOpenError);
    expect(fake.httpClient.request).toHaveBeenCalledTimes(2);
    expect(fake.searchObject).not.toHaveBeenCalled();

    const info = translateAdtError(new AuthCircuitOpenError(2));
    expect(info.message).toContain("連續失敗 2 次");
    expect(info.suggestion).toContain("修正 SAP_PASSWORD");
    expect(info.suggestion).toContain("重開 MCP");
  });

  it("成功一次即歸零", async () => {
    const fake = fakeAdtClient();
    fake.httpClient.request
      .mockRejectedValueOnce(http(401))
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce(http(401));
    const adt = realAdt(fake);
    await expect(adt.ping()).rejects.toThrow("401");
    await adt.ping();
    await expect(adt.ping()).rejects.toThrow("401"); // 只算 1 次,尚未斷路
    await expect(adt.ping()).resolves.toBeDefined();
  });

  it("非認證的 SAP 錯誤(404)也代表帳密正確而歸零;網路錯誤不計入", async () => {
    const fake = fakeAdtClient();
    fake.httpClient.request
      .mockRejectedValueOnce(http(401))
      .mockRejectedValueOnce(http(404))
      .mockRejectedValueOnce(http(401))
      .mockRejectedValueOnce(Object.assign(new Error(""), { parent: { code: "ECONNREFUSED" } }));
    const adt = realAdt(fake);
    await expect(adt.ping()).rejects.toThrow("401");
    await expect(adt.ping()).rejects.toThrow("404");
    await expect(adt.ping()).rejects.toThrow("401");
    await expect(adt.ping()).rejects.toThrow(); // ECONNREFUSED:計數維持 1
    await expect(adt.ping()).resolves.toBeDefined(); // 仍可連線
  });

  it("ping_system 在斷路時回傳提示訊息", async () => {
    const adt = mockAdt({ ping: vi.fn(async () => { throw new AuthCircuitOpenError(2); }) });
    const call = await connectTools(adt);
    const r = await call("ping_system");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("已停止連線 SAP");
    expect(r.text).toContain("重開 MCP");
  });
});

// ───────────────────────── package 白名單(F4)─────────────────────────

describe("package 白名單", () => {
  it("預設 $TMP,Z*,Y*;可自訂", () => {
    expect(makeConfig().safety.allowedPackages).toEqual(["$TMP", "Z*", "Y*"]);
    expect(makeConfig({ ABAP_MCP_ALLOWED_PACKAGES: "zfi*, $tmp" }).safety.allowedPackages).toEqual(["ZFI*", "$TMP"]);
  });

  it("* 結尾為前綴比對,否則完全比對", () => {
    expect(packageMatches("ZFI_TOOLS", "Z*")).toBe(true);
    expect(packageMatches("$tmp", "$TMP")).toBe(true);
    expect(packageMatches("$TMP_OTHER", "$TMP")).toBe(false);
    expect(packageMatches("SABP_CONVERT", "Z*")).toBe(false);
  });

  it("assertPackageAllowed:白名單外或無法判斷 package 時拒絕", () => {
    const cfg = makeConfig();
    expect(() => assertPackageAllowed(cfg, "$TMP")).not.toThrow();
    expect(() => assertPackageAllowed(cfg, "ZDEMO")).not.toThrow();
    expect(() => assertPackageAllowed(cfg, "SABP_CONVERT")).toThrow(/package 白名單/);
    expect(() => assertPackageAllowed(cfg, "$FOO")).toThrow(GuardViolationError);
    expect(() => assertPackageAllowed(cfg, "")).toThrow(/無法判斷/);
  });

  it("packageFromObjectXml 讀出 adtcore:packageRef", () => {
    const xml = `<class:abapClass adtcore:name="ZCL_X"><adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/%24tmp" adtcore:type="DEVC/K" adtcore:name="$TMP"/></class:abapClass>`;
    expect(packageFromObjectXml(xml)).toBe("$TMP");
    expect(packageFromObjectXml("<x/>")).toBe("");
  });

  it("write_source:Z 開頭但 package 不在白名單 → 拒絕且不鎖定", async () => {
    const adt = mockAdt({ objectPackage: vi.fn(async () => "SOME_SAP_PKG") });
    const call = await connectTools(adt);
    const r = await call("write_source", { object_url: "/sap/bc/adt/oo/classes/zcl_x/source/main", new_source: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("SOME_SAP_PKG");
    expect(adt.lock).not.toHaveBeenCalled();
  });

  it("activate_object:package 不在白名單 → 拒絕且不啟用", async () => {
    const adt = mockAdt({ objectPackage: vi.fn(async () => "SOME_SAP_PKG") });
    const call = await connectTools(adt);
    const r = await call("activate_object", { object_url: "/sap/bc/adt/oo/classes/zcl_x" });
    expect(r.isError).toBe(true);
    expect(adt.activate).not.toHaveBeenCalled();
  });
});

// ───────────────────────── create_object(G1)─────────────────────────

describe("create_object", () => {
  it("$TMP:先 validate 再 create,回傳物件 URI", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt);
    const r = await call("create_object", {
      object_type: "CLAS/OC", name: "zcl_new", package_name: "$tmp", description: "demo",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("/sap/bc/adt/oo/classes/zcl_new");
    const spec = { type: "CLAS/OC", name: "ZCL_NEW", packageName: "$TMP", description: "demo" };
    expect(adt.validateNewObject).toHaveBeenCalledWith(spec);
    expect(adt.createObject).toHaveBeenCalledWith({ ...spec, transport: undefined });
  });

  it("名稱檢查未通過 → 不建立,回傳 SAP 說明", async () => {
    const adt = mockAdt({ validateNewObject: vi.fn(async () => ({ ok: false, message: "Class ZCL_NEW already exists" })) });
    const call = await connectTools(adt);
    const r = await call("create_object", { object_type: "CLAS/OC", name: "ZCL_NEW", package_name: "$TMP", description: "d" });
    expect(r.text).toContain("already exists");
    expect(adt.createObject).not.toHaveBeenCalled();
  });

  it("非本機 package 沒給 transport → 拒絕", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt);
    const r = await call("create_object", { object_type: "PROG/P", name: "ZPROG", package_name: "ZPKG", description: "d" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("transport");
    expect(adt.validateNewObject).not.toHaveBeenCalled();
  });

  it("非本機 package 有 transport → 帶 transport 建立", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt);
    await call("create_object", { object_type: "INTF/OI", name: "ZIF_X", package_name: "ZPKG", description: "d", transport: "A4HK900001" });
    expect(adt.createObject).toHaveBeenCalledWith(expect.objectContaining({ transport: "A4HK900001" }));
  });

  it("名稱前綴或 package 不在白名單 → 拒絕", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt);
    const r1 = await call("create_object", { object_type: "CLAS/OC", name: "CL_STD", package_name: "$TMP", description: "d" });
    const r2 = await call("create_object", { object_type: "DDLS/DF", name: "ZI_X", package_name: "SAPPKG", description: "d", transport: "T" });
    expect(r1.text).toContain("前綴白名單");
    expect(r2.text).toContain("package 白名單");
    expect(adt.createObject).not.toHaveBeenCalled();
  });

  it("唯讀模式下不註冊 create_object", async () => {
    const server = new McpServer({ name: "unit", version: "0" });
    registerTools(server, mockAdt(), makeConfig({ ABAP_MCP_READONLY: "true" }), new AuditLogger(""));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(clientT);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("create_object");
  });

  it("BDEF 建立 XML 與 validation 解析", () => {
    const xml = bdefCreateBody({ name: "zi_demo", packageName: "$tmp", description: 'a "b" <c>', responsible: "dev", language: "EN" });
    expect(xml).toContain('adtcore:name="ZI_DEMO"');
    expect(xml).toContain('adtcore:type="BDEF/BDO"');
    expect(xml).toContain('<adtcore:packageRef adtcore:name="$TMP"/>');
    expect(xml).toContain("a &quot;b&quot; &lt;c&gt;");
    expect(parseValidation("<DATA><SEVERITY>ERROR</SEVERITY><SHORT_TEXT>exists</SHORT_TEXT></DATA>")).toEqual({ severity: "ERROR", text: "exists" });
    expect(newObjectUrl("BDEF/BDO", "ZI_DEMO")).toBe("/sap/bc/adt/bo/behaviordefinitions/zi_demo");
  });
});

// ───────────────────────── run_unit_tests(G2)─────────────────────────

/** 依 A4H 實測回傳的形狀:LTC_TEST 一綠一紅 */
function unitResult(): UnitTestClass[] {
  const m = (name: string, alerts: unknown[] = []) =>
    ({ "adtcore:name": name, "adtcore:uri": "", "adtcore:type": "CLAS/OLI", executionTime: 0.5, unit: "s", uriType: "semantic", alerts }) as never;
  return [
    {
      "adtcore:name": "LTC_TEST", "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_x#testclass=LTC_TEST", "adtcore:type": "CLAS/OP", uriType: "semantic",
      durationCategory: "short", riskLevel: "harmless", alerts: [],
      testmethods: [
        m("GREEN"),
        m("RED", [{
          kind: "failedAssertion", severity: "critical", title: "Critical Assertion Error: 'MCP-RED'",
          details: ["Different values\n\tExpected [4] Actual [3]"],
          stack: [{ "adtcore:uri": "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses#start=13,0;end=13,0", "adtcore:type": "", "adtcore:name": "", "adtcore:description": "" }],
        }]),
      ],
    } as never,
  ];
}

describe("run_unit_tests", () => {
  it("摘要、失敗訊息與位置;失敗的排前面", () => {
    const text = formatUnitTestResults(unitResult());
    expect(text).toContain("❌ ABAP Unit:2 個測試方法,1 通過,1 失敗");
    expect(text).toContain("ZCL_X / LTC_TEST->RED");
    expect(text).toContain("Expected [4] Actual [3]");
    expect(text).toContain("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses 第 13 行");
    expect(text.indexOf("->RED")).toBeLessThan(text.indexOf("->GREEN"));
  });

  it("全綠與沒有測試", () => {
    const green = unitResult();
    (green[0].testmethods[1] as { alerts: unknown[] }).alerts = [];
    expect(formatUnitTestResults(green)).toContain("✅ ABAP Unit:2 個測試方法,2 通過,0 失敗");
    expect(formatUnitTestResults([])).toContain("找不到可執行的 ABAP Unit 測試");
  });

  it("只跑 harmless 測試;package 轉成 package URI", async () => {
    const fake = fakeAdtClient({ unitTestRun: vi.fn(async () => []) });
    await realAdt(fake).runUnitTests("/sap/bc/adt/oo/classes/zcl_x");
    expect(fake.unitTestRun).toHaveBeenCalledWith(
      "/sap/bc/adt/oo/classes/zcl_x",
      expect.objectContaining({ harmless: true, dangerous: false, critical: false })
    );

    const adt = mockAdt();
    const call = await connectTools(adt);
    await call("run_unit_tests", { package_name: "$TMP" });
    expect(adt.runUnitTests).toHaveBeenCalledWith("/sap/bc/adt/packages/%24tmp");
    await call("run_unit_tests", { object_url: "/sap/bc/adt/oo/classes/zcl_x/source/main" });
    expect(adt.runUnitTests).toHaveBeenLastCalledWith("/sap/bc/adt/oo/classes/zcl_x");
    const r = await call("run_unit_tests", {});
    expect(r.isError).toBe(true);
  });

  it("會執行程式碼:唯讀模式與 prod 都不註冊,說明寫明會執行測試程式碼(v0.3 審查 #2)", async () => {
    const list = async (cfg: ReturnType<typeof makeConfig>) => {
      const server = new McpServer({ name: "unit", version: "0" });
      registerTools(server, mockAdt(), cfg, new AuditLogger(""));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(clientT);
      return (await client.listTools()).tools;
    };
    expect((await list(makeConfig({ ABAP_MCP_READONLY: "true" }))).map((t) => t.name)).not.toContain("run_unit_tests");
    expect((await list(makeConfig({ ABAP_MCP_SYSTEM_ROLE: "prod" }))).map((t) => t.name)).not.toContain("run_unit_tests");
    const tool = (await list(makeConfig())).find((t) => t.name === "run_unit_tests");
    expect(tool?.description).toContain("會在 SAP 系統上執行測試程式碼");
  });
});

// ───────────────────────── run_atc(G3)─────────────────────────

describe("run_atc", () => {
  const finding = (priority: number, msg: string) => ({
    objectName: "ZCL_X", priority, checkTitle: "Check", messageTitle: msg,
    location: "/sap/bc/adt/oo/classes/zcl_x/source/main#start=7,4", line: 7,
  });

  it("依優先級分組並附上執行資訊", () => {
    const text = formatAtcResult({
      checkVariant: "ZABAP_CLOUD_DEVELOPMENT",
      infos: [{ type: "TOOL_FAILURE", description: "Check not executable" }, { type: "FINDING_STATS", description: "1,0,0" }],
      findings: [finding(2, "warn"), finding(1, "err")],
    });
    expect(text).toContain("❌ ATC(check variant ZABAP_CLOUD_DEVELOPMENT):共 2 筆 finding(優先級 1:1 筆)");
    expect(text.indexOf("優先級 1(錯誤)")).toBeLessThan(text.indexOf("優先級 2(警告)"));
    expect(text).toContain("source/main 第 7 行");
    expect(text).toContain("TOOL_FAILURE");
    expect(text).not.toContain("FINDING_STATS");
  });

  it("位置 URI 沒有 #start 時改用 range 的行號(A4H 實測的形狀)", () => {
    const text = formatAtcResult({
      checkVariant: "V", infos: [],
      findings: [{ ...finding(1, "red"), location: "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", line: 13 }],
    });
    expect(text).toContain("includes/testclasses 第 13 行");
  });

  it("沒有 finding;超過上限時截斷", () => {
    expect(formatAtcResult({ checkVariant: "V", infos: [], findings: [] })).toContain("✅ ATC");
    const many = Array.from({ length: 120 }, (_, i) => finding(3, `m${i}`));
    const text = formatAtcResult({ checkVariant: "V", infos: [], findings: many }, 100);
    expect(text).toContain("共 120 筆");
    expect(text).toContain("僅顯示前 100 筆");
    expect(text).toContain("m99");
    expect(text).not.toContain("m100");
  });

  it("未指定 variant 時用系統預設;第一次建立 worklist 回 5xx 時重試一次", async () => {
    const http500 = Object.assign(new Error("Request failed with status code 500"), { status: 500 });
    const fake = fakeAdtClient({
      atcCustomizing: vi.fn(async () => ({ properties: [{ name: "systemCheckVariant", value: "SYSVAR" }], excemptions: [] })),
      atcCheckVariant: vi.fn().mockRejectedValueOnce(http500).mockResolvedValueOnce("WL1"),
      createAtcRun: vi.fn(async () => ({ id: "RUN1", timestamp: 0, infos: [] })),
      atcWorklists: vi.fn(async () => ({
        objects: [{ name: "ZCL_X", findings: [{ priority: 1, checkTitle: "ABAP Unit", messageTitle: "red", location: { uri: "u#start=13,0", range: { start: { line: 13, column: 0 } } } }] }],
      })),
    });
    const r = await realAdt(fake).runAtc("/sap/bc/adt/oo/classes/zcl_x");
    expect(fake.atcCheckVariant).toHaveBeenCalledTimes(2);
    expect(fake.atcCheckVariant).toHaveBeenCalledWith("SYSVAR");
    expect(fake.createAtcRun).toHaveBeenCalledWith("WL1", "/sap/bc/adt/oo/classes/zcl_x", 100);
    expect(r).toEqual({ checkVariant: "SYSVAR", infos: [], findings: [{ objectName: "ZCL_X", priority: 1, checkTitle: "ABAP Unit", messageTitle: "red", location: "u#start=13,0", line: 13 }] });
  });
});

// ───────────────────────── where_used(G4)─────────────────────────

describe("where_used", () => {
  const fixture = (n: string) => fs.readFileSync(path.resolve("test/unit/fixtures", n), "utf8");

  it("解析 A4H 的 usageReferences(小寫 prefix),只留實際使用處", () => {
    const objs = parseUsageReferences(fixture("where-used-refs.a4h.xml"));
    expect(objs).toHaveLength(1);
    expect(objs[0]).toMatchObject({
      uri: "/sap/bc/adt/oo/classes/zcl_mcp_expg/includes/testclasses",
      name: "Local Test Classes",
      packageName: "$TMP",
      usageInformation: "gradeDirect,includeTest",
    });
    expect(objs[0].objectIdentifier).toContain("\\TY:ZCL_MCP_EXPG\\ME:ADD");
  });

  it("解析 usageSnippets(大寫 prefix)並還原 XML entity", () => {
    const snips = parseUsageSnippets(fixture("where-used-snippets.a4h.xml"));
    expect(snips).toHaveLength(2);
    expect(snips[0].uri).toBe("/sap/bc/adt/oo/classes/zcl_mcp_expg/includes/testclasses#start=9,67;end=9,70");
    expect(snips[0].content).toBe("cl_abap_unit_assert=>assert_equals( act = NEW zcl_mcp_expg( )->add( a = 1 b = 2 ) exp = 3 ).");
  });

  it("snippet 請求帶上 objectIdentifier 並跳脫", () => {
    expect(usageSnippetsBody(["A;\\TY:X<1>"])).toContain('<usagereferences:objectIdentifier optional="false">A;\\TY:X&lt;1&gt;</usagereferences:objectIdentifier>');
  });

  it("格式化:列出物件與行號;沒有結果時明確說明;超過上限截斷", () => {
    const r = {
      objects: parseUsageReferences(fixture("where-used-refs.a4h.xml")),
      snippets: parseUsageSnippets(fixture("where-used-snippets.a4h.xml")),
    };
    const text = formatWhereUsed("ADD", r);
    expect(text).toContain("共 2 處(1 個物件)");
    expect(text).toContain("第 9 行:cl_abap_unit_assert=>");
    expect(text).toContain("第 13 行:");
    expect(formatWhereUsed("X", { objects: [], snippets: [] })).toContain("找不到 X 的使用處");
    expect(formatWhereUsed("ADD", r, 1)).toContain("僅顯示前 1 筆");
    expect(formatWhereUsed("ADD", r, 1)).not.toContain("第 13 行");
  });

  it("工具:位置轉成 source URI 與 0 起算欄位", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt, makeConfig({ ABAP_MCP_READONLY: "true" }));
    await call("where_used", { object_url: "/sap/bc/adt/oo/classes/zcl_x", line: 4, column: 13 });
    expect(adt.whereUsed).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/zcl_x/source/main", 4, 12);
    await call("where_used", { object_url: "/sap/bc/adt/oo/classes/zcl_x" });
    expect(adt.whereUsed).toHaveBeenLastCalledWith("/sap/bc/adt/oo/classes/zcl_x", undefined, undefined);
  });
});

// ───────────────────────── find_definition / class_components(G5)─────────────────────────

describe("find_definition", () => {
  it("identifierAt:找出識別字範圍(含 / 與 ~)", () => {
    const line = "    out->write( |MCP-RUN-{ add( a = 1 b = 2 ) }| ).";
    expect(identifierAt(line, 28)).toEqual({ start: 27, end: 30, text: "add" });
    expect(identifierAt("  CALL METHOD if_x~run.", 15)?.text).toBe("if_x~run");
    expect(identifierAt("  DATA x TYPE /dmo/travel_id.", 20)?.text).toBe("/dmo/travel_id");
    expect(identifierAt(line, 3)).toBeUndefined();
  });

  it("把 1 起算的欄位轉成識別字範圍,include 帶上主程式;回傳 1 起算欄位與定義行", async () => {
    const src = "line1\nline2\n    x = add( 1 ).\n";
    const fake = fakeAdtClient({
      getObjectSource: vi.fn(async () => src),
      findDefinition: vi.fn(async () => ({ url: "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", line: 2, column: 4 })),
    });
    const r = await realAdt(fake).findDefinition("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", 3, 9, false);
    expect(fake.findDefinition).toHaveBeenCalledWith(
      "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", src, 3, 8, 11, false, "/sap/bc/adt/oo/classes/zcl_x/source/main"
    );
    expect(r).toEqual({ identifier: "add", url: "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", line: 2, column: 5, sourceLine: "line2" });
  });

  it("位置不在識別字上 → 清楚的錯誤;工具會補上 /source/main", async () => {
    const fake = fakeAdtClient({ getObjectSource: vi.fn(async () => "  x = 1.") });
    await expect(realAdt(fake).findDefinition("/u/source/main", 1, 1, false)).rejects.toThrow("不是識別字");
    await expect(realAdt(fake).findDefinition("/u/source/main", 5, 1, false)).rejects.toThrow("第 5 行不存在");

    const adt = mockAdt({ findDefinition: vi.fn(async () => ({ identifier: "add", url: "/u/source/main", line: 13, column: 10, sourceLine: "  METHOD add." })) });
    const call = await connectTools(adt, makeConfig({ ABAP_MCP_READONLY: "true" }));
    const r = await call("find_definition", { object_url: "/sap/bc/adt/oo/classes/zcl_x", line: 10, column: 29 });
    expect(adt.findDefinition).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/zcl_x/source/main", 10, 28, false);
    expect(r.text).toContain("「add」的定義:/u/source/main 第 13 行第 10 欄");
    expect(r.text).toContain("13|   METHOD add.");
  });
});

describe("class_components", () => {
  it("格式化 A4H 實際回傳:方法、介面、本地測試類別(標示 include)", () => {
    const root = JSON.parse(fs.readFileSync(path.resolve("test/unit/fixtures/class-components.a4h.json"), "utf8"));
    const text = formatClassComponents(root);
    expect(text).toContain("ZCL_MCP_EXPG(CLAS/OC,public,final)");
    expect(text).toContain("- ADD(方法,public,instance) 定義於第 4 行");
    expect(text).toContain("- IF_OO_ADT_CLASSRUN(實作的介面) 定義於第 3 行");
    expect(text).toContain("- LTC_TEST(本地類別) 定義於testclasses include 第 1 行");
    expect(text).toContain("  - RED(本地類別方法,private,instance) 定義於testclasses include 第 4 行");
    expect(text).toContain("- ZCL_MCP_EXPG(文字元素)");
  });
});

// ───────────────────────── 測試 include 與語法檢查參數 ─────────────────────────

describe("source URI 與語法檢查", () => {
  it("baseObjectUrl / isSourceUrl / isTestClassesInclude", () => {
    expect(baseObjectUrl("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses")).toBe("/sap/bc/adt/oo/classes/zcl_x");
    expect(baseObjectUrl("/sap/bc/adt/oo/classes/zcl_x/source/main")).toBe("/sap/bc/adt/oo/classes/zcl_x");
    expect(baseObjectUrl("/sap/bc/adt/oo/classes/zcl_x")).toBe("/sap/bc/adt/oo/classes/zcl_x");
    expect(isSourceUrl("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses")).toBe(true);
    expect(isSourceUrl("/sap/bc/adt/oo/classes/zcl_x")).toBe(false);
    expect(isTestClassesInclude("/sap/bc/adt/oo/classes/zcl_x/includes/testclasses")).toBe(true);
    expect(isTestClassesInclude("/sap/bc/adt/oo/classes/zcl_x/source/main")).toBe(false);
  });

  it("write_source / syntax_check 以 (source URI, 物件 URI) 順序做語法檢查(A4H 實測 include 需此順序)", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt);
    const inc = "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses";
    await call("write_source", { object_url: inc, new_source: "tests" });
    expect(adt.syntaxCheck).toHaveBeenCalledWith(inc, "/sap/bc/adt/oo/classes/zcl_x", "tests");
    expect(adt.lock).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/zcl_x");
    expect(adt.objectStructure).not.toHaveBeenCalled();
    await call("syntax_check", { object_url: inc, source: "x" });
    expect(adt.syntaxCheck).toHaveBeenLastCalledWith(inc, "/sap/bc/adt/oo/classes/zcl_x", "x");
  });

  it("測試 include 尚未建立 → 先建立空 include 再做語法檢查;語法錯誤時不寫入", async () => {
    const order: string[] = [];
    let exists = false;
    const adt = mockAdt({
      getObjectSource: vi.fn(async () => {
        if (!exists) throw new Error("ZCL_X=====CCAU does not have any inactive version");
        return "* empty";
      }),
      lock: vi.fn(async () => { order.push("lock"); return { LOCK_HANDLE: "LH" } as never; }),
      createTestInclude: vi.fn(async () => { order.push("createTestInclude"); exists = true; }),
      unLock: vi.fn(async () => { order.push("unlock"); }),
      syntaxCheck: vi.fn(async () => { order.push("syntaxCheck"); return [{ severity: "E", line: 8, text: "\".\" expected", offset: 0, uri: "" }] as never; }),
      setObjectSource: vi.fn(async () => { order.push("write"); }),
    });
    const call = await connectTools(adt);
    const r = await call("write_source", { object_url: "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses", new_source: "bad" });
    expect(r.text).toContain("寫入已中止");
    expect(r.text).toContain("已先建立空的測試 include");
    expect(order).toEqual(["lock", "createTestInclude", "unlock", "syntaxCheck"]);
    expect(adt.setObjectSource).not.toHaveBeenCalled();
  });

  it("建立空測試 include 時寫 audit;給了非空 expected_current_source 卻不存在 → 不建立、回並行衝突(v0.3 審查 #3)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-inc-"));
    const auditPath = path.join(dir, "audit.jsonl");
    try {
      let exists = false;
      const missing = () => { if (!exists) throw new Error("ZCL_X=====CCAU does not have any inactive version"); return "* empty"; };
      const adt = mockAdt({
        getObjectSource: vi.fn(async () => missing()),
        createTestInclude: vi.fn(async () => { exists = true; }),
      });
      const server = new McpServer({ name: "unit", version: "0" });
      registerTools(server, adt, makeConfig(), new AuditLogger(auditPath));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(clientT);
      const inc = "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses";
      const callTool = async (args: Record<string, unknown>) =>
        ((await client.callTool({ name: "write_source", arguments: args })) as { content: { text: string }[] }).content[0].text;

      // 1) 並行衝突:不建立 include
      const conflict = await callTool({ object_url: inc, new_source: "tests", expected_current_source: "CLASS ltc …" });
      expect(conflict).toContain("不一致");
      expect(adt.createTestInclude).not.toHaveBeenCalled();

      // 2) 正常建立:audit 有 create_test_include
      await callTool({ object_url: inc, new_source: "tests" });
      expect(adt.createTestInclude).toHaveBeenCalledTimes(1);
      const entries = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(entries.some((e) => e.action === "create_test_include" && e.objectName === "ZCL_X" && e.success)).toBe(true);
      expect(entries.some((e) => e.action === "write_source" && e.success)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("解鎖或鎖定失敗回到 stateless 時丟掉 sap-contextid cookie(A4H 實測會導致之後全部 400)", async () => {
    const cookie = new Map([["SAP_SESSIONID_A4H_001", "s"], ["sap-contextid", "c"]]);
    const fake = fakeAdtClient();
    (fake.httpClient as unknown as { cookie: Map<string, string> }).cookie = cookie;
    const adt = realAdt(fake);
    await adt.lock("/u");
    await adt.unLock("/u", "LH-1");
    expect([...cookie.keys()]).toEqual(["SAP_SESSIONID_A4H_001"]);

    cookie.set("sap-contextid", "c2");
    fake.lock.mockRejectedValueOnce(new Error("locked by OTHER"));
    await expect(adt.lock("/u")).rejects.toThrow("locked");
    expect(cookie.has("sap-contextid")).toBe(false);
    expect(fake.stateful).toBe(session_types.stateless);
  });

  it("讀不到尚未建立的測試 include → 提示用 write_source 建立", () => {
    const info = translateAdtError(new Error("ZCL_X=====CCAU does not have any inactive version"));
    expect(info.message).toContain("原始碼尚未建立");
    expect(info.suggestion).toContain("write_source");
  });
});

// ───────────────────────── run_class(G6)─────────────────────────

describe("run_class", () => {
  it("說明開頭明寫會在 SAP 系統上執行程式;唯讀模式不註冊", async () => {
    const list = async (cfg: ReturnType<typeof makeConfig>) => {
      const server = new McpServer({ name: "unit", version: "0" });
      registerTools(server, mockAdt(), cfg, new AuditLogger(""));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(clientT);
      return (await client.listTools()).tools;
    };
    const tool = (await list(makeConfig())).find((t) => t.name === "run_class");
    expect(tool?.description?.startsWith("⚠️ 會在 SAP 系統上執行程式")).toBe(true);
    expect((await list(makeConfig({ ABAP_MCP_READONLY: "true" }))).map((t) => t.name)).not.toContain("run_class");
  });

  it("執行並回傳輸出;寫 audit log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-run-"));
    const auditPath = path.join(dir, "audit.jsonl");
    try {
      const adt = mockAdt({ runClass: vi.fn(async () => "MCP-RUN-3\n") });
      const server = new McpServer({ name: "unit", version: "0" });
      registerTools(server, adt, makeConfig(), new AuditLogger(auditPath));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(clientT);
      const r = (await client.callTool({ name: "run_class", arguments: { class_name: "zcl_run" } })) as { content: { text: string }[] };
      expect(r.content[0].text).toContain("已執行 ZCL_RUN");
      expect(r.content[0].text).toContain("MCP-RUN-3");
      expect(adt.objectPackage).toHaveBeenCalledWith("/sap/bc/adt/oo/classes/zcl_run");
      const entry = JSON.parse(fs.readFileSync(auditPath, "utf8").trim());
      expect(entry).toMatchObject({ action: "run_class", objectName: "ZCL_RUN", success: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("白名單外的 class 或 package 不執行;輸出超過 20,000 字元截斷", async () => {
    const adt = mockAdt({ runClass: vi.fn(async () => "x".repeat(25_000)) });
    const call = await connectTools(adt);
    expect((await call("run_class", { class_name: "CL_STANDARD" })).text).toContain("前綴白名單");
    (adt.objectPackage as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SAP_PKG");
    expect((await call("run_class", { class_name: "ZCL_X" })).text).toContain("package 白名單");
    expect(adt.runClass).not.toHaveBeenCalled();
    const big = await call("run_class", { class_name: "ZCL_BIG" });
    expect(big.text).toContain("已截斷");
    expect(big.text.length).toBeLessThan(21_000);
  });
});

// ───────────────────────── create_transport(G7)─────────────────────────

describe("create_transport", () => {
  const toolNames = async (cfg: ReturnType<typeof makeConfig>) => {
    const server = new McpServer({ name: "unit", version: "0" });
    registerTools(server, mockAdt(), cfg, new AuditLogger(""));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(clientT);
    return (await client.listTools()).tools.map((t) => t.name);
  };

  it("只在 dev 且非唯讀時註冊", async () => {
    expect(await toolNames(makeConfig())).toContain("create_transport");
    expect(await toolNames(makeConfig({ ABAP_MCP_SYSTEM_ROLE: "qa" }))).not.toContain("create_transport");
    expect(await toolNames(makeConfig({ ABAP_MCP_READONLY: "true" }))).not.toContain("create_transport");
    expect(await toolNames(makeConfig({ ABAP_MCP_SYSTEM_ROLE: "prod" }))).not.toContain("create_transport");
  });

  it("以 package 為參照建立並回傳 TR 編號", async () => {
    const adt = mockAdt({ createTransport: vi.fn(async () => "A4HK900123") });
    const call = await connectTools(adt);
    const r = await call("create_transport", { package_name: "zpkg", description: "demo" });
    expect(r.text).toContain("A4HK900123");
    expect(adt.createTransport).toHaveBeenCalledWith("/sap/bc/adt/packages/zpkg", "demo", "ZPKG");
  });

  it("本機 package 或白名單外 package → 拒絕", async () => {
    const adt = mockAdt();
    const call = await connectTools(adt);
    expect((await call("create_transport", { package_name: "$TMP", description: "d" })).text).toContain("不需要 transport");
    expect((await call("create_transport", { package_name: "SAPPKG", description: "d" })).text).toContain("package 白名單");
    expect(adt.createTransport).not.toHaveBeenCalled();
  });
});

// ───────────────────────── 鎖定用獨立 session(v0.3.1 #1)─────────────────────────

describe("鎖定/寫入使用獨立的 ADTClient", () => {
  it("lock、setObjectSource、createTestInclude、unLock 走鎖定 client;其他呼叫走一般 client", async () => {
    const read = fakeAdtClient({ getObjectSource: vi.fn(async () => "src"), activate: vi.fn(async () => ({ success: true })) });
    const lock = fakeAdtClient({ setObjectSource: vi.fn(async () => {}), createTestInclude: vi.fn(async () => {}) });
    const adt = new RealAdtService(makeConfig(), read as unknown as ADTClient, lock as unknown as ADTClient);
    await adt.getObjectSource("/u/source/main");
    const l = await adt.lock("/u");
    await adt.createTestInclude("ZCL_U", l.LOCK_HANDLE);
    await adt.setObjectSource("/u/source/main", "new", l.LOCK_HANDLE);
    await adt.unLock("/u", l.LOCK_HANDLE);
    await adt.activate("ZCL_U", "/u");
    expect(read.getObjectSource).toHaveBeenCalled();
    expect(read.activate).toHaveBeenCalled();
    expect(read.lock).not.toHaveBeenCalled();
    expect(lock.lock).toHaveBeenCalledWith("/u");
    expect(lock.createTestInclude).toHaveBeenCalled();
    expect(lock.setObjectSource).toHaveBeenCalled();
    expect(lock.unLock).toHaveBeenCalled();
  });

  it("鎖定期間一般 client 出錯,不影響持有鎖定的 session(stateful 與 context cookie 都保留)", async () => {
    const read = fakeAdtClient({
      getObjectSource: vi.fn(async () => { throw new Error("CCAU does not have any inactive version"); }),
    });
    const lock = fakeAdtClient();
    const jar = new Map([["sap-contextid", "ctx"]]);
    (lock.httpClient as unknown as { cookie: Map<string, string> }).cookie = jar;
    const adt = new RealAdtService(makeConfig(), read as unknown as ADTClient, lock as unknown as ADTClient);
    await adt.lock("/u");
    await expect(adt.getObjectSource("/u/includes/testclasses")).rejects.toThrow("inactive version");
    expect(lock.stateful).toBe(session_types.stateful);
    expect(jar.get("sap-contextid")).toBe("ctx");
    expect(read.stateful).toBe(session_types.stateless);
    await adt.unLock("/u", "LH-1");
    expect(jar.has("sap-contextid")).toBe(false);
  });

  it("只注入一個 client 時兩者共用(相容既有測試)", async () => {
    const one = fakeAdtClient();
    const adt = realAdt(one);
    await adt.lock("/u");
    expect(one.lock).toHaveBeenCalled();
  });
});

// ───────────────────────── data_preview(v0.4 D1)─────────────────────────

describe("data_preview 的 SQL 護欄", () => {
  const dp = { ABAP_MCP_ALLOW_DATA_PREVIEW: "true" };

  it("接受單一 SELECT,回傳 FROM / JOIN 的表", () => {
    expect(validateSelectSql("SELECT * FROM /dmo/travel").tables).toEqual(["/DMO/TRAVEL"]);
    expect(
      validateSelectSql(
        "SELECT t~travel_id, b~booking_id FROM /dmo/travel AS t INNER JOIN /dmo/booking AS b ON b~travel_id = t~travel_id"
      ).tables
    ).toEqual(["/DMO/TRAVEL", "/DMO/BOOKING"]);
    expect(validateSelectSql("select status, count(*) as cnt from /dmo/travel group by status").tables).toEqual(["/DMO/TRAVEL"]);
  });

  it("字串常值與註解裡的關鍵字、分號不算", () => {
    expect(validateSelectSql("SELECT * FROM /dmo/travel WHERE description = 'DELETE; UPDATE it''s'").tables).toEqual(["/DMO/TRAVEL"]);
    expect(validateSelectSql("SELECT * FROM /dmo/travel \" UPDATE x;\n WHERE status = 'N'").tables).toEqual(["/DMO/TRAVEL"]);
    expect(validateSelectSql("* DELETE FROM usr02;\nSELECT * FROM /dmo/travel").tables).toEqual(["/DMO/TRAVEL"]);
    expect(validateSelectSql("SELECT * FROM /dmo/travel -- ; DROP\n").tables).toEqual(["/DMO/TRAVEL"]);
  });

  it("拒絕變更類語法、多語句與非 SELECT", () => {
    expect(() => validateSelectSql("UPDATE /dmo/travel SET status = 'X'")).toThrow(/SELECT/);
    expect(() => validateSelectSql("SELECT * FROM /dmo/travel; DELETE FROM /dmo/travel")).toThrow(/;/);
    expect(() => validateSelectSql("SELECT * FROM /dmo/travel INTO TABLE @DATA(t)")).toThrow(/INTO/);
    expect(() => validateSelectSql("WITH +x AS ( SELECT * FROM /dmo/travel ) SELECT * FROM +x")).toThrow(/SELECT/);
    expect(() => validateSelectSql("")).toThrow(/不可為空/);
    expect(() => validateSelectSql("SELECT * FROM /dmo/travel WHERE x = 'abc")).toThrow(/未結束/);
  });

  it("無法可靠解析來源時拒絕:FROM 子查詢、表函式參數、逗號 join、沒有 FROM", () => {
    expect(() => validateSelectSql("SELECT * FROM ( SELECT * FROM /dmo/travel ) AS x")).toThrow(/子查詢/);
    expect(() => validateSelectSql("SELECT * FROM zcds_with_params( p_date = '20260101' )")).toThrow(/參數/);
    expect(() => validateSelectSql("SELECT * FROM /dmo/travel, usr02")).toThrow(/逗號/);
    expect(() => validateSelectSql("SELECT 1 AS x")).toThrow(/FROM/);
  });

  it("每張表都要在白名單內:WHERE 子查詢裡的 USR02 也擋", () => {
    const cfg = makeConfig(dp);
    expect(cfg.safety.dataPreviewTables).toEqual(["/DMO/*", "Z*", "Y*"]);
    const sub = validateSelectSql("SELECT * FROM /dmo/travel WHERE agency_id IN ( SELECT bname FROM usr02 )");
    expect(sub.tables).toEqual(["/DMO/TRAVEL", "USR02"]);
    expect(() => assertTablesAllowed(cfg, sub.tables)).toThrow(/USR02/);
    expect(() => assertTablesAllowed(cfg, ["/DMO/TRAVEL", "ZTAB"])).not.toThrow();
  });

  it("預設不註冊;開啟後唯讀模式也可用", async () => {
    const names = async (cfg: ReturnType<typeof makeConfig>) => {
      const server = new McpServer({ name: "unit", version: "0" });
      registerTools(server, mockAdt(), cfg, new AuditLogger(""));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(clientT);
      return (await client.listTools()).tools.map((t) => t.name);
    };
    expect(await names(makeConfig())).not.toContain("data_preview");
    expect(await names(makeConfig({ ...dp, ABAP_MCP_READONLY: "true" }))).toContain("data_preview");
  });

  it("工具:表名稱轉大寫、預設 100 筆;白名單外與 UPDATE 不送到 SAP", async () => {
    const qr = { columns: [{ name: "TRAVEL_ID" }, { name: "STATUS" }], values: [{ TRAVEL_ID: 1, STATUS: "N" }] } as never;
    const adt = mockAdt({ tableContents: vi.fn(async () => qr), runQuery: vi.fn(async () => qr) });
    const call = await connectTools(adt, makeConfig(dp));
    const r = await call("data_preview", { table: "/dmo/travel" });
    expect(adt.tableContents).toHaveBeenCalledWith("/DMO/TRAVEL", 100);
    expect(r.text).toContain("TRAVEL_ID | STATUS");
    expect(r.text).toContain("1 | N");
    await call("data_preview", { sql: "SELECT travel_id, status FROM /dmo/travel", max_rows: 5 });
    expect(adt.runQuery).toHaveBeenCalledWith("SELECT travel_id, status FROM /dmo/travel", 5);
    expect((await call("data_preview", { table: "USR02" })).text).toContain("白名單");
    expect((await call("data_preview", { sql: "UPDATE /dmo/travel SET status = 'X'" })).isError).toBe(true);
    expect((await call("data_preview", { table: "/dmo/travel", max_rows: 5000 })).isError).toBe(true);
    expect(adt.tableContents).toHaveBeenCalledTimes(1);
    expect(adt.runQuery).toHaveBeenCalledTimes(1);
  });

  it("audit 記 SQL 與筆數,不記資料內容", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-dp-"));
    const auditPath = path.join(dir, "audit.jsonl");
    try {
      const qr = { columns: [{ name: "SECRET" }], values: [{ SECRET: "TOP-SECRET-VALUE" }] } as never;
      const server = new McpServer({ name: "unit", version: "0" });
      registerTools(server, mockAdt({ runQuery: vi.fn(async () => qr) }), makeConfig(dp), new AuditLogger(auditPath));
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "c", version: "0" });
      await client.connect(clientT);
      await client.callTool({ name: "data_preview", arguments: { sql: "SELECT secret FROM ztab" } });
      const log = fs.readFileSync(auditPath, "utf8");
      expect(JSON.parse(log.trim())).toMatchObject({ action: "data_preview", success: true, summary: "SELECT secret FROM ztab(回傳 1 筆)" });
      expect(log).not.toContain("TOP-SECRET-VALUE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("日期印成 YYYY-MM-DD;SAP 多回的筆數會截到要求的筆數(A4H 實測)", async () => {
    const f = formatQueryResult({ columns: [{ name: "D" }], values: [{ D: new Date("2024-09-07T00:00:00Z") }] } as never);
    expect(f.text).toBe("D\n2024-09-07");
    const qr = { columns: [{ name: "N" }], values: [{ N: 1 }, { N: 2 }, { N: 3 }, { N: 4 }] } as never;
    const call = await connectTools(mockAdt({ tableContents: vi.fn(async () => qr) }), makeConfig(dp));
    const r = await call("data_preview", { table: "/DMO/TRAVEL", max_rows: 3 });
    expect(r.text).toContain("📊 3 筆;已達筆數上限 3");
    expect(r.text).not.toMatch(/\n4$/);
  });

  it("輸出:每格截斷 200 字元,整體超過上限時停止並標註", () => {
    const long = "x".repeat(500);
    const f1 = formatQueryResult({ columns: [{ name: "C" }], values: [{ C: long }] } as never);
    expect(f1.text.split("\n")[1].length).toBe(201);
    const many = { columns: [{ name: "C" }], values: Array.from({ length: 300 }, () => ({ C: "y".repeat(100) })) } as never;
    const f2 = formatQueryResult(many, { maxTotal: 5_000 });
    expect(f2.truncatedRows).toBe(true);
    expect(f2.text.length).toBeLessThanOrEqual(5_000);
  });
});

// ───────────────────────── ddic_info(v0.4 D2)─────────────────────────

describe("ddic_info", () => {
  const hit = (name: string, type: string, uri: string) => ({ "adtcore:name": name, "adtcore:type": type, "adtcore:uri": uri }) as never;

  it("表欄位:只列真正的欄位(排除 .include 與 package 節點,A4H 實際回應)", () => {
    const el = JSON.parse(fs.readFileSync(path.resolve("test/unit/fixtures/ddic-travel.a4h.json"), "utf8"));
    const text = formatDdicFields(el);
    expect(text).toContain("欄位(15 個)");
    expect(text).toContain("travel_id | key | /dmo/travel_id | numc | 8");
    expect(text).toContain("booking_fee |  | /dmo/booking_fee | curr | 16,2");
    expect(text).not.toContain(".include");
    expect(text).not.toContain("/DMO/FLIGHT_LEGACY");
  });

  it("domain 固定值、資料元素標籤", () => {
    const dom = formatDomain({
      metaData: { name: "/DMO/STATUS", description: "Status" },
      properties: { typeInformation: { datatype: "CHAR", length: 1, decimals: 0 }, valueInformation: { fixValues: [{ low: "B", text: "Booked" }, { low: "N", text: "New" }] } },
    });
    expect(dom).toContain("型別:CHAR 長度 1");
    expect(dom).toContain("固定值(2 個)");
    expect(dom).toContain("- B:Booked");
    const de = formatDataElement({
      metaData: { name: "/DMO/TRAVEL_ID", description: "Travel ID" },
      properties: { typeName: "/DMO/TRAVEL_ID", dataType: "NUMC", dataTypeLength: 8, fieldLabels: { shortFieldLabel: "Travel ID", longFieldLabel: "Travel Number" } },
    });
    expect(de).toContain("型別:NUMC 長度 8");
    expect(de).toContain("長「Travel Number」");
  });

  it("同名的資料元素與 domain 一併列出;結構改讀定義原始碼;找不到時說明", async () => {
    const adt = mockAdt({
      searchObject: vi.fn(async (q: string) =>
        q === "/DMO/TRAVEL_ID"
          ? [hit("/DMO/TRAVEL_ID", "DTEL/DE", "/u/de"), hit("/DMO/TRAVEL_ID", "DOMA/DD", "/u/dom"), hit("/DMO/TRAVEL_ID_X", "DTEL/DE", "/u/x")]
          : q === "BAPIRET2" ? [hit("BAPIRET2", "TABL/DS", "/sap/bc/adt/ddic/structures/bapiret2")] : []
      ),
      dataElementProperties: vi.fn(async () => ({ metaData: { name: "/DMO/TRAVEL_ID" }, properties: { dataType: "NUMC", dataTypeLength: 8 } })),
      domainProperties: vi.fn(async () => ({ metaData: { name: "/DMO/TRAVEL_ID" }, properties: { typeInformation: { datatype: "NUMC", length: 8 } } })),
      ddicElement: vi.fn(async () => ({ type: "", name: "", properties: { elementProps: false, annotations: [] }, children: [] }) as never),
      getObjectSource: vi.fn(async () => "define structure bapiret2 {\n  type : bapi_mtype;\n}"),
    });
    const call = await connectTools(adt, makeConfig({ ABAP_MCP_READONLY: "true" }));
    const r = await call("ddic_info", { name: "/dmo/travel_id" });
    expect(r.text).toContain("[DTEL/DE 資料元素]");
    expect(r.text).toContain("[DOMA/DD domain]");
    expect(r.text).not.toContain("TRAVEL_ID_X");
    const s = await call("ddic_info", { name: "bapiret2" });
    expect(adt.getObjectSource).toHaveBeenCalledWith("/sap/bc/adt/ddic/structures/bapiret2/source/main");
    expect(s.text).toContain("define structure bapiret2");
    expect((await call("ddic_info", { name: "ZNOPE" })).text).toContain("找不到名為 ZNOPE");
  });
});

// ───────────────────────── 寫入互斥(F1)─────────────────────────

describe("寫入類操作依序執行", () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("SerialQueue:先進先出,前一個失敗不影響下一個", async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const a = q.run(async () => { await delay(20); order.push("a"); throw new Error("a failed"); });
    const b = q.run(async () => { order.push("b"); return "B"; });
    await expect(a).rejects.toThrow("a failed");
    await expect(b).resolves.toBe("B");
    expect(order).toEqual(["a", "b"]);
  });

  it("兩個 write_source 同時送出仍依序完成,lock → write → unlock 不交錯", async () => {
    const events: string[] = [];
    let n = 0;
    const adt = mockAdt({
      lock: vi.fn(async (url: string) => {
        events.push(`lock ${url}`);
        await delay(15);
        return { LOCK_HANDLE: `LH-${++n}` } as never;
      }),
      setObjectSource: vi.fn(async (url: string) => {
        events.push(`write ${url}`);
        await delay(15);
      }),
      unLock: vi.fn(async (url: string) => {
        events.push(`unlock ${url}`);
      }),
    });
    const call = await connectTools(adt);
    const src = (n: string) => `/sap/bc/adt/oo/classes/${n}/source/main`;
    const [r1, r2] = await Promise.all([
      call("write_source", { object_url: src("zcl_a"), new_source: "A" }),
      call("write_source", { object_url: src("zcl_b"), new_source: "B" }),
    ]);
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(events).toEqual([
      "lock /sap/bc/adt/oo/classes/zcl_a",
      `write ${src("zcl_a")}`,
      "unlock /sap/bc/adt/oo/classes/zcl_a",
      "lock /sap/bc/adt/oo/classes/zcl_b",
      `write ${src("zcl_b")}`,
      "unlock /sap/bc/adt/oo/classes/zcl_b",
    ]);
  });

  it("write_source 與 activate_object 同時送出也依序執行", async () => {
    const events: string[] = [];
    const adt = mockAdt({
      lock: vi.fn(async () => { events.push("lock"); await delay(15); return { LOCK_HANDLE: "LH" } as never; }),
      unLock: vi.fn(async () => { events.push("unlock"); }),
      activate: vi.fn(async () => { events.push("activate"); return { success: true, messages: [] } as never; }),
    });
    const call = await connectTools(adt);
    await Promise.all([
      call("write_source", { object_url: "/sap/bc/adt/oo/classes/zcl_a/source/main", new_source: "A" }),
      call("activate_object", { object_url: "/sap/bc/adt/oo/classes/zcl_a" }),
    ]);
    expect(events).toEqual(["lock", "unlock", "activate"]);
  });
});

// ───────────────────────── config ─────────────────────────

describe("loadConfig", () => {
  it("缺少必要環境變數時丟出中文錯誤", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/環境變數設定錯誤/);
  });

  it("prod 系統強制唯讀,即使 READONLY=false", () => {
    const cfg = makeConfig({ ABAP_MCP_SYSTEM_ROLE: "prod", ABAP_MCP_READONLY: "false" });
    expect(cfg.safety.readonly).toBe(true);
  });

  it("dev 系統預設可讀寫", () => {
    const cfg = makeConfig();
    expect(cfg.safety.readonly).toBe(false);
    expect(cfg.safety.allowedPrefixes).toEqual(["Z", "Y", "$"]);
  });

  it("http:// 只允許本機(C2)", () => {
    for (const url of ["http://localhost:50000", "http://127.0.0.1:50000", "http://[::1]:50000"]) {
      expect(makeConfig({ SAP_URL: url }).sap.url).toBe(url);
    }
  });

  it("http:// 連遠端主機時丟出中文錯誤要求改用 https(C2)", () => {
    for (const url of ["http://sap.example.com:8000", "http://10.0.0.5:50000", "http://localhost.evil.com"]) {
      expect(() => makeConfig({ SAP_URL: url })).toThrow(/https/);
    }
    expect(() => makeConfig({ SAP_URL: "http://sap.example.com:8000" })).toThrow(/明文/);
  });

  it("可自訂前綴白名單", () => {
    const cfg = makeConfig({ ABAP_MCP_ALLOWED_PREFIXES: "ZFI, ztest" });
    expect(cfg.safety.allowedPrefixes).toEqual(["ZFI", "ZTEST"]);
  });
});

describe(".env 密碼 # 檢查(B3)", () => {
  it("未加引號且含 # → 偵測到", () => {
    expect(hasUnquotedHashPassword("SAP_USER=DEV\nSAP_PASSWORD=ab#cd\n")).toBe(true);
    expect(hasUnquotedHashPassword("SAP_PASSWORD = #abc\r\n")).toBe(true);
  });

  it("加了引號或不含 # → 不警告", () => {
    expect(hasUnquotedHashPassword('SAP_PASSWORD="ab#cd"')).toBe(false);
    expect(hasUnquotedHashPassword("SAP_PASSWORD='ab#cd'")).toBe(false);
    expect(hasUnquotedHashPassword("SAP_PASSWORD=abcd")).toBe(false);
    expect(hasUnquotedHashPassword("# SAP_PASSWORD=ab#cd\nSAP_USER=X")).toBe(false);
  });

  it("警告寫到 stderr 且不含密碼本身;沒有 .env 時不警告", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap-mcp-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "SAP_PASSWORD=Secr3t#Tail\n");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(warnIfPasswordUnquoted(file)).toBe(true);
      const msg = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msg).toContain("SAP_PASSWORD");
      expect(msg).not.toContain("Secr3t");
      expect(msg).not.toContain("Tail");
      expect(warnIfPasswordUnquoted(path.join(dir, "missing.env"))).toBe(false);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── guards ─────────────────────────

describe("objectNameFromUrl", () => {
  it("從 class source URI 萃取物件名稱", () => {
    expect(objectNameFromUrl("/sap/bc/adt/oo/classes/zcl_demo/source/main")).toBe("ZCL_DEMO");
  });
  it("從物件 URI 萃取名稱", () => {
    expect(objectNameFromUrl("/sap/bc/adt/programs/programs/zreport1")).toBe("ZREPORT1");
  });
});

describe("assertWriteAllowed", () => {
  it("唯讀模式下拒絕寫入", () => {
    const cfg = makeConfig({ ABAP_MCP_READONLY: "true" });
    expect(() => assertWriteAllowed(cfg, "/sap/bc/adt/oo/classes/zcl_demo")).toThrow(
      GuardViolationError
    );
  });

  it("prod 角色下拒絕寫入且訊息明確", () => {
    const cfg = makeConfig({ ABAP_MCP_SYSTEM_ROLE: "prod" });
    expect(() => assertWriteAllowed(cfg, "/sap/bc/adt/oo/classes/zcl_demo")).toThrow(/prod/);
  });

  it("拒絕修改非白名單前綴的物件(SAP 標準物件保護)", () => {
    const cfg = makeConfig();
    expect(() =>
      assertWriteAllowed(cfg, "/sap/bc/adt/oo/classes/cl_salv_table")
    ).toThrow(/白名單/);
  });

  it("允許 Z 開頭物件", () => {
    const cfg = makeConfig();
    expect(() => assertWriteAllowed(cfg, "/sap/bc/adt/oo/classes/zcl_demo")).not.toThrow();
  });
});

// ───────────────────────── lockedWrite ─────────────────────────

describe("lockedWrite", () => {
  const params = {
    objectUrl: "/sap/bc/adt/oo/classes/zcl_demo",
    sourceUrl: "/sap/bc/adt/oo/classes/zcl_demo/source/main",
    newSource: "new source",
  };

  it("正常流程:lock → write → unlock", async () => {
    const adt = mockAdt();
    const result = await lockedWrite(adt, params);
    expect(result.success).toBe(true);
    expect(result.previousSource).toBe("old source");
    expect(adt.lock).toHaveBeenCalledWith(params.objectUrl);
    expect(adt.setObjectSource).toHaveBeenCalledWith(
      params.sourceUrl,
      "new source",
      "LH-123",
      undefined
    );
    expect(adt.unLock).toHaveBeenCalledWith(params.objectUrl, "LH-123");
  });

  it("寫入失敗時仍保證解鎖(try/finally)", async () => {
    const adt = mockAdt({
      setObjectSource: vi.fn(async () => {
        throw new Error("500 internal error");
      }),
    });
    await expect(lockedWrite(adt, params)).rejects.toThrow("500");
    expect(adt.unLock).toHaveBeenCalledWith(params.objectUrl, "LH-123");
  });

  it("並行衝突:expected 與系統現況不符時中止,且不會鎖定", async () => {
    const adt = mockAdt({
      getObjectSource: vi.fn(async () => "someone else changed this"),
    });
    await expect(
      lockedWrite(adt, { ...params, expectedCurrentSource: "old source" })
    ).rejects.toThrow(ConcurrentModificationError);
    expect(adt.lock).not.toHaveBeenCalled();
    expect(adt.setObjectSource).not.toHaveBeenCalled();
  });

  it("行尾差異(CRLF vs LF)不視為並行衝突", async () => {
    const adt = mockAdt({
      getObjectSource: vi.fn(async () => "line1\r\nline2\r\n"),
    });
    const result = await lockedWrite(adt, {
      ...params,
      expectedCurrentSource: "line1\nline2\n",
    });
    expect(result.success).toBe(true);
  });

  it("class 測試 include 尚未建立 → 鎖定中先建立再寫入", async () => {
    const order: string[] = [];
    const adt = mockAdt({
      getObjectSource: vi.fn(async () => {
        throw new Error("ZCL_DEMO=====================CCAU does not have any inactive version");
      }),
      lock: vi.fn(async () => { order.push("lock"); return { LOCK_HANDLE: "LH-1" } as never; }),
      createTestInclude: vi.fn(async () => { order.push("createTestInclude"); }),
      setObjectSource: vi.fn(async () => { order.push("write"); }),
      unLock: vi.fn(async () => { order.push("unlock"); }),
    });
    const inc = "/sap/bc/adt/oo/classes/zcl_demo/includes/testclasses";
    const r = await lockedWrite(adt, { objectUrl: "/sap/bc/adt/oo/classes/zcl_demo", sourceUrl: inc, newSource: "tests" });
    expect(r.previousSource).toBe("");
    expect(adt.createTestInclude).toHaveBeenCalledWith("ZCL_DEMO", "LH-1", undefined);
    expect(order).toEqual(["lock", "createTestInclude", "write", "unlock"]);
  });

  it("main source 讀取失敗不會被當成新 include(原錯誤照拋)", async () => {
    const adt = mockAdt({
      getObjectSource: vi.fn(async () => { throw new Error("Resource does not exist"); }),
    });
    await expect(lockedWrite(adt, params)).rejects.toThrow("does not exist");
    expect(adt.lock).not.toHaveBeenCalled();
    expect(adt.createTestInclude).not.toHaveBeenCalled();
  });

  it("transport 編號正確傳遞", async () => {
    const adt = mockAdt();
    await lockedWrite(adt, { ...params, transport: "DEVK900123" });
    expect(adt.setObjectSource).toHaveBeenCalledWith(
      params.sourceUrl,
      "new source",
      "LH-123",
      "DEVK900123"
    );
  });
});

// ───────────────────────── errors ─────────────────────────

describe("translateAdtError", () => {
  it("401 → 認證建議", () => {
    const info = translateAdtError(new Error("Request failed with status 401"));
    expect(info.message).toContain("認證失敗");
    expect(info.suggestion).toContain("SAP_USER");
  });

  it("401 建議提醒 # 要加引號、連續失敗會鎖帳號與 SU01 解鎖(B2)", () => {
    const info = translateAdtError(new Error("Request failed with status code 401"));
    expect(info.suggestion).toContain("#");
    expect(info.suggestion).toContain("引號");
    expect(info.suggestion).toContain("鎖住帳號");
    expect(info.suggestion).toContain("SU01");
  });

  it("連線失敗 → 網路建議", () => {
    const info = translateAdtError(new Error("connect ECONNREFUSED 10.0.0.1:44300"));
    expect(info.suggestion).toContain("SAP_URL");
  });

  it("ECONNREFUSED / fetch failed → 提示系統可能未啟動與啟動方式(A4)", () => {
    for (const msg of ["connect ECONNREFUSED 127.0.0.1:50000", "fetch failed", "socket hang up"]) {
      const info = translateAdtError(new Error(msg));
      expect(info.message).toContain("無法連線");
      expect(info.suggestion).toContain("SAP 系統可能未啟動");
      expect(info.suggestion).toContain("a4h-start.bat");
      expect(info.suggestion).toContain("docker start a4h");
    }
  });

  it("abap-adt-api 的 AdtHttpException(message 為空,代碼在 parent.code)也能辨識為連線失敗", () => {
    // 實際形狀:SAP 未啟動時 message === "",parent 為 axios 錯誤,parent.request 內含帳密
    const err = Object.assign(new Error(""), {
      name: "AdtHttpException",
      parent: { code: "ECONNREFUSED", message: "", request: { auth: { username: "u", password: "TopSecret#1" } } },
    });
    const info = translateAdtError(err);
    expect(info.message).toContain("無法連線");
    expect(info.message).toContain("ECONNREFUSED");
    expect(info.suggestion).toContain("a4h-start.bat");
    expect(JSON.stringify(info)).not.toContain("TopSecret");
  });

  it("安全護欄的拒絕不會被關鍵字誤分類(例如含 transport 字樣)", () => {
    const info = translateAdtError(new GuardViolationError("package $TMP 是本機 package,不需要 transport。"));
    expect(info.message).toBe("已拒絕:package $TMP 是本機 package,不需要 transport。");
    expect(info.suggestion).toBeUndefined();
  });

  it("SAP 的 does not exist 訊息 → 物件不存在的建議", () => {
    const info = translateAdtError(new Error("Resource CLASS zcl_x does not exist."));
    expect(info.suggestion).toContain("search_objects");
  });

  it("5xx → 提示可能是 SAP 端逾時與縮小範圍", () => {
    const info = translateAdtError(Object.assign(new Error("Request failed with status code 500"), { status: 500 }));
    expect(info.message).toContain("SAP 伺服器錯誤(500)");
    expect(info.suggestion).toContain("逾時");
    expect(info.suggestion).toContain("where-used");
  });

  it("沒有任何訊息的錯誤也不會回傳空白描述", () => {
    const info = translateAdtError(Object.assign(new Error(""), { name: "AdtHttpException" }));
    expect(info.message).toBe("ADT 操作失敗:AdtHttpException");
  });

  it("port 號含 401 的連線錯誤不會被誤判為認證失敗", () => {
    const info = translateAdtError(new Error("connect ECONNREFUSED 10.0.0.1:44010"));
    expect(info.message).toContain("無法連線");
  });

  it("鎖定衝突 → SM12 建議", () => {
    const info = translateAdtError(new Error("Object is locked by user OTHER"));
    expect(info.suggestion).toContain("SM12");
  });
});

// ───────────────────────── audit ─────────────────────────

describe("diffSummary", () => {
  it("計算行數變化摘要", () => {
    const s = diffSummary("a\nb\nc", "a\nb\nc\nd");
    expect(s).toContain("3 → 4");
  });

  it("CRLF 與 LF 混用時只計實際變更的行(v0.3 審查 #4;A4H 實測曾顯示 +8 / -9)", () => {
    const sapSource = "CLASS x.\r\n  METHOD m.\r\n    out->write( 'R3-INITIAL' ).\r\n  ENDMETHOD.\r\nENDCLASS.";
    const aiSource = "CLASS x.\n  METHOD m.\n    out->write( 'R3-AFTER-RESTART' ).\n  ENDMETHOD.\nENDCLASS.";
    expect(diffSummary(sapSource, aiSource)).toBe("行數 5 → 5(約 +1 / -1)");
  });
});
