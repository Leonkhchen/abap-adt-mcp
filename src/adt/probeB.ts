/**
 * adt/probeB.ts — 除錯探針模式 B:Debugger 快照(v0.6)
 *
 * 原理:用 ADT 的 debugger API 自動化「設中斷點 → 停下 → 讀指定的變數與堆疊 → 立刻繼續執行」,
 * 不需要有人操作,也不依賴 Dynamic Logpoints(舊版系統也能用)。
 *
 * 本檔是純流程(引擎):所有對 SAP 的動作都經 `DebugPort` 介面,單元測試用假的 port 就能涵蓋
 * 命中、max_hits、逾時、觸發失敗、清除等流程,不需要連 SAP。真正的 port 見 debugPort.ts。
 *
 * 安全規則(寫死在引擎裡,不開放設定):
 *  - 一律自動繼續:不提供逐步執行,也不改變數值
 *  - 有總逾時;逾時、完成、失敗都走同一個 finally:刪中斷點、關閉監聽、讓停住的程式跑完或終止、登出 session
 *  - 每個探針收滿 max_hits 就刪掉自己的中斷點,避免程式一直停下來
 */

export interface ProbeSpec {
  /** 探針編號(報表與 probe_logs 用) */
  id: string;
  /** 要設中斷點的 source URI(已解析 include),例如 /sap/bc/adt/oo/classes/zcl_x/source/main */
  objectUrl: string;
  line: number;
  kind: "variables" | "stack";
  /** kind=variables 時要記錄的變數或運算式 */
  variables: string[];
  /** SAP 端的中斷點條件(條件成立才停) */
  condition?: string;
  maxHits: number;
}

export interface StackFrame {
  program: string;
  include: string;
  line: number;
  event: string;
}

export interface VariableValue {
  name: string;
  value: string;
  /** 結構、內表、物件參考等非單純值的種類 */
  meta?: string;
  note?: string;
}

export interface ProbeHit {
  n: number;
  at: string;
  /** 模式 A:這個 key 被執行了幾次 */
  calls?: number;
  variables?: VariableValue[];
  stack?: StackFrame[];
}

export interface ProbeState {
  spec: ProbeSpec;
  hits: ProbeHit[];
  /** SAP 回的中斷點編號(設定失敗時沒有) */
  bpId?: string;
  /** 中斷點設定失敗的原因 */
  error?: string;
  /** 已收滿 max_hits */
  full: boolean;
  /** SAP 上的中斷點已確認刪除(收滿 ≠ 已刪除;沒有確認就不可宣稱已移除) */
  bpDeleted?: boolean;
  /** 最後一次刪除失敗的原因 */
  bpDeleteError?: string;
}

export interface BreakpointRequest {
  /** 探針編號,當 clientId 用,SAP 回傳時帶回,用來對應 */
  clientId: string;
  uri: string;
  line: number;
  condition?: string;
}

export type BreakpointResult = { clientId: string; id: string } | { clientId: string; error: string };

/** 引擎對 SAP 的全部需求;真正的實作在 debugPort.ts */
export interface DebugPort {
  setBreakpoints(requests: BreakpointRequest[]): Promise<BreakpointResult[]>;
  deleteBreakpoint(id: string): Promise<void>;
  /** 開始監聽,直到有程式停在中斷點(回 debuggeeId)或監聽被取消(回 undefined);監聽衝突等錯誤丟例外 */
  listen(): Promise<{ debuggeeId: string } | undefined>;
  cancelListen(): Promise<void>;
  /** 接上停住的程式;回傳這次停下的中斷點(找不到對應時為空陣列) */
  attach(debuggeeId: string): Promise<{ reachedBreakpointIds: string[] }>;
  stack(): Promise<StackFrame[]>;
  /** 讀變數,結果與 names 一一對應(讀不到的給 note) */
  variables(names: string[]): Promise<VariableValue[]>;
  /** 繼續執行;回傳下一次停下的中斷點(同一次執行又碰到),或 ended=true 代表程式跑完 */
  continue(): Promise<{ reachedBreakpointIds: string[]; ended: boolean }>;
  /** 終止停住的程式(繼續失敗時的最後手段) */
  terminate(): Promise<void>;
  /** 登出所有 session(不丟例外) */
  close(): Promise<void>;
}

export interface EngineDeps {
  /** 暖機與寬限的短暫等待(單元測試可立即完成) */
  sleep(ms: number): Promise<void>;
  /** 總逾時計時器:ms 毫秒後完成(單元測試可控制「逾時」或「永不逾時」) */
  timer(ms: number): Promise<void>;
  now(): number;
  /** 清理階段單一請求的上限計時器(沒給就用真的計時器;單元測試可控制) */
  cleanupTimer?(ms: number): Promise<void>;
  /** 開始監聽後,等多久再觸發執行(讓 SAP 端先登記好監聽) */
  warmupMs: number;
}

export const realDeps: EngineDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  // unref:計時器不該讓 process 多活到逾時(結束時 shutdown 不用等它)
  timer: (ms) =>
    new Promise((r) => {
      setTimeout(r, ms).unref?.();
    }),
  now: () => Date.now(),
  warmupMs: 1500,
};

export type EngineStatus = "completed" | "all_full" | "timeout" | "trigger_failed" | "error";

export interface EngineResult {
  status: EngineStatus;
  probes: ProbeState[];
  /** 觸發執行的結果摘要(manual 時沒有) */
  triggerOutcome?: string;
  notes: string[];
}

export interface EngineInput {
  probes: ProbeSpec[];
  timeoutSeconds: number;
  /** 在監聽期間代為觸發執行並等結果;省略 = 手動觸發(由使用者自己在 SAP GUI 執行) */
  trigger?: () => Promise<string>;
  /** 引擎把「立刻中止並清除」的函式交給呼叫端登錄(process 被結束時 finally 跑不到,由 shutdown 呼叫;v0.6 審查 #1) */
  registerAbort?: (abort: () => Promise<void>) => void;
}

/** 單次停下最多處理幾次「繼續後又停」,避免異常時無限迴圈 */
const MAX_STOPS_PER_DEBUGGEE = 500;
/** 重新監聽的次數上限 */
const MAX_LISTENS = 200;
/** 堆疊最多記錄幾層 */
const MAX_STACK_FRAMES = 12;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const ZERO_HIT_NOTE =
  "命中 0 次。可能原因:程式沒有執行到該行、該行不是可執行的陳述式、條件從未成立," +
  "或程式在 update task / 背景 RFC / 背景作業中執行(一般 debugger 監聽不會在那裡停下來)。";

/** 清理時每個 ADT 請求最多等多久;整個清理階段的總上限(超過就不再重試刪除,仍會嘗試登出) */
const CLEANUP_STEP_MS = 8000;
const CLEANUP_TOTAL_MS = 30_000;
/** finally / abort 刪除中斷點最多試幾次(收滿當下另外試 1 次;持續失敗就在結果裡明確警告,不宣稱已移除) */
export const DELETE_ATTEMPTS = 3;

/** 停駐處理超過總逾時(或被 abort):handleStop 之後不可再對 port 發任何請求 */
class DeadlineError extends Error {
  constructor() {
    super("探針總逾時");
  }
}

const EXPIRED_NOTE = "處理停駐的程式時已超過總逾時,已停止收值並進入清理(讓程式繼續跑完或終止)。";

export async function runDebuggerProbes(port: DebugPort, input: EngineInput, deps: EngineDeps = realDeps): Promise<EngineResult> {
  const states: ProbeState[] = input.probes.map((spec) => ({ spec, hits: [], full: false }));
  const notes: string[] = [];
  let status: EngineStatus = "completed";
  let triggerOutcome: string | undefined;
  const deadline = deps.now() + input.timeoutSeconds * 1000;
  const stepTimer = deps.cleanupTimer ?? realDeps.timer;

  type ListenOutcome = { debuggee?: { debuggeeId: string }; error?: string };
  type TriggerOutcome = { ok: boolean; text: string };
  const startListen = (): Promise<ListenOutcome> =>
    port.listen().then(
      (debuggee) => ({ debuggee }),
      (e) => ({ error: errMsg(e) })
    );

  let listenP: Promise<ListenOutcome> | undefined;
  let triggerP: Promise<TriggerOutcome> | undefined;
  let attached = false;
  /** 逾時或被 abort 之後為 true:handleStop 不再使用 port,避免與清理競爭同一個 session */
  let halted = false;
  let cleanupStart = 0;
  const cleanupOver = () => deps.now() - cleanupStart > CLEANUP_TOTAL_MS;

  /** 清理用:單一請求有上限,逾時或失敗都不丟例外 */
  const step = <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    const p = Promise.resolve().then(fn);
    return Promise.race([
      p.then(
        (value) => ({ ok: true as const, value }),
        (e) => ({ ok: false as const, error: errMsg(e) })
      ),
      stepTimer(CLEANUP_STEP_MS).then(() => ({ ok: false as const, error: `逾時(${CLEANUP_STEP_MS / 1000} 秒)` })),
    ]);
  };

  /** 刪一個中斷點;成功才記為已刪除(收滿 ≠ 已刪除:SAP 上的中斷點要確認刪掉才算) */
  const tryDelete = async (s: ProbeState): Promise<boolean> => {
    if (!s.bpId || s.bpDeleted) return true;
    const r = await step(() => port.deleteBreakpoint(s.bpId!));
    if (r.ok) {
      s.bpDeleted = true;
      s.bpDeleteError = undefined;
      return true;
    }
    s.bpDeleteError = r.error;
    return false;
  };

  /** 重試刪除所有尚未確認刪除的中斷點(最多 DELETE_ATTEMPTS 輪) */
  const deleteAll = async (): Promise<void> => {
    for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt++) {
      const pending = states.filter((s) => s.bpId && !s.bpDeleted);
      if (pending.length === 0) return;
      if (attempt > 0) {
        if (cleanupOver()) return;
        await deps.sleep(200);
      }
      for (const s of pending) await tryDelete(s);
    }
  };

  /** 讓停住的程式繼續跑完;繼續失敗就終止 */
  const releaseDebuggee = async (): Promise<void> => {
    if (!attached) return;
    const c = await step(() => port.continue());
    if (!c.ok) await step(() => port.terminate());
    attached = false;
  };

  input.registerAbort?.(async () => {
    halted = true;
    cleanupStart = deps.now();
    await deleteAll();
    await step(() => port.cancelListen());
    await releaseDebuggee();
    await step(() => port.close());
  });

  const allDone = () => states.every((s) => s.full || s.error);

  /**
   * 處理一個停住的程式:attach → 讀值 → 自動繼續,直到跑完或不再停下。
   * 每個 ADT 請求都受剩餘期限約束:逾時就丟 DeadlineError、設 halted,之後不再碰 port(卡住的請求放著,清理另走獨立上限)。
   * 回傳 true = 因逾時中止(呼叫端要停止收值、進入清理)。
   */
  const handleStop = async (debuggeeId: string): Promise<boolean> => {
    const expired = deps.timer(Math.max(0, deadline - deps.now())).then(() => "expired" as const);
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (halted) throw new DeadlineError();
      const p = Promise.resolve().then(fn);
      p.catch(() => undefined); // 逾時後這個請求才失敗也不能變成 unhandled rejection
      const r = await Promise.race([p.then((v) => ({ v })), expired.then(() => undefined)]);
      if (halted || r === undefined) {
        halted = true;
        throw new DeadlineError();
      }
      return r.v;
    };
    try {
      attached = true; // 先當作已接上:attach 卡住逾時時,清理仍會嘗試繼續 / 終止
      let reached: string[];
      try {
        reached = (await call(() => port.attach(debuggeeId))).reachedBreakpointIds;
      } catch (e) {
        if (!(e instanceof DeadlineError)) attached = false;
        throw e;
      }
      for (let i = 0; i < MAX_STOPS_PER_DEBUGGEE; i++) {
        if (i > 0 && deps.now() >= deadline) throw new DeadlineError();
        const stack = await call(() => port.stack()).catch((e) => {
          if (e instanceof DeadlineError) throw e;
          return [] as StackFrame[];
        });
        const hitStates = reached.length
          ? states.filter((s) => s.bpId && reached.includes(s.bpId))
          : // SAP 沒告知中斷點編號時,退而用最上層堆疊的行號對應
            states.filter((s) => s.bpId && stack[0] && stack[0].line === s.spec.line);
        for (const s of hitStates) {
          if (s.full) continue;
          const hit: ProbeHit = { n: s.hits.length + 1, at: new Date(deps.now()).toISOString() };
          if (s.spec.kind === "stack") hit.stack = stack.slice(0, MAX_STACK_FRAMES);
          else {
            hit.variables = await call(() => port.variables(s.spec.variables)).catch((e) => {
              if (e instanceof DeadlineError) throw e;
              return s.spec.variables.map((name) => ({ name, value: "", note: `讀取失敗:${errMsg(e)}` }));
            });
          }
          s.hits.push(hit);
          if (s.hits.length >= s.spec.maxHits) {
            s.full = true;
            // 收滿就刪掉自己的中斷點,程式之後不再為它停下來;失敗不影響已收到的值,但會留給 finally 重試並在結果警告
            if (s.bpId) await tryDelete(s);
          }
        }
        const next = await call(() => port.continue());
        if (next.ended || next.reachedBreakpointIds.length === 0) {
          attached = false;
          return false;
        }
        reached = next.reachedBreakpointIds;
      }
      notes.push(`同一次執行停下超過 ${MAX_STOPS_PER_DEBUGGEE} 次,已強制結束處理。`);
      return false;
    } catch (e) {
      if (e instanceof DeadlineError) {
        halted = true;
        return true;
      }
      throw e;
    }
  };

  try {
    // 1. 設中斷點
    const requests: BreakpointRequest[] = states.map((s) => ({ clientId: s.spec.id, uri: s.spec.objectUrl, line: s.spec.line, condition: s.spec.condition }));
    const results = await port.setBreakpoints(requests);
    for (const s of states) {
      const r = results.find((x) => x.clientId === s.spec.id);
      if (!r) s.error = "SAP 沒有回報這個中斷點";
      else if ("error" in r) s.error = r.error;
      else s.bpId = r.id;
    }
    if (states.every((s) => s.error)) {
      status = "error";
      notes.push("所有中斷點都設定失敗(位置不存在、不可設中斷點,或沒有 debug 權限)。");
      return { status, probes: states, notes };
    }

    // 2. 開始監聽,再觸發執行
    listenP = startListen();
    await deps.sleep(deps.warmupMs);
    if (input.trigger) {
      triggerP = input.trigger().then(
        (text): TriggerOutcome => ({ ok: true, text }),
        (e): TriggerOutcome => ({ ok: false, text: errMsg(e) })
      );
    }

    // 3. 事件迴圈:停下 / 觸發完成 / 逾時
    for (let listens = 0; listens < MAX_LISTENS; listens++) {
      if (allDone()) {
        status = "all_full";
        break;
      }
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        status = "timeout";
        break;
      }
      const never = new Promise<never>(() => {});
      const winner = await Promise.race([
        listenP.then((r) => ({ t: "listen" as const, r })),
        triggerP ? triggerP.then((r) => ({ t: "trigger" as const, r })) : never,
        deps.timer(remaining).then(() => ({ t: "timeout" as const })),
      ]);
      if (winner.t === "timeout") {
        status = "timeout";
        break;
      }
      if (winner.t === "trigger") {
        triggerP = undefined;
        triggerOutcome = winner.r.text;
        if (!winner.r.ok) {
          status = "trigger_failed";
          notes.push(`觸發執行失敗:${winner.r.text}`);
          // 程式在斷點前就出錯也可能已經停過;看一眼有沒有等待處理的停駐
          const late = await Promise.race([listenP, deps.sleep(300).then(() => undefined)]);
          if (late?.debuggee) {
            const expired = await handleStop(late.debuggee.debuggeeId).catch((e) => {
              notes.push(`處理停駐時出錯:${errMsg(e)}`);
              return false;
            });
            if (expired) notes.push(EXPIRED_NOTE);
          }
          break;
        }
        // 觸發的程式已跑完;給監聽 300ms 看有沒有最後一個停駐還沒處理
        const late = await Promise.race([listenP, deps.sleep(300).then(() => undefined)]);
        if (late?.debuggee) {
          if (await handleStop(late.debuggee.debuggeeId)) {
            status = "timeout";
            notes.push(EXPIRED_NOTE);
            break;
          }
          listenP = startListen();
          continue;
        }
        status = "completed";
        break;
      }
      // winner.t === "listen"
      const r = winner.r;
      if (r.error) {
        status = "error";
        notes.push(`監聽失敗:${r.error}`);
        break;
      }
      if (!r.debuggee) {
        // 監聽結束但沒有程式停下(例如 SAP 端逾時):還有時間就重新監聽
        listenP = startListen();
        continue;
      }
      if (await handleStop(r.debuggee.debuggeeId)) {
        status = "timeout";
        notes.push(EXPIRED_NOTE);
        break;
      }
      listenP = allDone() ? undefined : startListen();
      if (!listenP) {
        status = "all_full";
        break;
      }
    }
    if (status === "completed" && !allDone() && deps.now() >= deadline) status = "timeout";
  } catch (e) {
    status = "error";
    notes.push(`探針執行中出錯:${errMsg(e)}`);
  } finally {
    // 4. 清除(不論成敗;每個請求與整體都有上限):刪中斷點(重試)→ 關閉監聽 → 讓停住的程式跑完或終止 → 等觸發結束 → 登出
    halted = true;
    cleanupStart = deps.now();
    await deleteAll();
    await step(() => port.cancelListen());
    if (listenP) {
      const late = await Promise.race([listenP, deps.sleep(3000).then(() => undefined)]);
      if (late?.debuggee && !attached) {
        // 取消監聽的同時剛好有程式停下:不讓它停在那裡
        const a = await step(() => port.attach(late.debuggee!.debuggeeId));
        if (a.ok) attached = true; // 接不上就交給 session 關閉
      }
    }
    await releaseDebuggee();
    if (triggerP) {
      const t = await Promise.race([triggerP, deps.sleep(8000).then(() => undefined)]);
      if (t) triggerOutcome ??= t.text;
      else notes.push("觸發的執行在清除時仍未結束(已放手,session 關閉後會終止)。");
    }
    await step(() => port.close());
  }

  // 中斷點沒有確認刪除就不可宣稱已移除:明確警告(外部中斷點在 SAP 上屬於使用者,關閉 session 不保證會消失)
  for (const s of states) {
    if (s.bpId && !s.bpDeleted) {
      notes.push(
        `⚠️ 探針 ${s.spec.id} 的中斷點(${s.bpId})沒有成功刪除${s.bpDeleteError ? `:${s.bpDeleteError}` : ""}。` +
          "請在 Eclipse 的 Breakpoints 視圖或 SAP GUI 清除,否則同帳號之後的執行仍會停在那裡。"
      );
    }
  }
  if (states.some((s) => s.bpId && s.hits.length === 0) && status !== "error") notes.push(ZERO_HIT_NOTE);
  return { status, probes: states, triggerOutcome, notes };
}
