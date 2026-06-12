# SECURITY — 安全設計說明

讓 AI agent 直接讀寫 SAP 系統,等同於給它一個開發者帳號。本文件說明內建的防護層,以及部署時你應該做的決策。

## 威脅模型

| 風險 | 防護 |
|---|---|
| AI 誤改 SAP 標準物件 | 前綴白名單(預設僅 `Z`/`Y`/`$`) |
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

### 4. Audit log

設定 `ABAP_MCP_AUDIT_LOG=/path/audit.jsonl` 後,每筆寫入/啟用操作記錄一行 JSON:

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

預設驗證伺服器憑證。`ABAP_MCP_ALLOW_SELF_SIGNED=true` 會停用整個 Node process 的 TLS 驗證(`NODE_TLS_REJECT_UNAUTHORIZED=0`),**僅限與內網開發系統搭配使用**;較佳的長期做法是把企業 Root CA 加入 Node 的信任清單:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-root-ca.pem
```

(設定了 `NODE_EXTRA_CA_CERTS` 就不需要 `ALLOW_SELF_SIGNED`。)

## 部署建議(checklist)

- [ ] 連 dev 系統:`SYSTEM_ROLE=dev`,開啟 audit log
- [ ] 連 qa 系統:考慮 `ABAP_MCP_READONLY=true`(AI 只做分析)
- [ ] 連 prod 系統:`SYSTEM_ROLE=prod`(自動唯讀),或乾脆不要連
- [ ] 使用專屬的技術帳號(非個人帳號),權限最小化,只授權需要的 package
- [ ] 白名單收斂到實際需要的命名空間
- [ ] 密碼不出現在任何進版控的檔案中

## 回報安全問題

請透過 GitHub Security Advisories 私下回報,勿開公開 issue。
