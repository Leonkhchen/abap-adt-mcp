/**
 * tools/result.ts — MCP 工具回傳格式的小工具函式
 */
import { formatErrorForAi } from "../adt/errors.js";

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: formatErrorForAi(err) }],
  isError: true,
});

/** 文字超過上限時截斷並標註 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(已截斷,共 ${text.length} 字元,僅顯示前 ${max} 字元)` : text;
}
