/**
 * safety/guards.ts — 安全護欄
 *
 * AI 直接寫入 SAP 系統風險很高,所有寫入操作必須先通過這裡的檢查:
 *  1. 唯讀模式 / prod 系統 → 寫入工具根本不會註冊(雙重保險:這裡再擋一次)
 *  2. 物件名稱前綴白名單 → 預設只允許 Z* / Y* / $(本機物件),
 *     防止 AI 誤改 SAP 標準物件
 *  3. package 白名單 → 預設只允許 $TMP、Z*、Y* package,
 *     即使物件名稱是 Z 開頭,放在其他 package 也不可寫入/建立/執行
 */
import type { AppConfig } from "../config.js";

export class GuardViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardViolationError";
  }
}

/**
 * 從 ADT 物件 URI 中萃取物件名稱。
 * 例如 /sap/bc/adt/oo/classes/zcl_demo/source/main → ZCL_DEMO
 */
export function objectNameFromUrl(objectUrl: string): string {
  const path = objectUrl.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  // 去除尾端的 source/main 等 source 路徑
  while (segments.length && ["main", "source", "includes", "testclasses", "definitions", "implementations", "macros"].includes(segments[segments.length - 1])) {
    segments.pop();
  }
  const name = segments[segments.length - 1] ?? "";
  return decodeURIComponent(name).toUpperCase();
}

/** 檢查是否允許寫入該物件;違反時丟出 GuardViolationError */
export function assertWriteAllowed(cfg: AppConfig, objectUrl: string): void {
  // 第一道:唯讀/prod(正常情況下寫入工具不會註冊,此為縱深防禦)
  if (cfg.safety.readonly) {
    throw new GuardViolationError(
      cfg.safety.systemRole === "prod"
        ? "此系統角色為 prod,所有寫入操作一律禁止。"
        : "目前為唯讀模式(ABAP_MCP_READONLY=true),禁止寫入操作。"
    );
  }

  // 第二道:物件名稱前綴白名單
  const name = objectNameFromUrl(objectUrl);
  const allowed = cfg.safety.allowedPrefixes;
  if (allowed.length > 0 && !allowed.some((p) => name.startsWith(p))) {
    throw new GuardViolationError(
      `物件 ${name} 不在允許寫入的前綴白名單內(目前允許:${allowed.join(", ")})。` +
        `若確實需要,請調整 ABAP_MCP_ALLOWED_PREFIXES 環境變數。`
    );
  }
}

/** package 名稱是否符合白名單項目(* 結尾為前綴比對,否則完全比對) */
export function packageMatches(packageName: string, pattern: string): boolean {
  const pkg = packageName.toUpperCase();
  const p = pattern.toUpperCase();
  return p.endsWith("*") ? pkg.startsWith(p.slice(0, -1)) : pkg === p;
}

/** 檢查物件所在 package 是否允許寫入/建立/執行;違反時丟出 GuardViolationError */
export function assertPackageAllowed(cfg: AppConfig, packageName: string): void {
  const allowed = cfg.safety.allowedPackages;
  if (allowed.length === 0) return;
  if (!packageName) {
    throw new GuardViolationError("無法判斷物件所在的 package,為安全起見拒絕操作。");
  }
  if (!allowed.some((p) => packageMatches(packageName, p))) {
    throw new GuardViolationError(
      `package ${packageName.toUpperCase()} 不在允許的 package 白名單內(目前允許:${allowed.join(", ")})。` +
        `若確實需要,請調整 ABAP_MCP_ALLOWED_PACKAGES 環境變數。`
    );
  }
}
