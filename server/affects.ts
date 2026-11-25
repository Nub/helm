import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { relatedItems } from './rankedsearch.ts';
import { searchIndexReady } from './searchindex.ts';
import { getSetting } from './settings.ts';
import { changedFiles, globMatch } from './tilescope.ts';
import { addTaskMessage } from './tasks.ts';

/**
 * New work that may affect a running task: when the director creates a task, changes its title or description, or a
 * task goes Active, Helm looks for the other Active tasks it may affect and lists them in the tool's result, so the
 * director tells their agents (message_agent) or records why not (affects_ack). Each such pair is kept
 * (affect_pairs); one line goes in both threads when it is answered. Pairs still unanswered when the director's turn
 * ends are put to it once more in a <helm-note kind="affects">, never a third time. Runner side (tools and the turn's
 * end). Per-project switch "affected_work".
 *
 * What counts: the same Spec entry (doc links), the same files (paths named in the new task's description, or its
 * own changed files, against the other task's changed files from its worktree or branch), or a strong search match
 * (rankedsearch.ts relatedItems; RELATIVE_MIN of the task's own score, as related.ts).
 */

export const AFFECTS_MAX = 5;
const RELATIVE_MIN = 0.28;

export const affectsOn = (projectId: string) => getSetting(projectId, 'affected_work');

export type Affected = { task: Row; reason: string };

/** Paths a text names: `server/tools.ts`, `web/src/`, `styles.css`. */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/(?:^|[\s`'"(\[])((?:[\w.*-]+\/)+[\w.*-]*|[\w-]+\.(?:ts|tsx|js|mjs|cjs|css|json|md|nix|sh|rs|py|go|toml|yaml|yml))(?=$|[\s`'")\],.;:])/gm)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (p.length > 2 && !/^https?:/.test(p)) out.add(p);
  }
  return [...out];
}

/** A task's own changed files, only when they come from its worktree or branch (not "everything since it started"). */
export async function ownFiles(t: Row): Promise<string[]> {
  try {
    const c = await changedFiles(t);
    return c.how.some((h) => /since the task started/.test(h)) ? [] : c.files;
  } catch {
    return [];
  }
}

const docsOf = (taskId: string) =>
  all("SELECT DISTINCT doc_id FROM doc_links WHERE task_id = ? AND relation = 'implements' UNION SELECT doc_id FROM tasks WHERE id = ? AND doc_id IS NOT NULL", taskId, taskId).map((r) => String(r.doc_id));

/** The other Active tasks `t` may affect, at most AFFECTS_MAX, each with why. */
export async function findAffected(t: Row): Promise<Affected[]> {
  const others = all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' AND id != ? ORDER BY importance DESC, position", t.project_id, t.id);
  if (!others.length) return [];
  const why = new Map<string, string>();
  // The same Spec entry.
  const mine = new Set(docsOf(t.id));
  if (mine.size) {
    for (const o of others) {
      const shared = docsOf(o.id).find((d) => mine.has(d));
      if (shared && !why.has(o.id)) why.set(o.id, `shares Spec entry [[${shared}]]`);
    }
  }
  // The same files.
  const paths = namedPaths(`${t.title}\n${t.description ?? ''}`);
  const files = t.state === 'active' ? await ownFiles(t) : [];
  if (paths.length || files.length) {
    for (const o of others) {
      if (why.has(o.id)) continue;
      const theirs = await ownFiles(o);
      const hit = theirs.find((f) => files.includes(f) || paths.some((p) => p === f || globMatch(p, f)));
      if (hit) why.set(o.id, `both touch ${hit}`);
    }
  }
  // Like it, by search.
  if (searchIndexReady()) {
    const hits = relatedItems(t.project_id, `${t.title}\n${t.description ?? ''}`, { kinds: ['task'], limit: 40 }) ?? [];
    const own = hits.find((h) => h.item === t.id)?.score ?? 0;
    const active = new Set(others.map((o) => o.id));
    for (const h of hits) {
      if (h.score < Math.max(1, own * RELATIVE_MIN)) break;
      if (active.has(h.item) && !why.has(h.item)) why.set(h.item, 'similar');
    }
  }
  const byId = new Map(others.map((o) => [o.id, o]));
  return [...why].slice(0, AFFECTS_MAX).map(([id, reason]) => ({ task: byId.get(id)!, reason }));
}

/**
 * For the director's tool result: find what `t` may affect, record the pairs not yet answered, and say so. '' when
 * there is nothing, or the switch is off.
 */
export async function affectsText(t: Row | undefined): Promise<string> {
  if (!t || t.kind !== 'task' || !affectsOn(t.project_id)) return '';
  const found = await findAffected(t);
  const lines: string[] = [];
  for (const { task: o, reason } of found) {
    const pair = get('SELECT * FROM affect_pairs WHERE task_id = ? AND affected_id = ?', t.id, o.id);
    if (pair?.answered_at) continue;
    if (!pair) run('INSERT INTO affect_pairs (task_id, affected_id, project_id, reason, shown_at) VALUES (?,?,?,?,?)', t.id, o.id, t.project_id, reason, now());
    const driver = o.driver_agent_id ? get('SELECT name FROM agents WHERE id = ?', o.driver_agent_id)?.name : null;
    lines.push(`- [[${o.id}]] (${driver ?? 'no driver'}, ${reason})`);
  }
  if (!lines.length) return '';
  return `\n\nMay affect running work:\n${lines.join('\n')}\nFor each, tell its agent with message_agent, naming [[${t.id}]] in the message, or record why not with affects_ack.`;
}

const HELM = { author: 'system' as const, name: 'Helm' };
function answer(pair: Row, how: 'told' | 'ack', line: string, note = '') {
  run('UPDATE affect_pairs SET answered_at = ?, how = ?, note = ? WHERE task_id = ? AND affected_id = ?', now(), how, note, pair.task_id, pair.affected_id);
  for (const id of [pair.task_id, pair.affected_id]) {
    const t = get('SELECT * FROM tasks WHERE id = ?', id);
    if (t) addTaskMessage(t, HELM, line, 'state');
  }
}

/** The director messaged `target`: open pairs about the tasks it drives count as told when the message names the new task. */
export function onDirectorMessage(projectId: string, target: Row, message: string) {
  const pairs = all(
    'SELECT p.* FROM affect_pairs p JOIN tasks a ON a.id = p.affected_id WHERE p.project_id = ? AND p.answered_at IS NULL AND (a.driver_agent_id = ? OR a.id = ?)',
    projectId, target.id, target.task_id ?? '',
  );
  for (const p of pairs.filter((p) => String(message).includes(p.task_id))) answer(p, 'told', `Told ${target.name} about [[${p.task_id}]], which may affect [[${p.affected_id}]].`);
}

/** affects_ack: why it was not passed on. Returns an error, or null. */
export function ackAffected(projectId: string, taskId: string, affectedId: string, reason: string): string | null {
  const pair = get('SELECT * FROM affect_pairs WHERE project_id = ? AND task_id = ? AND affected_id = ?', projectId, taskId, affectedId);
  if (!pair) {
    const open = all('SELECT task_id, affected_id FROM affect_pairs WHERE project_id = ? AND answered_at IS NULL', projectId);
    return `No such pair. Open: ${open.map((p) => `${p.task_id} → ${p.affected_id}`).join(', ') || 'none'}.`;
  }
  if (pair.answered_at) return null;
  answer(pair, 'ack', `Not passed on to [[${affectedId}]] about [[${taskId}]]: ${reason.replace(/\s+/g, ' ').trim()}`, reason);
  return null;
}

/**
 * The director's turn ended: pairs still open are put to it once more (never a third time). Returns the note to send,
 * or null.
 */
export function affectsNote(director: Row): string | null {
  const open = all('SELECT * FROM affect_pairs WHERE project_id = ? AND answered_at IS NULL AND renoted = 0', director.project_id);
  if (!open.length || !affectsOn(director.project_id)) return null;
  run('UPDATE affect_pairs SET renoted = 1 WHERE project_id = ? AND answered_at IS NULL AND renoted = 0', director.project_id);
  const lines = open.map((p) => `- [[${p.task_id}]] may affect [[${p.affected_id}]] (${p.reason})`);
  return `<helm-note kind="affects">Not yet passed on:\n${lines.join('\n')}\nTell each running task's agent with message_agent, naming the new task ([[id]]) in the message, or record why not with affects_ack. Helm does not ask again.</helm-note>`;
}
