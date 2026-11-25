import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { addTaskMessage, findTask, getTask, moveTask, taskRef } from './tasks.ts';
import type { Author } from './tasks.ts';
import { setWaits } from './waits.ts';
import { createDiscussion, settleDiscussion } from './discussions.ts';
import { namedPaths } from './affects.ts';
import { relatedItems } from './rankedsearch.ts';
import { searchIndexReady } from './searchindex.ts';
import { mergeParts } from './taskparts.ts';

/**
 * Tasks that are the same work, made one; the waiting queue looked over for such pairs; and Consolidate tasks on the
 * Work page.
 *
 * - mergeTasks: for tasks not running (Planning, Waiting, Scheduled, Paused). The kept task gains each other's
 *   description as a section, its Spec links, reports, attachments, open requests and waits-for links; the others are
 *   closed (state dropped, merged_into set: shown as "Merged into …", and a link to one opens the kept task), and their
 *   history shows in the kept task's as a collapsed "Merged from …" part (tasks.ts taskDetail origins).
 * - Queue review: pairs of not-running tasks that look like the same or adjoining work (shared Spec entry, named files,
 *   strong search match), told to the director in one note at most once a day and only when the set changed; pairs it
 *   kept apart (keep_apart) are not raised again.
 * - Consolidations: the director's proposals in a "Consolidate tasks" discussion (merge, back to back, wait for), each
 *   a card the user applies or declines; applying does it. The discussion settles with what was done.
 */

/** States a task may be merged from or into: not running and not closed. */
export const MERGEABLE = ['planning', 'waiting', 'scheduled', 'paused'];
const HELM: Author = { author: 'system', name: 'Helm' };

/** Why `t` cannot take part in a merge, or null. */
function notMergeable(t: Row): string | null {
  if (t.kind !== 'task') return `${taskRef(t)} is a discussion; merge tasks only.`;
  if (t.merged_into) return `${taskRef(t)} was already merged into [[${t.merged_into}]].`;
  if (!MERGEABLE.includes(t.state)) return `${taskRef(t)} is ${t.state}: only tasks that are not running (Planning, Waiting, Scheduled, Paused) are merged.`;
  if (get("SELECT 1 AS x FROM agents WHERE task_id = ? AND status IN ('working', 'waiting') LIMIT 1", t.id)) return `${taskRef(t)} has an agent working on it: it is running.`;
  return null;
}

/** Merge `fromRefs` into `intoRef`. Returns what was done, or why not (nothing changed then). */
export function mergeTasks(projectId: string, intoRef: string, fromRefs: string[], why: string, by: Author, title?: string): { text: string; into: Row } | { error: string } {
  const into = findTask(projectId, intoRef);
  if (!into) return { error: `No task "${intoRef}" on this project.` };
  const froms: Row[] = [];
  for (const ref of [...new Set(fromRefs)]) {
    const t = findTask(projectId, ref);
    if (!t) return { error: `No task "${ref}" on this project.` };
    if (t.id === into.id) return { error: 'A task cannot be merged into itself.' };
    froms.push(t);
  }
  if (!froms.length) return { error: 'Name at least one task to merge in (from).' };
  for (const t of [into, ...froms]) {
    const e = notMergeable(t);
    if (e) return { error: `Nothing merged: ${e}` };
  }
  const reason = why.trim().slice(0, 400);
  const moved: string[] = [];
  tx(() => {
    let description = String(into.description ?? '');
    for (const f of froms) {
      // A part per merged task (taskparts.ts): About lists each with its own Features and Done when.
      mergeParts(into, f);
      if (String(f.description ?? '').trim()) description += `\n\n## Merged from "${f.title}"\n\n${String(f.description).trim()}`;
      // Spec links, the main entry too.
      for (const l of all("SELECT doc_id, relation FROM doc_links WHERE task_id = ? AND relation = 'implements'", f.id)) {
        run('INSERT OR IGNORE INTO doc_links (doc_id, task_id, relation, revision_id, note, created_at) SELECT ?, ?, ?, NULL, \'\', ? WHERE NOT EXISTS (SELECT 1 FROM doc_links WHERE doc_id = ? AND task_id = ? AND relation = ?)', l.doc_id, into.id, l.relation, now(), l.doc_id, into.id, l.relation);
      }
      if (f.doc_id && !into.doc_id) run('UPDATE tasks SET doc_id = ? WHERE id = ?', f.doc_id, into.id);
      const reports = run('UPDATE reports SET task_id = ?, updated_at = ? WHERE task_id = ?', into.id, now(), f.id).changes;
      const files = run("UPDATE attachments SET owner_id = ? WHERE owner_kind = 'task' AND owner_id = ?", into.id, f.id).changes;
      const requests = run("UPDATE inbox SET task_id = ? WHERE task_id = ? AND status IN ('open', 'held', 'director', 'check')", into.id, f.id).changes;
      // What it waited for, the kept task now waits for; what waited for it waits for the kept task.
      for (const w of all('SELECT waits_for FROM task_waits WHERE task_id = ?', f.id)) {
        if (w.waits_for !== into.id) run('INSERT OR IGNORE INTO task_waits (task_id, waits_for, created_at) VALUES (?, ?, ?)', into.id, w.waits_for, now());
      }
      for (const w of all('SELECT task_id FROM task_waits WHERE waits_for = ?', f.id)) {
        if (w.task_id !== into.id) run('INSERT OR IGNORE INTO task_waits (task_id, waits_for, created_at) VALUES (?, ?, ?)', w.task_id, into.id, now());
      }
      run('DELETE FROM task_waits WHERE task_id = ? OR waits_for = ?', f.id, f.id);
      run('DELETE FROM task_waits WHERE task_id = ? AND waits_for = ?', into.id, into.id);
      run('UPDATE OR IGNORE discussion_tasks SET task_id = ? WHERE task_id = ?', into.id, f.id);
      run("UPDATE tasks SET state = 'dropped', merged_into = ?, updated_at = ? WHERE id = ?", into.id, now(), f.id);
      // Anything merged into it earlier now points at the kept task too.
      run('UPDATE tasks SET merged_into = ? WHERE merged_into = ?', into.id, f.id);
      const bits = [reports && `${reports} report${reports === 1 ? '' : 's'}`, files && `${files} file${files === 1 ? '' : 's'}`, requests && `${requests} open request${requests === 1 ? '' : 's'}`].filter(Boolean);
      moved.push(`[[${f.id}]]${bits.length ? ` (with ${bits.join(', ')})` : ''}`);
    }
    run('UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?', description, now(), into.id);
    // The umbrella title naming the area the parts share, never a list of them.
    if (title?.trim() && title.trim() !== into.title) run('UPDATE tasks SET title = ? WHERE id = ?', title.trim().slice(0, 140), into.id);
  });
  for (const f of froms) addTaskMessage(getTask(f.id)!, HELM, `Merged into [[${into.id}]] by ${by.name}${reason ? `: ${reason}` : '.'}`, 'state');
  addTaskMessage(getTask(into.id)!, HELM, `${by.name} merged ${moved.join(', ')} into this task${reason ? `: ${reason}` : '.'} Their history is below, folded.`, 'state');
  touchProject(projectId);
  return { text: `Merged ${moved.join(', ')} into ${taskRef(into)}. The others are closed as merged; their history shows folded in its thread.`, into: getTask(into.id)! };
}

/** The kept task a merged task leads to (following a chain), or the task itself. */
export function mergeTarget(t: Row): Row {
  let cur = t;
  for (let i = 0; i < 8 && cur.merged_into; i++) {
    const next = getTask(cur.merged_into);
    if (!next) break;
    cur = next;
  }
  return cur;
}

// ---------- the queue review ----------

export const REVIEW_EVERY_MS = 24 * 3600_000;
const SEARCH_MIN = 0.45;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export type Pair = { a: Row; b: Row; why: string };

/** Pairs of not-running tasks that look like the same or adjoining work, minus those kept apart. */
export function queuePairs(projectId: string): Pair[] {
  const tasks = all(`SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND merged_into IS NULL AND state IN (${MERGEABLE.map(() => '?').join(',')}) ORDER BY importance DESC, position`, projectId, ...MERGEABLE);
  if (tasks.length < 2) return [];
  const apart = new Set(all('SELECT a, b FROM task_pairs_apart WHERE project_id = ?', projectId).map((r) => pairKey(r.a, r.b)));
  const found = new Map<string, Pair>();
  const add = (a: Row, b: Row, why: string) => {
    const k = pairKey(a.id, b.id);
    if (a.id === b.id || apart.has(k) || found.has(k)) return;
    found.set(k, { a, b, why });
  };
  const docs = new Map(tasks.map((t) => [t.id, new Set(all("SELECT doc_id FROM doc_links WHERE task_id = ? AND relation = 'implements' UNION SELECT doc_id FROM tasks WHERE id = ? AND doc_id IS NOT NULL", t.id, t.id).map((r) => String(r.doc_id)))]));
  const paths = new Map(tasks.map((t) => [t.id, new Set(namedPaths(`${t.title}\n${t.description ?? ''}`))]));
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const [a, b] = [tasks[i], tasks[j]];
      const doc = [...docs.get(a.id)!].find((d) => docs.get(b.id)!.has(d));
      if (doc) add(a, b, `both implement [[${doc}]]`);
      const file = [...paths.get(a.id)!].find((p) => paths.get(b.id)!.has(p));
      if (file) add(a, b, `both name ${file}`);
    }
  }
  if (searchIndexReady()) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      const hits = relatedItems(projectId, `${t.title}\n${t.description ?? ''}`, { kinds: ['task'], limit: 20 }) ?? [];
      const own = hits.find((h) => h.item === t.id)?.score ?? 0;
      for (const h of hits) {
        if (h.item === t.id || !byId.has(h.item)) continue;
        if (own && h.score >= Math.max(1, own * SEARCH_MIN)) add(t, byId.get(h.item)!, 'similar titles and descriptions');
      }
    }
  }
  return [...found.values()].slice(0, 10);
}

/**
 * Tell the director about the pairs, once: at most every REVIEW_EVERY_MS, and only when the set changed since the last
 * note. Returns the note's text when it is due (the caller sends it), else null.
 */
export function queueReviewNote(projectId: string, at = now()): string | null {
  const pairs = queuePairs(projectId);
  const key = pairs.map((p) => pairKey(p.a.id, p.b.id)).sort().join(',');
  const last = get('SELECT * FROM queue_reviews WHERE project_id = ?', projectId);
  if (!pairs.length || (last && (last.pairs_key === key || at - last.noted_at < REVIEW_EVERY_MS))) return null;
  run('INSERT INTO queue_reviews (project_id, pairs_key, noted_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET pairs_key = excluded.pairs_key, noted_at = excluded.noted_at', projectId, key, at);
  return [
    `Queue review: these tasks that are not running look like the same or adjoining work.`,
    ...pairs.map((p) => `- [[${p.a.id}]] and [[${p.b.id}]]: ${p.why}`),
    `For each pair: merge them (merge_tasks) when they are the same work, put them next to each other in the queue (update_task after) when one pass covers both, record a wait (waits_for) when one depends on the other, or keep_apart with the reason. Only what saves work: never merge for a shorter list.`,
  ].join('\n');
}

export function keepApart(projectId: string, aRef: string, bRef: string, reason: string): string | null {
  const a = findTask(projectId, aRef);
  const b = findTask(projectId, bRef);
  if (!a || !b) return `No task "${!a ? aRef : bRef}" on this project.`;
  if (a.id === b.id) return 'Name two different tasks.';
  if (!reason.trim()) return 'Say why they stay apart (reason).';
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  run('INSERT INTO task_pairs_apart (project_id, a, b, reason, created_at) VALUES (?,?,?,?,?) ON CONFLICT(a, b) DO UPDATE SET reason = excluded.reason', projectId, x, y, reason.trim().slice(0, 300), now());
  return null;
}

// ---------- Consolidate tasks (the Work page's button) ----------

export const CONSOLIDATE_KINDS = ['merge', 'adjacent', 'wait'] as const;
export type ConsolidateKind = (typeof CONSOLIDATE_KINDS)[number];
const CONSOLIDATE_TITLE = 'Consolidate tasks';
export const CONSOLIDATE_ASK = 'Look over the tasks that are not running and propose only what is worth it: merging the same work, running adjoining work back to back, or a wait where one depends on another. If nothing is worth it, say so.';

/** The open "Consolidate tasks" discussion, or a new one with the user's ask; returns it and whether it is new. */
export function consolidationDiscussion(projectId: string): { d: Row; created: boolean } {
  const open = get("SELECT * FROM tasks WHERE project_id = ? AND kind = 'discussion' AND state = 'open' AND title = ? ORDER BY created_at DESC LIMIT 1", projectId, CONSOLIDATE_TITLE);
  if (open) return { d: open, created: false };
  return { d: createDiscussion(projectId, { title: CONSOLIDATE_TITLE, summary: 'Which tasks that are not running should be merged, run back to back, or wait for another.', origin: 'user' }, { author: 'user', name: 'You' }), created: true };
}

/** The director's proposal: one card in the discussion. */
export function proposeConsolidation(agent: Row, discussionRef: string, kind: string, taskRefs: string[], gain: string): { text: string } | { error: string } {
  const d = findTask(agent.project_id, discussionRef);
  if (!d || d.kind !== 'discussion' || d.state !== 'open') return { error: `No open discussion "${discussionRef}" on this project: propose in the Consolidate tasks discussion.` };
  if (!CONSOLIDATE_KINDS.includes(kind as ConsolidateKind)) return { error: `kind is one of ${CONSOLIDATE_KINDS.join(', ')}.` };
  if (!gain.trim()) return { error: 'Say the gain in one line (gain): fewer passes over the same files, one review instead of two, an order that avoids rework.' };
  const ts: Row[] = [];
  for (const ref of taskRefs) {
    const t = findTask(agent.project_id, ref);
    if (!t) return { error: `No task "${ref}" on this project.` };
    const e = notMergeable(t);
    if (e) return { error: e };
    ts.push(t);
  }
  if (ts.length < 2 || (kind === 'wait' && ts.length !== 2)) return { error: kind === 'wait' ? 'A wait names two tasks: the one that waits, then the one it waits for.' : 'Name at least two tasks.' };
  const id = newId('cn');
  run('INSERT INTO consolidations (id, project_id, discussion_id, agent_name, kind, tasks, gain, created_at) VALUES (?,?,?,?,?,?,?,?)', id, agent.project_id, d.id, agent.name, kind, JSON.stringify(ts.map((t) => t.id)), gain.trim().slice(0, 300), now());
  addTaskMessage(d, { author: 'director', name: agent.name }, JSON.stringify({ id }), 'consolidate');
  return { text: `Proposed in [[${d.id}]]: a card the user applies or declines. You are told what they decide.` };
}

export const getConsolidation = (id: string) => get('SELECT * FROM consolidations WHERE id = ?', id);

export function consolidationView(c: Row) {
  const ids = JSON.parse(c.tasks) as string[];
  return { id: c.id, kind: c.kind, gain: c.gain, status: c.status, result: c.result, agent_name: c.agent_name, created_at: c.created_at, tasks: ids.map((id) => get('SELECT id, title, state, merged_into FROM tasks WHERE id = ?', id)).filter(Boolean) };
}

/** The user applies a card: the merge, the reorder or the wait. Returns what was done, or an error (nothing changed). */
export function applyConsolidation(c: Row): { text: string } | { error: string; code?: number } {
  if (c.status !== 'open') return { error: `This proposal is ${c.status}.`, code: 409 };
  const ids = JSON.parse(c.tasks) as string[];
  let text: string;
  if (c.kind === 'merge') {
    const res = mergeTasks(c.project_id, ids[0], ids.slice(1), c.gain, { author: 'user', name: 'You' });
    if ('error' in res) return res;
    text = `Merged ${ids.slice(1).map((x) => `[[${x}]]`).join(', ')} into [[${ids[0]}]].`;
  } else if (c.kind === 'adjacent') {
    for (let i = 1; i < ids.length; i++) {
      const t = getTask(ids[i]);
      if (!t) return { error: `Task ${ids[i]} no longer exists.` };
      const e = moveTask(t, { after: ids[i - 1] }, 'user');
      if (e) return { error: e };
    }
    text = `Put ${ids.map((x) => `[[${x}]]`).join(', ')} back to back in the queue.`;
  } else {
    const t = getTask(ids[0]);
    if (!t) return { error: `Task ${ids[0]} no longer exists.` };
    const current = all('SELECT waits_for FROM task_waits WHERE task_id = ?', t.id).map((r) => String(r.waits_for));
    const e = setWaits(t.id, [...current, ids[1]]);
    if (e) return { error: e };
    text = `[[${ids[0]}]] now waits for [[${ids[1]}]].`;
  }
  run("UPDATE consolidations SET status = 'applied', result = ?, decided_at = ? WHERE id = ?", text, now(), c.id);
  settleWhenDecided(c.discussion_id);
  touchProject(c.project_id);
  return { text };
}

export function declineConsolidation(c: Row): { error: string; code?: number } | null {
  if (c.status !== 'open') return { error: `This proposal is ${c.status}.`, code: 409 };
  run("UPDATE consolidations SET status = 'declined', decided_at = ? WHERE id = ?", now(), c.id);
  settleWhenDecided(c.discussion_id);
  touchProject(c.project_id);
  return null;
}

/** Every card decided: the discussion settles with what was done. */
function settleWhenDecided(discussionId: string) {
  if (get("SELECT 1 AS x FROM consolidations WHERE discussion_id = ? AND status = 'open' LIMIT 1", discussionId)) return;
  const d = getTask(discussionId);
  if (!d || d.state !== 'open') return;
  const done = all("SELECT result FROM consolidations WHERE discussion_id = ? AND status = 'applied' ORDER BY decided_at", discussionId).map((r) => `- ${r.result}`);
  settleDiscussion(d, done.length ? `Done:\n${done.join('\n')}` : 'Nothing was changed: every proposal was declined.', HELM);
}
