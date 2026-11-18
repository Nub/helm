/**
 * Request text as the user reads it on a phone. Agents often write a to-do as one paragraph with the steps numbered
 * inline ("try these: (1) Open a preview. (2) Open the chat. ..."), which shows as a dense run-on block. These pure
 * functions turn such an inline enumeration into a lead sentence and a markdown numbered list, one item per line, and
 * leave everything else alone: text that mentions "(1)" once, version numbers like "2.5", and markdown that already has
 * its lists on their own lines. Table test: reqformat.test.ts.
 */

/** The three inline numbering styles: "(1) …", "1) …" and "1. …". */
const STYLES: ((n: number) => RegExp)[] = [
  (n) => new RegExp(`(^|\\s)\\(${n}\\)\\s+`, 'g'),
  // Not "(1)": the character before the number is whitespace or the start.
  (n) => new RegExp(`(^|\\s)${n}\\)\\s+`, 'g'),
  // A full stop after the number, then a space: never "2.5". The number starts the paragraph or follows punctuation
  // ("these: 1. …", "… close. 2. …"), so "in 2025. 3 things" or "page 2. Then" do not count.
  (n) => new RegExp(`(^|[:;.!?,]\\s+)${n}\\.\\s+`, 'g'),
];

/** A line that is already a markdown list item, a heading, a quote or a code fence. */
const BLOCK_LINE = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|~~~)/m;

export type Enumeration = { lead: string; items: string[] };

/**
 * Split one paragraph written with an inline enumeration of two or more items numbered from 1, or null when it has
 * none. Lead is the text before the first item (possibly empty); items are in order, trimmed, without their numbers.
 */
export function splitEnumeration(paragraph: string): Enumeration | null {
  const text = paragraph.trim();
  if (!text || text.includes('\n')) return null;
  let best: { starts: number[]; ends: number[] } | null = null;
  for (const style of STYLES) {
    // Find 1, then 2 after it, then 3 after that, … as far as the chain goes.
    const starts: number[] = [];
    const ends: number[] = [];
    let from = 0;
    for (let n = 1; ; n++) {
      const re = style(n);
      re.lastIndex = from;
      const m = re.exec(text);
      if (!m) break;
      starts.push(m.index + m[1].length);
      ends.push(m.index + m[0].length);
      from = m.index + m[0].length;
    }
    if (starts.length >= 2 && (!best || starts.length > best.starts.length)) best = { starts, ends };
  }
  if (!best) return null;
  const items = best.starts.map((_, i) =>
    text
      .slice(best!.ends[i], i + 1 < best!.starts.length ? best!.starts[i + 1] : undefined)
      .trim()
      // The joins between items: "a; 2) b", "a, and 2) b", "a and (2) b".
      .replace(/\s*(?:[;,]\s*)?(?:\band\b|\bor\b)?\s*[;,]?$/i, '')
      .trim(),
  );
  if (items.some((s) => !s)) return null;
  return { lead: text.slice(0, best.starts[0]).trim(), items };
}

/** The markdown form: the lead, a blank line, then the items as a numbered list. */
export const enumerationMarkdown = (e: Enumeration) => `${e.lead ? `${e.lead}\n\n` : ''}${listMarkdown(e.items)}`;
export const listMarkdown = (items: string[]) => items.map((s, i) => `${i + 1}. ${s}`).join('\n');

/**
 * Rewrite every paragraph of `text` that holds an inline enumeration as a lead and a numbered list. Text that already
 * uses markdown blocks (lists on their own lines, headings, quotes, code fences) is returned unchanged.
 */
export function formatRequestText(text: string): string {
  if (!text || BLOCK_LINE.test(text)) return text;
  return text
    .split(/(\n\s*\n)/)
    .map((p) => {
      const e = /\n\s*\n/.test(p) ? null : splitEnumeration(p);
      return e ? enumerationMarkdown(e) : p;
    })
    .join('');
}

/**
 * A to-do's text split for its two fields: the steps go in `steps`, the rest stays in the body. Only when the text is
 * one paragraph whose enumeration is the whole of what follows the lead, and there are no steps yet; otherwise the body
 * is formatted in place (formatRequestText) and the steps kept as given (formatted too).
 */
export function splitAction(body: string, steps: string): { body: string; steps: string } {
  const b = body.trim();
  if (!steps.trim() && !BLOCK_LINE.test(b) && !/\n\s*\n/.test(b)) {
    const e = splitEnumeration(b);
    if (e?.lead) return { body: e.lead, steps: listMarkdown(e.items) };
  }
  return { body: formatRequestText(body), steps: formatRequestText(steps) };
}
