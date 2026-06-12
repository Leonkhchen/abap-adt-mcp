# SETUP — 安裝與接入教學

目標:從零安裝到 Claude Code 可用,5 分鐘內完成。

## 1. 前置條件

- Node.js ≥ 20(`node -v` 確認)
- SAP 系統(本專案以 **S/4HANA 2022 / ABAP 7.56** 為目標開發)
- SAP 端確認:
  - **SICF**(T-code `SICF`):節點 `/default_host/sap/bc/adt` 已啟用(Activate Service)
  - 使用者具備 `S_DEVELOP` 等開發權限(能在 Eclipse ADT 開發的帳號即可)
  - ICM 已開啟 HTTPS port(T-code `SMICM` → Goto → Services)

## 2. 安裝

```bash
git clone https://github.com/<your-account>/abap-adt-mcp.git
cd abap-adt-mcp
npm install
npm run build
npm test          # 應顯示 19 passed(不需要 SAP 連線)
```

## 3. 接入 Claude Code

### 方式 A:CLI 指令(推薦)

```bash
# 密碼先放進 shell 環境變數,避免出現在 shell history 與設定檔
export SAP_PASSWORD='你的密碼'

claude mcp add abap \
  --env SAP_URL=https://your-sap-host:44300 \
  --env SAP_CLIENT=100 \
  --env SAP_USER=DEVELOPER \
  --env SAP_PASSWORD="$SAP_PASSWORD" \
  --env SAP_LANGUAGE=EN \
  --env ABAP_MCP_SYSTEM_ROLE=dev \
  --env ABAP_MCP_AUDIT_LOG="$HOME/.abap-adt-mcp/audit.jsonl" \
  -- node /絕對路徑/abap-adt-mcp/dist/index.js
```

### 方式 B:專案層級 `.mcp.json`(團隊共用,密碼用變數展開)

在專案根目錄建立 `.mcp.json`:

```json
{
  "mcpServers": {
    "abap": {
      "command": "node",
      "args": ["/絕對路徑/abap-adt-mcp/dist/index.js"],
      "env": {
        "SAP_URL": "https://your-sap-host:44300",
        "SAP_CLIENT": "100",
        "SAP_USER": "DEVELOPER",
        "SAP_PASSWORD": "${SAP_PASSWORD}",
        "ABAP_MCP_SYSTEM_ROLE": "dev"
      }
    }
  }
}
```

> ⚠️ `.mcp.json` 若進版控,**密碼一定要用 `${SAP_PASSWORD}` 變數展開**,不可寫死。

### 驗證

在 Claude Code 中:

```
/mcp                      ← 應看到 abap server 與 9 個工具
> 請用 ping_system 確認 SAP 連線
> 搜尋所有 ZCL_ 開頭的 class
```

## 4. 接入 Codex CLI

Codex 的 MCP 設定在 `~/.codex/config.toml`:

```toml
[mcp_servers.abap]
command = "node"
args = ["/絕對路徑/abap-adt-mcp/dist/index.js"]

[mcp_servers.abap.env]
SAP_URL = "https://your-sap-host:44300"
SAP_CLIENT = "100"
SAP_USER = "DEVELOPER"
SAP_PASSWORD = "你的密碼"   # Codex 的 toml 不支援變數展開時,請確保此檔權限為 600
ABAP_MCP_SYSTEM_ROLE = "dev"
```

```bash
chmod 600 ~/.codex/config.toml
```

## 5. 真實系統驗證腳本(首次連線建議依序執行)

在 Claude Code 中依序下指令,完整驗證讀寫迴圈:

| # | 對 Claude 說 | 預期結果 |
|---|---|---|
| 1 | 「用 ping_system 測試連線」 | ✅ 顯示系統 URL、帳號、模式 |
| 2 | 「搜尋 ZCL_* 的 class」 | 回傳物件清單與 URI |
| 3 | 「讀取 <某個 Z class> 的原始碼」 | 含行號的原始碼 |
| 4 | 「在這個 class 加一個註解行,然後寫回去(先不要啟用)」 | ✅ 寫入成功、物件 inactive |
| 5 | 「啟用它」 | ✅ 啟用成功 |
| 6 | 「列出我的 transport requests」 | TR 清單 |

若步驟 4 在非 `$TMP` package 失敗並提示需要 transport,先執行步驟 6 取得 TR 編號,再請 Claude 帶上 transport 重試 —— 這正是預期的防呆行為。

## 6. 常見問題

| 症狀 | 處理 |
|---|---|
| `認證失敗(401)` | 檢查帳密與 client;確認帳號未被鎖(SU01) |
| `403 / CSRF` | SICF 啟用 `/sap/bc/adt`;確認 S_DEVELOP 權限 |
| `TLS 憑證驗證失敗` | 內網自簽憑證 → 設 `ABAP_MCP_ALLOW_SELF_SIGNED=true`(風險見 SECURITY.md) |
| `無法連線` | 檢查 VPN、`SAP_URL` port(SMICM 查 HTTPS port) |
| 物件被鎖 | 他人正在編輯;SM12 查看/釋放 |
| 寫入工具看不到 | 檢查是否 `ABAP_MCP_READONLY=true` 或 `SYSTEM_ROLE=prod`(這是刻意設計) |
