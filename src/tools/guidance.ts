/**
 * tools/guidance.ts — v0.5 MCP prompts 與 resources
 *
 * prompts:把常見的多步驟工作流程寫成 AI 可直接照做的步驟(使用者在 Claude Code 以 /mcp 選單或 @ 引用)
 * resources:命名規範、安全護欄摘要(依目前設定即時產生)、Clean ABAP 要點(自行摘要並附官方連結)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "../config.js";

export const RESOURCE_URIS = {
  naming: "abap-mcp://guides/naming",
  safety: "abap-mcp://guides/safety",
  cleanAbap: "abap-mcp://guides/clean-abap",
} as const;

const CLEAN_ABAP_URL = "https://github.com/SAP/styleguides/blob/main/clean-abap/CleanABAP.md";

const userPrompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** 命名規範(依目前的白名單設定產生) */
export function namingGuide(cfg: AppConfig): string {
  const pkgs = cfg.safety.allowedPackages;
  return [
    "# 命名規範(abap-adt-mcp)",
    "",
    "## 物件名稱",
    `- 只能寫入名稱以 ${cfg.safety.allowedPrefixes.join(" / ")} 開頭的物件(ABAP_MCP_ALLOWED_PREFIXES)。Z / Y 是客戶命名空間,SAP 標準物件不能改。`,
    "- 常見慣例:class `ZCL_`、interface `ZIF_`、例外 class `ZCX_`、CDS interface view `ZI_`、consumption / projection view `ZC_`、" +
      "RAP 根實體 `ZR_`、behavior 實作 class `ZBP_`、service definition / binding `ZUI_…_O4`(OData V4 UI)、資料表 `Z…`(最多 16 字元)。",
    "- 名稱長度:class / CDS / service 最多 30 字元,資料表最多 16 字元。",
    "",
    "## package",
    `- 目前允許的 package:${pkgs.join("、")}(ABAP_MCP_ALLOWED_PACKAGES;* 結尾為前綴比對)。`,
    "- `$` 開頭是本機 package,不會進 transport,不需要 transport request。`$TMP` 是個人暫存;其他 `$` package(例如 abapGit 練習用的 `$LEON_PRACTICE`)可用 abapGit 同步到 Git。",
    "- 非 `$` 的 package 需要 transport request:先用 list_transports 找,沒有再用 create_transport 建。",
  ].join("\n");
}

/** 安全護欄摘要(依目前設定產生) */
export function safetyGuide(cfg: AppConfig): string {
  const s = cfg.safety;
  return [
    "# 安全護欄摘要(abap-adt-mcp)",
    "",
    `- 目前模式:系統角色 ${s.systemRole},${s.readonly ? "唯讀(寫入、執行類工具未註冊)" : "可讀寫"}。prod 一律強制唯讀。`,
    `- 寫入、建立、啟用、執行都要通過兩道白名單:名稱前綴(${s.allowedPrefixes.join(", ")})與 package(${s.allowedPackages.join(", ")})。批次啟用與 RAP 產生器任一物件不過就整批拒絕。`,
    "- write_source 會先做語法檢查、可用 expected_current_source 做並行保護,鎖定一定釋放;寫入類操作依序執行,鎖定用獨立 SAP session。",
    "- run_class 與 run_unit_tests 會在 SAP 上執行程式;rap_generate 一次建立約 14 個物件,預設只預覽,需 confirm=true 才產生。",
    s.allowDataPreview
      ? `- data_preview 已開啟:只接受單一 SELECT,只能讀表白名單(${s.dataPreviewTables.join(", ")})內的表,不支援 CDS 關聯路徑。`
      : "- data_preview 未開啟(ABAP_MCP_ALLOW_DATA_PREVIEW=false),無法讀資料表內容。",
    "- dump_detail 不帶出短傾印的變數內容;abapGit 只能列出 repo,pull / push 一律由人在 SAP GUI 操作(不經過 AI 傳帳密)。",
    "- 連續 2 次認證失敗會停止連線 SAP(避免鎖帳號),需修正密碼後重開 MCP。",
    `- audit log:${s.auditLogPath ? s.auditLogPath : "未設定(ABAP_MCP_AUDIT_LOG)"}。`,
    "",
    "詳細說明見專案的 docs/SECURITY.md。",
  ].join("\n");
}

/** Clean ABAP 要點(自行摘要;完整內容請見官方 repo) */
export function cleanAbapGuide(): string {
  return [
    "# Clean ABAP 要點(摘要)",
    "",
    `以下是本專案用來審查程式碼的重點,用自己的話整理;完整規則與理由請看 SAP 官方的 Clean ABAP 指南:${CLEAN_ABAP_URL}`,
    "",
    "- **命名**:用能說明用途的完整名稱,不要加型別或範圍的前綴(例如 lv_、lt_、gv_);名詞給物件、動詞給方法。",
    "- **語言**:用新式語法(inline 宣告、VALUE / NEW / COND / SWITCH、字串樣板 |…|、函式式方法呼叫),少用過時語句。",
    "- **常數**:不要在程式裡寫魔術數字或字串,改用有名字的常數或列舉 class。",
    "- **方法**:小而只做一件事;參數少(輸入最好不超過 3 個);寧可回傳值也不要 EXPORTING / CHANGING 一堆;不要用布林參數切換行為。",
    "- **類別**:預設 FINAL、成員預設 PRIVATE;偏好組合而非繼承;依賴用介面,方便測試替身。",
    "- **錯誤處理**:用 class-based 例外,不要回傳 sy-subrc 或錯誤碼;不要吞掉例外;例外 class 依呼叫端要處理的方式分類。",
    "- **註解**:用程式碼表達意圖,註解說明「為什麼」而不是「做什麼」;刪掉被註解掉的舊程式碼。",
    "- **格式**:一致的縮排與關鍵字大小寫(可用 pretty_print);一行一個敘述,適度空行分段。",
    "- **測試**:為公開行為寫 ABAP Unit;測試類別 FOR TESTING、RISK LEVEL HARMLESS;一個測試只驗一件事、名稱說明情境;用介面與測試替身隔離資料庫。",
  ].join("\n");
}

export function registerGuidance(server: McpServer, cfg: AppConfig): void {
  // ───────────────────────────── resources ─────────────────────────────
  server.registerResource(
    "naming",
    RESOURCE_URIS.naming,
    { title: "命名規範", description: "Z/Y 前綴、$TMP 與其他本機 package、常見物件命名慣例(依目前設定)", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: namingGuide(cfg) }] })
  );
  server.registerResource(
    "safety",
    RESOURCE_URIS.safety,
    { title: "安全護欄摘要", description: "本專案的白名單、唯讀、執行與資料讀取限制(依目前設定)", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: safetyGuide(cfg) }] })
  );
  server.registerResource(
    "clean-abap",
    RESOURCE_URIS.cleanAbap,
    { title: "Clean ABAP 要點", description: "Clean ABAP 審查重點摘要,附 SAP 官方指南連結", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: cleanAbapGuide() }] })
  );

  // ───────────────────────────── prompts ─────────────────────────────
  server.registerPrompt(
    "clean-abap-review",
    {
      title: "Clean ABAP 審查",
      description: "依 Clean ABAP 要點審查一個物件,列出問題與建議(預設不修改)",
      argsSchema: { object_url: z.string().describe("要審查的物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo") },
    },
    ({ object_url }) =>
      userPrompt(
        [
          `請依 Clean ABAP 審查 ${object_url}:`,
          `1. 先讀資源 ${RESOURCE_URIS.cleanAbap} 了解審查重點。`,
          `2. 用 read_source 讀原始碼(class 也讀 …/includes/testclasses,沒有就略過),用 class_components 看結構。`,
          `3. 用 run_atc 跑靜態檢查。`,
          `4. 整理成表格:嚴重度(高 / 中 / 低)、行號、問題、建議寫法;ATC 的優先級 1–2 一律列為高。最後用 2–3 句總結最該先改的地方。`,
          `5. 只審查、不要修改;使用者明確要求修改時,才用 write_source(帶 expected_current_source)並在之後重跑 run_atc 與 run_unit_tests。`,
        ].join("\n")
      )
  );

  server.registerPrompt(
    "rap-bo-from-table",
    {
      title: "由資料表產生 RAP BO",
      description: "建立(或沿用)一張 Z 資料表,再用 RAP 產生器產生 BO 與 Fiori 服務",
      argsSchema: {
        table_name: z.string().describe("資料表名稱(Z 開頭,最多 16 字元),例如 ZLEON_ORDERS"),
        package_name: z.string().optional().describe("package,預設 $TMP"),
        name_prefix: z.string().optional().describe("產生物件的名稱前綴,例如 ZLEON_(選填)"),
      },
    },
    ({ table_name, package_name, name_prefix }) => {
      const pkg = package_name || "$TMP";
      return userPrompt(
        [
          `請在 package ${pkg} 由資料表 ${table_name} 產生 RAP BO 與 OData V4 UI 服務:`,
          `1. 先讀資源 ${RESOURCE_URIS.naming} 確認名稱與 package 符合規範。`,
          `2. 用 ddic_info 查 ${table_name} 是否存在。不存在就用 create_object(TABL/DT)建立,再用 write_source 寫入 define table 並啟用。` +
            "建議欄位:key client : abap.clnt not null;key 一個 UUID(sysuuid_x16)或業務 key;業務欄位;" +
            "以及 local_created_by / local_created_at / local_last_changed_by / local_last_changed_at / last_changed_at(abp_* 資料元素)。",
          `3. 用 rap_generate 先預覽(source_table=${table_name}、package_name=${pkg}${name_prefix ? `、name_prefix=${name_prefix}` : ""}),把會建立的物件清單給使用者看。`,
          `4. 使用者確認後,以相同參數加 confirm=true 產生並發佈。產生可能需要數分鐘。`,
          `5. 回報 service binding 名稱、OData 服務 URL,以及在 Eclipse 開啟 Fiori Elements preview 的步驟。`,
        ].join("\n")
      );
    }
  );

  server.registerPrompt(
    "fix-dump",
    {
      title: "修正短傾印",
      description: "從 ST22 短傾印找出原因、修正程式並用 run_class 驗證",
      argsSchema: {
        class_name: z.string().optional().describe("選填:只看這個 class 的短傾印"),
        days: z.string().optional().describe("選填:查最近幾天,預設 1"),
      },
    },
    ({ class_name, days }) =>
      userPrompt(
        [
          `請找出並修正${class_name ? ` ${class_name} 的` : ""}短傾印:`,
          `1. 用 list_dumps(days=${days || "1"},user 為目前使用者)找出相關的短傾印${class_name ? `(程式名稱以 ${class_name.toUpperCase()}= 開頭)` : ""}。`,
          "2. 用 dump_detail 看錯誤類型、例外與出錯位置;以「出錯位置」給的 source/main 行號為準(章節裡的行號是相對於方法 include)。",
          "3. 用 read_source 讀出錯位置附近的程式碼,判斷根本原因(不要只用 TRY…CATCH 把錯誤吞掉)。",
          "4. 用 write_source(帶 expected_current_source、activate=true)寫入修正。",
          "5. 用 run_class 驗證不再短傾印;若 class 有 ABAP Unit 測試,再跑 run_unit_tests。",
          "6. 回報原因、修正內容與驗證結果。",
        ].join("\n")
      )
  );
}
