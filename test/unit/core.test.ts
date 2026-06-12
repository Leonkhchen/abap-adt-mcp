/**
 * 單元測試 — 不需要真實 SAP 系統
 * 重點驗證:
 *  1. 安全護欄(唯讀/prod/前綴白名單)
 *  2. lockedWrite 的鎖定釋放保證(成功、寫入失敗、並行衝突)
 *  3. 設定載入(prod 強制唯讀)
 *  4. 錯誤翻譯
 */
import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { assertWriteAllowed, objectNameFromUrl, GuardViolationError } from "../../src/safety/guards.js";
import { lockedWrite, ConcurrentModificationError } from "../../src/workflows/lockedWrite.js";
import { translateAdtError } from "../../src/adt/errors.js";
import { diffSummary } from "../../src/safety/audit.js";
import type { AdtService } from "../../src/adt/client.js";

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

  it("可自訂前綴白名單", () => {
    const cfg = makeConfig({ ABAP_MCP_ALLOWED_PREFIXES: "ZFI, ztest" });
    expect(cfg.safety.allowedPrefixes).toEqual(["ZFI", "ZTEST"]);
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

  it("連線失敗 → 網路建議", () => {
    const info = translateAdtError(new Error("connect ECONNREFUSED 10.0.0.1:44300"));
    expect(info.suggestion).toContain("SAP_URL");
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
