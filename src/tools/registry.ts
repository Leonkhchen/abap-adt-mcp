/**
 * tools/registry.ts — MCP 工具註冊中心
 *
 * 所有工具在這裡定義並註冊到 McpServer。
 * 唯讀模式下,寫入類工具(write_source / activate_object)完全不註冊,
 * AI 從 tool list 就看不到它們 —— 這比「註冊後再拒絕」更安全也更省 token。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AdtService } from "../adt/client.js";
import { formatErrorForAi } from "../adt/errors.js";
import type { AppConfig } from "../config.js";
import { AuditLogger, diffSummary } from "../safety/audit.js";
import { assertWriteAllowed, objectNameFromUrl } from "../safety/guards.js";
import { lockedWrite } from "../workflows/lockedWrite.js";

/** MCP 工具回傳格式的小工具函式 */
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: formatErrorForAi(err) }],
  isError: true,
});

/** 將物件 URI 解析為 main include 的 source URI */
async function resolveSourceUrl(adt: AdtService, objectUrl: string): Promise<string> {
  // 若呼叫端已直接給 source URI,直接使用
  if (/\/source\/(main|[^/]+)$/.test(objectUrl)) return objectUrl;
  const structure = await adt.objectStructure(objectUrl);
  return adt.mainInclude(structure);
}

export function registerTools(
  server: McpServer,
  adt: AdtService,
  cfg: AppConfig,
  audit: AuditLogger
): void {
  // ───────────────────────────── 診斷 ─────────────────────────────
  server.registerTool(
    "ping_system",
    {
      title: "測試 SAP 連線",
      description:
        "測試與 SAP 系統的 ADT 連線是否正常,回傳系統 URL、登入帳號與目前的安全模式。" +
        "連線異常時會回傳診斷建議。建議在開始任何工作前先呼叫一次。",
      inputSchema: {},
    },
    async () => {
      try {
        await adt.login();
        return ok(
          [
            `✅ SAP 連線正常`,
            `系統:${adt.baseUrl()}`,
            `使用者:${adt.username()}`,
            `系統角色:${cfg.safety.systemRole}`,
            `模式:${cfg.safety.readonly ? "唯讀(寫入工具未啟用)" : "可讀寫"}`,
            cfg.safety.readonly
              ? ""
              : `可寫入物件前綴:${cfg.safety.allowedPrefixes.join(", ")}`,
          ]
            .filter(Boolean)
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── 搜尋與瀏覽 ─────────────────────────────
  server.registerTool(
    "search_objects",
    {
      title: "搜尋 ABAP 物件",
      description:
        "以名稱(支援 * 萬用字元)搜尋 ABAP 物件,例如 'ZCL_INVOICE*'。" +
        "回傳物件名稱、類型、package 與 ADT URI(後續工具皆以此 URI 操作)。",
      inputSchema: {
        query: z.string().describe("搜尋字串,支援萬用字元,例如 ZCL_* 或 Z*PRICING*"),
        object_type: z
          .string()
          .optional()
          .describe("選填:限定物件類型,例如 CLAS/OC(class)、PROG/P(program)、INTF/OI(interface)"),
        max_results: z.number().int().positive().max(100).optional().describe("最多回傳筆數,預設 30"),
      },
    },
    async ({ query, object_type, max_results }) => {
      try {
        const results = await adt.searchObject(query, object_type, max_results ?? 30);
        if (results.length === 0) return ok(`找不到符合「${query}」的物件。`);
        const lines = results.map(
          (r) =>
            `- ${r["adtcore:name"]} [${r["adtcore:type"]}]` +
            (r["adtcore:packageName"] ? ` (package: ${r["adtcore:packageName"]})` : "") +
            `\n  uri: ${r["adtcore:uri"]}`
        );
        return ok(`找到 ${results.length} 個物件:\n${lines.join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "browse_package",
    {
      title: "瀏覽 Package 內容",
      description: "列出指定 package(開發類別)內的所有物件,例如 ZFI_TOOLS 或 $TMP。",
      inputSchema: {
        package_name: z.string().describe("Package 名稱,例如 ZFI_TOOLS、$TMP"),
      },
    },
    async ({ package_name }) => {
      try {
        const result = await adt.nodeContents("DEVC/K", package_name.toUpperCase());
        const nodes = result.nodes.filter((n) => n.OBJECT_NAME);
        if (nodes.length === 0) return ok(`Package ${package_name} 是空的或不存在。`);
        const lines = nodes.map(
          (n) =>
            `- ${n.OBJECT_NAME} [${n.OBJECT_TYPE}]` +
            (n.OBJECT_URI ? `\n  uri: ${n.OBJECT_URI}` : "")
        );
        return ok(`Package ${package_name.toUpperCase()} 共 ${nodes.length} 個項目:\n${lines.join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_object_structure",
    {
      title: "取得物件結構",
      description:
        "取得 ABAP 物件的結構資訊(class 的 methods/includes、program 的組成等)與 source URI。",
      inputSchema: {
        object_url: z.string().describe("物件的 ADT URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
      },
    },
    async ({ object_url }) => {
      try {
        const s = await adt.objectStructure(object_url);
        const main = adt.mainInclude(s);
        // metaData 內容依物件類型而異,序列化時做長度保護
        const meta = JSON.stringify(s, null, 1);
        const truncated = meta.length > 8000 ? meta.slice(0, 8000) + "\n…(已截斷)" : meta;
        return ok(`主要 source URI:${main}\n\n物件結構:\n${truncated}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "read_source",
    {
      title: "讀取原始碼",
      description:
        "讀取 ABAP 物件的原始碼。可傳入物件 URI(自動解析 main include)或完整 source URI。" +
        "回傳內容含行號,超過上限時會截斷並標註。",
      inputSchema: {
        object_url: z
          .string()
          .describe("物件 URI 或 source URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        start_line: z.number().int().positive().optional().describe("選填:起始行(1-based)"),
        end_line: z.number().int().positive().optional().describe("選填:結束行(含)"),
      },
    },
    async ({ object_url, start_line, end_line }) => {
      try {
        const sourceUrl = await resolveSourceUrl(adt, object_url);
        const source = await adt.getObjectSource(sourceUrl);
        const allLines = source.replace(/\r\n/g, "\n").split("\n");
        const from = (start_line ?? 1) - 1;
        const to = Math.min(end_line ?? allLines.length, allLines.length);
        let slice = allLines.slice(from, to);
        let note = "";
        if (slice.length > cfg.safety.maxSourceLines) {
          slice = slice.slice(0, cfg.safety.maxSourceLines);
          note = `\n…(已截斷,僅顯示前 ${cfg.safety.maxSourceLines} 行;可用 start_line/end_line 分段讀取)`;
        }
        const numbered = slice
          .map((l, i) => `${String(from + i + 1).padStart(5)}| ${l}`)
          .join("\n");
        return ok(
          `source URI:${sourceUrl}(全文共 ${allLines.length} 行,顯示 ${from + 1}–${from + slice.length})\n\n${numbered}${note}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── 檢查 ─────────────────────────────
  server.registerTool(
    "syntax_check",
    {
      title: "語法檢查",
      description:
        "對指定的原始碼內容執行 ABAP 語法檢查(不需要鎖定、不會修改系統)。" +
        "可用來在寫入前先驗證修改後的程式碼。",
      inputSchema: {
        object_url: z.string().describe("物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        source: z
          .string()
          .optional()
          .describe("要檢查的原始碼內容;省略時檢查系統上目前的版本"),
      },
    },
    async ({ object_url, source }) => {
      try {
        const sourceUrl = await resolveSourceUrl(adt, object_url);
        const content = source ?? (await adt.getObjectSource(sourceUrl));
        const baseObjectUrl = sourceUrl.replace(/\/source\/[^/]+$/, "");
        const results = await adt.syntaxCheck(baseObjectUrl, sourceUrl, content);
        if (results.length === 0) return ok("✅ 語法檢查通過,沒有發現任何問題。");
        const lines = results.map(
          (r) => `- [${r.severity}] 第 ${r.line} 行,第 ${r.offset} 字:${r.text}`
        );
        const hasErrors = results.some((r) => r.severity === "E" || r.severity === "A");
        return ok(
          `${hasErrors ? "❌ 語法檢查發現錯誤" : "⚠️ 語法檢查有警告"}(共 ${results.length} 筆):\n${lines.join("\n")}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── Transport ─────────────────────────────
  server.registerTool(
    "list_transports",
    {
      title: "查詢 Transport Requests",
      description:
        "列出使用者可用的(modifiable)workbench transport requests,供 write_source 指定使用。",
      inputSchema: {
        user: z.string().optional().describe("選填:SAP 使用者帳號,預設為登入帳號"),
      },
    },
    async ({ user }) => {
      try {
        const data = await adt.userTransports(user ?? adt.username());
        const out: string[] = [];
        for (const target of data.workbench ?? []) {
          for (const tr of target.modifiable ?? []) {
            out.push(
              `- ${tr["tm:number"]}:${tr["tm:desc"] ?? "(無描述)"}(owner: ${tr["tm:owner"] ?? "?"})`
            );
            for (const task of tr.tasks ?? []) {
              out.push(`    └ task ${task["tm:number"]}(${task["tm:owner"] ?? "?"})`);
            }
          }
        }
        return ok(
          out.length === 0
            ? "目前沒有可用的 modifiable workbench transport。若物件在 $TMP(本機),寫入時不需要 transport。"
            : `可用的 transport requests:\n${out.join("\n")}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ───────────────────────────── 寫入(唯讀模式下不註冊)─────────────────────────────
  if (cfg.safety.readonly) {
    console.error(
      `[abap-adt-mcp] 唯讀模式啟用(角色:${cfg.safety.systemRole}),write_source / activate_object 未註冊。`
    );
    return;
  }

  server.registerTool(
    "write_source",
    {
      title: "寫入原始碼(自動鎖定)",
      description:
        "修改 ABAP 物件的原始碼。內部自動完成:讀取現況 → 並行檢查 → 鎖定 → 寫入 → 解鎖," +
        "失敗時保證釋放鎖定。建議流程:先 read_source 取得現況,修改後將舊內容放入 " +
        "expected_current_source 以啟用並行保護,再呼叫本工具。" +
        "預設會先做語法檢查,有語法錯誤時不寫入。",
      inputSchema: {
        object_url: z.string().describe("物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        new_source: z.string().describe("完整的新原始碼(整份取代,不是 diff)"),
        transport: z
          .string()
          .optional()
          .describe("Transport request 編號;$TMP 本機物件可省略"),
        expected_current_source: z
          .string()
          .optional()
          .describe("先前 read_source 讀到的內容;提供時若系統內容已被他人改動會中止寫入"),
        skip_syntax_check: z
          .boolean()
          .optional()
          .describe("跳過寫入前語法檢查(預設 false;不建議跳過)"),
        activate: z.boolean().optional().describe("寫入成功後立即啟用(預設 false)"),
      },
    },
    async ({ object_url, new_source, transport, expected_current_source, skip_syntax_check, activate }) => {
      const objectName = objectNameFromUrl(object_url);
      try {
        // 安全護欄:前綴白名單等
        assertWriteAllowed(cfg, object_url);

        const sourceUrl = await resolveSourceUrl(adt, object_url);
        const baseObjectUrl = sourceUrl.replace(/\/source\/[^/]+$/, "");

        // 寫入前語法檢查(預設開啟):避免把壞掉的程式碼寫進系統
        if (!skip_syntax_check) {
          const checks = await adt.syntaxCheck(baseObjectUrl, sourceUrl, new_source);
          const errors = checks.filter((c) => c.severity === "E" || c.severity === "A");
          if (errors.length > 0) {
            const lines = errors.map((r) => `- 第 ${r.line} 行:${r.text}`);
            return ok(
              `❌ 寫入已中止:新原始碼有 ${errors.length} 個語法錯誤,請修正後重試:\n${lines.join("\n")}`
            );
          }
        }

        // 核心:鎖定寫入工作流程
        const result = await lockedWrite(adt, {
          objectUrl: baseObjectUrl,
          sourceUrl,
          newSource: new_source,
          transport,
          expectedCurrentSource: expected_current_source,
        });

        audit.log({
          timestamp: new Date().toISOString(),
          action: "write_source",
          objectUrl: baseObjectUrl,
          objectName,
          transport,
          summary: diffSummary(result.previousSource, new_source),
          success: true,
        });

        let activationNote = "";
        if (activate) {
          const act = await adt.activate(objectName, baseObjectUrl);
          audit.log({
            timestamp: new Date().toISOString(),
            action: "activate",
            objectUrl: baseObjectUrl,
            objectName,
            success: act.success,
            error: act.success ? undefined : JSON.stringify(act.messages),
          });
          activationNote = act.success
            ? "\n✅ 已啟用(active)。"
            : `\n⚠️ 寫入成功但啟用失敗:\n${(act.messages ?? [])
                .map((m) => `- ${m.shortText}(第 ${m.line ?? "?"} 行)`)
                .join("\n")}`;
        } else {
          activationNote = "\nℹ️ 物件目前為 inactive,確認無誤後可用 activate_object 啟用。";
        }

        return ok(
          `✅ 已寫入 ${objectName}(${diffSummary(result.previousSource, new_source)})` +
            (transport ? `,transport:${transport}` : "") +
            activationNote
        );
      } catch (e) {
        audit.log({
          timestamp: new Date().toISOString(),
          action: "write_source",
          objectUrl: object_url,
          objectName,
          transport,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });
        return fail(e);
      }
    }
  );

  server.registerTool(
    "activate_object",
    {
      title: "啟用物件",
      description: "啟用(activate)指定的 ABAP 物件,回傳啟用結果與錯誤訊息(若有)。",
      inputSchema: {
        object_url: z.string().describe("物件 URI,例如 /sap/bc/adt/oo/classes/zcl_demo"),
        object_name: z
          .string()
          .optional()
          .describe("選填:物件名稱;省略時由 URI 推導"),
      },
    },
    async ({ object_url, object_name }) => {
      const name = (object_name ?? objectNameFromUrl(object_url)).toUpperCase();
      try {
        assertWriteAllowed(cfg, object_url);
        const baseObjectUrl = object_url.replace(/\/source\/[^/]+$/, "");
        const result = await adt.activate(name, baseObjectUrl);
        audit.log({
          timestamp: new Date().toISOString(),
          action: "activate",
          objectUrl: baseObjectUrl,
          objectName: name,
          success: result.success,
          error: result.success ? undefined : JSON.stringify(result.messages),
        });
        if (result.success) return ok(`✅ ${name} 啟用成功。`);
        const msgs = (result.messages ?? []).map(
          (m) => `- [${m.type}] ${m.shortText}(第 ${m.line ?? "?"} 行)`
        );
        return ok(`❌ ${name} 啟用失敗:\n${msgs.join("\n") || "(無詳細訊息)"}`);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
