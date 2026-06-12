/**
 * workflows/lockedWrite.ts — 鎖定寫入工作流程(本專案核心)
 *
 * 設計理念:不把 lock / setObjectSource / unlock 個別暴露給 AI,
 * 而是封裝成單一原子操作,理由:
 *  1. AI 在多步驟協定中可能中途出錯,留下殘留鎖定(SM12 才能清)
 *  2. lockHandle 在多輪對話中傳遞容易出錯
 *  3. try/finally 保證:無論寫入成功與否,鎖定一定被釋放
 *
 * 流程:
 *  (0) 樂觀並行檢查:比對呼叫端提供的 base source(若有)
 *  (1) lock(stateful session)
 *  (2) setObjectSource(帶 lockHandle + transport)
 *  (3) finally → unLock
 *  (4) 可選:activate
 */
import type { AdtService } from "../adt/client.js";

export interface LockedWriteParams {
  /** 物件 URI(不含 /source/main),例如 /sap/bc/adt/oo/classes/zcl_demo */
  objectUrl: string;
  /** source URI,例如 /sap/bc/adt/oo/classes/zcl_demo/source/main */
  sourceUrl: string;
  /** 完整的新原始碼 */
  newSource: string;
  /** transport request 編號(本機物件可省略) */
  transport?: string;
  /**
   * 呼叫端先前讀到的原始碼(樂觀並行控制)。
   * 提供時會在寫入前重新讀取並比對,若已被他人修改則中止,
   * 避免蓋掉別人的變更。
   */
  expectedCurrentSource?: string;
}

export interface LockedWriteResult {
  success: boolean;
  /** 寫入前的舊原始碼(供 audit 摘要與 AI 確認) */
  previousSource: string;
}

export class ConcurrentModificationError extends Error {
  constructor() {
    super(
      "寫入中止:物件的目前內容與你先前讀取的版本不一致,可能已被其他人修改。" +
        "請重新 read_source 取得最新內容後再修改。"
    );
    this.name = "ConcurrentModificationError";
  }
}

/** 執行鎖定寫入;丟出例外表示失敗(鎖定保證已釋放) */
export async function lockedWrite(
  adt: AdtService,
  params: LockedWriteParams
): Promise<LockedWriteResult> {
  // (0) 樂觀並行檢查
  const currentSource = await adt.getObjectSource(params.sourceUrl);
  if (
    params.expectedCurrentSource !== undefined &&
    normalize(currentSource) !== normalize(params.expectedCurrentSource)
  ) {
    throw new ConcurrentModificationError();
  }

  // (1) 鎖定
  const lock = await adt.lock(params.objectUrl);
  const lockHandle = lock.LOCK_HANDLE;

  try {
    // (2) 寫入
    await adt.setObjectSource(
      params.sourceUrl,
      params.newSource,
      lockHandle,
      params.transport
    );
    return { success: true, previousSource: currentSource };
  } finally {
    // (3) 無論成敗,保證釋放鎖定
    try {
      await adt.unLock(params.objectUrl, lockHandle);
    } catch (unlockErr) {
      // 解鎖失敗只記到 stderr(stdout 是 MCP channel),
      // 不掩蓋原始錯誤;殘留鎖定會隨 session timeout 自動釋放
      console.error(
        `[abap-adt-mcp] 警告:解鎖失敗(${params.objectUrl}),` +
          `鎖定將於 session 逾時後自動釋放。原因:${String(unlockErr)}`
      );
    }
  }
}

/** 行尾差異(CRLF vs LF)不應視為內容變更 */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").trimEnd();
}
