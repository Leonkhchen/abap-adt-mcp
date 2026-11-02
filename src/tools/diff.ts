/**
 * tools/diff.ts — 以行為單位的 unified diff(Myers 演算法,無外部相依)
 */

type Op = { kind: " " | "-" | "+"; text: string };

/** Myers O((N+M)D) 最短編輯路徑,回傳逐行的保留 / 刪除 / 新增 */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const off = max + 1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }
  // 由終點回溯
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: " ", text: a[x] });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", text: b[--y] });
      else ops.push({ kind: "-", text: a[--x] });
    }
  }
  return ops.reverse();
}

/**
 * unified diff(含 @@ 區塊標頭,前後各 context 行);沒有差異時回空字串。
 * 超過 maxLines 行時截斷並標註。
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  opts: { context?: number; maxLines?: number } = {}
): { text: string; added: number; removed: number; truncated: boolean } {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 500;
  const split = (s: string) => {
    const lines = s.replace(/\r\n/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };
  const ops = diffLines(split(oldText), split(newText));
  const added = ops.filter((o) => o.kind === "+").length;
  const removed = ops.filter((o) => o.kind === "-").length;
  if (added === 0 && removed === 0) return { text: "", added, removed, truncated: false };

  // 依變更位置切出區塊(相鄰的變更若間隔 ≤ 2*context 合併)
  const changed = ops.map((o, i) => (o.kind === " " ? -1 : i)).filter((i) => i >= 0);
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  // 每個 op 之前已經過的舊/新行數,用來寫 @@ -l,s +l,s @@
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldBefore.push(o);
    newBefore.push(nn);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") nn++;
  }
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const oldLen = slice.filter((x) => x.kind !== "+").length;
    const newLen = slice.filter((x) => x.kind !== "-").length;
    out.push(`@@ -${oldBefore[s] + 1},${oldLen} +${newBefore[s] + 1},${newLen} @@`);
    for (const x of slice) out.push(`${x.kind}${x.text}`);
  }
  const truncated = out.length > maxLines;
  const lines = truncated ? [...out.slice(0, maxLines), `…(已截斷,diff 共 ${out.length} 行,僅顯示前 ${maxLines} 行)`] : out;
  return { text: lines.join("\n"), added, removed, truncated };
}
