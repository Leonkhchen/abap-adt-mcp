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
import { formatDataElement, formatDdicFields, formatDomain, formatQueryResult } from "./formatters.js";
import { fail, ok, truncate } from "./result.js";

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

  // ───────────────────────────── D2 ddic_info ─────────────────────────────
  server.registerTool(
    "ddic_info",
    {
      title: "讀取 DDIC 定義",
      description:
        "讀取 ABAP Dictionary 定義:資料表與 CDS view 的欄位(key、資料元素、型別、長度)、結構定義、" +
        "資料元素(型別與欄位標籤)、domain(型別與固定值)。同名物件(例如同名的資料元素與 domain)會一併列出," +
        "可用 object_type 限定。唯讀。",
      inputSchema: {
        name: z.string().min(1).describe("名稱,例如 /DMO/TRAVEL、/DMO/STATUS、BAPIRET2"),
        object_type: z
          .enum(DDIC_TYPES)
          .optional()
          .describe("選填:TABL/DT 資料表、TABL/DS 結構、DDLS/DF CDS、DTEL/DE 資料元素、DOMA/DD domain"),
      },
    },
    async ({ name, object_type }) => {
      try {
        const n = name.trim().toUpperCase();
        const hits = (await adt.searchObject(n, object_type, 20)).filter(
          (h) =>
            h["adtcore:name"].toUpperCase() === n &&
            (DDIC_TYPES as readonly string[]).includes(h["adtcore:type"])
        );
        if (hits.length === 0) {
          return ok(`找不到名為 ${n} 的 DDIC 物件${object_type ? `(類型 ${object_type})` : ""}。可先用 search_objects 確認名稱。`);
        }
        const sections: string[] = [];
        for (const h of hits) {
          const type = h["adtcore:type"] as (typeof DDIC_TYPES)[number];
          const uri = h["adtcore:uri"];
          const head = `## ${n} [${type}${DDIC_LABEL[type] ? ` ${DDIC_LABEL[type]}` : ""}]` +
            (h["adtcore:description"] ? ` ${h["adtcore:description"]}` : "");
          if (type === "DTEL/DE") sections.push(`${head}\n${formatDataElement(await adt.dataElementProperties(uri))}`);
          else if (type === "DOMA/DD") sections.push(`${head}\n${formatDomain(await adt.domainProperties(uri))}`);
          else {
            const el = await adt.ddicElement(n);
            if (el.children?.length) {
              sections.push(`${head}\n${formatDdicFields(el)}`);
            } else {
              // A4H 實測:結構(TABL/DS)的 ddicElement 回空,改讀 define structure 原始碼
              const src = await adt.getObjectSource(`${uri}/source/main`);
              const lines = src.split(/\r?\n/);
              sections.push(
                `${head}\n定義原始碼(${lines.length} 行):\n` +
                  lines.slice(0, DDIC_SOURCE_MAX_LINES).join("\n") +
                  (lines.length > DDIC_SOURCE_MAX_LINES ? `\n…(已截斷,僅顯示前 ${DDIC_SOURCE_MAX_LINES} 行)` : "")
              );
            }
          }
        }
        return ok(truncate(sections.join("\n\n"), DIAG_MAX_OUTPUT));
      } catch (e) {
        return fail(e);
      }
    }
  );
}

/** ddic_info 支援的類型 */
const DDIC_TYPES = ["TABL/DT", "TABL/DS", "DDLS/DF", "DTEL/DE", "DOMA/DD"] as const;
const DDIC_LABEL: Record<string, string> = {
  "TABL/DT": "資料表",
  "TABL/DS": "結構",
  "DDLS/DF": "CDS",
  "DTEL/DE": "資料元素",
  "DOMA/DD": "domain",
};
/** 結構定義原始碼最多顯示行數 */
const DDIC_SOURCE_MAX_LINES = 200;
/** 診斷類工具的輸出上限(字元) */
export const DIAG_MAX_OUTPUT = 20_000;
