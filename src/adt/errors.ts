/**
 * adt/errors.ts — ADT 錯誤翻譯層
 *
 * 把 ADT REST API 的原始錯誤(HTTP 狀態碼、SAP exception XML)
 * 轉成結構化、AI 可據以行動的訊息。好的錯誤訊息能讓 AI agent
 * 自行修正,而不是反覆撞牆。
 */

export interface AdtErrorInfo {
  /** 給 AI 的摘要訊息(中文) */
  message: string;
  /** 建議的下一步行動 */
  suggestion?: string;
}

/** 401 斷路器開啟:連續認證失敗後不再連 SAP(見 RealAdtService.guard) */
export class AuthCircuitOpenError extends Error {
  constructor(public readonly failures: number) {
    super(`SAP 認證已連續失敗 ${failures} 次,為避免帳號被鎖,已停止連線 SAP。`);
    this.name = "AuthCircuitOpenError";
  }
}

/** 取得錯誤上的 HTTP 狀態碼(abap-adt-api 的 AdtHttpException 以 getter 提供 status) */
function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** SAP 有回 HTTP 狀態碼(不是網路層錯誤) */
export function hasHttpStatus(err: unknown): boolean {
  return httpStatus(err) !== undefined;
}

/** 是否為認證失敗(401) */
export function isAuthFailure(err: unknown): boolean {
  if (httpStatus(err) === 401) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /status code 401\b|\bunauthorized\b/i.test(msg);
}

/**
 * 取出錯誤的可讀描述。
 * abap-adt-api 在網路層失敗(例如 SAP 未啟動)時丟出的 AdtHttpException message 是空字串,
 * 真正的代碼(ECONNREFUSED 等)在 parent.code,因此一併收集 code / parent / cause。
 * 只取字串欄位,絕不序列化整個錯誤物件(parent.request 內含帳密)。
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    code?: unknown;
    parent?: { code?: unknown; message?: unknown };
    cause?: { code?: unknown; message?: unknown };
  };
  const parts = [e.message, e.code, e.parent?.code, e.parent?.message, e.cause?.code, e.cause?.message]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(" / ") : e.name || "未知錯誤";
}

/** 將任意錯誤翻譯為 AI 友善的說明 */
export function translateAdtError(err: unknown): AdtErrorInfo {
  if (err instanceof AuthCircuitOpenError) {
    return {
      message: err.message,
      suggestion:
        "請修正 SAP_PASSWORD(密碼含 # 時 .env 要加引號)後重開 MCP" +
        "(重新啟動 Claude Code,或在 /mcp 重新連線)。重開前所有工具都不會再連 SAP。" +
        "若帳號已被鎖,請用同一 client 的管理者帳號以 SU01 解鎖。",
    };
  }
  const raw = describeError(err);
  const lower = raw.toLowerCase();

  // 常見情境的對應表(依出現頻率排序)
  // 連線失敗放最前面:訊息含 port 號(例如 :44010)時不可被誤判為 401
  if (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("socket hang up") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed")
  ) {
    return {
      message: `無法連線 SAP 系統:${raw}`,
      suggestion:
        "SAP 系統可能未啟動;本機 Trial 可執行 a4h-start.bat 或 docker start a4h。" +
        "若系統已啟動,請檢查 SAP_URL 是否正確、VPN/網路是否暢通、ICM 的 HTTP(S) port 是否開啟(SMICM)。",
    };
  }
  if (lower.includes("401") || lower.includes("unauthorized")) {
    return {
      message: `SAP 認證失敗(401):${raw}`,
      suggestion:
        "請檢查 SAP_USER / SAP_PASSWORD / SAP_CLIENT 環境變數是否正確,以及帳號是否被鎖定。" +
        "密碼含 # 時,.env 中要加引號(SAP_PASSWORD=\"...\"),否則 # 之後會被當成註解截斷。" +
        "注意:連續登入失敗會鎖住帳號,請先確認設定再重試;被鎖時請用同一 client 的管理者帳號" +
        "以 SU01 解鎖(SU01 只能管理目前登入 client 的使用者)。",
    };
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("csrf")) {
    return {
      message: `權限不足或 CSRF token 問題(403):${raw}`,
      suggestion: "請確認使用者具備 S_DEVELOP 權限,且 SICF 節點 /sap/bc/adt 已啟用。",
    };
  }
  if (lower.includes("404") || lower.includes("not found") || lower.includes("does not exist")) {
    return {
      message: `物件或服務不存在(404):${raw}`,
      suggestion: "請先用 search_objects 確認物件名稱與 URI 正確;也可能是該 ADT 服務未在此系統啟用。",
    };
  }
  if (lower.includes("lock") && (lower.includes("fail") || lower.includes("locked") || lower.includes("enqueue"))) {
    return {
      message: `物件鎖定失敗:${raw}`,
      suggestion: "物件可能正被其他使用者(或 SE80/Eclipse session)編輯中。請稍後重試,或請對方釋放鎖定(SM12)。",
    };
  }
  if (lower.includes("self-signed") || lower.includes("certificate")) {
    return {
      message: `TLS 憑證驗證失敗:${raw}`,
      suggestion: "若為內網開發系統的自簽憑證,可設定 ABAP_MCP_ALLOW_SELF_SIGNED=true(請見 SECURITY.md 的風險說明)。",
    };
  }
  if (lower.includes("transport")) {
    return {
      message: `Transport 相關錯誤:${raw}`,
      suggestion: "可用 list_transports 查詢可用的 transport request,或確認物件的 package 是否需要 TR(本機物件 $TMP 不需要)。",
    };
  }
  const status = httpStatus(err);
  if (status !== undefined && status >= 500) {
    return {
      message: `SAP 伺服器錯誤(${status}):${raw}`,
      suggestion:
        "若等了數分鐘才出現,多半是 SAP 端處理逾時:例如 where-used 查詢整個標準物件(結果太多,請改查特定方法)、" +
        "或系統剛啟動後第一次執行 ATC / 啟用 CDS(稍後重試通常就會成功)。其他情況可在 SAP 的 ST22 查看 dump。",
    };
  }

  return { message: `ADT 操作失敗:${raw}` };
}

/** 將錯誤格式化為 MCP 工具回傳的文字 */
export function formatErrorForAi(err: unknown): string {
  const info = translateAdtError(err);
  return info.suggestion
    ? `❌ ${info.message}\n💡 建議:${info.suggestion}`
    : `❌ ${info.message}`;
}
