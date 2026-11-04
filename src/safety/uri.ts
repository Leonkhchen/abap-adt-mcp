/**
 * safety/uri.ts — ADT URI 驗證(v0.5.1 S1)
 *
 * 所有送往 SAP 的 request 都會帶 Basic 認證與 cookie。若 URI 可被操控成絕對 URL
 * (https://evil/…、//evil/…),axios 會直接送往該主機,把帳密帶出去。
 * 因此任何「使用者(AI)給的 URI」在送出 request 前都要先過這裡:
 * 只接受 /sap/bc/adt/ 開頭的相對路徑。
 */
import type { AppConfig } from "../config.js";
import { GuardViolationError } from "./guards.js";

export const ADT_ROOT = "/sap/bc/adt/";

const HINT = "只接受 /sap/bc/adt/ 開頭的相對 URI(例如 /sap/bc/adt/oo/classes/zcl_demo)。";

function reject(uri: string, reason: string): never {
  const shown = uri.length > 120 ? `${uri.slice(0, 120)}…` : uri;
  throw new GuardViolationError(`拒絕 URI「${shown.replace(/[\u0000-\u001f\u007f]/g, "?")}」:${reason}。${HINT}`);
}

/** 重複解碼直到穩定(擋 %252e%252e 之類的雙重編碼);格式錯誤的 % 序列視為攻擊 */
function fullyDecode(s: string): string | undefined {
  let cur = s;
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return undefined;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * 驗證並回傳正規化後的相對 ADT URI。
 * 拒絕:scheme、//host 開頭、反斜線、控制字元、. / .. 路徑段(解碼後判斷)、不在 /sap/bc/adt/ 底下。
 * 查詢字串與 #fragment 原樣保留(只驗證路徑部分)。
 * @param _cfg 預留(未來若支援同 origin 的絕對 URI 時用),目前不使用
 */
export function assertAdtUri(uri: string, _cfg?: AppConfig): string {
  if (typeof uri !== "string") reject(String(uri), "URI 必須是字串");
  const trimmed = uri.trim();
  if (!trimmed) reject(uri, "URI 是空的");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) reject(trimmed, "含有控制字元");
  if (trimmed.includes("\\")) reject(trimmed, "含有反斜線");
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) reject(trimmed, "含有 scheme(不接受絕對 URL)");
  if (trimmed.startsWith("//")) reject(trimmed, "以 // 開頭(會被當成其他主機)");
  if (!trimmed.startsWith(ADT_ROOT)) reject(trimmed, "不是以 /sap/bc/adt/ 開頭");

  const path = trimmed.split(/[?#]/, 1)[0];
  const decoded = fullyDecode(path);
  if (decoded === undefined) reject(trimmed, "含有格式錯誤的百分比編碼");
  if (/[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes("\\")) reject(trimmed, "解碼後含有控制字元或反斜線");
  if (decoded.split("/").some((seg) => seg === ".." || seg === ".")) reject(trimmed, "含有 . 或 .. 路徑段(路徑穿越)");
  if (!decoded.startsWith(ADT_ROOT)) reject(trimmed, "解碼後不在 /sap/bc/adt/ 底下");
  return trimmed;
}
