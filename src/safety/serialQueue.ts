/**
 * safety/serialQueue.ts — process 內的互斥佇列
 *
 * 所有工具共用同一個 ADTClient。寫入類操作(lock → write → unlock、activate、create、delete)
 * 會把 client 切到 stateful 再切回 stateless;若兩個寫入同時進行,後一個可能在前一個
 * 鎖定期間把 session 切回 stateless,或拿到錯誤的鎖定狀態。
 * 因此寫入類操作一律排進這個佇列依序執行(先進先出;前一個失敗不影響後一個)。
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** 等前面的工作都結束後才執行 fn;回傳 fn 的結果(或拋出 fn 的錯誤) */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // 佇列只關心「結束」,不讓前一個的失敗傳染給下一個
    this.tail = result.catch(() => undefined);
    return result;
  }
}
