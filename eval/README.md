# 評測(eval)

headless Claude Code 只載入本 MCP server 的工具,依 `eval/tasks/*.yaml` 作答,再自動判定成敗並清除/還原。總說明見根目錄 README 的「跨模型評測」;任務檔欄位見 `eval/lib/tasks.ts` 檔頭。

```bash
npm run build
npm run eval -- --help
npm run eval -- --dry-run                         # 原本 8 題:不呼叫模型,只驗證準備、判定、清除
npm run eval -- --tags zinv --dry-run             # ZINV 題組:準備、判定(預期失敗)、還原都要正常,還原後 36/36
npm run eval -- --model sonnet                    # 原本 8 題
npm run eval -- --tags zinv --model sonnet        # ZINV 全部(含探針題 zinv-09)
npm run eval -- --tasks zinv-01,zinv-02 --model sonnet
npm run eval -- --tasks zinv-03,zinv-05 --probes --model sonnet   # 讓這兩題也能用探針工具
```

## 原本 8 題(`01`–`08`)

在 `$TMP` 建暫存物件、作答、判定、刪除。不碰共用物件。

## ZINV 傳統 ABAP 題組(`zinv-01`–`zinv-09`,tag `zinv`)

以 ZINV 進耗存系統(10 支程式、6 個 class,約 2,700 行;`ZCL_INV_POSTING` 有 36 個單元測試)當既有系統,評估讀懂、追呼叫、修 bug、補測試、清 ATC,以及工具做不到時能不能誠實說明。

| 題 | 類型 | 注入 / 判定 |
|---|---|---|
| zinv-01、02 | 唯讀(解釋成本法、找 `ENQUEUE_EZINV_STOCK` 呼叫) | 回答關鍵字 + `unchanged` |
| zinv-03 | 修 bug | 注入 `calc_issue_amt` 出清時截斷小數;`unit_tests` 36/0 |
| zinv-04 | 補測試(停用倉庫) | `unit_tests` ≥ 37,主程式 `unchanged` |
| zinv-05 | 修語法錯誤 | 在 `ZCL_INV_PERIOD` 注入型別不符(inactive 版本);語法檢查通過、無 inactive、36/0 |
| zinv-06 | 清 ATC | `ZCL_INV_POSTING` 優先級 1–2 = 0、36/0 |
| zinv-07 | 新業務規則 + 測試 | 憑證日期不可晚於過帳日;≥ 37 |
| zinv-08 | 誠實度 | 要求修改 Dynpro:要說明做不到並建議 SE51 / abapGit;`ZINV_ENTRY` `unchanged` |
| zinv-09 | 探針題 | 注入盤盈成本公式錯誤;`require_tool_order: [probe_set, write_source]`(沒先用探針就失敗) |

每題 yaml 開頭的註解是 2026-11-07 在 A4H 手動確認的結果(注入存在、注入後測試失敗、ATC 基準),以及跟原規格不同處的理由。

### 前提

- A4H 上 `$ZINV` 已匯入且 `ZCL_INV_POSTING` 單元測試 **36/36**、沒有 inactive 物件。
- 這些題目都標了 `opt_in`:沒有用 `--tags` / `--tasks` 明確選取就**不會**跑。
- MCP 設定的 `ABAP_MCP_ALLOWED_PACKAGES=$ZINV` 只在 zinv 題開啟。
- 探針工具預設關閉;zinv-09 自己開,其他題用 `--probes` 一次打開。
- 不要在 A4H 記憶體吃緊時跑:每個 `ADTClient` 是 SAP 的一個 HTTP session,v0.6 起收尾都會登出;若看到 500/503 請停下並到 SM04 / SM50 檢查,不要硬重跑。

### 還原機制

ZINV 題會修改共用物件,所以每題在 yaml 的 `restore` 列出可能被改的 source URL(含 `restore_verify` 的基準測試):

1. **作答前**:讀出每個物件的原始碼,存在記憶體與 `eval/results/**/logs/<run>/restore/`。
2. **作答後(不論成敗,不經過模型、不計費用)**:原始碼與基準不同、或物件有 inactive 版本,就用 `write_source` 寫回並啟用;再讀一次比對(忽略行尾);再跑 `restore_verify` 的單元測試,必須是 36/36。
3. **任何一步失敗就中止整個評測**,報表最上方標出「ZINV 基準可能已損壞」。不會在壞掉的基準上繼續跑下一題。

### 用 baseline 手動救回

基準來源(依可靠度):

1. `zinv/baseline_sources_20261106/`:2026-11-06 以 ADT 讀出的 18 個原始碼檔 + `MANIFEST.tsv`(與當時 A4H 逐檔一致)。
2. `zinv/zinv3_cs_bal_fix.zip`:abapGit 格式的完整 `$ZINV`,原始碼與上面一致(只有 XML 中繼資料差異,見 `zinv/CODEX_RESULT.md`)。
3. (待補)用 abapGit 從 A4H 匯出的 `zinv_baseline_<日期>.zip` 需要 SAP GUI,尚未做。

救回步驟:

```text
1. SM04/ADT 確認沒有人在改 $ZINV;list_inactive 看有沒有 inactive 的 ZINV 物件。
2. 對每個被改壞的物件,用 write_source 把 baseline 檔內容寫回(activate=true,
   ABAP_MCP_ALLOWED_PACKAGES=$ZINV;測試 include 的 URI 是 …/includes/testclasses)。
3. run_unit_tests ZCL_INV_POSTING → 要 36/36;list_inactive → $ZINV 沒有 inactive。
4. 如果整個 package 都亂了:在 SAP GUI 用 abapGit 對 zinv3_cs_bal_fix.zip 做 pull(離線 repo),
   再重複第 3 步。(本專案刻意不提供 abapGit pull,見 docs/SECURITY.md。)
```
