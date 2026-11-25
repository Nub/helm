import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { getChoice } from './settings.ts';
import { createRequest, withdrawRequest } from './requests.ts';
import { addTaskMessage, getTask, isDiscussion } from './tasks.ts';
import type { Author } from './tasks.ts';
import { proposedConclusion, settleDiscussion, reopenDiscussion } from './discussions.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { getProject } from './store.ts';

/**
 * Discussions that go quiet (this replaced "cold"): states open, stale, settled (Closed) and archived. An open discussion
 * with no activity for the project's revisit period (Setup, default 7 days) gets one request, "Revisit <title>?":
 * Continue (the director recaps in one line and asks the next question), Close (the director proposes a conclusion),
 * Archive, or Not now (asked again after another quiet period). A second reminder left unanswered for a period, or a
 * second Not now, makes it stale. Any activity resets it: the counters, and a stale one opens again. Nothing closes a
 * discussion by itself. Archived discussions leave the default list (an Archived filter and search still find them).
 */

const HELM: Author = { author: 'system', name: 'Helm' };
export const REVISIT_OPTIONS = ['Continue', 'Close', 'Archive', 'Not now'] as const;
export const CHECK_EVERY_MS = 10 * 60_000;

export const revisitDays = (projectId: string) => Number(getChoice(projectId, 'discussion_revisit_days')) || 7;

/**
 * The latest activity on a discussion, the reminders left out (their filing and answer are not activity): messages,
 * other requests and answers, previews, journal entries, and state changes (updated_at, which reminders do not move).
 */
export function lastActivity(d: Row): number {
  const times = [
    d.updated_at,
    // Helm's own state lines (marked stale, archived) are not activity.
    get("SELECT MAX(created_at) AS t FROM task_messages WHERE task_id = ? AND kind != 'state'", d.id)?.t,
    get("SELECT MAX(MAX(created_at), COALESCE(MAX(answered_at), 0)) AS t FROM inbox WHERE task_id = ? AND json_extract(payload, '$.revisit') IS NULL", d.id)?.t,
    get('SELECT MAX(created_at) AS t FROM previews WHERE task_id = ?', d.id)?.t,
    get('SELECT MAX(ts) AS t FROM journal WHERE task_id = ?', d.id)?.t,
  ];
  return Math.max(...times.map((t) => Number(t) || 0));
}

const openReminder = (discId: string) => get("SELECT * FROM inbox WHERE task_id = ? AND status IN ('open', 'held') AND json_extract(payload, '$.revisit') IS NOT NULL ORDER BY created_at DESC LIMIT 1", discId);

/** Set a discussion's state by the user's or Helm's hand (stale, archived, open), with a line in its thread. */
export function setDiscussionState(d: Row, state: 'stale' | 'archived' | 'open', by: Author, why = '') {
  if (d.state === state) return;
  tx(() => {
    run('UPDATE tasks SET state = ?, updated_at = ?, revisit_count = 0, revisit_at = NULL, revisit_later = 0 WHERE id = ?', state, now(), d.id);
    const word = { stale: 'marked it stale', archived: 'archived it', open: 'reopened it' }[state];
    addTaskMessage(getTask(d.id)!, HELM, `${by.name} ${word}${why ? `: ${why}` : '.'}`, 'state');
  });
  const r = openReminder(d.id);
  if (r) withdrawRequest(r.id, state === 'open' ? 'The discussion is active again.' : `The discussion is ${state === 'stale' ? 'stale' : 'archived'}.`);
  touchProject(d.project_id);
}

function fileReminder(d: Row, days: number) {
  createRequest({
    projectId: d.project_id,
    agentId: null,
    kind: 'question',
    title: `Revisit "${d.title}"?`.slice(0, 140),
    body: `Nothing has happened in this discussion for ${days} days.${d.status_summary ? `\n\nWhere it stands: ${String(d.status_summary).slice(0, 400)}` : ''}`,
    options: [
      { label: 'Continue', detail: 'The director recaps in one line and asks the next question' },
      { label: 'Close', detail: 'The director proposes a conclusion' },
      { label: 'Archive' },
      { label: 'Not now', detail: 'Ask again later' },
    ],
    payload: { revisit: d.id },
    importance: 2,
    blocking: false,
    task: d,
  });
  run('UPDATE tasks SET revisit_count = COALESCE(revisit_count, 0) + 1, revisit_at = ? WHERE id = ?', now(), d.id);
}

/** One pass over a project's (or every) open and stale discussions: reset on activity, remind, or mark stale. */
export function checkDiscussions(projectId?: string, at = now()): { reminded: number; staled: number; reset: number } {
  const out = { reminded: 0, staled: 0, reset: 0 };
  const rows = all(
    `SELECT * FROM tasks WHERE kind = 'discussion' AND state IN ('open', 'stale') AND requests_agent_id IS NULL AND COALESCE(inbox_archive, 0) = 0 ${projectId ? 'AND project_id = ?' : ''}`,
    ...(projectId ? [projectId] : []),
  );
  for (const d of rows) {
    const days = revisitDays(d.project_id);
    const period = days * 86_400_000;
    const last = lastActivity(d);
    // Activity since the last reminder (or since it went stale): the clock starts again.
    if (d.state === 'stale') {
      if (d.stale_at && last > d.stale_at) {
        setDiscussionState(d, 'open', HELM, 'there was new activity');
        out.reset++;
      }
      continue;
    }
    if (d.revisit_at && last > d.revisit_at) {
      run('UPDATE tasks SET revisit_count = 0, revisit_at = NULL, revisit_later = 0 WHERE id = ?', d.id);
      const r = openReminder(d.id);
      if (r) withdrawRequest(r.id, 'The discussion is active again.');
      out.reset++;
      continue;
    }
    if (at - last < period) continue;
    const count = Number(d.revisit_count ?? 0);
    const pending = openReminder(d.id);
    // A reminder is waiting: after a period unanswered, the second one makes it stale; the first gets a follow-up.
    if (pending) {
      if (at - Number(d.revisit_at ?? at) < period) continue;
      if (count >= 2) {
        markStale(d, 'two reminders went unanswered');
        out.staled++;
      } else {
        withdrawRequest(pending.id, 'Asked again below.');
        fileReminder(d, Math.round((at - last) / 86_400_000));
        out.reminded++;
      }
      continue;
    }
    // Answered Not now (or the reminder was withdrawn): asked again once a period has passed since.
    if (count > 0 && at - Number(d.revisit_at ?? 0) < period) continue;
    fileReminder(d, Math.round((at - last) / 86_400_000));
    out.reminded++;
  }
  if (out.reminded || out.staled || out.reset) for (const p of new Set(rows.map((r) => r.project_id))) touchProject(p);
  return out;
}

function markStale(d: Row, why: string) {
  setDiscussionState(d, 'stale', HELM, why);
  run('UPDATE tasks SET stale_at = updated_at WHERE id = ?', d.id);
}

/** The user answered a reminder (answers.ts). Returns true when it was one (handled here). */
export async function onRevisitAnswer(item: Row, choice: string | undefined, dismissed: boolean): Promise<boolean> {
  let payload: Row;
  try {
    payload = JSON.parse(item.payload || '{}');
  } catch {
    return false;
  }
  if (!payload.revisit) return false;
  run('UPDATE inbox SET status = ?, answer = ?, answered_at = ? WHERE id = ?', dismissed ? 'dismissed' : 'answered', dismissed ? 'Dismissed' : choice ?? '', now(), item.id);
  const d = getTask(payload.revisit);
  if (!d || !isDiscussion(d) || dismissed) {
    touchProject(item.project_id);
    return true;
  }
  const project = getProject(d.project_id)!;
  const tell = (text: string) => sendToAgent(rootAgent(project).id, `<helm-note kind="revisit">${text}</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
  if (choice === 'Archive') setDiscussionState(d, 'archived', { author: 'user', name: 'You' });
  else if (choice === 'Not now') {
    const later = Number(d.revisit_later ?? 0) + 1;
    if (later >= 2) markStale(d, 'Not now, a second time');
    else run('UPDATE tasks SET revisit_later = ? WHERE id = ?', later, d.id);
  } else if (choice === 'Continue') {
    run('UPDATE tasks SET revisit_count = 0, revisit_at = NULL, revisit_later = 0, updated_at = ? WHERE id = ?', now(), d.id);
    await tell(`The user wants to continue [[${d.id}]]: post in its thread (task_post) a one-line recap of where it stands and the next question.`);
  } else if (choice === 'Close') {
    run('UPDATE tasks SET revisit_count = 0, revisit_at = NULL, revisit_later = 0, updated_at = ? WHERE id = ?', now(), d.id);
    await tell(`The user wants to close [[${d.id}]]: propose its conclusion in its thread (task_post conclude: true); the user's Conclude closes it.`);
  }
  touchProject(d.project_id);
  return true;
}

/** Many discussions at once (the list's selection): mark stale, archive, close or reopen. Returns how many changed. */
export function batchDiscussions(projectId: string, ids: string[], action: 'stale' | 'archive' | 'close' | 'reopen', by: Author): { changed: number } | { error: string } {
  if (!['stale', 'archive', 'close', 'reopen'].includes(action)) return { error: 'action is one of stale, archive, close, reopen.' };
  let changed = 0;
  for (const id of [...new Set(ids)].slice(0, 500)) {
    const d = getTask(id);
    if (!d || d.project_id !== projectId || !isDiscussion(d)) continue;
    if (action === 'close') {
      if (d.state === 'settled') continue;
      // Its proposed conclusion when the director wrote one, else a plain marker.
      const post = proposedConclusion(d);
      settleDiscussion(d, post ? String(post.body) : 'Closed in bulk', by);
    } else if (action === 'reopen') {
      if (d.state === 'open') continue;
      if (d.state === 'settled') reopenDiscussion(d, by);
      else setDiscussionState(d, 'open', by);
    } else {
      const state = action === 'stale' ? 'stale' : 'archived';
      if (d.state === state) continue;
      setDiscussionState(d, state, by);
      if (state === 'stale') run('UPDATE tasks SET stale_at = updated_at WHERE id = ?', d.id);
    }
    changed++;
  }
  touchProject(projectId);
  return { changed };
}

let timer: NodeJS.Timeout | null = null;
export function startRevisitChecks() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      checkDiscussions();
    } catch (err) {
      console.error('Discussion reminders failed:', (err as Error).message);
    }
  }, CHECK_EVERY_MS);
  timer.unref?.();
}
