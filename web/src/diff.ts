/** Word-level diff for showing Spec edits. Same algorithm as diffTokens in server/spec.ts. */

export type Op = { op: '=' | '-' | '+'; text: string };

export function diffTokens(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  if (A.length * B.length > 4_000_000) {
    A.forEach((t) => mid.push({ op: '-', text: t }));
    B.forEach((t) => mid.push({ op: '+', text: t }));
  } else {
    const n = A.length;
    const m = B.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        mid.push({ op: '=', text: A[i] });
        i++;
        j++;
      } else if (i < n && (j === m || L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1])) mid.push({ op: '-', text: A[i++] });
      else mid.push({ op: '+', text: B[j++] });
    }
  }
  const ops: Op[] = [...a.slice(0, pre).map((t) => ({ op: '=' as const, text: t })), ...mid, ...a.slice(a.length - suf).map((t) => ({ op: '=' as const, text: t }))];
  const out: Op[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text += o.text;
    else out.push({ ...o });
  }
  return out;
}

export const words = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

/**
 * Easier to read: within a run of changes, unchanged spaces and very short
 * unchanged words are folded in, so the removed phrase shows whole and then
 * the added one, instead of alternating word by word.
 */
export function readable(ops: Op[]): Op[] {
  const out: Op[] = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out.push({ op: '-', text: del });
    if (ins) out.push({ op: '+', text: ins });
    del = ins = '';
  };
  ops.forEach((o, i) => {
    const inside = (del || ins) && i < ops.length - 1 && ops[i + 1].op !== '=';
    if (o.op === '=' && inside && (!o.text.trim() || o.text.trim().length <= 3)) {
      del += o.text;
      ins += o.text;
    } else if (o.op === '-') del += o.text;
    else if (o.op === '+') ins += o.text;
    else {
      flush();
      out.push(o);
    }
  });
  flush();
  return out;
}

/** The first sentence of a markdown body, for entries without a summary (mirrors firstSentence on the server). */
export function firstSentence(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/[*_`>#]|\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = text.match(/^(.{20,}?[.!?])(\s|$)/);
  const s = m ? m[1] : text;
  return s.length > 220 ? s.slice(0, 217).replace(/\s+\S*$/, '') + '…' : s;
}
