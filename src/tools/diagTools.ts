/**
 * tools/diagTools.ts — v0.4 診斷與資料工具
 *
 * 讓 AI 讀 DDIC 結構、查資料、看 ST22 短傾印、看版本歷史,並能從短傾印定位錯誤後自己修正。
 *  - data_preview:ABAP_MCP_ALLOW_DATA_PREVIEW=true 才註冊(唯讀模式也可用,只讀資料);表白名單 + SQL 限制
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService } from "../adt/client.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import { GuardViolationError } from "../safety/guards.js";
import type { SerialQueue } from "../safety/serialQueue.js";
import { assertTableName, assertTablesAllowed, validateSelectSql } from "../safety/sql.js";
import { formatQueryResult } from "./formatters.js";
import { fail, ok } from "./result.js";

/** data_preview 筆數:預設與上限 */
export const DATA_PREVIEW_DEFAULT_ROWS = 100;
export const DATA_PREVIEW_MAX_ROWS = 1_000;

export function registerDiagnosticTools(
  server: McpServer,
  adt: AdtService,
  cfg: AppConfig,
  audit: AuditLogger,
  _writes: SerialQueue
): void {
  // ───────────────────────────── D1 data_preview(預設不註冊)─────────────────────────────
  if (cfg.safety.allowDataPreview) {
    server.registerTool(
      "data_preview",
      {
        title: "查詢資料表內容(Data Preview)",
        description:
          "讀取 SAP 資料表或 view 的內容。table 與 sql 擇一:table 讀單一表的前幾筆;sql 為單一 ABAP SQL SELECT" +
          "(例如 SELECT status, COUNT(*) AS cnt FROM /dmo/travel GROUP BY status;字串常值用單引號)。" +
          `只能讀可讀表白名單內的表(目前:${cfg.safety.dataPreviewTables.join(", ")}),每張出現在 FROM / JOIN 的表都會檢查;` +
          "不接受多語句或任何變更資料的語法。筆數預設 100、上限 1,000;每格截斷 200 字元,整體上限 20,000 字元。",
        inputSchema: {
          table: z.string().optional().describe("表或 view 名稱,例如 /DMO/TRAVEL"),
          sql: z.string().optional().describe("單一 SELECT 敘述(ABAP SQL 語法)"),
          max_rows: z
            .number()
            .int()
            .positive()
            .max(DATA_PREVIEW_MAX_ROWS)
            .optional()
            .describe(`最多回傳筆數,預設 ${DATA_PREVIEW_DEFAULT_ROWS},上限 ${DATA_PREVIEW_MAX_ROWS}`),
        },
      },
      async ({ table, sql, max_rows }) => {
        const rows = max_rows ?? DATA_PREVIEW_DEFAULT_ROWS;
        const query = sql ?? `table ${table ?? ""}`;
        try {
          if (!!table === !!sql) return fail(new GuardViolationError("table 與 sql 必須擇一提供。"));
          let result;
          if (table) {
            const name = assertTableName(table);
            assertTablesAllowed(cfg, [name]);
            result = await adt.tableContents(name, rows);
          } else {
            const { tables } = validateSelectSql(sql!);
            assertTablesAllowed(cfg, tables);
            result = await adt.runQuery(sql!, rows);
          }
          // A4H 實測:tableContents 會多回 1 筆,依要求筆數截斷
          const more = result.values.length > rows;
          result = { ...result, values: result.values.slice(0, rows) };
          const f = formatQueryResult(result);
          // audit 只記查詢與筆數,絕不記資料內容
          audit.log({
            timestamp: new Date().toISOString(),
            action: "data_preview",
            objectUrl: "",
            objectName: table ? table.toUpperCase() : "",
            summary: `${query}(回傳 ${f.rows} 筆)`,
            success: true,
          });
          const head =
            `📊 ${f.rows} 筆` +
            (f.truncatedRows ? `(輸出超過 20,000 字元,只顯示前 ${f.rows} 筆;請縮小欄位或筆數)` : "") +
            (more || result.values.length >= rows ? `;已達筆數上限 ${rows},可能還有更多` : "");
          return ok(`${head}\n${f.text}`);
        } catch (e) {
          audit.log({
            timestamp: new Date().toISOString(),
            action: "data_preview",
            objectUrl: "",
            objectName: table ? table.toUpperCase() : "",
            summary: query,
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
          return fail(e);
        }
      }
    );
  }
}
