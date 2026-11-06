# Changelog

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
