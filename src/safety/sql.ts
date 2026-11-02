/**
 * safety/sql.ts — data_preview 的 SQL 護欄
 *
 * data_preview 讓 AI 讀資料庫內容,是外洩風險最高的工具。這裡在送到 SAP 之前做三件事:
 *  1. 只接受單一 SELECT:去掉字串常值與註解後,不得含 ; 或任何變更/控制類關鍵字
 *  2. 解析 FROM / JOIN 後面的表或 view 名稱;無法可靠解析(子查詢當來源、表函式參數、逗號 join、
 *     CDS 關聯路徑 \_assoc)一律拒絕
 *  3. 每張表都必須在 ABAP_MCP_DATA_PREVIEW_TABLES 白名單內(避免讀 USR02 等敏感表)
 * SAP 端本身也只接受 SELECT,這裡是第二道、且可在本機先擋下的防線。
 */
import type { AppConfig } from "../config.js";
import { GuardViolationError, packageMatches } from "./guards.js";

/** 送到 SAP 的 SQL 長度上限(字元) */
const MAX_SQL_LENGTH = 10_000;

/** 去掉字串常值(內容換成空字串)與註解後,不得出現的關鍵字 */
const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "MODIFY", "COMMIT", "ROLLBACK", "CALL", "EXEC", "EXECUTE",
  "MERGE", "UPSERT", "CREATE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "INTO",
  "LOCK", "SET",
];

/**
 * 去掉字串常值與註解:'…'(含 '' 跳脫)、`…` → 空常值;
 * " 到行尾(ABAP)、-- 到行尾、/* … *\/、行首 * 的整行註解 → 移除
 */
export function stripLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  let lineStart = true;
  while (i < sql.length) {
    const ch = sql[i];
    // 行首 *(ABAP 整行註解)
    if (lineStart && ch === "*") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n") {
      out += ch;
      i++;
      lineStart = true;
      continue;
    }
    if (lineStart && (ch === " " || ch === "\t" || ch === "\r")) {
      out += ch;
      i++;
      continue;
    }
    lineStart = false;
    if (ch === "'" || ch === "`") {
      // 字串常值:找到對應的結束引號('' / `` 為跳脫)
      const q = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === q && sql[i + 1] === q) {
          i += 2;
          continue;
        }
        if (sql[i] === q) break;
        i++;
      }
      if (i >= sql.length) throw new GuardViolationError("SQL 中有未結束的字串常值,無法可靠解析。");
      i++;
      out += q + q;
      continue;
    }
    if (ch === '"' || (ch === "-" && sql[i + 1] === "-")) {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new GuardViolationError("SQL 中有未結束的註解,無法可靠解析。");
      i = end + 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 檢查 SQL 是否為單一 SELECT,並回傳用到的表/view 名稱(大寫、去重)。
 * 不符合時丟出 GuardViolationError(中文說明拒絕原因)。
 */
export function validateSelectSql(sql: string): { tables: string[] } {
  if (!sql.trim()) throw new GuardViolationError("SQL 不可為空。");
  if (sql.length > MAX_SQL_LENGTH) throw new GuardViolationError(`SQL 超過 ${MAX_SQL_LENGTH} 字元。`);
  const code = stripLiteralsAndComments(sql);

  if (code.includes(";")) {
    throw new GuardViolationError("只接受單一 SELECT 敘述,SQL 中不可有 ;(多語句)。");
  }
  // CDS 關聯路徑(\_assoc,例如 FROM /dmo/i_travel_u\_agency 或 SELECT \_agency-name)會讀到關聯目標的 view,
  // 但目標名稱不出現在 SQL 裡,白名單無從檢查。ABAP SQL 中反斜線只用於路徑,字串常值外出現一律拒絕
  if (code.includes("\\")) {
    throw new GuardViolationError(
      "不支援 CDS 關聯路徑(\\_關聯名稱):關聯可能讀到白名單外的 view。請改用 JOIN 明確寫出要讀的表或 view。"
    );
  }
  if (!/^\s*SELECT\b/i.test(code)) {
    throw new GuardViolationError("只接受以 SELECT 開頭的查詢(不支援 WITH 等其他形式)。");
  }
  const forbidden = FORBIDDEN.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(code));
  if (forbidden.length > 0) {
    throw new GuardViolationError(`只接受唯讀的 SELECT,SQL 中不可含 ${forbidden.join("、")}。`);
  }

  const tables: string[] = [];
  for (const m of code.matchAll(/\b(FROM|JOIN)\b/gi)) {
    const rest = code.slice((m.index ?? 0) + m[0].length);
    const t = rest.match(/^\s*([A-Za-z0-9_/]+)(\s*)(\S?)/);
    if (!t) {
      throw new GuardViolationError(
        `${m[1].toUpperCase()} 後面不是表名稱(例如子查詢),無法可靠判斷讀取的表,為安全起見拒絕。`
      );
    }
    const [, name, , next] = t;
    if (next === "(") {
      throw new GuardViolationError(`${name} 後面接參數(表函式或帶參數的 view),無法可靠判斷,為安全起見拒絕。`);
    }
    if (next === ",") {
      throw new GuardViolationError("不支援以逗號列出多張表,請改用 JOIN。");
    }
    tables.push(name.toUpperCase());
  }
  if (tables.length === 0) {
    throw new GuardViolationError("找不到 FROM 後面的表名稱,無法判斷讀取的表,為安全起見拒絕。");
  }
  return { tables: [...new Set(tables)] };
}

/** 檢查表/view 名稱格式 */
export function assertTableName(name: string): string {
  const n = name.trim().toUpperCase();
  if (!/^[A-Z0-9_/]+$/.test(n)) throw new GuardViolationError(`表名稱 ${name} 格式不正確。`);
  return n;
}

/** 每張表都要在 data_preview 白名單內,否則整個查詢拒絕 */
export function assertTablesAllowed(cfg: AppConfig, tables: string[]): void {
  const allowed = cfg.safety.dataPreviewTables;
  const denied = tables.filter((t) => !allowed.some((p) => packageMatches(t, p)));
  if (denied.length > 0) {
    throw new GuardViolationError(
      `${denied.join("、")} 不在 data_preview 可讀的表白名單內(目前允許:${allowed.join(", ") || "(無)"})。` +
        `若確實需要,請調整 ABAP_MCP_DATA_PREVIEW_TABLES 環境變數。`
    );
  }
}
