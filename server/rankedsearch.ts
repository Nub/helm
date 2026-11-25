import { all, get, now } from './db.ts';
import type { Row } from './db.ts';

// The ranked half of search.ts's searchItems: a query over the full-text index (searchschema.ts, built by
// searchindex.ts). search.ts decides when to use it (index ready, the project's setting on) and falls back to word
// matching when this returns null.
//
// Matching. Every word must match (in any column of one indexed row: an item's own text, one thread message, one
// final report). Words match their other forms (the porter tokenizer: "searches" finds "searching"); the last word,
// while typing, also matches as a prefix; "words in quotes" match as a phrase; punctuation inside a word joins its
// parts as a phrase ("node:sqlite" is "node sqlite"). Every piece is quoted for FTS, so nothing a user types is FTS
// syntax: no query reaches the user as an error, and any error that still happens falls back to word matching.
//
// Ranking. bm25 with the title weighted 10, the text 2 and the rest (thread messages, final reports, tags, section path)
// 1; each item keeps its best row, previews and agents counted 0.6, journal entries 0.75 (KIND_WEIGHT), an agent
// found only by a final report half that again. FTS5's bm25 applies column weights inside its saturating term-frequency curve, so
// they alone barely lift a title match (about 1.4 times); an item whose title has every word is therefore counted 3
// times, one whose title has some of them 1.5 times. Then recent items are lifted (up to +50%, halving every 30
// days), and items within about 15% of each other count as tied: open or active before done, then the higher score,
// then newer.

export const MARK_OPEN = '';
export const MARK_CLOSE = '';

const WEIGHTS = '10.0, 2.0, 1.0';
/** Raw rows looked at, best first, before items are deduplicated and capped per kind. */
const ROW_LIMIT = 1500;
const MAX_PIECES = 8;

type Piece = { tokens: string[]; prefix: boolean };

/** The query's pieces: quoted phrases and words, each as the tokens FTS would make of it. */
function pieces(query: string): Piece[] {
  const out: Piece[] = [];
  const typing = !/\s$/.test(query);
  const re = /"([^"]*)("?)|([^\s"]+)/g;
  let m: RegExpExecArray | null;
  const found: { text: string; quoted: boolean; closed: boolean; end: number }[] = [];
  while ((m = re.exec(query))) found.push({ text: m[1] ?? m[3], quoted: m[1] !== undefined, closed: m[2] === '"', end: re.lastIndex });
  found.forEach((f, i) => {
    const tokens = f.text.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
    // As the word matching does: a lone letter is not a search word (inside quotes it is part of the phrase).
    if (!tokens.length || (!f.quoted && tokens.join('').length < 2)) return;
    const last = i === found.length - 1 && f.end === query.length;
    out.push({ tokens, prefix: last && typing && !(f.quoted && f.closed) });
  });
  return out.slice(0, MAX_PIECES);
}

/** Common English endings (and doubled consonants) a half-typed word may stop inside: "searchin", "runn", "configura". */
const ENDINGS = ['ing', 'ings', 'ed', 'es', 'ies', 'ation', 'ations', 'ment', 'ments', 'ness', 'ly', 'er', 'ers', 'al', 'ive', 'ize', 'ise', 'ful', 'able', 'ible', 'ity', 'ous'];
/** Shorter prefixes worth trying for a word being typed, since the index holds stems ("runn" cannot find "run"). */
export function typingStems(w: string): string[] {
  const out = new Set<string>();
  for (const end of ENDINGS) {
    for (let k = end.length; k >= 1; k--) {
      const part = end.slice(0, k);
      if (w.endsWith(part) && w.length - k >= 3) out.add(w.slice(0, -k));
    }
  }
  for (const s of [w, ...out]) if (s.length >= 4 && /([b-df-hj-np-tv-z])\1$/.test(s)) out.add(s.slice(0, -1));
  out.delete(w);
  return [...out];
}

const phrase = (tokens: string[]) => `"${tokens.join(' ')}"`;

/**
 * The roots a query's words are marked by in a hit's text: each word cut to its shortest likely stem (typingStems),
 * at least three letters. FTS5's highlight() would mark exactly, but it tokenizes each row again against the whole
 * match, and on a large index that cost more than the search itself; so the marking is done here: a word of the text
 * is marked when it starts with a root ("search" marks "searching" and "searches").
 */
export function markRoots(query: string): string[] {
  const out = new Set<string>();
  for (const p of pieces(`${query} `)) for (const t of p.tokens) out.add([t, ...typingStems(t)].filter((s) => s.length >= 3).sort((a, b) => a.length - b.length)[0] ?? t);
  return [...out];
}
/** `text` with MARK_OPEN/MARK_CLOSE around each word starting with one of `roots`. */
export function markText(text: string, roots: string[]): string {
  if (!roots.length || !text) return text ?? '';
  return text.replace(/[\p{L}\p{N}\p{M}]+/gu, (w) => (roots.some((r) => w.toLowerCase().startsWith(r)) ? `${MARK_OPEN}${w}${MARK_CLOSE}` : w));
}

/** The FTS5 expression every item must match, and one matching any piece in the title (to mark the title). */
export function buildMatch(query: string): { all: string; any: string; inTitle: string; count: number } | null {
  const ps = pieces(query);
  if (!ps.length) return null;
  const exprs = ps.map((p) => {
    if (!p.prefix) return phrase(p.tokens);
    if (p.tokens.length > 1) return `${phrase(p.tokens)}*`;
    return `(${[p.tokens[0], ...typingStems(p.tokens[0])].map((t) => `"${t}"*`).join(' OR ')})`;
  });
  return { all: exprs.join(' AND '), any: `title : (${exprs.join(' OR ')})`, inTitle: `title : (${exprs.join(' AND ')})`, count: ps.length };
}

/**
 * How much a match of each kind counts. bm25 favours short texts, and previews (a title and a caption) and journal
 * lines are the shortest, so without this they crowd the work items out of a mixed list (the find tool's). An agent
 * comes after the task or discussion it works on, which matches the same words, and a chat message after both (what was
 * said usually ended up in one); matched only by one of its final
 * reports it counts less again (FINAL_REPORT_WEIGHT), so an agent tops a list only when its name matches.
 */
const KIND_WEIGHT: Record<string, number> = { preview: 0.6, journal: 0.75, agent: 0.6, chat: 0.5 };
const FINAL_REPORT_WEIGHT = 0.5;
const CLOSED = new Set(['done', 'dropped', 'settled', 'closed', 'fixed', 'dismissed', 'duplicate']);
const DAY = 86_400_000;

export type RankedHit = {
  kind: 'task' | 'discussion' | 'doc' | 'chat' | 'preview' | 'report' | 'agent' | 'journal' | 'knowledge' | 'dashboard';
  id: string;
  project_id: string;
  ref: string;
  title: string;
  state: string;
  ts: number;
  /** The matched row's text, marks taken out. */
  text: string;
  /** The title and the matched text with MARK_OPEN/MARK_CLOSE around what matched. */
  hl: { title: string; text: string };
  inTitle: number;
  score: number;
};

const ids = (list: unknown[]) => JSON.stringify(list);

/** Each item's own fields, for the hits that survive the filters of word matching (archived requests, kinds). */
function itemRows(kind: string, list: string[]): Row[] {
  const j = ids(list);
  const IN = 'IN (SELECT value FROM json_each(?))';
  switch (kind) {
    case 'task':
      return all(`SELECT id, project_id, kind, title, state, updated_at AS ts FROM tasks WHERE id ${IN} AND requests_agent_id IS NULL AND inbox_archive = 0`, j);
    case 'doc':
      return all(`SELECT id, project_id, title, status AS state, updated_at AS ts FROM docs WHERE id ${IN}`, j);
    case 'preview':
      return all(`SELECT id, project_id, title, kind AS state, created_at AS ts FROM previews WHERE id ${IN}`, j);
    case 'report':
      return all(`SELECT id, project_id, title, status AS state, updated_at AS ts FROM reports WHERE id ${IN}`, j);
    case 'knowledge':
      return all(`SELECT id, project_id, title, topic AS state, updated_at AS ts FROM knowledge_notes WHERE id ${IN}`, j);
    case 'dashboard':
      // Dashboards and their tiles share the kind; a tile's state names its dashboard.
      return all(
        `SELECT id, project_id, title, CASE state WHEN 'ready' THEN 'dashboard' ELSE 'being built' END AS state, updated_at AS ts FROM dashboards WHERE id ${IN}
         UNION ALL SELECT t.id, t.project_id, t.title, 'tile on ' || d.title AS state, t.updated_at AS ts FROM tiles t JOIN dashboards d ON d.id = t.dashboard_id WHERE t.id ${IN}`,
        j, j,
      );
    case 'agent':
      return all(`SELECT id, project_id, name AS title, status AS state, updated_at AS ts FROM agents WHERE id ${IN}`, j);
    case 'chat':
      // A message the director filed into a discussion shows there, once (the discussion's thread message is indexed).
      return all(
        `SELECT CAST(e.id AS TEXT) AS id, e.project_id, CASE e.kind WHEN 'inbound' THEN 'You' ELSE a.name END AS title, 'chat' AS state, e.ts
         FROM events e JOIN agents a ON a.id = e.agent_id WHERE e.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM task_messages m WHERE m.event_id = e.id)`,
        j,
      );
    case 'journal':
      return all(`SELECT CAST(id AS TEXT) AS id, project_id, title, kind AS state, ts, task_id, doc_id FROM journal WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))`, j);
  }
  return [];
}

const strip = (s: string) => s.replace(/[]/g, '');

/**
 * Ranked hits, best first, at most `cap` of each kind; null when the index cannot answer (an FTS error), so the caller
 * uses word matching instead. `projectId` null: every project not archived (or every project, with `archived`).
 */
export function rankedItems(projectId: string | null, query: string, opts: { kind?: string; cap: number; archived?: boolean; mark?: number }): RankedHit[] | null {
  const m = buildMatch(query);
  if (!m) return [];
  try {
    const scope = projectId ? 'AND r.project_id = ?' : opts.archived ? '' : 'AND r.project_id IN (SELECT id FROM projects WHERE archived = 0)';
    const kindOf = opts.kind === 'discussion' ? 'task' : opts.kind;
    const rows = all(
      `SELECT r.id AS rid, r.src, r.kind, r.item, bm25(search_fts, ${WEIGHTS}) AS bm FROM search_fts JOIN search_rows r ON r.id = search_fts.rowid
       WHERE search_fts MATCH ? ${scope} ${kindOf ? 'AND r.kind = ?' : ''} ORDER BY bm LIMIT ${ROW_LIMIT}`,
      m.all, ...(projectId ? [projectId] : []), ...(kindOf ? [kindOf] : []),
    );
    // Items whose title has every word, or some of them.
    const titled = (expr: string) =>
      new Set(all(`SELECT r.kind, r.item FROM search_fts JOIN search_rows r ON r.id = search_fts.rowid WHERE search_fts MATCH ? ${scope}`, expr, ...(projectId ? [projectId] : [])).map((r) => `${r.kind}:${r.item}`));
    const allInTitle = titled(m.inTitle);
    const someInTitle = m.count > 1 ? titled(m.any) : allInTitle;
    // Each item's best row.
    const best = new Map<string, Row>();
    for (const r of rows) if (!best.has(`${r.kind}:${r.item}`)) best.set(`${r.kind}:${r.item}`, r);
    const byKind = new Map<string, string[]>();
    for (const r of best.values()) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.item]);
    const t = now();
    const hits: (RankedHit & { rid: number; tier: number })[] = [];
    for (const [kind, list] of byKind) {
      for (const it of itemRows(kind, list)) {
        const k = (kind === 'task' ? (it.kind === 'discussion' ? 'discussion' : 'task') : kind) as RankedHit['kind'];
        if (opts.kind && opts.kind !== k) continue;
        const r = best.get(`${kind}:${it.id}`)!;
        const age = Math.max(0, t - Number(it.ts)) / DAY;
        const inTitle = allInTitle.has(`${kind}:${it.id}`) ? 2 : someInTitle.has(`${kind}:${it.id}`) ? 1 : 0;
        const score = -Number(r.bm) * (KIND_WEIGHT[kind] ?? 1) * (r.src === 'ev' ? FINAL_REPORT_WEIGHT : 1) * [1, 1.5, 3][inTitle] * (1 + 0.5 * 2 ** (-age / 30));
        const ref = kind === 'journal' ? it.task_id || it.doc_id || 'page:history' : kind === 'knowledge' ? 'page:knowledge' : kind === 'dashboard' ? 'page:dashboards' : kind === 'chat' ? '' : it.id;
        hits.push({ kind: k, id: String(it.id), project_id: it.project_id, ref: ref ? `[[${ref}]]` : '', title: it.title, state: it.state, ts: Number(it.ts), text: '', hl: { title: it.title, text: '' }, inTitle, score, rid: r.rid, tier: 0 });
      }
    }
    // About 15% apart is a different tier; within one, open before done.
    for (const h of hits) h.tier = h.score > 0 ? Math.floor(Math.log(h.score) / Math.log(1.15)) : -1e9;
    hits.sort((a, b) => b.tier - a.tier || Number(CLOSED.has(a.state)) - Number(CLOSED.has(b.state)) || b.score - a.score || b.ts - a.ts);
    const count = new Map<string, number>();
    const kept = hits.filter((h) => {
      const n = count.get(h.kind) ?? 0;
      count.set(h.kind, n + 1);
      return n < opts.cap;
    });
    if (!kept.length) return [];
    // The matched text, marked, from the matched row: only for the hits that will be shown (`mark` per kind, best
    // first); the rest keep their title and no text. Rows are read by rowid (no MATCH), so this does not grow with
    // the index.
    const markCount = new Map<string, number>();
    const toMark = kept.filter((h) => {
      const n = markCount.get(h.kind) ?? 0;
      markCount.set(h.kind, n + 1);
      return n < (opts.mark ?? opts.cap);
    });
    const roots = markRoots(query);
    const marked = new Map<number, Row>();
    for (const r of all(`SELECT rowid AS rid, title, body, more FROM search_fts WHERE rowid IN (SELECT value FROM json_each(?))`, ids(toMark.map((h) => h.rid)))) {
      const t = markText(String(r.title ?? ''), roots);
      marked.set(r.rid, { rid: r.rid, title: t.includes(MARK_OPEN) ? t : '', body: markText(String(r.body ?? ''), roots), more: markText(String(r.more ?? ''), roots) });
    }
    // An item found by a thread message or a final report: its title marked wherever any piece is in it, from its own row.
    const own = new Map<string, string>();
    const bySub = new Map<string, unknown[]>();
    for (const h of toMark) {
      const src = h.kind === 'discussion' ? 'task' : h.kind;
      if (marked.get(h.rid)?.title) continue;
      bySub.set(src, [...(bySub.get(src) ?? []), src === 'journal' || src === 'chat' ? Number(h.id) : h.id]);
    }
    for (const [src, list] of bySub) {
      for (const r of all(
        `SELECT r.item, search_fts.title FROM search_rows r JOIN search_fts ON search_fts.rowid = r.id
         WHERE r.src = ? AND r.src_id IN (SELECT value FROM json_each(?))`,
        src, ids(list),
      )) {
        const t = markText(String(r.title ?? ''), roots);
        if (t.includes(MARK_OPEN)) own.set(`${src}:${r.item}`, t);
      }
    }
    return kept.map(({ rid, tier: _tier, ...h }) => {
      const row = marked.get(rid);
      // A view's NULL column (a chat message with no text) comes back NULL from highlight().
      const rb = String(row?.body ?? '');
      const rm = String(row?.more ?? '');
      const body: string = !row ? '' : rb.includes(MARK_OPEN) || !rm.includes(MARK_OPEN) ? rb : rm;
      const title = row?.title || own.get(`${h.kind === 'discussion' ? 'task' : h.kind}:${h.id}`) || h.title;
      return { ...h, text: `${h.title}\n${strip(body)}`, hl: { title, text: body } };
    });
  } catch (err) {
    console.error('Ranked search failed, using word matching:', (err as Error).message);
    return null;
  }
}

/**
 * The one line under a title, from marked text: the line with the most marks, cut to about `width` characters around
 * the first, markdown marks taken out, every mark closed. With no mark, the first line.
 */
export function markedLine(text: string, width = 140): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[#>*_`]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let best = '';
  let most = 0;
  for (const l of lines) {
    const n = l.split(MARK_OPEN).length - 1;
    if (n > most) [best, most] = [l, n];
  }
  if (!best) {
    const first = lines[0] ?? '';
    return first.length > width ? `${first.slice(0, width)}…` : first;
  }
  const at = best.indexOf(MARK_OPEN);
  // Start a little before the first mark, at the start of a word.
  let start = Math.max(0, at - 16);
  if (start > 0) {
    const space = best.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  let s = best.slice(start, start + width);
  // A cut inside a marked word: reopen at the start, close at the end.
  const firstOpen = s.indexOf(MARK_OPEN);
  const firstClose = s.indexOf(MARK_CLOSE);
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) s = MARK_OPEN + s;
  if (s.lastIndexOf(MARK_OPEN) > s.lastIndexOf(MARK_CLOSE)) s += MARK_CLOSE;
  return `${start > 0 ? '…' : ''}${s.trim()}${start + width < best.length ? '…' : ''}`;
}

/** Whether the index has a row for this item (tests). */
export const indexed = (kind: string, item: string) => !!get('SELECT 1 AS x FROM search_rows WHERE kind = ? AND item = ?', kind, item);

/** For plain-text output: the text on one line, cut to about `width` characters starting a little before the first mark. */
export function markedExcerpt(text: string, width = 160, lead = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = Math.max(0, flat.indexOf(MARK_OPEN));
  const start = Math.max(0, at - lead);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width).trim()}${start + width < flat.length ? '…' : ''}`;
}

// ---------- related to a text (knowledge for an agent's task, related past work) ----------

/** Words that say nothing about what a task is about. */
const STOP = new Set(
  ('the and for with that this from into when what which while where will would should could have has had are was were not but '
    + 'its it\'s their there then than them they you your our out all any each every one two can may must also only just more most '
    + 'make made does done doing use used using new old now how why who via per about after before over under same other such '
    + 'task tasks work agent agents helm user users should done look looks like need needs want wants get gets set sets '
    + 'shown show shows give gives given take takes keep keeps line lines one ones see sees'
  ).split(/\s+/),
);

/** The words of a text worth searching for its relatives: three letters or more, no stop words, first ones first. */
export function relevanceTerms(text: string, max = 32): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export type Related = { kind: string; item: string; score: number };

/**
 * The items of `kinds` most related to `text`: any of its words (relevanceTerms) over the index, ranked by bm25 (the
 * title weighted as in search), each item by its best row, best first. Null when the index cannot answer (an FTS
 * error); the caller decides whether the index is ready.
 */
export function relatedItems(projectId: string, text: string, opts: { kinds: string[]; limit: number }): Related[] | null {
  const terms = relevanceTerms(text);
  if (!terms.length || !opts.kinds.length) return [];
  try {
    // bm25 cannot be aggregated: rows best first, each item kept at its best row here.
    const rows = all(
      `SELECT r.kind, r.item, bm25(search_fts, ${WEIGHTS}) AS bm FROM search_fts JOIN search_rows r ON r.id = search_fts.rowid
       WHERE search_fts MATCH ? AND r.project_id = ? AND r.kind IN (SELECT value FROM json_each(?)) ORDER BY bm LIMIT ${ROW_LIMIT}`,
      terms.map((t) => `"${t}"`).join(' OR '), projectId, ids(opts.kinds),
    );
    const best = new Map<string, Related>();
    for (const r of rows) {
      const key = `${r.kind}:${r.item}`;
      if (!best.has(key)) best.set(key, { kind: String(r.kind), item: String(r.item), score: -Number(r.bm) });
      if (best.size >= opts.limit) break;
    }
    return [...best.values()];
  } catch (err) {
    console.error('Related search failed:', (err as Error).message);
    return null;
  }
}
