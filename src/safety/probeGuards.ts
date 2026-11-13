/**
 * safety/probeGuards.ts — 除錯探針的位置檢查(v0.6)
 *
 * 探針不修改程式,所以預設不套用「寫入白名單」:標準程式也可以埋(主要用途是偵測 SAP 標準程式有沒有問題)。
 * 但探針會把執行時的變數值記下來,可能讀到敏感資料,因此有自己的範圍設定:
 *  - ABAP_MCP_PROBE_SCOPE=all(預設):任何物件都可以,除非在 ABAP_MCP_PROBE_DENY
 *  - ABAP_MCP_PROBE_SCOPE=custom:只限寫入白名單內的物件(名稱前綴 + package)
 *  - ABAP_MCP_PROBE_DENY:排除的物件或 package(逗號分隔,* 結尾為前綴),任何範圍都適用
 * 另外一律先過 assertAdtUri(v0.5.1 S1)。
 */
import type { AppConfig } from "../config.js";
import { GuardViolationError, objectNameFromUrl, packageMatches } from "./guards.js";
import { assertAdtUri } from "./uri.js";

/** 名稱是否符合排除項目(* 結尾為前綴,否則完全比對;不分大小寫) */
export function denyMatches(value: string, pattern: string): boolean {
  return packageMatches(value, pattern);
}

/**
 * 檢查探針位置是否允許;違反時丟出 GuardViolationError。
 * @param objectUrl 物件或 source URI
 * @param packageName 物件所在 package(呼叫端先查好;查不到給空字串)
 * @param extraNames 也要拿去比對排除清單的名稱:include 所屬的主程式、function group(審查 #2:否則排除 SAPLXXX 擋不住它的 include)
 */
export function assertProbeAllowed(cfg: AppConfig, objectUrl: string, packageName: string, extraNames: string[] = []): void {
  const safeUrl = assertAdtUri(objectUrl, cfg);
  const name = objectNameFromUrl(safeUrl);
  const { deny, scope } = cfg.safety.probes;

  const names = [name, ...extraNames.map((n) => n.toUpperCase())];
  const hit = deny.find((p) => names.some((n) => denyMatches(n, p)) || (packageName && denyMatches(packageName, p)));
  if (hit) {
    throw new GuardViolationError(
      `探針位置 ${name}${packageName ? `(package ${packageName.toUpperCase()})` : ""} 在排除清單內(ABAP_MCP_PROBE_DENY 的 ${hit}),拒絕。`
    );
  }

  if (scope === "custom") {
    // 兩份白名單都空 = 沒有任何「自己的程式」可言:拒絕,不要退化成 all(審查 #3)
    if (cfg.safety.allowedPrefixes.length === 0 && cfg.safety.allowedPackages.length === 0) {
      throw new GuardViolationError("探針範圍為 custom,但名稱前綴與 package 白名單都是空的,無法判斷哪些是自己的程式,拒絕。");
    }
    const prefixes = cfg.safety.allowedPrefixes;
    if (prefixes.length > 0 && !prefixes.some((p) => name.startsWith(p))) {
      throw new GuardViolationError(
        `探針範圍為 custom(ABAP_MCP_PROBE_SCOPE=custom),物件 ${name} 不在可寫入的前綴白名單內(目前允許:${prefixes.join(", ")})。`
      );
    }
    const pkgs = cfg.safety.allowedPackages;
    if (pkgs.length > 0) {
      if (!packageName) throw new GuardViolationError("探針範圍為 custom,但無法判斷物件所在的 package,為安全起見拒絕。");
      if (!pkgs.some((p) => packageMatches(packageName, p))) {
        throw new GuardViolationError(
          `探針範圍為 custom,package ${packageName.toUpperCase()} 不在可寫入的 package 白名單內(目前允許:${pkgs.join(", ")})。`
        );
      }
    }
  }
}
