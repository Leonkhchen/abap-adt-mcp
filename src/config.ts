/**
 * config.ts — 環境變數設定載入與驗證
 *
 * 所有連線資訊與安全設定皆透過環境變數提供,
 * 密碼絕不寫入任何設定檔或 MCP client 的 JSON 設定中。
 */
import { z } from "zod";
import * as dotenv from "dotenv";

// 支援 .env 檔(開發時方便),正式使用建議直接設定環境變數
dotenv.config({ quiet: true } as Parameters<typeof dotenv.config>[0]);

/** 布林環境變數解析:接受 true/1/yes(不分大小寫) */
const boolEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined ? def : ["true", "1", "yes"].includes(v.toLowerCase())
    );

const ConfigSchema = z.object({
  /** SAP 系統 base URL,例如 https://myhost:44300 */
  SAP_URL: z.string().url({ message: "SAP_URL 必須是合法的 URL(例如 https://host:44300)" }),
  SAP_USER: z.string().min(1, "SAP_USER 不可為空"),
  SAP_PASSWORD: z.string().min(1, "SAP_PASSWORD 不可為空"),
  /** SAP client(例如 100),選填 */
  SAP_CLIENT: z.string().optional().default(""),
  /** 登入語言,預設 EN */
  SAP_LANGUAGE: z.string().optional().default("EN"),

  /** 唯讀模式:true 時所有寫入工具不會註冊(AI 完全看不到) */
  ABAP_MCP_READONLY: boolEnv(false),
  /** 系統角色:dev / qa / prod;prod 一律強制唯讀 */
  ABAP_MCP_SYSTEM_ROLE: z.enum(["dev", "qa", "prod"]).optional().default("dev"),
  /** 可寫入的物件名稱前綴白名單(逗號分隔),預設 Z,Y,$ */
  ABAP_MCP_ALLOWED_PREFIXES: z.string().optional().default("Z,Y,$"),
  /** 允許自簽憑證(僅限內網開發系統使用!) */
  ABAP_MCP_ALLOW_SELF_SIGNED: boolEnv(false),
  /** Audit log 檔案路徑;空字串表示停用 */
  ABAP_MCP_AUDIT_LOG: z.string().optional().default(""),
  /** read_source 回傳的最大行數(超過會截斷以保護 AI context) */
  ABAP_MCP_MAX_SOURCE_LINES: z.coerce.number().int().positive().optional().default(5000),
});

export type AppConfig = {
  sap: {
    url: string;
    user: string;
    password: string;
    client: string;
    language: string;
    allowSelfSigned: boolean;
  };
  safety: {
    /** 最終生效的唯讀狀態(prod 強制唯讀) */
    readonly: boolean;
    systemRole: "dev" | "qa" | "prod";
    allowedPrefixes: string[];
    auditLogPath: string;
    maxSourceLines: number;
  };
};

/** 載入並驗證設定;驗證失敗時丟出含中文說明的錯誤 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const msgs = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`環境變數設定錯誤:\n${msgs}\n請參考 .env.example`);
  }
  const c = parsed.data;

  // 安全規則:prod 系統一律強制唯讀,無法以環境變數覆寫
  const effectiveReadonly = c.ABAP_MCP_SYSTEM_ROLE === "prod" ? true : c.ABAP_MCP_READONLY;

  return {
    sap: {
      url: c.SAP_URL,
      user: c.SAP_USER,
      password: c.SAP_PASSWORD,
      client: c.SAP_CLIENT,
      language: c.SAP_LANGUAGE,
      allowSelfSigned: c.ABAP_MCP_ALLOW_SELF_SIGNED,
    },
    safety: {
      readonly: effectiveReadonly,
      systemRole: c.ABAP_MCP_SYSTEM_ROLE,
      allowedPrefixes: c.ABAP_MCP_ALLOWED_PREFIXES.split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean),
      auditLogPath: c.ABAP_MCP_AUDIT_LOG,
      maxSourceLines: c.ABAP_MCP_MAX_SOURCE_LINES,
    },
  };
}
