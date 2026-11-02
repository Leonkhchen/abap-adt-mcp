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
npm test          # 單元測試應全部通過(不需要 SAP 連線)
```

### 本機 Trial(ABAP Cloud Developer Trial / A4H)範例 `.env`

```dotenv
SAP_URL=http://localhost:50000
SAP_USER=DEVELOPER
SAP_PASSWORD="你的密碼"
SAP_CLIENT=001
SAP_LANGUAGE=EN
ABAP_MCP_SYSTEM_ROLE=dev
```

- `http://` 只允許 `localhost` / `127.0.0.1` / `::1`;連其他主機必須用 `https://`,否則啟動時會報錯
- 確認系統已啟動:`curl http://localhost:50000/sap/public/ping` 回 403 代表 ICM 已在服務
- 系統未啟動時,工具會回報「無法連線」並提示執行 `a4h-start.bat` 或 `docker start a4h`

有了 `.env` 之後可以直接跑整合測試(PowerShell / bash 通用):

```bash
npm run test:it          # 唯讀組
npm run test:it:write    # 唯讀 + 寫入組($TMP 暫存 class,測完自動刪除)
```

### 使用 `.env` 檔(選用)

開發時可把連線設定放在專案根目錄的 `.env`(已列入 `.gitignore`),啟動時自動載入:

```bash
cp .env.example .env    # Windows PowerShell:Copy-Item .env.example .env
```

> ⚠️ **密碼請用雙引號包起來**:`SAP_PASSWORD="你的密碼"`。
> dotenv 會把未加引號的值中 `#` 之後的內容當成註解截斷,密碼含 `#` 時會變成錯誤的密碼而 401;
> 連續失敗數次(SAP 預設 5 次)會鎖住帳號。密碼本身含 `"` 時改用單引號。
> 偵測到 `SAP_PASSWORD` 未加引號且含 `#` 時,server 啟動時會在 stderr 警告(不會印出密碼)。

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

### 方式 A'(Windows PowerShell)

PowerShell 的換行是反引號 `` ` ``,環境變數寫成 `$env:NAME`:

```powershell
# 密碼以隱藏輸入放進目前 session,不進 history
$p = Read-Host "SAP 密碼" -AsSecureString
$env:SAP_PASSWORD = [System.Net.NetworkCredential]::new("", $p).Password

# 本機 Trial(A4H)範例
claude mcp add abap-a4h `
  --env SAP_URL=http://localhost:50000 `
  --env SAP_CLIENT=001 `
  --env SAP_USER=DEVELOPER `
  --env "SAP_PASSWORD=$env:SAP_PASSWORD" `
  --env SAP_LANGUAGE=EN `
  --env ABAP_MCP_SYSTEM_ROLE=dev `
  --env "ABAP_MCP_AUDIT_LOG=$env:USERPROFILE\.abap-adt-mcp\audit.jsonl" `
  -- node C:\path\to\abap-adt-mcp\dist\index.js
```

> `claude mcp add --env` 會把值存進 Claude Code 的使用者設定檔(明文)。若不希望密碼留在設定檔,改用方式 B 的變數展開。

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
/mcp                      ← 應看到 abap server 與 17 個工具(唯讀模式 12 個;create_transport 只在 dev)
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
| `認證失敗(401)` | 檢查帳密與 client;`.env` 中密碼含 `#` 時必須加雙引號;確認帳號未被鎖(SU01) |
| `403 / CSRF` | SICF 啟用 `/sap/bc/adt`;確認 S_DEVELOP 權限 |
| `TLS 憑證驗證失敗` | 內網自簽憑證 → 設 `ABAP_MCP_ALLOW_SELF_SIGNED=true`(風險見 SECURITY.md) |
| `無法連線` | 檢查 VPN、`SAP_URL` port(SMICM 查 HTTPS port) |
| 物件被鎖 | 他人正在編輯;SM12 查看/釋放 |
| 寫入工具看不到 | 檢查是否 `ABAP_MCP_READONLY=true` 或 `SYSTEM_ROLE=prod`(這是刻意設計) |
