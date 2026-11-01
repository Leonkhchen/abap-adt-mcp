# SECURITY — 安全設計說明

讓 AI agent 直接讀寫 SAP 系統,等同於給它一個開發者帳號。本文件說明內建的防護層,以及部署時你應該做的決策。

## 威脅模型

| 風險 | 防護 |
|---|---|
| AI 誤改 SAP 標準物件 | 前綴白名單(預設僅 `Z`/`Y`/`$`)+ package 白名單(預設僅 `$TMP`、`Z*`、`Y*`) |
| AI 在 SAP 上執行任意程式(`run_class`) | 唯讀模式不註冊;只能執行通過兩道白名單的 class;工具說明開頭明寫「會在 SAP 系統上執行程式」;audit log |
| AI 大量建立物件或放進錯誤的 package(`create_object`) | 兩道白名單;非本機 package 必須明確給 transport;建立前先做名稱檢查;audit log |
| ABAP Unit 測試改到資料 | `run_unit_tests` 只執行 RISK LEVEL HARMLESS 的測試 |
| 密碼錯誤時自動重試把帳號鎖住 | 401 斷路:連續 2 次認證失敗後停止連線 SAP,需修正密碼後重開 MCP |
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

- `run_unit_tests` 只執行 `RISK LEVEL HARMLESS`、`DURATION SHORT/MEDIUM` 的測試類別(不跑 DANGEROUS / CRITICAL),因此唯讀模式也提供
- `create_object` 在建立前呼叫 SAP 的名稱檢查;非 `$` 開頭的 package 必須給 transport;`create_transport` 只在 `SYSTEM_ROLE=dev` 且非唯讀時註冊

### 3-4. 401 斷路

SAP 預設連續登入失敗 5 次即鎖住帳號。密碼錯誤時,AI 或使用者很容易在幾次重試內就把帳號鎖住。因此連續 2 次 401 後,所有工具直接回錯誤、不再連 SAP,提示「修正 SAP_PASSWORD 後重開 MCP」;中間只要成功一次就歸零。網路層錯誤(SAP 未啟動)不計入。

### 4. Audit log

設定 `ABAP_MCP_AUDIT_LOG=/path/audit.jsonl` 後,每筆寫入、啟用、建立物件(`create_object`)、執行(`run_class`)、建立 transport(`create_transport`)操作記錄一行 JSON:

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
- [ ] 密碼不出現在任何進版控的檔案中

## 回報安全問題

請透過 GitHub Security Advisories 私下回報,勿開公開 issue。
