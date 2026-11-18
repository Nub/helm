import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { turnInbound } from './turns.ts';
import { findUserAsks } from './userasks.ts';

/**
 * The safety net for asks made only in prose. After a manager's turn, the text the user will see from it (its reply
 * in the conversation, its posts and status summaries in task and discussion threads) is checked for sentences that
 * say the user must do or decide something (userasks.ts). When one is found and no request was filed in that turn or
 * is open where it was said, the manager gets one <helm-note kind="user-ask"> quoting it (runtime.ts delivers it as its
 * next turn). Never more than one note per turn; a turn answering such a note is not checked; a sentence is noted at
 * most once per agent, remembered across restarts (user_ask_notes). The note is not dialogue (turns.ts), so the user does not see it as a message.
 */

export const NOTE_TAG = '<helm-note kind="user-ask">';

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 300);
/** Whether this agent was already told about the sentence (user_ask_notes, kept across restarts). */
const wasNoted = (agentId: string, sentence: string) => !!get('SELECT 1 AS x FROM user_ask_notes WHERE agent_id = ? AND sentence_key = ?', agentId, key(sentence));

/** Open questions and to-dos on a task or discussion. */
const openAsks = (taskId: string) => Number(get("SELECT COUNT(*) AS n FROM inbox WHERE task_id = ? AND status = 'open' AND kind IN ('question', 'action')", taskId)?.n ?? 0);

/**
 * The note for a manager's finished turn, or null. `resultId`: the turn's result event; `reply`: its final text and
 * whether it was dialogue (shown in the conversation). Thread posts and summaries are read from task_messages.
 */
export function unfiledAskNote(agent: Row, resultId: number, reply: { text: string; dialogue: boolean }): string | null {
  const inbound = turnInbound(agent.id, resultId);
  if (inbound.some((e) => String(e.data?.text ?? '').startsWith(NOTE_TAG))) return null;
  const since = get("SELECT ts FROM events WHERE agent_id = ? AND kind = 'result' AND id < ? ORDER BY id DESC LIMIT 1", agent.id, resultId)?.ts ?? inbound[0]?.ts ?? 0;
  const filed = all('SELECT task_id FROM inbox WHERE agent_id = ? AND created_at >= ?', agent.id, since);
  const filedOn = new Set(filed.map((r) => r.task_id));

  const said: { sentence: string; task: Row | null; where: string }[] = [];
  if (reply.dialogue) for (const s of findUserAsks(reply.text)) said.push({ sentence: s, task: null, where: 'in your reply in the conversation' });
  const posts = all(
    `SELECT m.body, m.kind, t.* FROM task_messages m JOIN tasks t ON t.id = m.task_id
     WHERE t.project_id = ? AND m.author = 'director' AND m.author_name = ? AND m.created_at >= ? AND m.kind IN ('message', 'summary') ORDER BY m.id`,
    agent.project_id, agent.name, since,
  );
  for (const p of posts) {
    const { body, kind, ...task } = p;
    for (const s of findUserAsks(body)) said.push({ sentence: s, task, where: `in ${kind === 'summary' ? 'the status summary of' : 'your post in'} ${task.kind === 'discussion' ? 'the discussion' : 'the task'} "${task.title}"` });
  }

  const hit = said.find(({ sentence, task }) => {
    if (wasNoted(agent.id, sentence)) return false;
    // Filed or already open where it was said. For the conversation reply, which concerns no one task, anything this
    // agent filed this turn or has open anywhere counts. Known gap, accepted for now: a new prose-only ask in a reply
    // slips through while an unrelated request of this agent is open.
    if (task) return !filedOn.has(task.id) && openAsks(task.id) === 0;
    const open = Number(get("SELECT COUNT(*) AS n FROM inbox WHERE agent_id = ? AND status = 'open' AND kind IN ('question', 'action')", agent.id)?.n ?? 0);
    return filed.length === 0 && open === 0;
  });
  if (!hit) return null;
  run('INSERT OR IGNORE INTO user_ask_notes (agent_id, sentence_key, created_at) VALUES (?,?,?)', agent.id, key(hit.sentence), now());

  // The task is named as `id: ...`, not "(id ...)", so the reply to this note is not posted into its thread (turns.ts).
  const target = hit.task ? `on ${hit.task.kind === 'discussion' ? 'the discussion' : 'the task'} "${hit.task.title}" (task: ${hit.task.id})` : 'on the task or discussion it concerns (or with no task, where Helm starts a discussion for it)';
  return (
    `${NOTE_TAG}You wrote ${hit.where}: "${hit.sentence}"\n\n` +
    `That reads as something the user must do or decide, but no request was filed for it, so it does not show under Needs response and the user may never see it. ` +
    `If it is, file it now with ask_user ${target}: kind "action" with exact steps for something to do outside Helm, a question for a decision. ` +
    `If nothing is needed from the user, say so in one line and correct the text if it misleads.</helm-note>`
  );
}

/** For tests: forget what was noted. */
export function resetNoted() {
  run('DELETE FROM user_ask_notes');
}
