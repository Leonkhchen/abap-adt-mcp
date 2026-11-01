/**
 * tools/devTools.ts — v0.3 開發循環工具
 *
 * 讓 AI 在 $TMP 從零完成「建立 → 寫 → 啟用 → ABAP Unit → ATC」:
 *  - 分析類(唯讀模式也註冊):run_unit_tests、run_atc、where_used、find_definition、class_components
 *  - 寫入/執行類(唯讀模式不註冊):create_object、run_class、create_transport
 * 寫入類一律經 SerialQueue 依序執行,並通過名稱前綴與 package 兩道白名單。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService } from "../adt/client.js";
import { CREATABLE_TYPES, isLocalPackage, newObjectUrl, packageUrl } from "../adt/objectTypes.js";
import { formatAtcResult, formatUnitTestResults } from "./formatters.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import { assertPackageAllowed, assertWriteAllowed, GuardViolationError } from "../safety/guards.js";
import type { SerialQueue } from "../safety/serialQueue.js";
import { fail, ok } from "./result.js";

/** 分析類工具(唯讀模式也註冊) */
export function registerAnalysisTools(server: McpServer, adt: AdtService): void {
  // ───────────────────────────── G2 run_unit_tests ─────────────────────────────
  server.registerTool(
    "run_unit_tests",
    {
      title: "執行 ABAP Unit 測試",
      description:
        "執行物件(class / program)或整個 package 的 ABAP Unit 測試,回傳每個測試方法的結果、" +
        "失敗訊息與位置。只執行 RISK LEVEL HARMLESS、DURATION SHORT/MEDIUM 的測試(不會跑會改資料的測試)。" +
        "object_url 與 package_name 擇一提供。",
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
          ? object_url.replace(/\/source\/[^/]+$/, "")
          : packageUrl(package_name!);
        return ok(formatUnitTestResults(await adt.runUnitTests(url)));
      } catch (e) {
        return fail(e);
      }
    }
  );

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
          ? object_url.replace(/\/source\/[^/]+$/, "")
          : packageUrl(package_name!);
        return ok(formatAtcResult(await adt.runAtc(url, check_variant, ATC_MAX_FINDINGS), ATC_MAX_FINDINGS));
      } catch (e) {
        return fail(e);
      }
    }
  );
}

/** run_atc 回傳 finding 上限 */
const ATC_MAX_FINDINGS = 100;

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
}
