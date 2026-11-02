# abap-adt-mcp

讓 **Claude Code / Codex** 直接連接 SAP **ABAP ADT**(ABAP Development Tools)REST API 的獨立 MCP server —— **不需要 VS Code、不需要 Eclipse**,且具備**完整讀寫能力**。

```
Claude Code ◄── stdio (MCP) ──► abap-adt-mcp ◄── HTTPS (ADT REST) ──► SAP 系統
```

## 為什麼做這個?

[vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) 是很棒的專案,但它的 MCP 模式有兩個限制:必須開著 VS Code 作為橋接層,而且 MCP 工具是唯讀的。市面上其他 standalone 方案則多半把 ADT API 一對一薄包裝,把 `lock`/`unlock` 等底層步驟直接丟給 AI 操作,容易出錯並留下殘留鎖定。

**本專案的設計理念:封裝成「AI 友善」的高階工作流程工具。**

- `write_source` 一個工具內部自動完成:讀取現況 → 並行衝突檢查 → 語法檢查 → lock → 寫入 → unlock(try/finally 保證釋放)
- 錯誤訊息經過翻譯,附帶可行動的建議(例如「請檢查 SICF 節點 /sap/bc/adt」),AI 能自行修正
- 安全優先:唯讀模式、prod 系統強制唯讀、Z*/Y* 前綴白名單、audit log

## 功能

AI 可以在 `$TMP` 從零完成「建立 → 寫 → 啟用 → ABAP Unit → ATC」,全程不需要 SAP GUI 或 Eclipse。

| 工具 | 說明 |
|---|---|
| `ping_system` | 連線測試與診斷(每次實際連線,顯示回應時間與版本) |
| `search_objects` | 萬用字元搜尋 ABAP 物件 |
| `browse_package` | 瀏覽 package 內容 |
| `get_object_structure` | 物件結構(methods / includes) |
| `read_source` | 讀取原始碼(含行號、分段讀取、截斷保護;含 class 的測試 include) |
| `syntax_check` | 語法檢查(免鎖定) |
| `list_transports` | 查詢可用 transport requests |
| `run_atc` | 執行 ATC 靜態檢查(依優先級分組,上限 100 筆) |
| `where_used` | 查詢物件或元件的使用處(含程式碼行,上限 50 筆) |
| `find_definition` | 跳到定義 / 實作 |
| `class_components` | 列出 class / interface 的方法、屬性、介面、本地類別 |
| `write_source` | ✏️ 寫入原始碼(自動鎖定編排 + 並行保護 + 語法檢查 + 可選啟用;可寫測試 include) |
| `activate_object` | ✏️ 啟用物件 |
| `create_object` | ✏️ 建立 CLAS/OC、INTF/OI、PROG/P、DDLS/DF、BDEF/BDO |
| `run_unit_tests` | ⚠️ **會執行測試程式碼**:ABAP Unit(物件或 package;只跑宣告為 RISK LEVEL HARMLESS 的測試) |
| `run_class` | ⚠️ **會在 SAP 系統上執行程式**:執行 IF_OO_ADT_CLASSRUN(輸出上限 20,000 字元) |
| `create_transport` | ✏️ 建立 workbench transport request(只在 `SYSTEM_ROLE=dev`) |

✏️ / ⚠️ = 寫入或執行類工具,唯讀模式下不會註冊(AI 完全看不到),且必須通過名稱前綴與 package 兩道白名單。

## 系統需求

- Node.js ≥ 20
- SAP 系統已啟用 ADT(SICF 節點 `/sap/bc/adt`)— 已在 **S/4HANA 2022 / ABAP 7.56** 上以此為目標開發
- SAP 使用者具備開發權限(S_DEVELOP)

## 快速開始(Claude Code)

```bash
# 1. 安裝
git clone https://github.com/<your-account>/abap-adt-mcp.git
cd abap-adt-mcp
npm install && npm run build

# 2. 註冊到 Claude Code(密碼建議用環境變數帶入,勿寫死)
claude mcp add abap \
  --env SAP_URL=https://your-sap-host:44300 \
  --env SAP_CLIENT=100 \
  --env SAP_USER=DEVELOPER \
  --env SAP_PASSWORD="$SAP_PASSWORD" \
  --env ABAP_MCP_SYSTEM_ROLE=dev \
  -- node /絕對路徑/abap-adt-mcp/dist/index.js

# 3. 在 Claude Code 中測試
# > 請用 ping_system 確認 SAP 連線
```

### 本機 ABAP Cloud Developer Trial(A4H,Windows PowerShell)

Trial 容器的 ADT 走本機 HTTP port 50000(`http://` 只允許 localhost / 127.0.0.1 / ::1,遠端主機必須用 https):

```powershell
# 密碼以隱藏輸入放進目前 PowerShell session,不進 history
$p = Read-Host "SAP 密碼" -AsSecureString
$env:SAP_PASSWORD = [System.Net.NetworkCredential]::new("", $p).Password

claude mcp add abap-a4h `
  --env SAP_URL=http://localhost:50000 `
  --env SAP_CLIENT=001 `
  --env SAP_USER=DEVELOPER `
  --env "SAP_PASSWORD=$env:SAP_PASSWORD" `
  --env SAP_LANGUAGE=EN `
  --env ABAP_MCP_SYSTEM_ROLE=dev `
  -- node C:\path\to\abap-adt-mcp\dist\index.js
```

PowerShell 的換行符號是反引號 `` ` ``(行尾不可有空白)。密碼含 `#`、`$`、`"` 等特殊字元時,用上面的 `"SAP_PASSWORD=$env:SAP_PASSWORD"` 寫法即可,不需另外跳脫。

詳細設定(含 Codex、自簽憑證、唯讀模式)請見 [docs/SETUP.md](docs/SETUP.md)。

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `SAP_URL` | ✅ | — | 例如 `https://host:44300`;`http://` 僅限本機(如 Trial 的 `http://localhost:50000`) |
| `SAP_USER` / `SAP_PASSWORD` | ✅ | — | SAP 帳密(僅從環境變數讀取) |
| `SAP_CLIENT` | | `''` | 例如 `100` |
| `SAP_LANGUAGE` | | `EN` | 登入語言 |
| `ABAP_MCP_READONLY` | | `false` | `true` 時不註冊寫入工具 |
| `ABAP_MCP_SYSTEM_ROLE` | | `dev` | `dev`/`qa`/`prod`;**prod 強制唯讀** |
| `ABAP_MCP_ALLOWED_PREFIXES` | | `Z,Y,$` | 可寫入的物件名稱前綴白名單 |
| `ABAP_MCP_ALLOWED_PACKAGES` | | `$TMP,Z*,Y*` | 可寫入/建立/執行物件所在的 package 白名單(`*` 結尾為前綴比對) |
| `ABAP_MCP_ALLOW_SELF_SIGNED` | | `false` | 允許自簽憑證(限內網開發系統) |
| `ABAP_MCP_AUDIT_LOG` | | (停用) | 寫入操作稽核紀錄檔路徑 |
| `ABAP_MCP_MAX_SOURCE_LINES` | | `5000` | `read_source` 回傳行數上限 |

## 安全設計

AI 直接寫入 SAP 系統風險很高,本專案內建多層防護,詳見 [docs/SECURITY.md](docs/SECURITY.md):

1. **唯讀模式** — 寫入工具不註冊,而非「註冊後拒絕」
2. **prod 強制唯讀** — 設定 `ABAP_MCP_SYSTEM_ROLE=prod` 後無法以任何方式覆寫
3. **前綴白名單** — 預設僅允許 `Z*` / `Y*` / `$`(本機物件),保護 SAP 標準物件
4. **package 白名單** — 預設僅允許 `$TMP`、`Z*`、`Y*` package;寫入、建立、執行都要同時通過名稱與 package 兩道白名單
5. **並行保護** — 寫入前比對先前讀取的版本,避免蓋掉他人變更;寫入類操作在 process 內依序執行
6. **寫入前語法檢查** — 預設不讓語法錯誤的程式碼進系統
7. **Audit log** — JSON Lines 紀錄所有寫入、建立、執行操作(不含憑證與原始碼內容)
8. **鎖定保證釋放** — try/finally,不留殘留鎖定,也不讓連線卡在 stateful
9. **401 斷路** — 連續 2 次認證失敗後停止連線 SAP,避免重試把帳號鎖住

## 開發

```bash
npm run build          # tsc 編譯
npm test               # vitest 單元測試(不需 SAP 系統)
npm run test:it        # 整合測試唯讀組(連 .env 設定的 SAP 系統)
npm run test:it:write  # 整合測試唯讀 + 寫入組(只在 $TMP 建暫存 class,測完刪除)
```

整合測試會讀取專案根目錄的 `.env`(見 `.env.example`),PowerShell 與 bash 指令相同。

## Roadmap

- ~~**Phase 2**:`create_object`、ABAP Unit 測試、ATC、where-used~~(v0.3 完成)
- **Phase 3**:SQL 資料查詢(Data Preview)、ST22 dump 分析、DDIC 資訊
- **Phase 4**:BTP ABAP Environment(JWT / Service Key)

## 致謝

- [abap-adt-api](https://github.com/marcellourbani/abap-adt-api)(Marcello Urbani, MIT)— 本專案的 ADT 存取底層
- [vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) — 架構與工具設計的重要參考

## License

MIT
