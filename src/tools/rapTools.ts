/**
 * tools/rapTools.ts — v0.5 RAP 產生器(rap_generate)
 *
 * 由一張 Z 資料表產生 RAP BO 與 OData V4 UI 服務(A4H 實測約 14 個物件)。一次建立大量物件,因此:
 *  - 兩段式:預設只預覽(回傳會建立哪些物件),必須再以 confirm=true 呼叫才真的產生
 *  - preview 清單的每個物件都要通過名稱前綴白名單,目標 package 要通過 package 白名單;任一不過整批拒絕
 *  - 經寫入佇列、每個物件各寫一筆 audit;唯讀模式不註冊(呼叫端負責)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService } from "../adt/client.js";
import { isLocalPackage, newObjectUrl } from "../adt/objectTypes.js";
import { serviceBindingName, type RapObjectRef } from "../adt/rapGenerator.js";
import type { AppConfig } from "../config.js";
import type { AuditLogger } from "../safety/audit.js";
import { assertPackageAllowed, assertWriteAllowed, GuardViolationError } from "../safety/guards.js";
import type { SerialQueue } from "../safety/serialQueue.js";
import { assertTableName } from "../safety/sql.js";
import { fail, ok } from "./result.js";

/** 物件清單 → 文字(類型、名稱) */
function listObjects(objects: RapObjectRef[]): string {
  return objects.map((o) => `- ${o.type.padEnd(9)} ${o.name}`).join("\n");
}

/** 檢查每個物件的名稱前綴白名單;回傳違反的說明(空陣列 = 全部通過) */
export function deniedObjects(cfg: AppConfig, objects: RapObjectRef[]): string[] {
  const denied: string[] = [];
  for (const o of objects) {
    try {
      assertWriteAllowed(cfg, o.uri || `/sap/bc/adt/x/${encodeURIComponent(o.name.toLowerCase())}`);
    } catch (e) {
      denied.push(`- ${o.type} ${o.name}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return denied;
}

export function registerRapTools(
  server: McpServer,
  adt: AdtService,
  cfg: AppConfig,
  audit: AuditLogger,
  writes: SerialQueue
): void {
  server.registerTool(
    "rap_generate",
    {
      title: "由資料表產生 RAP BO 與 Fiori 服務",
      description:
        "以 SAP 的 RAP 產生器(ui-service),由一張資料表產生 RAP business object 與 OData V4 UI 服務" +
        "(約 14 個物件:CDS、behavior、behavior 實作 class、projection、metadata extension、access control、" +
        "service definition / binding、草稿表等)。兩段式:預設只預覽、不建立任何物件;確認清單後以相同參數加 confirm=true 再呼叫才會產生。" +
        "每個物件都必須通過名稱前綴白名單、目標 package 必須通過 package 白名單,任一不過整批拒絕。" +
        "產生可能需要數分鐘(系統剛啟動時可能超過 5 分鐘而逾時,此時會回報已建立的物件)。" +
        "來源表可先用 create_object(TABL/DT)建立;建議含 client、UUID key 與 RAP 管理欄位(local_last_changed_at 等)。",
      inputSchema: {
        source_table: z.string().min(1).describe("來源資料表名稱,例如 ZLEON_ORDERS"),
        package_name: z.string().min(1).describe("產生的物件放在哪個 package,例如 $TMP 或 $LEON_PRACTICE"),
        name_prefix: z
          .string()
          .regex(/^[ZYzy][A-Za-z0-9_]*$/)
          .optional()
          .describe("選填:名稱前綴,取代預設名稱開頭的 Z,例如 ZLEON_ → ZLEON_R_ORDERS、ZLEON_UI_ORDERS_O4"),
        publish: z.boolean().optional().describe("產生後發佈 service binding(預設 true)"),
        confirm: z.boolean().optional().describe("true 才實際產生;省略或 false 只預覽"),
        transport: z.string().optional().describe("非本機 package 時必填的 transport request"),
      },
    },
    async ({ source_table, package_name, name_prefix, publish, confirm, transport }) =>
      writes.run(async () => {
        const table = assertTableName(source_table);
        const pkg = package_name.toUpperCase();
        const tableUri = newObjectUrl("TABL/DT", table);
        try {
          assertPackageAllowed(cfg, pkg);
          if (!isLocalPackage(pkg) && !transport) {
            throw new GuardViolationError(`package ${pkg} 不是本機 package,必須提供 transport(可用 create_transport 建立)。`);
          }
          const links = await adt.rapGeneratorLinks(tableUri);
          if (!links) {
            return fail(
              new GuardViolationError(
                "此系統沒有可用的 RAP 產生器(repository generators 裡找不到 ui-service)。" +
                  "請改在 Eclipse ADT 對資料表按右鍵 → Generate ABAP Repository Objects。"
              )
            );
          }

          const preview = await adt.rapPreview(links, tableUri, pkg, name_prefix);
          if (!preview.validation.ok) {
            return ok(`❌ 產生器檢查未通過,未建立任何物件:\n${preview.validation.messages.map((m) => `- ${m}`).join("\n") || "(無詳細訊息)"}`);
          }
          const denied = deniedObjects(cfg, preview.objects);
          const binding = serviceBindingName(preview.content);
          const list = listObjects(preview.objects);

          if (!confirm) {
            return ok(
              `🔍 預覽(尚未建立任何物件):會在 package ${pkg} 由 ${table} 產生 ${preview.objects.length} 個物件:\n${list}\n` +
                `service binding:${binding}\n` +
                (denied.length
                  ? `\n⚠️ 以下物件不在可寫入的名稱白名單內,確認時會整批拒絕:\n${denied.join("\n")}\n` +
                    `可改用 name_prefix 讓名稱符合白名單。`
                  : `\n確認無誤後,請以相同參數加上 confirm=true 再呼叫一次。`)
            );
          }
          if (denied.length) {
            return fail(new GuardViolationError(`整批拒絕,沒有產生任何物件:\n${denied.join("\n")}`));
          }

          try {
            await adt.rapGenerate(links, tableUri, preview.content, transport ?? "");
          } catch (e) {
            // A4H 實測:系統剛啟動後第一次產生超過 5 分鐘 → 500,但 SAP 端多半已建立大部分物件
            const status = (e as { status?: unknown } | null)?.status;
            if (typeof status !== "number" || status < 500) throw e;
            const existing: RapObjectRef[] = [];
            for (const o of preview.objects) {
              const hits = await adt.searchObject(o.name, o.type, 5).catch(() => []);
              if (hits.some((h) => h["adtcore:name"].toUpperCase() === o.name.toUpperCase() && h["adtcore:type"] === o.type)) existing.push(o);
            }
            for (const o of existing) {
              audit.log({ timestamp: new Date().toISOString(), action: "rap_generate", objectUrl: o.uri, objectName: o.name, transport, summary: `${o.type}(產生逾時,事後確認存在)`, success: true });
            }
            const missing = preview.objects.filter((o) => !existing.includes(o));
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `⚠️ 產生請求逾時(SAP 回 ${status})。已存在 ${existing.length}/${preview.objects.length} 個物件` +
                    (missing.length ? `,缺少:\n${listObjects(missing)}` : "。") +
                    `\n系統剛啟動後第一次產生常超過 5 分鐘;請用 list_inactive 確認狀態。` +
                    `若只缺 service binding,可刪除這批物件後在系統熱機時重新產生,或在 Eclipse 補建。`,
                },
              ],
              isError: true,
            };
          }

          for (const o of preview.objects) {
            audit.log({ timestamp: new Date().toISOString(), action: "rap_generate", objectUrl: o.uri, objectName: o.name, transport, summary: `${o.type} 由 ${table} 產生`, success: true });
          }
          const lines = [`✅ 已在 package ${pkg} 由 ${table} 產生 ${preview.objects.length} 個物件:\n${list}`, `service binding:${binding}`];

          if (publish !== false && binding) {
            const p = await adt.rapPublish(binding);
            lines.push(p.ok ? `✅ 已發佈:${p.message || binding}` : `⚠️ 發佈失敗:${p.message}(可在 Eclipse 開啟 service binding 按 Publish)`);
            try {
              const s = await adt.odataV4Service(binding);
              if (s.serviceUrl) {
                const base = cfg.sap.url.replace(/\/$/, "");
                const client = cfg.sap.client ? `?sap-client=${cfg.sap.client}` : "";
                lines.push(
                  `OData V4 服務:${base}${s.serviceUrl}${client}` +
                    (s.leadingEntity ? `\n資料:${base}${s.serviceUrl}${s.leadingEntity}${client}` : "")
                );
              }
            } catch {
              // 服務資訊讀不到不影響產生結果
            }
            lines.push(
              `Fiori Elements preview:在 Eclipse 開啟 service binding ${binding},` +
                `於 Entity Set and Association 選主要 entity set 後按 Preview(會開瀏覽器顯示列表與明細頁)。`
            );
          } else {
            lines.push(`ℹ️ 尚未發佈;可再以 Eclipse 開啟 service binding ${binding} 按 Publish。`);
          }
          return ok(lines.join("\n"));
        } catch (e) {
          return fail(e);
        }
      })
  );
}
