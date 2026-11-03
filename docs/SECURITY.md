# SECURITY — 安全設計說明

讓 AI agent 直接讀寫 SAP 系統,等同於給它一個開發者帳號。本文件說明內建的防護層,以及部署時你應該做的決策。

## 威脅模型

| 風險 | 防護 |
|---|---|
| AI 誤改 SAP 標準物件 | 前綴白名單(預設僅 `Z`/`Y`/`$`)+ package 白名單(預設僅 `$TMP`、`Z*`、`Y*`) |
| AI 在 SAP 上執行任意程式(`run_class`) | 唯讀模式不註冊;只能執行通過兩道白名單的 class;工具說明開頭明寫「會在 SAP 系統上執行程式」;audit log |
| AI 大量建立物件或放進錯誤的 package(`create_object`) | 兩道白名單;非本機 package 必須明確給 transport;建立前先做名稱檢查;audit log |
| ABAP Unit 測試改到資料 | `run_unit_tests` 唯讀模式(含 prod)不註冊;只執行宣告為 RISK LEVEL HARMLESS 的測試 |
| 密碼錯誤時自動重試把帳號鎖住 | 401 斷路:連續 2 次認證失敗後停止連線 SAP,需修正密碼後重開 MCP |
| AI 讀出敏感資料(`data_preview`,例如 USR02 密碼雜湊、薪資) | 預設不註冊;表白名單(預設只有 `/DMO/*`),FROM / JOIN / 子查詢裡的每張表都檢查;無法可靠解析即拒絕 |
| AI 透過查詢改資料或執行多語句 | 只接受單一 SELECT:去掉字串常值與註解後不得含 `;` 或 INSERT/UPDATE/DELETE/MODIFY/COMMIT/ROLLBACK/CALL/EXEC/INTO 等;SAP 端也只接受 SELECT |
| 查詢結果撐爆或外洩大量資料 | 預設 100 筆、上限 1,000 筆;每格 200 字元、整體 20,000 字元;audit 只記 SQL 與筆數,不記資料 |
| 短傾印帶出業務資料(`dump_detail`) | 只取除錯需要的章節,不含 Selected Variables(變數內容)、系統環境、記憶體資訊;dump_id 只接受 runtime/dump 路徑 |
| 並行寫入互相干擾(共用 stateful session) | 寫入類操作在 process 內依序執行;解鎖後回到 stateless 並清除 stateful context |
| AI 在 prod 系統執行寫入 | `SYSTEM_ROLE=prod` 強制唯讀,程式內無覆寫路徑 |
| AI 蓋掉其他開發者的變更 | 樂觀並行檢查(`expected_current_source`) |
| AI 寫入語法錯誤的程式碼 | 寫入前強制語法檢查(可明確跳過,但預設開啟) |
| 多步驟操作中斷留下殘留鎖定 | lock/unlock 封裝在單一工具內,try/finally 保證釋放 |
| 憑證外洩 | 僅從環境變數讀取;audit log 不記錄憑證;文件強制要求不寫死密碼 |
| 無法追溯 AI 做了什麼 | Audit log(JSON Lines):時間、物件、TR、行數變化摘要 |

## 防護層細節

### 1. 唯讀模式 = 工具不註冊

`ABAP_MCP_READONLY=true` 或 `SYSTEM_ROLE=prod` 時,`write_source` 與 `activate_object` **根本不會註冊到 MCP server**。AI 從 `tools/list` 就看不到這些工具 —— 這比「註冊後再拒絕」安全,因為:

- 不存在 prompt injection 說服 AI「再試一次」的攻擊面
- 不浪費 AI 的 context token 在不可用的工具上

同時保留第二道防禦:即使工具被註冊(理論上不可能),`assertWriteAllowed()` 仍會在執行期再次檢查。

### 2. prod 強制唯讀

```
SYSTEM_ROLE=prod → readonly=true(無條件)
```

這個規則寫死在 `config.ts`,沒有任何環境變數組合可以讓 prod 系統可寫。如果你真的需要在 prod 寫入(不建議),唯一方法是把角色標成 dev —— 這是刻意設計的「必須說謊才能繞過」的摩擦力。

### 3. 前綴白名單

`ABAP_MCP_ALLOWED_PREFIXES`(預設 `Z,Y,$`)。可以收得更緊,例如只允許特定團隊的命名空間:

```
ABAP_MCP_ALLOWED_PREFIXES=ZFI_,ZMM_
```

### 3-1. package 白名單

`ABAP_MCP_ALLOWED_PACKAGES`(預設 `$TMP,Z*,Y*`;`*` 結尾為前綴比對,否則完全比對)。即使物件名稱是 `Z` 開頭,只要放在白名單外的 package,`write_source`、`activate_object`、`create_object`、`run_class` 都會拒絕。物件的 package 在鎖定前從 SAP 讀取;讀不到 package 時一律拒絕。

```
ABAP_MCP_ALLOWED_PACKAGES=$TMP,ZFI_*
```

### 3-2. 執行程式(`run_class`)

`run_class` 會在 SAP 系統上**真的執行** class 的 `IF_OO_ADT_CLASSRUN~MAIN`,程式裡寫資料庫、呼叫 RFC 等都會發生。防護:

- 唯讀模式或 `SYSTEM_ROLE=prod` 時不註冊
- 只能執行同時通過名稱前綴與 package 白名單的 class(預設即只有 `$TMP` / `Z*` / `Y*` 的自建 class)
- 工具說明開頭寫明「會在 SAP 系統上執行程式」,讓 AI 與使用者在呼叫前都看得到
- 每次執行都寫 audit log(`action: "run_class"`)

刻意**沒有**另外的開關:能寫入就能把任意程式寫進白名單內的 class,再加一個執行開關提供不了實質保護,只會增加設定負擔。不希望 AI 執行程式時,請改用唯讀模式。

### 3-3. ABAP Unit 與建立物件

- `run_unit_tests` 會在 SAP 上執行測試程式碼,因此與 `run_class` 一樣**唯讀模式(含 prod)不註冊**。它只執行宣告為 `RISK LEVEL HARMLESS`、`DURATION SHORT/MEDIUM` 的測試類別(不跑 DANGEROUS / CRITICAL),但 RISK LEVEL 是測試類別自己的宣告,不保證測試不寫資料,所以不能當作唯讀的依據(v0.3.1 起)
- `create_object` 在建立前呼叫 SAP 的名稱檢查;非 `$` 開頭的 package 必須給 transport;`create_transport` 只在 `SYSTEM_ROLE=dev` 且非唯讀時註冊

### 3-4. 401 斷路

SAP 預設連續登入失敗 5 次即鎖住帳號。密碼錯誤時,AI 或使用者很容易在幾次重試內就把帳號鎖住。因此連續 2 次 401 後,所有工具直接回錯誤、不再連 SAP,提示「修正 SAP_PASSWORD 後重開 MCP」;中間只要成功一次就歸零。網路層錯誤(SAP 未啟動)不計入。

### 3-5. 資料讀取(`data_preview`)

讀資料表等於把資料交給 AI(以及它背後的模型服務),是這個專案外洩風險最高的工具,因此:

- **預設不註冊**:只有 `ABAP_MCP_ALLOW_DATA_PREVIEW=true` 時 AI 才看得到。開啟後唯讀模式也可用,因為它只讀資料
- **表白名單** `ABAP_MCP_DATA_PREVIEW_TABLES`(預設只有 `/DMO/*`;`*` 結尾為前綴比對):單表模式檢查表名;SQL 模式從 SQL 解析 FROM / JOIN 後的每張表(含 WHERE 裡子查詢的表),任一不在白名單就整個拒絕。FROM 後面接子查詢、表函式或帶參數的 view、逗號列出多張表、找不到 FROM 等**無法可靠判斷讀取哪些表**的寫法一律拒絕
- **只接受單一 SELECT**:先去掉字串常值與註解,再檢查不得含 `;`(多語句)與 INSERT、UPDATE、DELETE、MODIFY、COMMIT、ROLLBACK、CALL、EXEC、INTO 等關鍵字,且必須以 SELECT 開頭。SAP 的 Data Preview 端點本身也只接受 SELECT(實測回「Only SELECT statement is allowed」),這裡是可以在本機先擋下的第二道防線
- **筆數與大小**:預設 100 筆、上限 1,000 筆;每格截斷 200 字元,整體輸出上限 20,000 字元
- **audit**:記錄 SQL 文字(或表名)與回傳筆數,**不記錄任何資料內容**。注意 SQL 裡的 WHERE 條件值會進 audit

白名單外的表(例如 USR02、HR 相關表、客戶主檔)不建議開放;確實需要時,只加入最小範圍的表名,不要用 `*`。

**不要把 `Z*` / `Y*` 加進表白名單**(v0.4 起預設不含):白名單只看得到查詢裡寫的名稱,看不到 view 背後讀的是哪張表。AI 在非唯讀模式下可以用 `create_object` + `write_source` 建一個 `Z` 開頭的 CDS view,例如 `define view entity ZI_X as select from usr02 { … }`,再用 `data_preview` 讀 `ZI_X`,白名單就形同虛設。若確實要讓 AI 查自建的表,請只列出那幾張表的完整名稱(例如 `/DMO/*,ZMY_ORDERS`),或在開啟 `data_preview` 時同時使用唯讀模式(唯讀模式下 AI 無法建立物件)。

### 3-6. 短傾印(`list_dumps` / `dump_detail`)

ST22 短傾印的完整內容常超過 1 MB,其中 **Selected Variables** 章節會列出當下的變數內容,可能包含業務資料。`dump_detail` 只擷取除錯需要的章節(Short Text、Error analysis、How to correct、where terminated、Source Code Extract、Active Calls/Events 等),不含變數內容、系統環境、記憶體與核心資訊;輸出上限 20,000 字元。即使如此,原始碼片段與錯誤說明仍可能出現常數或訊息文字,連正式系統時請評估。`dump_detail` 的 dump_id 只接受 `/sap/bc/adt/runtime/dump/…` 路徑,不能被拿來讀其他 ADT 資源。

### 3-7. RAP 產生器(`rap_generate`)一次建立很多物件

`rap_generate` 呼叫 SAP 的 RAP 產生器(ui-service),由一張表產生整套 RAP BO 與 OData V4 UI 服務。A4H 實測一次約 **14 個物件**:base / projection CDS、behavior definition 與兩個 behavior 實作 class、metadata extension、兩個 access control、service definition、service binding、SAP object type / node type,以及一張**草稿表**(新的資料庫表)。一次呼叫影響的範圍遠大於其他寫入工具,而且產生後要一個個依相依關係刪除才能還原。因此:

- **兩段式**:預設只預覽(不建立任何物件),回傳完整物件清單與 service binding 名稱;必須以相同參數再加 `confirm=true` 才會產生。AI 應把清單給使用者看過再確認。
- **整批白名單**:預覽清單的**每一個**物件都要通過名稱前綴白名單,目標 package 要通過 package 白名單;任一不過,`confirm=true` 也**整批拒絕**、一個都不建。注意 SAP object type / node type 與草稿表沿用**來源表名稱**,不受 `name_prefix` 影響。
- **寫入佇列 + 每物件一筆 audit**:產生在寫入佇列內執行,不與其他寫入交錯;audit 對每個物件各記一筆 `rap_generate`。
- **唯讀模式不註冊**;非本機 package 必須提供 transport。
- **發佈 = 對外開放 OData 服務**:預設 `publish=true` 會發佈 service binding,系統上任何有權限的使用者都能透過 `/sap/opu/odata4/…` 讀寫這張表的資料。連共用的開發系統時,請考慮 `publish=false`,確認後再在 Eclipse 手動發佈。
- **逾時**:系統剛啟動時產生可能超過 5 分鐘而回 5xx,但 SAP 端多半已建立大部分物件。工具會逐一查證並回報「已存在 X/N、缺少哪些」,不會假裝成功。
- **刪除順序**(由外而內):service binding → service definition → metadata extension → access control → behavior definition(projection 先)→ behavior 實作 class → CDS(projection 先)→ SAP object type / node type → 草稿表 → 來源表。已發佈的 binding 可能要先取消發佈。

### 3-8. abapGit 只讀、不提供 pull / push

`abapgit_repos` 只列出系統上已連結的 abapGit repo(需要 abapGit 的 ADT 後端;A4H 預設沒有,此時回報說明並建議用 SAP GUI 執行 `ZABAPGIT_STANDALONE`)。**刻意不提供 pull / push / stage**:

- **pull 會覆寫系統上的物件**,可能一次改動整個 package,且不經過本專案的名稱白名單、語法檢查與並行保護;內容也來自外部 repo,等於讓 AI 把任意程式碼放進 SAP。
- **push 會把 SAP 上的程式碼送到外部 Git 服務**,屬於資料外洩路徑,而且需要 Git 帳號憑證,本專案不應持有。
- 兩者都難以還原,也不適合在 AI 沒有人監看時執行。請在 abapGit 介面由人確認差異後操作。

### 4. Audit log

設定 `ABAP_MCP_AUDIT_LOG=/path/audit.jsonl` 後,每筆寫入、啟用(含 `activate_objects` 批次啟用的每個物件)、建立物件(`create_object`)、為語法檢查先建立空的測試 include(`create_test_include`)、執行(`run_class`)、建立 transport(`create_transport`)、資料查詢(`data_preview`,只記 SQL 與筆數)、RAP 產生(`rap_generate`,每個物件一筆)操作記錄一行 JSON:

```json
{"timestamp":"2026-06-12T08:00:00.000Z","action":"write_source","objectUrl":"/sap/bc/adt/oo/classes/zcl_demo","objectName":"ZCL_DEMO","transport":"DEVK900123","summary":"行數 120 → 135(約 +18 / -3)","success":true}
```

**刻意不記錄**:憑證、完整原始碼內容(只有行數統計)。SAP 端的版本歷史(version management)才是完整的程式碼變更紀錄來源。

### 5. 憑證處理

- 密碼僅從環境變數讀取,程式不會將其寫入任何檔案或 log
- `.env` 已列入 `.gitignore`
- Claude Code 設定建議使用 `${SAP_PASSWORD}` 變數展開,而非明文寫入 `.mcp.json`
- 建議搭配 OS 層級的祕密管理(macOS Keychain、Windows Credential Manager、`pass` 等),在 shell profile 中動態載入

### 6. TLS

預設驗證伺服器憑證。`ABAP_MCP_ALLOW_SELF_SIGNED=true` 會讓連 SAP 的 ADT client 改用專屬的 `https.Agent({ rejectUnauthorized: false })`,**不再驗證 SAP 伺服器憑證**(可能遭中間人攻擊),**僅限與內網開發系統搭配使用**。

自 v0.2 起,這個設定只作用在 ADT client 本身,不再設定 `NODE_TLS_REJECT_UNAUTHORIZED=0`,所以同一個 Node process 的其他 HTTPS 連線仍會驗證憑證。

較佳的長期做法是把企業 Root CA 加入 Node 的信任清單:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem
```

(設定了 `NODE_EXTRA_CA_CERTS` 就不需要 `ALLOW_SELF_SIGNED`。)

## 部署建議(checklist)

- [ ] 連 dev 系統:`SYSTEM_ROLE=dev`,開啟 audit log
- [ ] 連 qa 系統:考慮 `ABAP_MCP_READONLY=true`(AI 只做分析)
- [ ] 連 prod 系統:`SYSTEM_ROLE=prod`(自動唯讀),或乾脆不要連
- [ ] 使用專屬的技術帳號(非個人帳號),權限最小化,只授權需要的 package
- [ ] 白名單收斂到實際需要的命名空間與 package(`ABAP_MCP_ALLOWED_PREFIXES`、`ABAP_MCP_ALLOWED_PACKAGES`)
- [ ] 不希望 AI 在 SAP 上執行程式(`run_class`)時,使用唯讀模式
- [ ] 只在確實需要時開啟 `ABAP_MCP_ALLOW_DATA_PREVIEW`,並把 `ABAP_MCP_DATA_PREVIEW_TABLES` 收斂到最小範圍
- [ ] 使用 `rap_generate` 前先看過預覽清單;共用系統上考慮 `publish=false`
- [ ] 跑評測(`npm run eval`)只對 Trial / 沙箱系統;評測會在 `$TMP` 建立並刪除暫存物件,且依模型收費
- [ ] 密碼不出現在任何進版控的檔案中

## 回報安全問題

請透過 GitHub Security Advisories 私下回報,勿開公開 issue。
