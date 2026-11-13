# Changelog

## 0.6.0 — 除錯探針、ZINV 評測題組、工作階段修正(2026-11-07)

### 新功能:除錯探針(預設關閉)
- 新工具 `probe_set` / `probe_list` / `probe_logs` / `probe_delete`,新 prompt `probe-debug`。在指定程式行(可以是 SAP 標準程式)記錄變數值、呼叫堆疊或 SQL,不改程式、不改變數值。
- **模式 A(Dynamic Logpoints)**與**模式 B(Debugger 快照)**都實作;`ABAP_MCP_PROBE_MODE=auto` 依系統是否有 `/sap/bc/adt/dlp` 端點選擇。模式 A 不停住程式、可開著等人執行;模式 B 是外部中斷點 → 監聽 → 停下取值 → 自動繼續,一律在 `finally` 清理。
- 安全:`ABAP_MCP_ALLOW_PROBES`(預設 false,prod 不註冊)、`ABAP_MCP_PROBE_SCOPE`(all/custom)、`ABAP_MCP_PROBE_DENY`、`ABAP_MCP_MAX_PROBES`;只對登入帳號自己的執行生效;trigger 物件走兩道白名單;audit 與存檔都不含變數值。
- 探針定義存檔:`save_as` → `probes/<名稱>.json`(`ABAP_MCP_PROBES_DIR`),不存變數值。
- 升級 `abap-adt-api` 8.4.0 → 8.5.0(Dynamic Logpoints API)。
- 實測的 SAP 行為見 HANDOFF.md:logpoint 要帶 `state="A"`、`subKey` 只能是單一變數、讀取前要先轉進資料庫。

### 評測框架與 ZINV 題組
- 還原機制(`restore` / `restore_verify`):作答前讀出、作答後不論成敗寫回並比對、跑基準單元測試;任何一步失敗就中止整個評測。包含清掉 inactive 殘留。
- `patch` 注入(含 `inactive: true` 注入語法錯誤)、`expect_unit_tests`、新判定 `unit_tests` / `source_contains` / `source_not_contains` / `atc_max` / `unchanged`、`--tags`、`opt_in`、`allow_probes` / `require_tool_order` / `--probes`。
- ZINV 題組 9 題(`eval/tasks/zinv-01..09.yaml`),其中 zinv-09 是探針題。說明見 `eval/README.md`。

### 修正
- **C0-10(重要)ADT 工作階段外洩**:stateful 流程只刪了本地 cookie、沒通知 SAP,ADTClient 也從不登出,session 累積到 A4H 記憶體耗盡(500/503)。新增 `src/adt/session.ts`(`releaseStateful` / `logoutClient`)、`RealAdtService.close()`、`src/lifecycle.ts`(stdin 結束 / SIGINT / SIGTERM 時先登出再結束);整合測試與評測收尾也登出。
- C0-1/2:測試 include 範本改在鎖定內讀取且必須只含註解;`create_test_include` 的 audit 不再漏。
- C0-3:`deleteWithLock` 不吞解鎖錯誤。
- C0-4:`dumpDetail`、`dataElementProperties`、`domainProperties` 補上 URI 驗證。
- C0-5/6:SECURITY.md 與實作一致;實機確認 unit test 對 package 遞迴、`%70ackages` / `//packages` 不被當成 package、`Packages`(大小寫)會被當成 package(T50–T52)。

### 獨立審查後的修正(`claude -p` 唯讀審查 `v0.5.1..v0.6`)
- 探針進行中 MCP 被結束時,中斷點、監聽、探針專用 session、logpoint 都會先清掉(新增 `src/adt/cleanup.ts`)。
- `ABAP_MCP_PROBE_DENY` 也比對 include 所屬的主程式與 function group;`ABAP_MCP_PROBE_SCOPE=custom` 在白名單都空時拒絕。
- 模式 B 讀不到指定變數時回報「讀不到」,不再退回第一個變數。
- 文件校正:`save_as` 的 `condition` 是原文、模式 A 的 `max_hits` 是「最多讀幾個不同的值」。

### 第二次審查後的修正(`v06review.md`,3 項 P2)
- **模式 B 收滿 `max_hits` 時刪除中斷點失敗**:「收滿」與「SAP 上的中斷點已確認刪除」分開記錄(`bpDeleted`)。刪除失敗不再被吞掉:`finally` 與 shutdown abort 會重試所有尚未確認刪除的中斷點(最多 3 輪);仍失敗就在結果與 notes 明確警告(摘要不再寫「已收滿並移除」),請手動清除。
- **模式 B 總逾時涵蓋停駐處理**:`attach` / `stack` / `variables` / `continue` 每個請求都受剩餘期限約束;逾時就停止收值(之後不再對 port 發請求,避免與清理競爭同一個 session),狀態為 `timeout`,再進入清理。清理的每個請求有 8 秒上限、整體有 30 秒上限(超過就不再重試刪除,仍會嘗試登出)。引擎計時器改為 `unref`。
- **模式 A 仍啟用的 logpoint 不會因歷史紀錄淘汰而遺失**:「SAP 上仍活著的 logpoint id」與最多 20 筆的歷史紀錄分開登錄,保留到確認刪除(或已不存在)。shutdown 清理與 `probe_delete(all=true)` 都從這份登錄清;`probe_delete(run_id)` 遇到已被淘汰的紀錄會明說並提示用 `all=true`。

### 測試
- 單元測試 364;整合測試 T01–T52(T41–T49 為探針)。


## 0.5.1 — 安全與一致性修正(2026-11-04)

來源:`review1104v1.md`(R1–R5)。不加新功能。

### 安全
- **S1(R1,P1)集中驗證 ADT URI**:新增 `src/safety/uri.ts` 的 `assertAdtUri`。`RealAdtService` 所有吃 URI 的方法與各工具入口,在送出任何帶 SAP 帳密的 request 之前,拒絕外部絕對 URL、`//host`、反斜線、控制字元與路徑穿越;只接受 `/sap/bc/adt/` 開頭的相對 URI。物件名稱護欄改用驗證後的路徑。底層 axios 的 redirect 限制為同 origin。影響範圍比報告大:`activate_object`、`activate_objects`、`run_class`、`write_source` 都經過同一個 `objectPackage()`。
- **S2(R2,P1)`run_unit_tests` 套用兩道白名單**:單一物件比照 `run_class`;package 模式檢查 package 白名單,並對 package 內每個 class / program / function group 做名稱前綴檢查(子 package 做 package 白名單),任一不過整批拒絕並列出被擋項目。新增 audit 紀錄。

### 並行與一致性
- **C1(R3)鎖定後再比對一次**:`lockedWrite()` 取得鎖定後、寫入前,用同一個鎖定 session 重新讀取並比對 `expected_current_source`(新增 `AdtService.getSourceInLock`)。鎖定前的比對保留。
- **C2(R4)自己建立的測試 include 不算衝突**:`ensureTestInclude()` 回傳建立後的範本內容;新建 include 且 `expected_current_source` 為 `""` 時,以該範本作為比對基準。建立後被他人改動仍會被擋下。

### 評測框架
- **E1(R5)清除失敗也要解鎖**:`eval/lib/harness.ts` 新增 `deleteWithLock`,刪除失敗時在同一個 stateful session 解鎖,解鎖失敗不蓋掉刪除錯誤。

### 其他
- 既有單元測試中的假 URI(`/u`)改為合法的 `/sap/bc/adt/…`。
