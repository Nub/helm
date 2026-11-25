import { Marked } from 'marked';
import type { Tokens } from 'marked';

// Which markdown tables can be drawn as a chart, and the chart they make. Pure (no DOM, no React), so
// web/test/plottable.test.ts runs it under Node. A table is plottable when it has one label column and one or more
// numeric columns, or when every column is numeric and the first one is an ordered x (a step or time column).
// The chart spec has the shape the chart renderer in ui.tsx reads.

export type PlotSpec = { type: 'line' | 'bar'; labels: string[]; series: { name: string; values: number[] }[]; unit?: string };
/** A plottable table: its chart, the table's markdown, and the text around it. */
export type Plottable = { spec: PlotSpec; table: string; before: string; after: string };

const lexer = new Marked({ gfm: true });

/** Cell text without inline markdown. */
const plain = (s: string) => s.replace(/[*_`~]/g, '').trim();
const EMPTY = /^(|-|—|–|n\/a|na|none|null)$/i;

/** A cell as a number and its unit suffix ("12.5%" → 12.5, "%"; "1,200 ms" → 1200, "ms"; "$3" → 3, "$"), else null. */
export function parseNumber(cell: string): { value: number; unit: string } | null {
  const m = /^([$€£¥])?\s*([-+−]?)\s*([$€£¥])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+(?:e[+-]?\d+)?)\s*(%|[a-zµ/°]{1,5})?$/i.exec(plain(cell));
  if (!m) return null;
  const value = Number(m[4].replace(/,/g, '')) * (m[2] === '-' || m[2] === '−' ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { value, unit: m[5] ?? m[1] ?? m[3] ?? '' };
}

/** A column of cells as numbers (gaps NaN), or null when any filled cell is not a number or fewer than two are. */
function numeric(cells: string[]): { values: number[]; units: Set<string> } | null {
  const values: number[] = [];
  const units = new Set<string>();
  for (const c of cells) {
    if (EMPTY.test(plain(c))) {
      values.push(NaN);
      continue;
    }
    const n = parseNumber(c);
    if (!n) return null;
    values.push(n.value);
    units.add(n.unit);
  }
  return values.filter(Number.isFinite).length >= 2 ? { values, units } : null;
}

const ORDERED_HEAD = /^(time|date|day|week|month|year|hour|minute|second|step|steps|epoch|iter|iteration|round|run|version|commit|build|t|n|x|size|#)\b/i;
const DATE = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}:\d{2}(:\d{2})?$/;
const increasing = (v: number[]) => v.every((x, i) => i === 0 || x > v[i - 1]);

/** The chart for one table (header cells, rows of cells), or null when it is not plottable. */
export function tableChart(header: string[], rows: string[][]): PlotSpec | null {
  if (rows.length < 2 || header.length < 2) return null;
  const col = (k: number) => rows.map((r) => r[k] ?? '');
  const cols = header.map((_, k) => numeric(col(k)));
  const first = cols[0];
  let labels: string[];
  let ordered: boolean;
  if (first) {
    // Every column numeric: the first is x only when it climbs, like a step or a time.
    if (!increasing(first.values)) return null;
    labels = col(0).map(plain);
    ordered = true;
  } else {
    labels = col(0).map(plain);
    ordered = ORDERED_HEAD.test(plain(header[0])) || labels.every((l) => DATE.test(l));
  }
  const rest = cols.slice(1);
  if (!rest.length || rest.some((c) => !c)) return null;
  const units = new Set(rest.flatMap((c) => [...c!.units]));
  const unit = units.size === 1 ? [...units][0] : '';
  return {
    type: ordered ? 'line' : 'bar',
    labels,
    series: rest.map((c, k) => ({ name: plain(header[k + 1]), values: c!.values })),
    ...(unit ? { unit } : {}),
  };
}

/** The first plottable table in a markdown text, with its chart and the text before and after it. */
export function findPlottable(text: string | null | undefined): Plottable | null {
  if (!text || !text.includes('|')) return null;
  let tokens;
  try {
    tokens = lexer.lexer(text);
  } catch {
    return null;
  }
  for (const t of tokens) {
    if (t.type !== 'table') continue;
    const tb = t as Tokens.Table;
    const spec = tableChart(
      tb.header.map((h) => h.text),
      tb.rows.map((r) => r.map((c) => c.text)),
    );
    if (!spec) continue;
    const at = text.indexOf(tb.raw);
    return { spec, table: tb.raw, before: at < 0 ? '' : text.slice(0, at), after: at < 0 ? '' : text.slice(at + tb.raw.length) };
  }
  return null;
}

/** A short first line of a text for a card: the first line that is not the title again, without markdown marks. */
export function firstLine(text: string | null | undefined, title = '', max = 120): string {
  const t = title.trim().toLowerCase();
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/[*_`~|]/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    if (!line || /^[-:\s]+$/.test(line) || line.toLowerCase() === t) continue;
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
  }
  return '';
}
