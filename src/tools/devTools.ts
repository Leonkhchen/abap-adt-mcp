/**
 * tools/devTools.ts — v0.3 開發循環工具
 *
 * 讓 AI 在 $TMP 從零完成「建立 → 寫 → 啟用 → ABAP Unit → ATC」:
 *  - 分析類(唯讀模式也註冊):run_atc、where_used、find_definition、class_components
 *  - 寫入/執行類(唯讀模式不註冊):create_object、run_unit_tests、run_class、create_transport
 * 寫入類一律經 SerialQueue 依序執行,並通過名稱前綴與 package 兩道白名單。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService } from "../adt/client.js";
import {
  baseObjectUrl,
  CREATABLE_TYPES,
  isLocalPackage,
  isSourceUrl,
  newObjectUrl,
  packageUrl,
} from "../adt/objectTypes.js";
import { formatAtcResult, formatClassComponents, formatUnitTestResults, formatWhereUsed } from "./formatters.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import { assertPackageAllowed, assertWriteAllowed, GuardViolationError } from "../safety/guards.js";
import type { SerialQueue } from "../safety/serialQueue.js";
import { fail, ok, truncate } from "./result.js";

/** 分析類工具(唯讀模式也註冊) */
export function registerAnalysisTools(server: McpServer, adt: AdtService): void {
  // ───────────────────────────── G3 run_atc ─────────────────────────────
  server.registerTool(
    "run_atc",
    {
      title: "執行 ATC 檢查",
      description:
        "對物件或 package 執行 ATC(ABAP Test Cockpit)靜態檢查,finding 依優先級分組(1 最嚴重),最多 100 筆。" +
        "check_variant 省略時用系統預設。系統啟動後第一次執行可能需要數分鐘。object_url 與 package_name 擇一提供。",
      inputSchema: {
        object_url: z.string().optional().describe("物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        package_name: z.string().optional().describe("package 名稱,例如 $TMP"),
        check_variant: z.string().optional().describe("選填:ATC check variant;省略時用系統預設"),
      },
    },
    async ({ object_url, package_name, check_variant }) => {
      try {
        if (!!object_url === !!package_name) {
          return fail(new GuardViolationError("object_url 與 package_name 必須擇一提供。"));
        }
        const url = object_url
          ? baseObjectUrl(object_url)
          : packageUrl(package_name!);
        return ok(formatAtcResult(await adt.runAtc(url, check_variant, ATC_MAX_FINDINGS), ATC_MAX_FINDINGS));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── G4 where_used ─────────────────────────────
  server.registerTool(
    "where_used",
    {
      title: "查詢使用處(where-used)",
      description:
        "查詢物件或其中某個元件(方法、屬性等)被哪些程式使用,回傳使用處的物件與程式碼行,最多 50 筆。" +
        "只給 object_url 時查整個物件;要查某個方法,請另給該方法名稱所在的 line 與 column(1 起算,可先用 read_source 看行號)。" +
        "注意:SAP 不會列出物件內部自己呼叫自己的地方;查詢廣泛使用的標準物件整體可能數分鐘後逾時,請改查特定元件。",
      inputSchema: {
        object_url: z.string().describe("物件 URI 或 source URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        ...positionSchema,
      },
    },
    async ({ object_url, line, column }) => {
      try {
        if (column && !line) return fail(new GuardViolationError("給 column 時必須同時給 line。"));
        let url = object_url;
        // 指定位置時要用 source URI(位置是相對於原始碼)
        if (line && !isSourceUrl(url)) url = `${url.replace(/\/$/, "")}/source/main`;
        const r = await adt.whereUsed(url, line, line ? (column ?? 1) - 1 : undefined);
        const target = line ? `${object_url} 第 ${line} 行${column ? `第 ${column} 欄` : ""}的元件` : object_url;
        return ok(formatWhereUsed(target, r, WHERE_USED_MAX));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── G5 find_definition ─────────────────────────────
  server.registerTool(
    "find_definition",
    {
      title: "跳到定義",
      description:
        "找出原始碼某個位置上的名稱(方法、變數、型別、class…)的定義位置,回傳 URI、行欄與該行原始碼。" +
        "line / column 以 1 起算(可先用 read_source 看行號),column 指到名稱上的任一字元即可。" +
        "implementation=true 時改跳到實作(例如方法的 METHOD 區塊)。",
      inputSchema: {
        object_url: z.string().describe("物件 URI 或 source URI,例如 /sap/bc/adt/oo/classes/zcl_demo 或 …/includes/testclasses"),
        line: z.number().int().positive().describe("名稱所在行(1 起算)"),
        column: z.number().int().positive().describe("名稱上的任一欄(1 起算)"),
        implementation: z.boolean().optional().describe("跳到實作而非定義(預設 false)"),
      },
    },
    async ({ object_url, line, column, implementation }) => {
      try {
        const sourceUrl = isSourceUrl(object_url)
          ? object_url
          : `${object_url.replace(/\/$/, "")}/source/main`;
        const d = await adt.findDefinition(sourceUrl, line, column - 1, implementation ?? false);
        if (!d.url) return ok(`找不到「${d.identifier}」的定義(可能是 ABAP 關鍵字或內建型別)。`);
        return ok(
          `📍 「${d.identifier}」的${implementation ? "實作" : "定義"}:${d.url} 第 ${d.line} 行第 ${d.column} 欄` +
            (d.sourceLine ? `\n${String(d.line).padStart(5)}| ${d.sourceLine}` : "")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── G5 class_components ─────────────────────────────
  server.registerTool(
    "class_components",
    {
      title: "列出 class 元件",
      description:
        "列出 class 或 interface 的元件:方法、屬性、常數、型別、事件、實作的介面,含可見性、static/instance 與定義行號。",
      inputSchema: {
        object_url: z.string().describe("class / interface URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
      },
    },
    async ({ object_url }) => {
      try {
        return ok(formatClassComponents(await adt.classComponents(baseObjectUrl(object_url))));
      } catch (e) {
        return fail(e);
      }
    }
  );
}

/** run_class 輸出上限(字元) */
export const RUN_CLASS_MAX_OUTPUT = 20_000;

/** run_atc 回傳 finding 上限 */
const ATC_MAX_FINDINGS = 100;
/** where_used 回傳筆數上限 */
const WHERE_USED_MAX = 50;

/** AI 給的位置(1 起算的行與欄)→ ADT 位置(行 1 起算、欄 0 起算) */
const positionSchema = {
  line: z.number().int().positive().optional().describe("選填:元件所在行(1 起算),例如方法定義那一行"),
  column: z.number().int().positive().optional().describe("選填:元件名稱開頭的欄位(1 起算,同編輯器顯示);需搭配 line"),
};

/** 寫入/執行類工具(呼叫端只在非唯讀模式時呼叫) */
export function registerWriteDevTools(
  server: McpServer,
  adt: AdtService,
  cfg: AppConfig,
  audit: AuditLogger,
  writes: SerialQueue
): void {
  // ───────────────────────────── G1 create_object ─────────────────────────────
  server.registerTool(
    "create_object",
    {
      title: "建立 ABAP 物件",
      description:
        "建立新的 ABAP 物件(只建立空殼與 SAP 產生的範本,原始碼請之後用 write_source 寫入並啟用)。" +
        "支援 CLAS/OC(class)、INTF/OI(interface)、PROG/P(program)、DDLS/DF(CDS data definition)、" +
        "BDEF/BDO(behavior definition,名稱須與已存在的 root view entity 相同)。" +
        "會先檢查名稱是否可用;package 不是 $TMP 等本機 package 時必須提供 transport(可用 list_transports 查詢)。",
      inputSchema: {
        object_type: z.enum(CREATABLE_TYPES).describe("物件類型"),
        name: z.string().min(1).describe("物件名稱,例如 ZCL_DEMO(必須符合可寫入前綴白名單)"),
        package_name: z.string().min(1).describe("package,例如 $TMP(必須符合 package 白名單)"),
        description: z.string().min(1).max(60).describe("物件描述(60 字元內)"),
        transport: z.string().optional().describe("Transport request 編號;$TMP 等本機 package 可省略"),
      },
    },
    async ({ object_type, name, package_name, description, transport }) =>
      writes.run(async () => {
        const objectName = name.toUpperCase();
        const packageName = package_name.toUpperCase();
        const objectUrl = newObjectUrl(object_type, objectName);
        try {
          // 兩道白名單:名稱前綴 + package
          assertWriteAllowed(cfg, objectUrl);
          assertPackageAllowed(cfg, packageName);
          if (!isLocalPackage(packageName) && !transport) {
            throw new GuardViolationError(
              `package ${packageName} 不是本機 package,必須提供 transport(可用 list_transports 查詢,或用 create_transport 建立)。`
            );
          }

          const spec = { type: object_type, name: objectName, packageName, description };
          const v = await adt.validateNewObject(spec);
          if (!v.ok) {
            return ok(`❌ 無法建立 ${objectName}:${v.message || "名稱檢查未通過"}`);
          }

          await adt.createObject({ ...spec, transport });
          audit.log({
            timestamp: new Date().toISOString(),
            action: "create_object",
            objectUrl,
            objectName,
            transport,
            summary: `${object_type} 於 ${packageName}`,
            success: true,
          });
          return ok(
            `✅ 已建立 ${object_type} ${objectName}(package ${packageName}` +
              (transport ? `,transport ${transport}` : "") +
              `)\nuri:${objectUrl}\n` +
              `ℹ️ 物件目前為 inactive:請用 read_source 取得範本,write_source 寫入完整原始碼後啟用。`
          );
        } catch (e) {
          audit.log({
            timestamp: new Date().toISOString(),
            action: "create_object",
            objectUrl,
            objectName,
            transport,
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
          return fail(e);
        }
      })
  );

  // ───────────────────────────── G2 run_unit_tests ─────────────────────────────
  // 測試會在 SAP 上執行程式碼;RISK LEVEL 只是測試類別的宣告,不保證不寫資料,
  // 因此與 run_class 一樣在唯讀模式(含 prod)不註冊(v0.3 審查 #2)
  server.registerTool(
    "run_unit_tests",
    {
      title: "執行 ABAP Unit 測試",
      description:
        "會在 SAP 系統上執行測試程式碼:執行物件(class / program)或整個 package 的 ABAP Unit 測試," +
        "回傳每個測試方法的結果、失敗訊息與位置。只執行宣告為 RISK LEVEL HARMLESS、DURATION SHORT/MEDIUM 的測試類別。" +
        "唯讀模式不提供。object_url 與 package_name 擇一提供。",
      inputSchema: {
        object_url: z.string().optional().describe("物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        package_name: z.string().optional().describe("package 名稱,例如 $TMP(執行其中所有物件的測試)"),
      },
    },
    async ({ object_url, package_name }) => {
      try {
        if (!!object_url === !!package_name) {
          return fail(new GuardViolationError("object_url 與 package_name 必須擇一提供。"));
        }
        const url = object_url
          ? baseObjectUrl(object_url)
          : packageUrl(package_name!);
        return ok(formatUnitTestResults(await adt.runUnitTests(url)));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── G6 run_class ─────────────────────────────
  server.registerTool(
    "run_class",
    {
      title: "執行 class(IF_OO_ADT_CLASSRUN)",
      description:
        "⚠️ 會在 SAP 系統上執行程式:呼叫 class 的 IF_OO_ADT_CLASSRUN~MAIN,程式內容(包括寫資料庫)都會真的執行。" +
        "回傳 out->write 的輸出(超過 20,000 字元截斷)。只能執行符合可寫入前綴與 package 白名單的 class;" +
        "class 必須已啟用並實作 IF_OO_ADT_CLASSRUN。執行前請先確認程式內容。",
      inputSchema: {
        class_name: z.string().min(1).describe("class 名稱,例如 ZCL_DEMO_RUN"),
      },
    },
    async ({ class_name }) => {
      const name = class_name.toUpperCase();
      const objectUrl = newObjectUrl("CLAS/OC", name);
      try {
        // 執行程式與寫入同等風險:兩道白名單
        assertWriteAllowed(cfg, objectUrl);
        assertPackageAllowed(cfg, await adt.objectPackage(objectUrl));
        const output = await adt.runClass(name);
        audit.log({
          timestamp: new Date().toISOString(),
          action: "run_class",
          objectUrl,
          objectName: name,
          summary: `輸出 ${output.length} 字元`,
          success: true,
        });
        const text = output.trim() ? truncate(output.trimEnd(), RUN_CLASS_MAX_OUTPUT) : "(沒有輸出)";
        return ok(`▶️ 已執行 ${name}:\n${text}`);
      } catch (e) {
        audit.log({
          timestamp: new Date().toISOString(),
          action: "run_class",
          objectUrl,
          objectName: name,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });
        return fail(e);
      }
    }
  );

  // ───────────────────────────── G7 create_transport(只在 dev 註冊)─────────────────────────────
  if (cfg.safety.systemRole !== "dev") return;
  server.registerTool(
    "create_transport",
    {
      title: "建立 Transport Request",
      description:
        "為非本機 package 建立 workbench transport request,回傳 TR 編號,供 create_object / write_source 使用。" +
        "$TMP 等本機 package 不需要 transport。只在 dev 系統且非唯讀時可用;package 必須符合 package 白名單。",
      inputSchema: {
        package_name: z.string().min(1).describe("要放物件的 package,例如 ZMY_PACKAGE"),
        description: z.string().min(1).max(60).describe("TR 描述(60 字元內)"),
        object_url: z
          .string()
          .optional()
          .describe("選填:要記錄的物件 URI;省略時以 package 為參照"),
      },
    },
    async ({ package_name, description, object_url }) =>
      writes.run(async () => {
        const packageName = package_name.toUpperCase();
        const refUrl = object_url ?? packageUrl(packageName);
        try {
          assertPackageAllowed(cfg, packageName);
          if (isLocalPackage(packageName)) {
            return fail(new GuardViolationError(`package ${packageName} 是本機 package,不需要 transport。`));
          }
          const tr = await adt.createTransport(refUrl, description, packageName);
          audit.log({
            timestamp: new Date().toISOString(),
            action: "create_transport",
            objectUrl: refUrl,
            objectName: packageName,
            transport: tr,
            summary: description,
            success: !!tr,
          });
          return tr
            ? ok(`✅ 已建立 transport request ${tr}(package ${packageName}):${description}`)
            : fail(new Error("SAP 沒有回傳 transport 編號。"));
        } catch (e) {
          audit.log({
            timestamp: new Date().toISOString(),
            action: "create_transport",
            objectUrl: refUrl,
            objectName: packageName,
            success: false,
            error: e instanceof Error ? e.message : String(e),
          });
          return fail(e);
        }
      })
  );
}
