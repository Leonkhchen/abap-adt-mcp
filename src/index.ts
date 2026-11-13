#!/usr/bin/env node
/**
 * index.ts — abap-adt-mcp 進入點
 *
 * 以 stdio transport 啟動 MCP server,供 Claude Code / Codex 連線。
 * 重要:stdout 是 MCP 的 JSON-RPC channel,所有日誌一律走 stderr!
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RealAdtService } from "./adt/client.js";
import { loadConfig, warnIfPasswordUnquoted } from "./config.js";
import { installShutdown } from "./lifecycle.js";
import { runCleanups } from "./adt/cleanup.js";
import { AuditLogger } from "./safety/audit.js";
import { registerTools } from "./tools/registry.js";
import { VERSION } from "./version.js";

async function main() {
  // 1. 載入設定(失敗時輸出中文錯誤說明並結束);.env 密碼含 # 未加引號時先警告
  warnIfPasswordUnquoted();
  const cfg = loadConfig();

  // 2. 建立 ADT 服務與安全元件
  const adt = new RealAdtService(cfg);
  const audit = new AuditLogger(cfg.safety.auditLogPath);

  // 3. 建立 MCP server 並註冊工具
  const server = new McpServer({
    name: "abap-adt-mcp",
    version: VERSION,
  });
  registerTools(server, adt, cfg, audit);

  // 4. 啟動 stdio transport;結束時(stdin 關閉 / SIGINT / SIGTERM)登出所有 ADT client,
  //    否則 SAP 端的 HTTP session 要等逾時才釋放(C0-10)
  const transport = new StdioServerTransport();
  // 先清掉進行中的探針(中斷點、監聽、logpoint),再登出 ADT 工作階段
  installShutdown({ close: async () => { await runCleanups(); await adt.close?.(); } }, { signals: process, stdin: process.stdin, exit: (code) => process.exit(code) });
  await server.connect(transport);

  console.error(
    `[abap-adt-mcp] v${VERSION} 已啟動。系統:${cfg.sap.url}(角色:${cfg.safety.systemRole},` +
      `${cfg.safety.readonly ? "唯讀" : "可讀寫"})`
  );
}

main().catch((err) => {
  console.error(`[abap-adt-mcp] 啟動失敗:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
