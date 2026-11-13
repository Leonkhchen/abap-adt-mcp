# 探針定義存檔(標準程式探針參考)

`probe_set` / `probe_logs` 帶 `save_as` 時,會把探針的定義與發現存成 `probes/<名稱>.json`
(目錄可用 `ABAP_MCP_PROBES_DIR` 改)。累積起來就是一份「哪個程式、哪一行、看哪些變數值得觀察」的參考,
之後不用重新找,也可以拿來檢查舊版系統是否支援。

檔案內容:探針定義(物件 URI、行號、kind、變數名稱、條件、max_hits;`definition` 可直接餵回 `probe_set`)、
目的、系統(host / client / 版本)、模式(A = Dynamic Logpoints,B = Debugger 快照)、命中次數、結論、日期。

**不存任何變數值**(避免把業務資料寫進檔案)。同名檔案會被覆蓋。
