/**
 * eval/lib/args.ts — 評測執行器的參數解析(嚴格:未知選項直接報錯,避免誤觸真的評測)
 */
export const USAGE = `用法:npx tsx eval/run.ts [選項]
  --model <清單>        opus / sonnet / haiku,逗號分隔可多個(預設 sonnet);
                        也可寫 claude:<模型 ID>;codex: / gemini: 本版未實作
  --matrix              確認要跑多模型矩陣(--model 超過一個時必須加)
  --tasks <01,07,…>     只跑指定題目(預設全部)
  --dry-run             不呼叫模型:只驗證事前準備、判定與清除
  --timeout-min <分>    每題逾時(預設 20)
  --budget <USD>        每題費用上限(預設 3)
  --out <目錄>          結果目錄(預設 eval/results)
  --help                顯示說明後結束(不連 SAP、不呼叫模型)`;

const VALUE_OPTS = new Set(["model", "tasks", "timeout-min", "budget", "out"]);
const FLAG_OPTS = new Set(["dry-run", "help", "matrix"]);

/** 嚴格解析參數:未知選項或缺值一律報錯,不會「忽略後照跑」 */
export function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith("--") ? a.slice(2) : "";
    if (a === "-h" || name === "help") flags.add("help");
    else if (FLAG_OPTS.has(name)) flags.add(name);
    else if (VALUE_OPTS.has(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`選項 --${name} 需要一個值`);
      values.set(name, v);
    } else throw new Error(`未知的參數:${a}`);
  }
  for (const n of ["timeout-min", "budget"]) {
    const v = values.get(n);
    if (v !== undefined && !(Number(v) > 0)) throw new Error(`--${n} 必須是正數`);
  }
  return { flags, values };
}
