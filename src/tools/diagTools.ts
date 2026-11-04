/**
 * tools/diagTools.ts — v0.4 診斷與資料工具
 *
 * 讓 AI 讀 DDIC 結構、查資料、看 ST22 短傾印、看版本歷史,並能從短傾印定位錯誤後自己修正。
 *  - data_preview:ABAP_MCP_ALLOW_DATA_PREVIEW=true 才註冊(唯讀模式也可用,只讀資料);表白名單 + SQL 限制
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService, InactiveEntry } from "../adt/client.js";
import { baseObjectUrl, isSourceUrl } from "../adt/objectTypes.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import { assertPackageAllowed, assertWriteAllowed, GuardViolationError, objectNameFromUrl } from "../safety/guards.js";
import { assertAdtUri } from "../safety/uri.js";
import type { SerialQueue } from "../safety/serialQueue.js";
import { assertTableName, assertTablesAllowed, validateSelectSql } from "../safety/sql.js";
import { formatDataElement, formatDdicFields, formatDomain, formatQueryResult } from "./formatters.js";
import { fail, ok, truncate } from "./result.js";
import { unifiedDiff } from "./diff.js";
import type { Revision } from "abap-adt-api";

/** data_preview 筆數:預設與上限 */
export const DATA_PREVIEW_DEFAULT_ROWS = 100;
export const DATA_PREVIEW_MAX_ROWS = 1_000;

export function registerDiagnosticTools(
  server: McpServer,
  adt: AdtService,
  cfg: AppConfig,
  audit: AuditLogger,
  writes: SerialQueue
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

  // ───────────────────────────── D5 list_inactive ─────────────────────────────
  server.registerTool(
    "list_inactive",
    {
      title: "列出 inactive 物件",
      description:
        "列出目前使用者尚未啟用(inactive)的物件,子項目(例如 class 的 include)歸在所屬物件下。" +
        "可再用 activate_objects 批次啟用。唯讀。",
      inputSchema: {},
    },
    async () => {
      try {
        const mine = (await adt.inactiveObjects()).filter((o) => o.user.toUpperCase() === cfg.sap.user.toUpperCase());
        const groups = groupInactive(mine);
        if (groups.length === 0) return ok(`${cfg.sap.user.toUpperCase()} 目前沒有 inactive 的物件。`);
        const lines = groups.map(
          (g) =>
            `- ${g.name} [${g.type}]${g.deleted ? "(已刪除,待啟用)" : ""}` +
            (g.parts > 0 ? `(含 ${g.parts} 個子項目)` : "") +
            `\n  uri:${g.uri}`
        );
        return ok(`📝 ${cfg.sap.user.toUpperCase()} 有 ${groups.length} 個 inactive 物件:\n${lines.join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── D5 activate_objects(唯讀模式不註冊)─────────────────────────────
  if (!cfg.safety.readonly) {
    server.registerTool(
      "activate_objects",
      {
        title: "批次啟用物件",
        description:
          "一次啟用多個 inactive 物件(object_urls 可用 list_inactive 的 uri)。每個物件都必須通過名稱前綴與 package 兩道白名單," +
          "任一不過就整批拒絕、不啟用任何物件。回傳啟用結果與錯誤訊息。",
        inputSchema: {
          object_urls: z.array(z.string().min(1)).min(1).max(ACTIVATE_MAX_OBJECTS).describe("物件 URI 清單,例如 /sap/bc/adt/oo/classes/zcl_a"),
        },
      },
      async ({ object_urls }) =>
        writes.run(async () => {
          let urls: string[];
          try {
            // URI 格式先於白名單:任一個不合格就整批拒絕(v0.5.1 S1)
            urls = [...new Set(object_urls.map((u) => baseObjectUrl(assertAdtUri(u, cfg))))];
          } catch (e) {
            return fail(e);
          }
          try {
            // 兩道白名單:先全部檢查,任一不過就整批拒絕
            const denied: string[] = [];
            for (const u of urls) {
              try {
                assertWriteAllowed(cfg, u);
                assertPackageAllowed(cfg, await adt.objectPackage(u));
              } catch (e) {
                denied.push(`- ${objectNameFromUrl(u)}:${e instanceof Error ? e.message : String(e)}`);
              }
            }
            if (denied.length > 0) {
              return fail(new GuardViolationError(`整批拒絕,沒有啟用任何物件:\n${denied.join("\n")}`));
            }

            const inactive = (await adt.inactiveObjects()).filter((o) => o.user.toUpperCase() === cfg.sap.user.toUpperCase());
            const toActivate = inactive.filter((o) => urls.includes(o.uri) || urls.includes(o.parentUri));
            const skipped = urls.filter((u) => !toActivate.some((o) => o.uri === u || o.parentUri === u));
            if (toActivate.length === 0) {
              return ok(`沒有需要啟用的物件:${skipped.map(objectNameFromUrl).join("、")} 目前都不是 inactive。`);
            }
            const result = await adt.activateObjects(toActivate);
            for (const u of urls.filter((x) => !skipped.includes(x))) {
              audit.log({
                timestamp: new Date().toISOString(),
                action: "activate",
                objectUrl: u,
                objectName: objectNameFromUrl(u),
                summary: `activate_objects 批次(${urls.length - skipped.length} 個物件)`,
                success: result.success,
                error: result.success ? undefined : JSON.stringify(result.messages),
              });
            }
            const names = urls.filter((x) => !skipped.includes(x)).map(objectNameFromUrl);
            const note = skipped.length ? `\nℹ️ 略過(不是 inactive):${skipped.map(objectNameFromUrl).join("、")}` : "";
            if (result.success) return ok(`✅ 已啟用 ${names.length} 個物件:${names.join("、")}${note}`);
            const msgs = (result.messages ?? []).map((m) => `- [${m.type}] ${m.objDescr ?? ""} ${m.shortText}(第 ${m.line ?? "?"} 行)`);
            return ok(`❌ 啟用失敗(${names.join("、")}):\n${msgs.join("\n") || "(無詳細訊息)"}${note}`);
          } catch (e) {
            return fail(e);
          }
        })
    );
  }

  // ───────────────────────────── D6 get_revisions ─────────────────────────────
  server.registerTool(
    "get_revisions",
    {
      title: "版本歷史與比較",
      description:
        "列出物件(或 class 的 include)的版本歷史,新的在前,編號 1 為最新。給 compare_from 與 compare_to(版本編號)" +
        "時回傳兩個版本的 unified diff(上限 500 行)。注意:$TMP 等不記錄 transport 的物件沒有歷史版本," +
        "只會有 active(目前啟用)與 inactive(已寫入尚未啟用)兩個版本。唯讀。",
      inputSchema: {
        object_url: z.string().min(1).describe("物件、source/main 或 include URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        compare_from: z.number().int().positive().optional().describe("選填:比較的舊版本編號(get_revisions 列出的編號)"),
        compare_to: z.number().int().positive().optional().describe("選填:比較的新版本編號,例如 1(最新)"),
      },
    },
    async ({ object_url, compare_from, compare_to }) => {
      try {
        if ((compare_from === undefined) !== (compare_to === undefined)) {
          return fail(new GuardViolationError("compare_from 與 compare_to 需同時提供。"));
        }
        assertAdtUri(object_url);
        const revs = await adt.revisions(object_url);
        if (revs.length === 0) return ok(`${object_url} 沒有任何版本紀錄。`);
        const lines = revs.map((r, i) => `#${i + 1} ${r.date} ${r.author}  ${revisionLabel(r)}`);
        let text = `🕘 ${object_url} 共 ${revs.length} 個版本(新的在前):\n${lines.join("\n")}`;
        if (compare_from !== undefined && compare_to !== undefined) {
          const from = revs[compare_from - 1];
          const to = revs[compare_to - 1];
          if (!from || !to) return fail(new GuardViolationError(`版本編號需在 1–${revs.length} 之間。`));
          const sourceUrl = isSourceUrl(object_url) ? object_url : `${object_url.replace(/\/$/, "")}/source/main`;
          const [a, b] = await Promise.all([
            adt.revisionContent(from.uri, sourceUrl),
            adt.revisionContent(to.uri, sourceUrl),
          ]);
          const d = unifiedDiff(a, b, `#${compare_from} ${revisionLabel(from)}`, `#${compare_to} ${revisionLabel(to)}`, {
            maxLines: REVISION_DIFF_MAX_LINES,
          });
          text += d.text
            ? `\n\n比較 #${compare_from} → #${compare_to}(+${d.added} / -${d.removed} 行):\n${d.text}`
            : `\n\n#${compare_from} 與 #${compare_to} 內容相同。`;
        }
        return ok(truncate(text, DIAG_MAX_OUTPUT));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── E3 abapgit_repos(只讀)─────────────────────────────
  server.registerTool(
    "abapgit_repos",
    {
      title: "列出 abapGit repo(只讀)",
      description:
        "列出系統上以 abapGit ADT 後端連結的 repo(package、Git URL、branch、狀態)。只讀:" +
        "pull / push / stage 刻意不提供(需要把 GitHub 帳密或 token 交給工具,會經過 AI),請在 SAP GUI 的 abapGit 操作。" +
        "系統沒有 abapGit ADT 後端時會說明替代方式。",
      inputSchema: {},
    },
    async () => {
      try {
        if (!(await adt.hasAdtCollection(ABAPGIT_REPOS_PATH))) {
          return ok(
            `ℹ️ 此系統沒有 abapGit ADT 後端(ADT discovery 沒有 ${ABAPGIT_REPOS_PATH}),無法從這裡讀取 repo。` +
              `請用 SAP GUI 執行 ZABAPGIT_STANDALONE(交易碼 SE38)查看與操作 repo;pull / push 也請在那裡由人操作。`
          );
        }
        const repos = await adt.gitRepos();
        if (repos.length === 0) return ok("abapGit 沒有任何已連結的 repo。");
        return ok(
          `📦 abapGit 共 ${repos.length} 個 repo:\n` +
            repos.map((r) => `- ${r.name}(package ${r.packageName},branch ${r.branch || "?"})${r.status ? ` ${r.status}` : ""}\n  ${r.url}`).join("\n") +
            "\nℹ️ pull / push 請在 SAP GUI 的 abapGit 由人操作。"
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── D4 pretty_print ─────────────────────────────
  server.registerTool(
    "pretty_print",
    {
      title: "格式化原始碼(Pretty Printer)",
      description:
        "以 SAP 系統的 Pretty Printer 設定(關鍵字大小寫、縮排)格式化 ABAP 原始碼並回傳結果。" +
        "source 與 object_url 擇一:object_url 會讀取系統上目前的內容來格式化。" +
        "不會寫回系統;要套用請把結果交給 write_source。",
      inputSchema: {
        source: z.string().optional().describe("要格式化的原始碼"),
        object_url: z.string().optional().describe("物件或 source URI;讀取系統上目前的內容來格式化"),
      },
    },
    async ({ source, object_url }) => {
      try {
        if (!!source === !!object_url) return fail(new GuardViolationError("source 與 object_url 必須擇一提供。"));
        if (object_url) assertAdtUri(object_url);
        const input = source ?? (await adt.getObjectSource(isSourceUrl(object_url!) ? object_url! : `${object_url!.replace(/\/$/, "")}/source/main`));
        const r = await adt.prettyPrint(input);
        const same = r.source.replace(/\r\n/g, "\n").trimEnd() === input.replace(/\r\n/g, "\n").trimEnd();
        return ok(
          `🧹 已依系統 Pretty Printer 設定(${r.style || "預設"}${r.indentation ? "、縮排" : ""})格式化` +
            (same ? ",內容沒有變化" : "") +
            "。尚未寫回系統,要套用請用 write_source。\n\n" +
            truncate(r.source, DIAG_MAX_OUTPUT)
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── D3 list_dumps / dump_detail ─────────────────────────────
  server.registerTool(
    "list_dumps",
    {
      title: "列出 ST22 短傾印",
      description:
        "列出 ST22 短傾印(runtime dump):時間(UTC)、錯誤類型、中斷的程式、使用者與 dump_id。" +
        "預設最近 1 天、最多 20 筆,新的在前;可依天數與使用者篩選。用 dump_detail 看單筆內容。唯讀。",
      inputSchema: {
        days: z.number().int().positive().max(30).optional().describe("最近幾天,預設 1,上限 30"),
        user: z.string().optional().describe("選填:只列此使用者的短傾印,例如 DEVELOPER"),
        max_results: z.number().int().positive().max(100).optional().describe("最多筆數,預設 20,上限 100"),
      },
    },
    async ({ days, user, max_results }) => {
      try {
        const since = Date.now() - (days ?? 1) * 86_400_000;
        const all = await adt.listDumps(user);
        const recent = all.filter((d) => d.datetime && Date.parse(d.datetime) >= since);
        const shown = recent.slice(0, max_results ?? 20);
        if (shown.length === 0) {
          return ok(`最近 ${days ?? 1} 天沒有${user ? ` ${user.toUpperCase()} 的` : ""}短傾印。`);
        }
        const lines = shown.map(
          (d) => `- ${d.datetime} ${d.error}(程式 ${d.program},使用者 ${d.user})\n  dump_id:${d.id}`
        );
        return ok(
          `💥 最近 ${days ?? 1} 天共 ${recent.length} 筆短傾印` +
            (recent.length > shown.length ? `,顯示最新 ${shown.length} 筆` : "") +
            `:\n${lines.join("\n")}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "dump_detail",
    {
      title: "讀取短傾印內容",
      description:
        "讀取單筆短傾印:錯誤類型、例外類別、出錯位置(以 source/main 為準的 URI 與行號,可直接用於 read_source / write_source)、" +
        "以及 Short Text、Error analysis、How to correct、where terminated、Source Code Extract、Active Calls 等章節。" +
        "為避免帶出業務資料,不包含 Selected Variables 等變數內容章節;輸出上限 20,000 字元。唯讀。",
      inputSchema: {
        dump_id: z.string().min(1).describe("list_dumps 回傳的 dump_id"),
      },
    },
    async ({ dump_id }) => {
      try {
        const { meta, text } = await adt.dumpDetail(dump_id);
        const where = meta.termination
          ? `📍 出錯位置:${meta.termination.uri} 第 ${meta.termination.line} 行(以 source/main 為準)`
          : "📍 出錯位置:SAP 沒有提供可對應到原始碼的位置(物件可能已刪除或不是一般 ABAP 原始碼),請參考下方 where terminated";
        const head = [
          `💥 ${meta.error}${meta.exception ? `(例外 ${meta.exception})` : ""}`,
          `程式:${meta.program}`,
          `時間:${meta.datetime}  使用者:${meta.author}`,
          where,
          "ℹ️ 下方章節裡的行號是相對於方法 include,修改時請以上面的出錯位置為準。",
        ].join("\n");
        return ok(truncate(`${head}\n\n${text}`, DIAG_MAX_OUTPUT));
      } catch (e) {
        return fail(e);
      }
    }
  );
}

/** abapGit ADT 後端的 repo 集合(A4H 沒有,需另裝 abapGit 的 ADT 後端) */
const ABAPGIT_REPOS_PATH = "/sap/bc/adt/abapgit/repos";

/** get_revisions 的 diff 上限行數 */
const REVISION_DIFF_MAX_LINES = 500;

/**
 * 版本說明。A4H 實測:版本 URI 的編號 00000 = 目前 active、99999 = 已寫入尚未啟用(inactive);
 * 有 transport 紀錄的物件才會有其他編號與 versionTitle
 */
export function revisionLabel(r: Revision): string {
  const num = r.uri.match(/\/versions\/[^/]+\/([^/]+)\/content$/)?.[1] ?? "";
  if (num === "99999") return "inactive(已寫入、尚未啟用)";
  if (num === "00000") return "active(目前啟用的版本)";
  return [r.version, r.versionTitle].filter(Boolean).join(" ") || `版本 ${num}`;
}

/** activate_objects 一次最多物件數 */
const ACTIVATE_MAX_OBJECTS = 50;

/** inactive 清單 → 以主物件分組(子項目歸到 parentUri 下;只有子項目時以 parentUri 當主物件) */
export function groupInactive(entries: InactiveEntry[]) {
  const groups = new Map<string, { uri: string; name: string; type: string; parts: number; deleted: boolean }>();
  for (const e of entries) {
    const key = e.parentUri || e.uri;
    const g = groups.get(key) ?? { uri: key, name: e.name, type: e.parentUri ? "" : e.type, parts: 0, deleted: false };
    if (e.parentUri) g.parts++;
    else {
      g.type = e.type;
      g.name = e.name;
      g.deleted = e.deleted;
    }
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, type: g.type || "子項目" }));
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
