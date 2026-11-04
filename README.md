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
| `ddic_info` | DDIC 定義:表與 CDS 欄位、結構、資料元素、domain(含固定值) |
| `list_dumps` | ST22 短傾印列表(依天數、使用者篩選) |
| `dump_detail` | 短傾印內容與出錯位置(以 source/main 為準的行號;不含變數內容) |
| `pretty_print` | 以系統 Pretty Printer 設定格式化原始碼(不寫回) |
| `list_inactive` | 目前使用者的 inactive 物件 |
| `get_revisions` | 版本歷史與兩版比較(unified diff) |
| `data_preview` | 🔒 **讀取資料表內容**:單表或單一 SELECT;**預設不註冊**,需 `ABAP_MCP_ALLOW_DATA_PREVIEW=true`,只能讀表白名單內的表 |
| `write_source` | ✏️ 寫入原始碼(自動鎖定編排 + 並行保護 + 語法檢查 + 可選啟用;可寫測試 include) |
| `activate_object` | ✏️ 啟用物件 |
| `activate_objects` | ✏️ 批次啟用(每個物件都要通過兩道白名單,任一不過整批拒絕) |
| `abapgit_repos` | 列出已連結的 abapGit repo(只讀;系統沒有 abapGit ADT 後端時回報說明。**不提供 pull / push**,理由見 SECURITY.md) |
| `create_object` | ✏️ 建立 CLAS/OC、INTF/OI、PROG/P、DDLS/DF、BDEF/BDO、TABL/DT(資料表) |
| `rap_generate` | ✏️ **由資料表產生 RAP BO 與 OData V4 UI 服務**(約 14 個物件):預設只預覽,`confirm=true` 才產生;每個物件都要過白名單,任一不過整批拒絕;可發佈並回傳服務網址 |
| `run_unit_tests` | ⚠️ **會執行測試程式碼**:ABAP Unit(物件或 package;只跑宣告為 RISK LEVEL HARMLESS 的測試)。**與 `run_class` 一樣受名稱前綴與 package 白名單限制**;package 模式任一物件不符合就整批拒絕 |
| `run_class` | ⚠️ **會在 SAP 系統上執行程式**:執行 IF_OO_ADT_CLASSRUN(輸出上限 20,000 字元) |
| `create_transport` | ✏️ 建立 workbench transport request(只在 `SYSTEM_ROLE=dev`) |

✏️ / ⚠️ = 寫入或執行類工具,唯讀模式下不會註冊(AI 完全看不到),且必須通過名稱前綴與 package 兩道白名單。
🔒 = 資料讀取工具,預設關閉;開啟後唯讀模式也可用(只讀資料)。

v0.4 起還能診斷:AI 可以讀 DDIC 結構、查資料、從 ST22 短傾印定位出錯行號後自己修正,再用 `run_class` 驗證。

v0.5 起可以從一張表做到 Fiori:`create_object`(TABL/DT)→ `write_source` 定義欄位 → `rap_generate` 預覽 → 確認後產生並發佈 → 在 Eclipse 開 service binding 按 Preview。

### Prompts 與 Resources(v0.5)

| 類型 | 名稱 | 用途 |
|---|---|---|
| prompt | `clean-abap-review` | 依 Clean ABAP 要點審查一個物件,列出問題與建議(預設不修改) |
| prompt | `rap-bo-from-table` | 建立(或沿用)一張 Z 資料表,再用 RAP 產生器產生 BO 與 Fiori 服務(先預覽、確認後才產生) |
| prompt | `fix-dump` | 從 ST22 短傾印找出原因、修正程式並用 `run_class` 驗證 |
| resource | `abap-mcp://guides/naming` | 目前設定下可寫入的名稱前綴與 package |
| resource | `abap-mcp://guides/safety` | 目前啟用的安全設定(不含密碼) |
| resource | `abap-mcp://guides/clean-abap` | Clean ABAP 重點摘要(連結到 SAP 官方 styleguide) |

唯讀模式下 prompts 與 resources 一樣可用。

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
| `ABAP_MCP_ALLOW_DATA_PREVIEW` | | `false` | `true` 時才註冊 `data_preview`(讀資料表內容) |
| `ABAP_MCP_DATA_PREVIEW_TABLES` | | `/DMO/*` | `data_preview` 可讀的表/view 白名單(`*` 結尾為前綴比對);加入 `Z*`/`Y*` 的風險見 SECURITY.md |
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
10. **資料讀取預設關閉** — `data_preview` 需明確開啟;只接受單一 SELECT、每張表都要在表白名單內、audit 不記資料內容
11. **短傾印不帶出變數內容** — `dump_detail` 只取除錯需要的章節,不含 Selected Variables
12. **RAP 產生兩段式** — `rap_generate` 預設只預覽;確認時預覽清單中每個物件都要過白名單,任一不過整批拒絕
13. **abapGit 只讀** — 不提供 pull / push(會覆寫系統物件或把程式碼送出系統)

## 開發

```bash
npm run build          # tsc 編譯
npm test               # vitest 單元測試(不需 SAP 系統)
npm run test:it        # 整合測試唯讀組(連 .env 設定的 SAP 系統)
npm run test:it:write  # 整合測試唯讀 + 寫入組(只在 $TMP 建暫存 class,測完刪除)
```

整合測試會讀取專案根目錄的 `.env`(見 `.env.example`),PowerShell 與 bash 指令相同。寫入組含 RAP 產生(T34),A4H 熱機約需 3–4 分鐘。

### 跨模型評測(v0.5)

`eval/tasks/*.yaml` 有 8 個實際開發任務(讀懂 class、修語法錯誤、寫 unit test、修短傾印、清 ATC、產生 RAP、查資料、跨 class 重新命名)。評測以 headless Claude Code 執行,只載入本 MCP server 的工具,自動判定成敗並清除暫存物件:

```bash
npm run build
npm run eval -- --help                          # 說明(不連 SAP、不呼叫模型)
npm run eval -- --dry-run                       # 只驗證事前準備、判定與清除,不呼叫模型
npm run eval -- --model sonnet                  # 8 題 × 1 個模型(依模型收費)
npm run eval -- --model opus,sonnet,haiku --matrix   # 多模型矩陣(需明確加 --matrix)
```

結果寫到 `eval/results/<日期>.md` 與 `.csv`(題目 × 模型:成敗、回合、秒數、費用、工具呼叫次數與總計)。原始記錄在 `eval/results/logs/`,不入版控。密碼只經環境變數傳給子行程,不寫進任何檔案。Codex / Gemini 目前只有轉接介面,本版未實作。

## Roadmap

- ~~**Phase 2**:`create_object`、ABAP Unit 測試、ATC、where-used~~(v0.3 完成)
- ~~**Phase 3**:SQL 資料查詢(Data Preview)、ST22 dump 分析、DDIC 資訊~~(v0.4 完成)
- ~~**Phase 3.5**:RAP 產生器、資料表建立、prompts / resources、跨模型評測~~(v0.5 完成)
- **Phase 4**:BTP ABAP Environment(JWT / Service Key)

## 致謝

- [abap-adt-api](https://github.com/marcellourbani/abap-adt-api)(Marcello Urbani, MIT)— 本專案的 ADT 存取底層
- [vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) — 架構與工具設計的重要參考

## License

MIT
