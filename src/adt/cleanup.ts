/**
 * adt/cleanup.ts — 結束時要清掉的進行中資源登錄表(v0.6 審查 #1)
 *
 * 探針會在 SAP 端留下東西:模式 B 的外部中斷點、debugger 監聽與兩個專用 ADT session,
 * 模式 A 的 logpoint。正常路徑由各自的 finally 清除;但 MCP 在探針進行中收到 stdin 結束 / SIGINT / SIGTERM 時
 * process 會直接結束,finally 沒機會跑。這裡讓進行中的資源登錄清除函式,shutdown 時先全部執行再登出。
 * 清除函式必須自己吞掉錯誤、不可無限等待(shutdown 另有總逾時)。
 */
const hooks = new Set<() => Promise<void>>();

/** 登錄清除函式;回傳取消登錄的函式(資源正常清完後呼叫) */
export function registerCleanup(fn: () => Promise<void>): () => void {
  hooks.add(fn);
  return () => {
    hooks.delete(fn);
  };
}

/** 平行執行所有已登錄的清除函式(任何一個失敗都不影響其他);回傳執行的個數 */
export async function runCleanups(): Promise<number> {
  const list = [...hooks];
  await Promise.all(list.map((f) => f().catch(() => undefined)));
  return list.length;
}

/** 測試用 */
export function pendingCleanups(): number {
  return hooks.size;
}
