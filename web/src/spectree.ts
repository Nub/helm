import type { Doc, DocSection } from './api';

/**
 * The Spec's sections as a tree, the client's mirror of server/sections.ts: at most MAX_DEPTH levels, names unique
 * among siblings, entries in a section at any level. The server checks every move again; these let the page grey out
 * the moves it would refuse and say why.
 */

export const MAX_DEPTH = 3;

export type SecNode = { sec: DocSection; depth: number; kids: SecNode[]; entries: Doc[]; total: number; flagged: number };

export type SecTree = {
  roots: SecNode[];
  byId: Map<string, SecNode>;
  /** Every section in reading order (depth first). */
  order: SecNode[];
};

const parentOf = (byId: Map<string, DocSection>, s: DocSection) => (s.parent_id && byId.has(s.parent_id) ? s.parent_id : null);

export function buildTree(sections: DocSection[], docs: Doc[], sortEntries: (a: Doc, b: Doc) => number): SecTree {
  const secs = new Map(sections.map((s) => [s.id, s]));
  const byId = new Map<string, SecNode>();
  for (const s of sections) byId.set(s.id, { sec: s, depth: 1, kids: [], entries: [], total: 0, flagged: 0 });
  const roots: SecNode[] = [];
  // Sections arrive in position order, so children are added in their sibling order.
  for (const s of sections) {
    const p = parentOf(secs, s);
    (p ? byId.get(p)!.kids : roots).push(byId.get(s.id)!);
  }
  for (const d of docs) if (d.section_id && byId.has(d.section_id)) byId.get(d.section_id)!.entries.push(d);
  const order: SecNode[] = [];
  const seen = new Set<string>();
  const walk = (n: SecNode, depth: number): [number, number] => {
    if (seen.has(n.sec.id)) return [0, 0];
    seen.add(n.sec.id);
    n.depth = depth;
    n.entries.sort(sortEntries);
    order.push(n);
    let total = n.entries.length;
    let flagged = n.entries.filter((d) => d.spec_state).length;
    for (const k of n.kids) {
      const [t, f] = walk(k, depth + 1);
      total += t;
      flagged += f;
    }
    n.total = total;
    n.flagged = flagged;
    return [total, flagged];
  };
  for (const r of roots) walk(r, 1);
  return { roots, byId, order };
}

/** The section and its ancestors' names, top first. */
export function pathNames(t: SecTree, id: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let n = id ? t.byId.get(id) : undefined;
  while (n && !seen.has(n.sec.id)) {
    seen.add(n.sec.id);
    out.unshift(n.sec.name);
    n = n.sec.parent_id ? t.byId.get(n.sec.parent_id) : undefined;
  }
  return out;
}

export const ancestors = (t: SecTree, id: string): string[] => {
  const out: string[] = [];
  let n = t.byId.get(id);
  while (n?.sec.parent_id && t.byId.has(n.sec.parent_id) && !out.includes(n.sec.parent_id)) {
    out.push(n.sec.parent_id);
    n = t.byId.get(n.sec.parent_id);
  }
  return out;
};

export function subtree(n: SecNode): string[] {
  return [n.sec.id, ...n.kids.flatMap(subtree)];
}

export function heightOf(n: SecNode): number {
  return 1 + Math.max(0, ...n.kids.map(heightOf));
}

/** Why a section cannot go under `parentId` (null: the top level), or null when it can. */
export function sectionMoveError(t: SecTree, id: string, parentId: string | null): string | null {
  const n = t.byId.get(id);
  if (!n) return 'That section is gone.';
  if ((n.sec.parent_id ?? null) === parentId) return 'It is already there.';
  if (parentId) {
    if (subtree(n).includes(parentId)) return parentId === id ? 'It cannot go inside itself.' : 'It cannot go inside its own subsection.';
    const p = t.byId.get(parentId);
    if (!p) return 'That section is gone.';
    if (p.depth + heightOf(n) > MAX_DEPTH) return `That would make ${p.depth + heightOf(n)} levels; at most ${MAX_DEPTH}.`;
  }
  const siblings = parentId ? t.byId.get(parentId)!.kids : t.roots;
  if (siblings.some((k) => k.sec.id !== id && k.sec.name.toLowerCase() === n.sec.name.toLowerCase())) return `There is already a “${n.sec.name}” there.`;
  return null;
}
