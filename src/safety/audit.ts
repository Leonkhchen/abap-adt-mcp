/**
 * safety/audit.ts — 寫入操作稽核紀錄
 *
 * 所有寫入類操作(write_source / activate)都會留下一筆 JSON Lines 紀錄,
 * 內容包含:時間、操作、物件、transport、來源大小與 diff 摘要。
 * 注意:絕不記錄任何憑證;原始碼僅記錄統計資訊,不記錄完整內容。
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface AuditEntry {
  timestamp: string;
  action:
    | "write_source"
    | "activate"
    | "force_unlock"
    | "create_object"
    | "create_test_include"
    | "run_class"
    | "create_transport"
    | "data_preview"
    | "rap_generate";
  objectUrl: string;
  objectName: string;
  transport?: string;
  /** 變更摘要(行數統計),不含原始碼內容 */
  summary?: string;
  success: boolean;
  error?: string;
}

export class AuditLogger {
  constructor(private filePath: string) {}

  /** 是否啟用(路徑為空字串時停用) */
  get enabled(): boolean {
    return this.filePath.length > 0;
  }

  log(entry: AuditEntry): void {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // audit 失敗不應中斷主要操作,但寫到 stderr 提醒
      // (stdout 是 MCP stdio channel,絕不能污染!)
      console.error(`[abap-adt-mcp] 警告:audit log 寫入失敗(${this.filePath})`);
    }
  }
}

/** 產生變更摘要:舊/新行數與粗略差異統計(不含程式碼內容) */
export function diffSummary(oldSource: string, newSource: string): string {
  // SAP 回傳的原始碼是 CRLF、AI 送來的多半是 LF:不先統一,每一行都會被當成不同
  const oldLines = oldSource.replace(/\r\n/g, "\n").split("\n");
  const newLines = newSource.replace(/\r\n/g, "\n").split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let added = 0;
  let removed = 0;
  for (const l of newLines) if (!oldSet.has(l)) added++;
  for (const l of oldLines) if (!newSet.has(l)) removed++;
  return `行數 ${oldLines.length} → ${newLines.length}(約 +${added} / -${removed})`;
}
