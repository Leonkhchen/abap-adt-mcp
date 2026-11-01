/**
 * vitest 設定
 *
 * 以 --mode 切換整合測試開關,取代在 shell 設環境變數(PowerShell 與 bash 寫法不同):
 *   npm test                → 只跑單元測試(不需 SAP)
 *   npm run test:it         → --mode it:A4H 唯讀組
 *   npm run test:it:write   → --mode it-write:A4H 唯讀 + 寫入組
 */
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  const integration = mode === "it" || mode === "it-write";
  return {
    test: {
      env: integration
        ? {
            ABAP_MCP_IT: "1",
            // 明確設定,避免 shell 殘留的 ABAP_MCP_IT_WRITE=1 讓唯讀指令跑到寫入組
            ABAP_MCP_IT_WRITE: mode === "it-write" ? "1" : "0",
          }
        : {},
      // 整合測試連真實 SAP,冷啟動時單次呼叫可能數秒到數十秒
      testTimeout: integration ? 60_000 : 5_000,
    },
  };
});
