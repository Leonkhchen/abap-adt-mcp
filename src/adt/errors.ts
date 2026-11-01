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

/** 將任意錯誤翻譯為 AI 友善的說明 */
export function translateAdtError(err: unknown): AdtErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
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
      suggestion: "請檢查 SAP_USER / SAP_PASSWORD / SAP_CLIENT 環境變數是否正確,以及帳號是否被鎖定。",
    };
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("csrf")) {
    return {
      message: `權限不足或 CSRF token 問題(403):${raw}`,
      suggestion: "請確認使用者具備 S_DEVELOP 權限,且 SICF 節點 /sap/bc/adt 已啟用。",
    };
  }
  if (lower.includes("404") || lower.includes("not found")) {
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

  return { message: `ADT 操作失敗:${raw}` };
}

/** 將錯誤格式化為 MCP 工具回傳的文字 */
export function formatErrorForAi(err: unknown): string {
  const info = translateAdtError(err);
  return info.suggestion
    ? `❌ ${info.message}\n💡 建議:${info.suggestion}`
    : `❌ ${info.message}`;
}
