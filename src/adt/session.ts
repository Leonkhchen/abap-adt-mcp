/**
 * adt/session.ts — ADT 工作階段收尾(v0.6 C0-10)
 *
 * 背景:A4H 實測,每個 ADTClient 在 SAP 端都是一個 HTTP user session(SM04 看得到),
 * stateful 的還會占著 extended memory(每個 8–70 MB)。這些 session 只有「登出」或「逾時」才會釋放;
 * 用完不收尾,連續跑測試會累積到 ES 記憶體用盡、工作行程卡在 PRIV mode,A4H 開始回 500/503。
 *
 * 兩種收尾:
 *  - releaseStateful:一次 stateful 流程(lock → 寫入 → unlock)結束後呼叫。
 *    先用 dropSession() 通知 SAP 結束 stateful context(它會切回 stateless 並送一個不帶 stateful 標頭的請求),
 *    再清掉用戶端的 sap-contextid。只清 cookie 不通知 SAP 的話,伺服器端的 context 要等逾時才釋放。
 *  - logoutClient:client 生命週期結束時呼叫(ICF logoff),整個 HTTP session 釋放。
 * 兩者都吞掉錯誤:SAP 端例外會先結束 context(之後任何請求回 400),收尾不能因此丟例外、蓋掉原本的錯誤。
 */
import { session_types, type ADTClient } from "abap-adt-api";

/** 單次收尾請求的逾時;SAP 沒回應時不能卡住關閉流程 */
const RELEASE_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => timer && clearTimeout(timer));
}

/** 結束 stateful session:通知 SAP 放掉 context → 回到 stateless → 丟掉 sap-contextid。不丟例外。 */
export async function releaseStateful(c: ADTClient, timeoutMs = RELEASE_TIMEOUT_MS): Promise<void> {
  try {
    await withTimeout(Promise.resolve(c.dropSession()), timeoutMs);
  } catch {
    // context 已被 SAP 端例外結束(之後的請求回 400)、或連不上:都不影響收尾
  }
  c.stateful = session_types.stateless;
  // AdtHTTP.cookie 在型別上是 private,執行期為 Map<cookie 名稱, 值>;
  // 失效的 context id 留著,之後所有請求都會回 400(A4H 實測),所以一定要丟
  (c.httpClient as unknown as { cookie?: Map<string, string> } | undefined)?.cookie?.delete("sap-contextid");
}

/** 登出並釋放整個 HTTP session;沒登入過的 client 不送請求。不丟例外。 */
export async function logoutClient(c: ADTClient, timeoutMs = RELEASE_TIMEOUT_MS): Promise<void> {
  try {
    if (!c.loggedin) return;
    await withTimeout(Promise.resolve(c.logout()), timeoutMs);
  } catch {
    // 登出失敗只代表 session 要等逾時才釋放
  }
}
