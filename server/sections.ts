import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';

/**
 * The Spec's sections form a tree, at most MAX_DEPTH levels deep (e.g. Combat › Weapons › Ranged). Entries are the
 * leaves and may sit in a section at any level. A section's `parent_id` is its parent section (null at the top);
 * `position` orders it among its siblings. Names are unique among siblings only, so a section is named by its id,
 * by its path ("Combat / Weapons / Ranged", or the end of one, "Weapons / Ranged"), or by its bare name when that
 * name is used once in the project. Moving sections or entries is organisation, not a change of meaning: nothing
 * here touches an entry's content, so no move ever opens a planning task (see saveDoc in spec.ts).
 */

export const MAX_DEPTH = 3;
/** How a path is written for agents. Splitting accepts "/", "›" and ">". */
export const PATH_SEP = ' / ';

export type Tree = { byId: Map<string, Row>; kids: Map<string | null, Row[]>; list: Row[] };

export function listSections(projectId: string): Row[] {
  return all('SELECT * FROM doc_sections WHERE project_id = ? ORDER BY position, created_at', projectId);
}

export function sectionTree(projectId: string): Tree {
  const list = listSections(projectId);
  const byId = new Map(list.map((s) => [s.id, s]));
  const kids = new Map<string | null, Row[]>();
  for (const s of list) {
    // A parent that is gone (it never should be) reads as the top level, so nothing is ever unreachable.
    const p = s.parent_id && byId.has(s.parent_id) ? s.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  return { byId, kids, list };
}

const parentOf = (t: Tree, s: Row): string | null => (s.parent_id && t.byId.has(s.parent_id) ? s.parent_id : null);

/** The names from the top level down to this section. Stops on a cycle rather than looping. */
export function pathNames(t: Tree, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = t.byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.name);
    const p = parentOf(t, cur);
    cur = p ? t.byId.get(p) : undefined;
  }
  return out;
}

export const pathText = (t: Tree, id: string) => pathNames(t, id).join(PATH_SEP);

/** 1 for a top-level section. */
export const depthOf = (t: Tree, id: string) => pathNames(t, id).length;

/** How many levels a section and everything beneath it span: 1 for a section without subsections. */
export function heightOf(t: Tree, id: string): number {
  return 1 + Math.max(0, ...(t.kids.get(id) ?? []).map((k) => heightOf(t, k.id)));
}

/** The section and every section beneath it. */
export function subtreeIds(t: Tree, id: string): string[] {
  return [id, ...(t.kids.get(id) ?? []).flatMap((k) => subtreeIds(t, k.id))];
}

/** The sections of a project in reading order (depth first), each with its depth. */
export function walkTree(t: Tree, parent: string | null = null, depth = 1): { s: Row; depth: number }[] {
  return (t.kids.get(parent) ?? []).flatMap((s) => [{ s, depth }, ...walkTree(t, s.id, depth + 1)]);
}

export function splitPath(ref: string): string[] {
  return ref
    .split(/\s*(?:\/|›|>)\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const lc = (s: string) => s.trim().toLowerCase();

/**
 * A section by id, bare name or path. A bare name used by one section names it; used by several, it is ambiguous
 * and the error lists their paths. A path matches a section whose path is it (from the top) or ends with it.
 */
export function resolveSection(projectId: string, ref: string, tree?: Tree): { section: Row } | { error: string; missing: boolean } {
  const t = tree ?? sectionTree(projectId);
  const r = ref.trim();
  if (!r) return { error: 'Name a section.', missing: true };
  const byId = t.byId.get(r);
  if (byId) return { section: byId };
  const ambiguous = (list: Row[]) => ({
    error: `"${r}" matches ${list.length} sections: ${list.map((s) => pathText(t, s.id)).join('; ')}. Give its path (e.g. "${pathText(t, list[0].id)}") or its id.`,
    missing: false,
  });
  const named = t.list.filter((s) => lc(s.name) === lc(r));
  if (named.length === 1) return { section: named[0] };
  if (named.length > 1) return ambiguous(named);
  const segs = splitPath(r).map(lc);
  if (segs.length > 1) {
    const ends = t.list.filter((s) => {
      const p = pathNames(t, s.id).map(lc);
      return p.length >= segs.length && segs.every((x, i) => p[p.length - segs.length + i] === x);
    });
    const full = ends.filter((s) => depthOf(t, s.id) === segs.length);
    if (full.length === 1) return { section: full[0] };
    if (ends.length === 1) return { section: ends[0] };
    if (ends.length > 1) return ambiguous(ends);
  }
  return { error: `No section "${r}".`, missing: true };
}

/** A section by id, name or path, or undefined when there is none or the name is ambiguous. */
export function findSection(projectId: string, ref: string): Row | undefined {
  const r = resolveSection(projectId, ref);
  return 'section' in r ? r.section : undefined;
}

/** A sibling (same parent) with this name, other than `exceptId`. */
export function siblingNamed(projectId: string, parentId: string | null, name: string, exceptId?: string): Row | undefined {
  return all('SELECT * FROM doc_sections WHERE project_id = ? AND parent_id IS ? AND id IS NOT ?', projectId, parentId, exceptId ?? null).find((s) => lc(s.name) === lc(name));
}

/** Insert a section without checks (see addSection), last among its siblings. */
export function createSection(projectId: string, name: string, description = '', parentId: string | null = null): Row {
  const id = newId('sec');
  const position = Number(get('SELECT MAX(position) AS p FROM doc_sections WHERE project_id = ? AND parent_id IS ?', projectId, parentId)?.p ?? 0) + 1;
  run(
    'INSERT INTO doc_sections (id, project_id, parent_id, name, description, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, projectId, parentId, name.trim(), description.trim(), position, now(), now(),
  );
  return get('SELECT * FROM doc_sections WHERE id = ?', id)!;
}

/** Why a section called `name` cannot go under `parentId` (null: the top level), or null. */
function placeError(projectId: string, t: Tree, parentId: string | null, name: string, height: number, selfId?: string): string | null {
  if (parentId) {
    const parent = t.byId.get(parentId);
    if (!parent || parent.project_id !== projectId) return 'No such parent section on this project.';
    if (selfId && subtreeIds(t, selfId).includes(parentId))
      return parentId === selfId ? 'A section cannot go inside itself.' : `"${parent.name}" is inside "${t.byId.get(selfId)!.name}", so "${t.byId.get(selfId)!.name}" cannot go inside it.`;
    const depth = depthOf(t, parentId) + height;
    if (depth > MAX_DEPTH)
      return `That would make the Spec ${depth} levels deep (${[...pathNames(t, parentId), name, ...(height > 1 ? ['…'] : [])].join(' › ')}); at most ${MAX_DEPTH}.`;
  }
  const clash = siblingNamed(projectId, parentId, name, selfId);
  if (clash) return `There is already a section "${clash.name}" ${parentId ? `in ${pathText(t, parentId)}` : 'at the top level'}.`;
  return null;
}

/** Create a section under a parent (null: the top level), refusing a sibling of the same name or a fourth level. */
export function addSection(projectId: string, name: string, description = '', parentId: string | null = null): { section: Row } | { error: string } {
  const n = name.trim();
  if (!n) return { error: 'Give the section a name.' };
  const err = placeError(projectId, sectionTree(projectId), parentId, n, 1);
  if (err) return { error: err };
  const section = createSection(projectId, n, description, parentId);
  touchProject(projectId);
  return { section };
}

/**
 * The section a path names, creating any missing levels beneath the deepest one that exists: "Combat / Weapons /
 * Ranged" creates Weapons and Ranged when only Combat exists. A bare unknown name is a new top-level section.
 */
export function ensureSectionPath(projectId: string, ref: string): { id: string; created: string[] } | { error: string } {
  const t = sectionTree(projectId);
  const found = resolveSection(projectId, ref, t);
  if ('section' in found) return { id: found.section.id, created: [] };
  if (!found.missing) return { error: found.error };
  const segs = splitPath(ref);
  if (!segs.length) return { error: 'Name a section.' };
  let base: Row | null = null;
  let rest = segs;
  for (let i = segs.length - 1; i >= 1; i--) {
    const r = resolveSection(projectId, segs.slice(0, i).join(PATH_SEP), t);
    if ('section' in r) {
      base = r.section;
      rest = segs.slice(i);
      break;
    }
    if (!r.missing) return { error: r.error };
  }
  const depth = (base ? depthOf(t, base.id) : 0) + rest.length;
  if (depth > MAX_DEPTH) return { error: `"${segs.join(PATH_SEP)}" would be ${depth} levels deep; the Spec has at most ${MAX_DEPTH}. Use an existing section or a shorter path.` };
  const created: string[] = [];
  let parent = base?.id ?? null;
  tx(() => {
    for (const name of rest) {
      const s = createSection(projectId, name, '', parent);
      created.push(s.id);
      parent = s.id;
    }
  });
  touchProject(projectId);
  return { id: parent!, created };
}

/** Section id for a name or path, creating what is missing. Throws when the path is ambiguous or too deep. */
export function sectionIdFor(projectId: string, ref: string): string {
  const r = ensureSectionPath(projectId, ref);
  if ('error' in r) throw new Error(r.error);
  return r.id;
}

export function updateSection(section: Row, input: { name?: string; description?: string }): { error: string } | { ok: true } {
  const name = input.name?.trim() || section.name;
  if (lc(name) !== lc(section.name)) {
    const clash = siblingNamed(section.project_id, section.parent_id ?? null, name, section.id);
    if (clash) return { error: `There is already a section "${clash.name}" next to it.` };
  }
  run('UPDATE doc_sections SET name = ?, description = ?, updated_at = ? WHERE id = ?', name, input.description !== undefined ? input.description.trim() : section.description, now(), section.id);
  touchProject(section.project_id);
  return { ok: true };
}

/** Rewrite the positions of one set of siblings in this order. */
function renumber(list: Row[]) {
  list.forEach((s, i) => run('UPDATE doc_sections SET position = ? WHERE id = ?', i + 1, s.id));
}

/**
 * Move a section (with everything in it) under another (`parentId`; null for the top level; undefined to stay where
 * it is) and/or to a 1-based place among its new siblings (last when not given and the parent changes). Refuses a
 * cycle, a fourth level, and a sibling of the same name.
 */
export function placeSection(section: Row, parentId: string | null | undefined, place?: number): { error: string } | { ok: true } {
  const pid = section.project_id;
  const t = sectionTree(pid);
  const cur = parentOf(t, section);
  const target = parentId === undefined ? cur : parentId || null;
  if (target !== cur) {
    const err = placeError(pid, t, target, section.name, heightOf(t, section.id), section.id);
    if (err) return { error: err };
  }
  const siblings = (t.kids.get(target) ?? []).filter((s) => s.id !== section.id);
  const at = place ? Math.max(0, Math.min(siblings.length, place - 1)) : target === cur ? (t.kids.get(cur) ?? []).findIndex((s) => s.id === section.id) : siblings.length;
  siblings.splice(at < 0 ? siblings.length : at, 0, section);
  tx(() => {
    if (target !== cur) run('UPDATE doc_sections SET parent_id = ?, updated_at = ? WHERE id = ?', target, now(), section.id);
    renumber(siblings);
    if (target !== cur) renumber((t.kids.get(cur) ?? []).filter((s) => s.id !== section.id));
  });
  touchProject(pid);
  return { ok: true };
}

/** Put a section at a 1-based place among its siblings. */
export function moveSection(section: Row, place: number) {
  placeSection(section, undefined, place);
}

/** Reorder sections: those given come first in this order, among their own siblings. */
export function setSectionOrder(projectId: string, ids: string[]) {
  const list = listSections(projectId);
  const ordered = [...ids.map((id) => list.find((s) => s.id === id)).filter(Boolean), ...list.filter((s) => !ids.includes(s.id))] as Row[];
  tx(() => renumber(ordered));
  touchProject(projectId);
}

/**
 * Remove a section. Its entries and its subsections move up to its parent (the top level for a top-level section),
 * the subsections taking its place in the order. A subsection whose name its new siblings already use is renamed
 * "Name (Removed section)". Returns those renames.
 */
export function deleteSection(section: Row): { renamed: { from: string; to: string }[] } {
  const pid = section.project_id;
  const t = sectionTree(pid);
  const parent = parentOf(t, section);
  const kids = t.kids.get(section.id) ?? [];
  const siblings = (t.kids.get(parent) ?? []).filter((s) => s.id !== section.id);
  const at = (t.kids.get(parent) ?? []).findIndex((s) => s.id === section.id);
  const renamed: { from: string; to: string }[] = [];
  tx(() => {
    run('UPDATE docs SET section_id = ? WHERE section_id = ?', parent, section.id);
    const taken = new Set(siblings.map((s) => lc(s.name)));
    for (const k of kids) {
      let name = k.name;
      for (let n = 1; taken.has(lc(name)); n++) name = `${k.name} (${section.name}${n > 1 ? ` ${n}` : ''})`;
      taken.add(lc(name));
      if (name !== k.name) renamed.push({ from: k.name, to: name });
      run('UPDATE doc_sections SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?', parent, name, now(), k.id);
    }
    run('DELETE FROM doc_sections WHERE id = ?', section.id);
    siblings.splice(Math.max(0, at), 0, ...kids);
    renumber(siblings);
  });
  touchProject(pid);
  return { renamed };
}

/** How many entries sit directly in each section, and in it and everything beneath it. */
export function entryCounts(projectId: string, t: Tree = sectionTree(projectId)): { direct: Map<string, number>; total: Map<string, number> } {
  const direct = new Map<string, number>();
  for (const r of all("SELECT section_id, COUNT(*) AS n FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design') AND section_id IS NOT NULL GROUP BY section_id", projectId)) direct.set(r.section_id, Number(r.n));
  const total = new Map<string, number>();
  const sum = (id: string): number => {
    const n = (direct.get(id) ?? 0) + (t.kids.get(id) ?? []).reduce((a, k) => a + sum(k.id), 0);
    total.set(id, n);
    return n;
  };
  for (const s of t.kids.get(null) ?? []) sum(s.id);
  return { direct, total };
}

/** The section tree as an indented outline for agents: path, entry count (all beneath it), description. */
export function renderOutline(projectId: string): string {
  const t = sectionTree(projectId);
  if (!t.list.length) return '(no sections)';
  const { total } = entryCounts(projectId, t);
  return walkTree(t)
    .map(({ s, depth }) => `${'  '.repeat(depth - 1)}- ${pathText(t, s.id)} (${total.get(s.id) ?? 0} entr${total.get(s.id) === 1 ? 'y' : 'ies'})${s.description ? ` — ${s.description}` : ''}`)
    .join('\n');
}
