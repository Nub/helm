import { all } from './db.ts';
import { MAX_DEPTH, PATH_SEP, pathText, resolveSection, sectionTree, splitPath } from './sections.ts';
import type { Tree } from './sections.ts';

/**
 * Size limits on what agents write into the Spec, so it stays easy to digest: a summary is one sentence, an entry's
 * text a handful of points, a section a handful of entries before it splits into sub-sections (and no sub-sections
 * before then). set_doc, propose_doc_edit, propose_spec_entries and set_section refuse over-limit text with the limit
 * in the reason. The user's own edits (the web API) never pass through here.
 */
export const LIMITS = { summaryWords: 30, bodyItems: 8, sectionEntries: 8 };

/** The limits as agents are told them, for tool descriptions and the prompt. */
export const LIMITS_RULE = `A summary is one sentence of at most ${LIMITS.summaryWords} words; an entry's text at most ${LIMITS.bodyItems} bullets or paragraphs; a section holds at most ${LIMITS.sectionEntries} entries without sub-sections, and gets sub-sections only once it holds ${LIMITS.sectionEntries}.`;

const words = (s: string) => s.replace(/`[^`]*`/g, 'code').split(/\s+/).filter(Boolean).length;

const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|cf|approx|no|mr|mrs|dr|st)|\b[A-Z])$/i;
/** Sentences in a short text: ends (. ! ?) followed by a space and a capital or digit, not after a common abbreviation. */
export function sentences(s: string): number {
  const t = s.replace(/`[^`]*`/g, 'code').trim();
  if (!t) return 0;
  let n = 1;
  for (const m of t.matchAll(/([.!?])["')\]]?\s+(?=["'(\[]?[A-Z0-9])/g)) {
    const before = t.slice(0, m.index!);
    if (m[1] === '.' && ABBREV.test(before)) continue;
    n++;
  }
  return n;
}

/** Why an agent's summary is too long, or null. */
export function summaryError(summary: string, what = 'The summary'): string | null {
  const w = words(summary);
  const n = sentences(summary);
  if (n > 1) return `${what} is ${n} sentences; a summary is one sentence (at most ${LIMITS.summaryWords} words) saying what must be true. Put the rest in the entry's text. Nothing was changed.`;
  if (w > LIMITS.summaryWords) return `${what} is ${w} words; a summary is one sentence of at most ${LIMITS.summaryWords} words. Nothing was changed.`;
  return null;
}

/**
 * The points in an entry's text: each list item, each paragraph (a run of other lines), each code block and table.
 * Headings and blank lines are not counted; an indented line under a list item belongs to that item.
 */
export function bodyItems(body: string): number {
  let n = 0;
  let prev: 'none' | 'item' | 'para' | 'table' = 'none';
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence) n++;
      fence = !fence;
      prev = 'none';
      continue;
    }
    if (fence) continue;
    if (!line.trim()) {
      prev = 'none';
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      prev = 'none';
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      n++;
      prev = 'item';
    } else if (/^\s*\|/.test(line)) {
      if (prev !== 'table') n++;
      prev = 'table';
    } else if (prev === 'none') {
      n++;
      prev = 'para';
    }
    // Otherwise a continuation of the item, paragraph or table above.
  }
  return n;
}

/** Why an agent's entry text is too long, or null. */
export function bodyError(body: string, what = "The entry's text"): string | null {
  const n = bodyItems(body);
  return n > LIMITS.bodyItems ? `${what} has ${n} bullets or paragraphs; an entry's text has at most ${LIMITS.bodyItems}. Cut it to the points that matter, or split the entry in two. Nothing was changed.` : null;
}

/** Entries to be put in a section (by name, path or id): `count` of them, or the existing entry `docId` moving there. */
export type Placement = { ref: string; count: number; docId?: string };

const lc = (s: string) => s.trim().toLowerCase();

/**
 * Why putting these entries in these sections (creating missing levels of their paths) would break the section
 * limits, or null: a section without sub-sections holds at most LIMITS.sectionEntries, and a section gets a new
 * sub-section only when it holds (with everything beneath it, the placements included) at least that many. Ambiguous
 * or too-deep paths are left to the call that creates them. An entry already in the section it is placed in is no
 * change and is not checked.
 */
export function placementError(projectId: string, placements: Placement[], t: Tree = sectionTree(projectId)): string | null {
  const max = LIMITS.sectionEntries;
  const moving = placements.map((p) => p.docId).filter((x): x is string => !!x);
  const direct = new Map<string, number>();
  for (const r of all(
    `SELECT section_id, COUNT(*) AS n FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design') AND section_id IS NOT NULL AND id NOT IN (${moving.map(() => '?').join(',') || "''"}) GROUP BY section_id`,
    projectId,
    ...moving,
  ))
    direct.set(String(r.section_id), Number(r.n));
  const docSection = new Map(moving.map((id) => [id, all('SELECT section_id FROM docs WHERE id = ?', id)[0]?.section_id ?? null]));
  // The tree as it would be: existing sections by id, new ones by "new:" and their lowercased path.
  const kids = new Map<string, Set<string>>();
  for (const s of t.list) if (s.parent_id && t.byId.has(s.parent_id)) kids.set(s.parent_id, new Set([...(kids.get(s.parent_id) ?? []), s.id]));
  const fresh = new Map<string, { parent: string | null; label: string }>();
  const label = (key: string) => (fresh.has(key) ? fresh.get(key)!.label : pathText(t, key));
  const targets = new Set<string>();
  for (const p of placements) {
    if (!p.ref.trim()) continue;
    let end: string;
    const found = resolveSection(projectId, p.ref, t);
    if ('section' in found) {
      end = found.section.id;
      if (p.docId && docSection.get(p.docId) === end) continue;
    } else {
      if (!found.missing) continue;
      const segs = splitPath(p.ref);
      let base: string | null = null;
      let rest = segs;
      for (let i = segs.length - 1; i >= 1; i--) {
        const r = resolveSection(projectId, segs.slice(0, i).join(PATH_SEP), t);
        if ('section' in r) {
          base = r.section.id;
          rest = segs.slice(i);
          break;
        }
      }
      const baseNames = base ? pathText(t, base).split(PATH_SEP) : [];
      if (baseNames.length + rest.length > MAX_DEPTH || !rest.length) continue;
      let parent = base;
      let names = baseNames;
      for (const name of rest) {
        names = [...names, name];
        const key = `new:${names.map(lc).join('/')}`;
        if (!fresh.has(key)) fresh.set(key, { parent, label: names.join(PATH_SEP) });
        if (parent) kids.set(parent, new Set([...(kids.get(parent) ?? []), key]));
        parent = key;
      }
      end = parent!;
    }
    direct.set(end, (direct.get(end) ?? 0) + p.count);
    if (p.count > 0) targets.add(end);
  }
  const total = (key: string): number => (direct.get(key) ?? 0) + [...(kids.get(key) ?? [])].reduce((a, k) => a + total(k), 0);
  const many = (n: number) => `${n} entr${n === 1 ? 'y' : 'ies'}`;
  for (const [key, f] of fresh) {
    if (!f.parent) continue;
    const n = total(f.parent);
    if (n < max)
      return `"${label(f.parent)}" would hold ${many(n)}; a section gets sub-sections only once it holds ${max}. Put it in "${label(f.parent)}" itself, not in a new "${label(key)}". Nothing was changed.`;
  }
  for (const key of targets) {
    const n = direct.get(key) ?? 0;
    if (n > max && !(kids.get(key)?.size ?? 0))
      return `"${label(key)}" would hold ${many(n)}; a section without sub-sections holds at most ${max}. Split it into sub-sections first (set_section, then move entries into them), or use another section. Nothing was changed.`;
  }
  return null;
}
