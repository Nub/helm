import { all, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getAgent, touchProject } from './store.ts';
import { getTask, taskRef } from './tasks.ts';

/**
 * Consults: a question (ask_manager) or a review request (request_review) from an
 * agent to the agent that spawned it. The manager gets it as a tagged message and
 * answers with message_agent (reply_to); the answer goes back to the asker as a
 * message. Both sit in the consults table so the pair shows in the task's thread
 * and the team view can show who is waiting on whom. They never become requests to
 * the user (needs response) or reach the director conversation. A quick helper (agents.quick) consults the
 * agent that started it with quick_job, which need not be a manager: it answers with answer_helper.
 */

export type Verdict = 'accepted' | 'changes_needed';
export const VERDICTS: Verdict[] = ['accepted', 'changes_needed'];
const VERDICT_TEXT: Record<Verdict, string> = { accepted: 'accepted', changes_needed: 'changes needed' };

export type QuestionInput = {
  question: string;
  options?: { label: string; detail?: string }[];
  recommendation?: string;
  blocking?: boolean;
};

export type ReviewInput = {
  summary: string;
  where: string;
  how_to_run?: string;
  verified: string;
  not_verified?: string;
  doubts?: string;
};

/** Attribute values come from agent and task names; keep them from closing the tag. */
const attr = (s: string) => s.replace(/["<>\n]/g, "'");

/** The agent that answers `asker`'s consults, or why there is none. */
export function managerOf(asker: Row): { manager: Row } | { error: string } {
  if (!asker.parent_id) return { error: 'You are the top-level agent: you have no manager. Ask the user with ask_user.' };
  const manager = getAgent(asker.parent_id);
  if (!manager || manager.status === 'closed') {
    if (asker.quick) return { error: 'The agent that asked for this job has been closed. Stop here and report what you have.' };
    return { error: 'The agent that assigned your task has been closed. Put the question to the user with ask_user instead.' };
  }
  return { manager };
}

function waitingLine(kind: string, manager: Row) {
  return kind === 'review' ? `Waiting for review from ${manager.name}` : `Waiting for ${manager.name}'s answer`;
}

function questionBody(q: QuestionInput): string {
  const parts = [q.question.trim()];
  if (q.options?.length) parts.push(`Options:\n${q.options.map((o) => `- ${o.label}${o.detail ? `: ${o.detail}` : ''}`).join('\n')}`);
  if (q.recommendation) parts.push(`Their recommendation: ${q.recommendation}`);
  return parts.join('\n\n');
}

function reviewBody(r: ReviewInput): string {
  return [
    `What changed: ${r.summary.trim()}`,
    `Where: ${r.where.trim()}`,
    r.how_to_run && `How to run it: ${r.how_to_run.trim()}`,
    `Verified: ${r.verified.trim()}`,
    r.not_verified && `Not verified: ${r.not_verified.trim()}`,
    r.doubts && `Doubts: ${r.doubts.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Record a consult and build the message for the manager. A review always counts
 * as blocking: the asker is told to end its turn unless it has independent work.
 */
export function fileConsult(asker: Row, manager: Row, taskId: string | null, input: { kind: 'question'; q: QuestionInput } | { kind: 'review'; r: ReviewInput }): { consult: Row; message: string } {
  const id = newId('cq');
  const blocking = input.kind === 'review' ? true : !!input.q.blocking;
  const question = input.kind === 'question' ? questionBody(input.q) : reviewBody(input.r);
  const detail = { ...(input.kind === 'question' ? input.q : input.r), prevStatus: asker.status_line ?? '' };
  run(
    'INSERT INTO consults (id, project_id, asker_id, manager_id, task_id, kind, question, detail, blocking, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, asker.project_id, asker.id, manager.id, taskId, input.kind, question, JSON.stringify(detail), blocking ? 1 : 0, now(),
  );
  if (blocking) run('UPDATE agents SET status_line = ?, updated_at = ? WHERE id = ?', waitingLine(input.kind, manager), now(), asker.id);
  touchProject(asker.project_id);

  const task = taskId ? getTask(taskId) : undefined;
  const tag = input.kind === 'review' ? 'review-request' : 'agent-question';
  const attrs = `from="${attr(asker.name)}" id="${asker.id}" ref="${id}"${blocking ? ' blocking="true"' : ''}${task ? ` task="${task.id}"` : ''}`;
  const about = task ? `It is about ${taskRef(task)}.\n\n` : '';
  // A quick helper (quick_job) may report to an agent that has no message_agent: answer_helper is the way back.
  const how = asker.quick && input.kind === 'question'
    ? `Answer with answer_helper (ref "${id}"): decide, and say why.${blocking ? ' They have stopped until you answer.' : ' They are carrying on meanwhile.'}`
    : input.kind === 'review'
      ? `Review it yourself or spawn a reviewer, then answer with message_agent (agent "${asker.id}", reply_to "${id}", verdict "accepted" or "changes_needed"), giving the specifics of what must change.`
      : `Answer with message_agent (agent "${asker.id}", reply_to "${id}"): decide, and say why.${blocking ? ' They have stopped until you answer.' : ' They are carrying on with other work meanwhile.'}`;
  return { consult: get('SELECT * FROM consults WHERE id = ?', id)!, message: `<${tag} ${attrs}>\n${about}${question}\n\n${how}\n</${tag}>` };
}

export function getConsult(id: string): Row | undefined {
  return get('SELECT * FROM consults WHERE id = ?', id);
}

/** Open consults `asker` sent to `manager`, oldest first. */
export function openConsults(askerId: string, managerId: string): Row[] {
  return all("SELECT * FROM consults WHERE asker_id = ? AND manager_id = ? AND status = 'open' ORDER BY created_at", askerId, managerId);
}

export function hasOpenBlockingConsult(askerId: string): boolean {
  return !!get("SELECT 1 AS x FROM consults WHERE asker_id = ? AND status = 'open' AND blocking = 1 LIMIT 1", askerId);
}

/** Record the manager's answer and build the message for the asker. */
export function answerConsult(c: Row, manager: Row, text: string, verdict: Verdict | undefined): string {
  run("UPDATE consults SET status = 'answered', answer = ?, verdict = ?, answered_at = ? WHERE id = ?", text, verdict ?? null, now(), c.id);
  const asker = getAgent(c.asker_id);
  // Put back the status the asker had before it started waiting, unless it has moved on since.
  if (asker && asker.status_line === waitingLine(c.kind, manager)) {
    const prev = JSON.parse(c.detail || '{}').prevStatus ?? '';
    run('UPDATE agents SET status_line = ?, updated_at = ? WHERE id = ?', prev, now(), asker.id);
  }
  touchProject(c.project_id);
  const v = verdict ? ` verdict="${verdict}"` : '';
  const lead = c.kind === 'review' ? `Review ${verdict ? VERDICT_TEXT[verdict] : 'answered'}.\n\n` : '';
  return `<manager-answer from="${attr(manager.name)}" ref="${c.id}" kind="${c.kind}"${v}>\n${lead}${text}\n</manager-answer>`;
}

/** The asker was closed: nothing will read the answer. */
export function dropConsults(askerId: string) {
  run("UPDATE consults SET status = 'dropped', answered_at = ? WHERE asker_id = ? AND status = 'open'", now(), askerId);
}

/** For the web: what each agent is waiting on its manager for. */
export function openConsultViews(projectId: string): Row[] {
  return all("SELECT id, asker_id, manager_id, task_id, kind, blocking, created_at FROM consults WHERE project_id = ? AND status = 'open' ORDER BY created_at", projectId);
}

