import { get, run } from './db.ts';
import type { Row } from './db.ts';
import { dateText } from './clock.ts';
import { relatedItems } from './rankedsearch.ts';
import { searchIndexReady } from './searchindex.ts';
import { getSetting } from './settings.ts';

/**
 * Related past work: when an agent is given a task (spawned for it, or a standing agent made the driver of its next
 * one), Helm searches the project for the earlier tasks, journal decisions and discussion conclusions most like it
 * (rankedsearch.ts relatedItems over the task's title, description and the paths it names) and hands over a short
 * block of references, so known decisions and overlapping work are seen before the agent starts. create_task's result
 * shows the director the same list. Per-project switch "related_work" (Setup › Agent context).
 *
 * Strength: a hit counts when it scores at least RELATIVE_MIN of what the task's own row scores for the same words (its
 * best possible match). bm25 figures depend on the size of the project, so the bar is relative; calibrated on a copy of
 * real data, where a clear relative scores 0.3 to 0.6 of the task itself and a loose one under 0.28 (a task with a
 * short description has a low own score, so its bar is lower and looser matches get in). Nothing is added
 * when no hit is strong.
 */

export const RELATED_MAX = 5;
export const RELATIVE_MIN = 0.28;
export const ABSOLUTE_MIN = 1;

export const relatedOn = (projectId: string) => getSetting(projectId, 'related_work');

const oneLine = (s: string, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const LABEL: Record<string, string> = { planning: 'Planning', waiting: 'Waiting', scheduled: 'Scheduled', active: 'Active', paused: 'Paused', done: 'Done', dropped: 'Dropped' };

/** A related item: an earlier task, a discussion that reached a conclusion, or a journal decision (its row). */
export type RelatedHit = { kind: 'task' | 'discussion'; row: Row } | { kind: 'decision'; row: Row };

/** The strong related items for a task, best first (about 4 ms on a real project: cheap enough to run on read). */
export function relatedHits(task: Row, max = RELATED_MAX): RelatedHit[] {
  if (!searchIndexReady()) return [];
  const text = [task.title, task.description].filter(Boolean).join('\n');
  const hits = relatedItems(task.project_id, text, { kinds: ['task', 'journal'], limit: 40 });
  if (!hits?.length) return [];
  const own = hits.find((h) => h.kind === 'task' && h.item === task.id)?.score ?? 0;
  const floor = Math.max(ABSOLUTE_MIN, own * RELATIVE_MIN);
  const out: RelatedHit[] = [];
  for (const h of hits) {
    if (out.length >= max) break;
    if (h.score < floor) break;
    if (h.kind === 'task') {
      if (h.item === task.id) continue;
      const t = get('SELECT id, kind, title, state, conclusion, requests_agent_id, inbox_archive FROM tasks WHERE id = ?', h.item);
      if (!t || t.requests_agent_id || t.inbox_archive) continue;
      if (t.kind === 'discussion') {
        if (t.conclusion) out.push({ kind: 'discussion', row: t });
      } else out.push({ kind: 'task', row: t });
    } else {
      const j = get('SELECT id, kind, title, body, ts, task_id, doc_id FROM journal WHERE id = ?', Number(h.item));
      if (!j || j.kind !== 'decision' || j.task_id === task.id) continue;
      out.push({ kind: 'decision', row: j });
    }
  }
  return out;
}

/** One line per related item: earlier tasks, journal decisions, discussions that reached a conclusion. */
export function relatedLines(task: Row): string[] {
  return relatedHits(task).map(({ kind, row: r }) => {
    if (kind === 'discussion') return `- [[${r.id}]] discussion "${oneLine(r.title, 80)}": ${oneLine(r.conclusion, 160)}`;
    if (kind === 'task') return `- [[${r.id}]] task "${oneLine(r.title, 80)}" (${LABEL[r.state] ?? r.state})`;
    const where = r.task_id || r.doc_id ? ` [[${r.task_id || r.doc_id}]]` : '';
    return `- decision, ${dateText(r.ts)}: "${oneLine(r.title, 80)}"${where}`;
  });
}

/** The block an agent is given with its task, or '' (the switch off, nothing strong). */
export function relatedBlock(task: Row | undefined): string {
  if (!task || task.kind !== 'task' || !relatedOn(task.project_id)) return '';
  const lines = relatedLines(task);
  return lines.length ? `Related past work (found by search; read what applies before you start):\n${lines.join('\n')}` : '';
}

/**
 * For a message to an agent: the related work of the task it now works on, once per task. A spawned agent got it in
 * its brief (markRelatedGiven); a standing agent made the driver of its next task gets it with its next message.
 */
export function relatedNote(agentId: string): string {
  const a = get('SELECT id, task_id, related_given, parent_id FROM agents WHERE id = ?', agentId);
  if (!a?.task_id || !a.parent_id || a.related_given === a.task_id) return '';
  markRelatedGiven(agentId, a.task_id);
  const block = relatedBlock(get('SELECT * FROM tasks WHERE id = ?', a.task_id));
  return block ? `\n<helm-note kind="related">You are now on [[${a.task_id}]]. ${block}</helm-note>` : '';
}

export function markRelatedGiven(agentId: string, taskId: string) {
  run('UPDATE agents SET related_given = ? WHERE id = ?', taskId, agentId);
}
