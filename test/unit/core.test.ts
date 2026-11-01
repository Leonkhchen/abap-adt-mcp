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
import { assertWriteAllowed, objectNameFromUrl, GuardViolationError } from "../../src/safety/guards.js";
import { lockedWrite, ConcurrentModificationError } from "../../src/workflows/lockedWrite.js";
import { translateAdtError, AuthCircuitOpenError } from "../../src/adt/errors.js";
import { diffSummary } from "../../src/safety/audit.js";
import * as https from "node:https";
import { RealAdtService, adtClientOptions, type AdtService } from "../../src/adt/client.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { session_types, type ADTClient } from "abap-adt-api";
import { registerTools } from "../../src/tools/registry.js";
import { AuditLogger } from "../../src/safety/audit.js";
import { VERSION } from "../../src/version.js";
import { SerialQueue } from "../../src/safety/serialQueue.js";

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
    mainInclude: vi.fn(() => "/sap/bc/adt/oo/classes/zcl_demo/source/main"),
    getObjectSource: vi.fn(async () => "old source"),
    setObjectSource: vi.fn(async () => {}),
    lock: vi.fn(async () => ({ LOCK_HANDLE: "LH-123" } as never)),
    unLock: vi.fn(async () => {}),
    activate: vi.fn(async () => ({ success: true, messages: [] } as never)),
    syntaxCheck: vi.fn(async () => []),
    nodeContents: vi.fn(async () => ({ nodes: [] } as never)),
    transportInfo: vi.fn(async () => ({} as never)),
    userTransports: vi.fn(async () => ({ workbench: [] } as never)),
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

  it("ping_system 顯示版本,且版本取自 package.json(E2)", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toBe("0.2.0");
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
});
