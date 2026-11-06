/**
 * eval/lib/baseline.ts — 共用物件的注入與還原(v0.6 Z1,ZINV 題組用)
 *
 * ZINV 題目會修改共用物件,不能像 $TMP 題目那樣建立後刪掉:
 *  - 作答前(事前準備之前)讀出 `restore` 清單內每個物件的原始碼 = 還原基準
 *  - 作答後(不論成敗)用 write_source 寫回並啟用 → 再讀一次比對(忽略行尾)→ 跑基準單元測試確認
 *  - 任何一步失敗就中止整個評測,不在壞掉的基準上繼續跑
 * 本檔只放純邏輯(依賴由呼叫端注入),單元測試用假依賴即可,不需要 SAP。
 */

/** 行尾差異(CRLF vs LF)與結尾空白不算內容變更 */
export function normalizeSource(s: string): string {
  return s.replace(/\r\n/g, "\n").trimEnd();
}

export function sameSource(a: string, b: string): boolean {
  return normalizeSource(a) === normalizeSource(b);
}

export interface PatchResult {
  /** 找到幾處 */
  count: number;
  /** 取代後的原始碼(count 為 0 時原樣回傳) */
  source: string;
}

/** 注入用:把 find 換成 replace(比對前統一行尾;區分大小寫,找不到就是 0 處) */
export function applyPatch(source: string, find: string, replace: string, all = false): PatchResult {
  const src = source.replace(/\r\n/g, "\n");
  const needle = find.replace(/\r\n/g, "\n");
  if (!needle) return { count: 0, source };
  const count = src.split(needle).length - 1;
  if (count === 0) return { count: 0, source };
  const rep = replace.replace(/\r\n/g, "\n");
  return { count, source: all ? src.split(needle).join(rep) : src.replace(needle, () => rep) };
}

export interface UnitCounts {
  methods: number;
  passed: number;
  failed: number;
  /** 測試類別本身有錯誤(例如 setup 失敗) */
  classErrors: number;
}

/** 解析 run_unit_tests 的第一行:「ABAP Unit:N 個測試方法,P 通過,F 失敗[;K 個測試類別本身有錯誤]」 */
export function parseUnitCounts(text: string): UnitCounts | undefined {
  const m = text.match(/ABAP Unit:(\d+) 個測試方法,(\d+) 通過,(\d+) 失敗(?:;(\d+) 個測試類別本身有錯誤)?/);
  if (!m) return undefined;
  return { methods: Number(m[1]), passed: Number(m[2]), failed: Number(m[3]), classErrors: Number(m[4] ?? 0) };
}

/** 判定:失敗數 0、沒有類別層級錯誤、通過數 ≥ minPassed;回傳問題說明或 undefined */
export function checkUnitTests(text: string, minPassed: number, label = "單元測試"): string | undefined {
  const c = parseUnitCounts(text);
  if (!c) return `${label}:找不到測試結果(${text.slice(0, 120).replace(/\n/g, " ")})`;
  if (c.classErrors > 0) return `${label}:${c.classErrors} 個測試類別本身有錯誤`;
  if (c.failed > 0) return `${label}:${c.failed} 個失敗(${c.passed}/${c.methods} 通過)`;
  if (c.passed < minPassed) return `${label}:通過 ${c.passed} 個,少於要求的 ${minPassed} 個`;
  return undefined;
}

export interface RestoreDeps {
  /** 讀目前的原始碼(經 AdtService,有 URI 驗證) */
  read(url: string): Promise<string>;
  /** 寫回並啟用;失敗丟例外 */
  write(url: string, source: string): Promise<void>;
  /** 跑單元測試,回傳 run_unit_tests 的輸出文字 */
  runUnitTests(url: string): Promise<string>;
}

export interface RestoreVerify {
  object_url: string;
  /** 還原後必須全部通過的測試方法數(例如 ZCL_INV_POSTING 的 36) */
  passed: number;
}

/**
 * 把 originals 寫回、逐一比對、再跑基準單元測試。回傳問題清單(空陣列 = 還原成功)。
 * 單一物件失敗不會讓其他物件跳過(盡量多還原),但整體只要有任何問題就算失敗。
 */
export async function restoreSources(
  deps: RestoreDeps,
  originals: ReadonlyMap<string, string>,
  verify?: RestoreVerify
): Promise<string[]> {
  const problems: string[] = [];
  for (const [url, original] of originals) {
    try {
      // 已經一樣就不重寫(少一次鎖定、啟用)
      const before = await deps.read(url).catch(() => undefined);
      if (before === undefined || !sameSource(before, original)) await deps.write(url, original);
      const after = await deps.read(url);
      if (!sameSource(after, original)) problems.push(`${url}:寫回後內容與原始碼不一致`);
    } catch (e) {
      problems.push(`${url}:還原失敗(${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (verify) {
    try {
      const text = await deps.runUnitTests(verify.object_url);
      const c = parseUnitCounts(text);
      if (!c) problems.push(`基準單元測試 ${verify.object_url}:找不到測試結果`);
      else if (c.failed > 0 || c.classErrors > 0 || c.passed !== verify.passed) {
        problems.push(`基準單元測試 ${verify.object_url}:${c.passed}/${c.methods} 通過、${c.failed} 失敗,應為 ${verify.passed}/${verify.passed}`);
      }
    } catch (e) {
      problems.push(`基準單元測試 ${verify.object_url} 無法執行(${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return problems;
}
