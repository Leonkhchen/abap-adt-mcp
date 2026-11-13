/**
 * lifecycle.ts — MCP server 結束時登出所有 ADT client(v0.6 C0-10)
 *
 * stdin 關閉(Claude Code 結束、關掉 MCP)、SIGINT、SIGTERM 時,先 adt.close()(登出、釋放 SAP 端 HTTP session),
 * 再結束 process。只會執行一次;登出最多等 timeoutMs,SAP 沒回應也不能讓 process 掛著。
 * 注意:stdout 是 MCP 的 JSON-RPC channel,日誌一律走 stderr。
 */
import type { AdtService } from "./adt/client.js";

interface Listenable {
  on(event: string, listener: () => void): unknown;
}

export interface ShutdownDeps {
  signals: Listenable;
  stdin: Listenable;
  exit: (code: number) => void;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

/** 安裝結束處理;回傳手動觸發的函式(測試用),重複呼叫只會執行一次 */
export function installShutdown(adt: Pick<AdtService, "close">, deps: ShutdownDeps): (reason: string) => Promise<void> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const timeoutMs = deps.timeoutMs ?? 8000;
  let started: Promise<void> | undefined;

  const run = (reason: string): Promise<void> => {
    started ??= (async () => {
      log(`[abap-adt-mcp] 結束(${reason}):登出 ADT 工作階段…`);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([Promise.resolve(adt.close?.()), timeout]);
      } catch (e) {
        log(`[abap-adt-mcp] 警告:登出失敗,SAP 端 session 將於逾時後釋放:${String(e)}`);
      } finally {
        if (timer) clearTimeout(timer);
        deps.exit(0);
      }
    })();
    return started;
  };

  deps.signals.on("SIGINT", () => void run("SIGINT"));
  deps.signals.on("SIGTERM", () => void run("SIGTERM"));
  deps.stdin.on("end", () => void run("stdin 關閉"));
  deps.stdin.on("close", () => void run("stdin 關閉"));
  return run;
}
