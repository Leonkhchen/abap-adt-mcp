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
 *  (0) 樂觀並行檢查:比對呼叫端提供的 base source(若有)——鎖定前的快速檢查,避免不必要的鎖定
 *  (1) lock(stateful session);鎖定後(寫入前)在同一個 session 再讀一次、再比對(v0.5.1 C1,
 *      權威檢查:擋住「第一次讀取之後、取得鎖定之前」被別人改動的情況);
 *      寫入 class 測試 include 而它尚未存在時,在鎖定中先建立
 *  (2) setObjectSource(帶 lockHandle + transport)
 *  (3) finally → unLock
 *  (4) 可選:activate
 */
import type { AdtService } from "../adt/client.js";
import { isTestClassesInclude } from "../adt/objectTypes.js";
import { objectNameFromUrl } from "../safety/guards.js";

/**
 * 讀取原始碼失敗是否代表「尚未建立」。
 * A4H 實測:讀取不存在的測試 include 回「…CCAU does not have any inactive version」
 */
function isMissingSource(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  const msg = e instanceof Error ? e.message : String(e);
  return status === 404 || /does not have any inactive version|does not exist|not found/i.test(msg);
}

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
  // (0) 樂觀並行檢查;class 的測試 include 尚未建立時視為空內容,鎖定後再建立
  let currentSource: string;
  let createTestInclude = false;
  try {
    currentSource = await adt.getObjectSource(params.sourceUrl);
  } catch (e) {
    if (!isTestClassesInclude(params.sourceUrl) || !isMissingSource(e)) throw e;
    currentSource = "";
    createTestInclude = true;
  }
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
    // (1b) 鎖定後再比對一次(C1):此刻起別人無法再改,這份才是寫入的真正基準
    if (params.expectedCurrentSource !== undefined || createTestInclude) {
      let locked: string | undefined;
      try {
        locked = await adt.getSourceInLock(params.sourceUrl);
      } catch (e) {
        // 測試 include 仍不存在:照原計畫在鎖定中建立;其他錯誤照丟
        if (!(createTestInclude && isMissingSource(e))) throw e;
      }
      if (locked !== undefined) {
        // 讀得到內容 → 要寫的 include 已經存在(讀取到鎖定之間被別人建立),不能再建立
        createTestInclude = false;
        if (
          params.expectedCurrentSource !== undefined &&
          normalize(locked) !== normalize(params.expectedCurrentSource)
        ) {
          throw new ConcurrentModificationError();
        }
        currentSource = locked;
      }
    }
    if (createTestInclude) {
      await adt.createTestInclude(objectNameFromUrl(params.objectUrl), lockHandle, params.transport);
    }
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

/**
 * class 的測試 include 尚未存在時先建立(空的,內容只有 SAP 的註解範本)。
 * 有建立時回傳建立後讀到的範本內容(C2:呼叫端以它作為後續並行比對的基準,
 * 才不會把自己剛建立的範本誤判成他人修改);沒有建立回傳 undefined。
 * A4H 實測:include 不存在時語法檢查只回警告、不會檢查內容;建立後才能在寫入前正確擋下語法錯誤。
 */
export async function ensureTestInclude(
  adt: AdtService,
  objectUrl: string,
  sourceUrl: string,
  transport?: string,
  expectedCurrentSource?: string
): Promise<string | undefined> {
  if (!isTestClassesInclude(sourceUrl)) return undefined;
  try {
    await adt.getObjectSource(sourceUrl);
    return undefined;
  } catch (e) {
    if (!isMissingSource(e)) throw e;
  }
  // 並行檢查先於建立:呼叫端以為已有內容、系統上卻不存在 → 已被他人改動,什麼都不建立
  if (expectedCurrentSource !== undefined && normalize(expectedCurrentSource) !== "") {
    throw new ConcurrentModificationError();
  }
  const lock = await adt.lock(objectUrl);
  try {
    await adt.createTestInclude(objectNameFromUrl(objectUrl), lock.LOCK_HANDLE, transport);
  } finally {
    await adt.unLock(objectUrl, lock.LOCK_HANDLE);
  }
  return adt.getObjectSource(sourceUrl);
}

/** 內容只有空行與註解(* 或 " 開頭)→ 沒有實際程式碼,例如 SAP 建立 include 時產生的範本 */
export function isCommentOnly(s: string): boolean {
  return s.split(/\r?\n/).every((l) => l.trim() === "" || /^\s*[*"]/.test(l));
}

/** 行尾差異(CRLF vs LF)不應視為內容變更 */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").trimEnd();
}
