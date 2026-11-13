/**
 * tools/probeFile.ts — 探針定義存檔(v0.6)
 *
 * probe_set / probe_logs 的 save_as 會把「探針定義與發現」寫到 <probes 目錄>/<名稱>.json,
 * 累積成「標準程式探針參考」(哪個程式、哪一行、看哪些變數值得觀察)。
 *
 * 只存位置、變數名稱、命中次數與結論,**不存任何變數值**(避免把業務資料寫進檔案)。
 * 名稱只接受英數字、底線、連字號,檔案一律落在 probes 目錄內。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GuardViolationError } from "../safety/guards.js";
import type { ProbeRunRecord } from "./probeTools.js";

export const PROBE_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const MAX_TEXT = 2000;

export interface ProbeFileMeta {
  purpose?: string;
  conclusion?: string;
  /** 例如 A4H、ABAP Platform 2025;沒給就用系統主機與 client */
  systemVersion?: string;
}

export interface ProbeFileSystem {
  host: string;
  client: string;
}

function clip(s: string | undefined): string | undefined {
  if (s === undefined || !s.trim()) return undefined;
  return s.trim().slice(0, MAX_TEXT);
}

/** 紀錄 → 檔案內容(不含任何命中的變數值) */
export function buildProbeFile(name: string, r: ProbeRunRecord, meta: ProbeFileMeta, system: ProbeFileSystem, now = new Date()) {
  return {
    name,
    savedAt: now.toISOString(),
    purpose: clip(meta.purpose),
    conclusion: clip(meta.conclusion),
    system: { host: system.host, client: system.client, version: clip(meta.systemVersion) },
    mode: r.mode === "dlp" ? "A" : "B",
    mode_name: r.mode === "dlp" ? "Dynamic Logpoints" : "Debugger snapshot",
    run: { id: r.id, startedAt: r.createdAt, status: r.status, trigger: r.trigger },
    hit_count: r.probes.reduce((a, p) => a + p.hits.length, 0),
    // 可直接餵回 probe_set 的 definition。注意:condition 是探針條件的原文,若寫了字面值(例如 kunnr = '0000100023')也會存進來(審查 #5)
    definition: {
      probes: r.probes.map((p) => ({
        object_url: p.sourceUrl,
        line: p.line,
        kind: p.kind,
        fields: p.fields,
        condition: p.condition,
        max_hits: p.maxHits,
      })),
      trigger: r.triggerInput,
    },
    probes: r.probes.map((p) => ({ id: p.id, location: p.location, kind: p.kind, fields: p.fields, condition: p.condition, hit_count: p.hits.length, error: p.error })),
  };
}

export function probeFilePath(dir: string, name: string): string {
  if (!PROBE_FILE_NAME_RE.test(name)) throw new GuardViolationError("save_as 只接受英數字、底線、連字號(最長 60 字元,不含副檔名與路徑)。");
  const root = path.resolve(dir);
  const file = path.resolve(root, `${name}.json`);
  if (path.dirname(file) !== root) throw new GuardViolationError("save_as 不可含路徑。");
  return file;
}

/** 寫檔(覆蓋同名檔);回傳實際路徑 */
export function writeProbeFile(dir: string, name: string, content: unknown): string {
  const file = probeFilePath(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + "\n", "utf8");
  return file;
}
