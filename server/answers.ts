import { get, now, run, tx } from './db.ts';
import { onTestBuildAnswer } from './testbuilds.ts';
import { getAgent, getProject, touchProject } from './store.ts';
import { bindAttachments, pendingAttachments } from './attachments.ts';
import { ACTION_CHOICES, needsAnswered } from './requests.ts';
import { settle } from './triage.ts';
import { noteRequestAnswered } from './pins.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { answerAgentError } from './agenterrors.ts';
import { onProgressAnswer } from './progress.ts';
import { onWatchdogAnswer } from './watchdog.ts';
import { onRevisitAnswer } from './discrevisit.ts';
import { onWatchAnswer } from './watches.ts';
import { onToolboxAnswer } from './toolbox.ts';
import { actionLabel, performAction } from './reqactions.ts';
import type { RequestAction } from './reqactions.ts';
import { onReleaseAnswer } from './releases.ts';
import { deferRequest, defers } from './reminders.ts';
import { openCards } from './speccards.ts';
import { onWorkAnswer } from './crossproject.ts';

// The user's answers to requests (server/api.ts). Database work plus a message to the agent, so it runs in the web
// service as well as in one process; a permission answer wakes the waiting agent through server/agents.ts.

/** What a note alone stands for on each kind of request (none: the note is the answer, or the kind picks its own). */
export const noteChoice = (kind: string): string | undefined => (kind === 'action' ? 'Done' : kind === 'permission' || kind === 'structure' ? 'Deny' : undefined);

/**
 * Answer a request. `attachments` (ids of pending uploads, for a question only) go with the answer: they become the
 * request's own (owner 'inbox'), show under the answer in its thread, and reach the agent in an <attachments> block
 * as files sent with a thread message do. An answer may be files only.
 */
export async function answerInbox(id: string, input: { choice?: string; text?: string; dismiss?: boolean; attachments?: unknown; all?: boolean; perform?: boolean }): Promise<string | null> {
  const item = get('SELECT * FROM inbox WHERE id = ?', id);
  if (!item) return 'No such request.';
  if (item.kind === 'permission' ? !['open', 'director', 'check'].includes(item.status) : item.status !== 'open') {
    return `Already answered${item.decided_by && item.decided_by !== 'user' ? ` by ${item.decided_by === 'check' ? 'the independent check' : item.decided_by === 'auto' ? 'Helm automatically' : 'the director'}` : ''}.`;
  }
  // A note on its own settles the request like pressing a button (the user's "Send"): a to-do is Done, a permission or a
  // structure proposal is Denied with the note as the reason (a note never approves), a question is answered by it.
  // An agent's error is handled in answerAgentError. Anything more the agent needs comes as a new request.
  if (!input.dismiss && !input.choice && input.text?.trim()) {
    const alone = noteChoice(item.kind);
    if (alone) input = { ...input, choice: alone };
  }
  const sent = input.dismiss ? { rows: [] } : pendingAttachments(item.project_id, input.attachments, id);
  if ('error' in sent) return sent.error;
  const files = sent.rows;
  if (files.length && item.kind !== 'question' && item.kind !== 'action') return 'Files can only be sent with the answer to a question or a to-do.';
  const filesNote = files.length ? `(sent ${files.length === 1 ? 'a file' : `${files.length} files`})` : '';
  // The request's inline action (reqactions.ts), done now because the user tapped it: its button (perform), or the
  // option it rides on. Done as the user, through the dashboard's own code; a failure leaves the request open.
  const act: RequestAction | undefined = item.kind === 'question' || item.kind === 'action' ? JSON.parse(item.payload || '{}').act : undefined;
  if (act && !input.dismiss && (input.perform || (act.option && input.choice === act.option))) {
    const res = await performAction(act);
    if ('error' in res) return res.error;
    input = { ...input, choice: item.kind === 'action' ? 'Done' : act.option ?? actionLabel(act), text: [res.done, input.text].filter(Boolean).join('. ') };
  }
  const answer = [input.choice, input.text].filter(Boolean).join(' — ') || filesNote;

  if (item.kind === 'permission') {
    if (!input.dismiss && !['Allow', 'Always allow', 'Deny'].includes(input.choice ?? '')) return 'Choose Allow, Always allow or Deny.';
    if (input.choice === 'Always allow' && !JSON.parse(item.payload).canAlways) return 'This request cannot be allowed always; choose Allow or Deny.';
    const allow = !input.dismiss && (input.choice === 'Allow' || input.choice === 'Always allow');
    // First answer wins: the director or the independent check may have decided it a moment ago.
    return settle(id, { allow, always: input.choice === 'Always allow', message: input.text ?? '' }, { status: input.dismiss ? 'dismissed' : 'answered', answer: answer || 'Dismissed', by: input.dismiss ? null : 'user' });
  }

  // An agent that stopped with an error: Resume, Ask the director, Close the agent (agenterrors.ts).
  if (item.kind === 'agent_error') return answerAgentError(item, input);

  // A team change proposed before teams were retired (Helm starts a fresh builder per task): nothing to apply.
  if (item.kind === 'structure') {
    run("UPDATE inbox SET status = 'dismissed', answer = ?, answered_at = ? WHERE id = ?", 'Team changes were retired: nothing was applied', now(), id);
    touchProject(item.project_id);
    return null;
  }

  // A discussion's revisit reminder: Continue, Close, Archive or Not now act here (discrevisit.ts), with no deferral.
  if (item.kind === 'question' && (await onRevisitAnswer(item, input.choice, !!input.dismiss))) return null;
  if (item.kind === 'action' && !input.dismiss && !(ACTION_CHOICES as readonly string[]).includes(input.choice ?? '')) return `Choose ${ACTION_CHOICES.join(' or ')}.`;
  if (!input.dismiss && !answer.trim()) return 'Choose an option, write an answer or attach a file.';
  // A to-do about Spec edit cards (speccards.ts) is done by deciding its cards: Apply or Not this on each settles it.
  if (item.kind === 'action' && !input.dismiss && input.choice === 'Done') {
    const left = openCards(item);
    if (left) return `Apply or decline ${left === 1 ? 'the Spec edit card' : `the ${left} Spec edit cards`} on this to-do: deciding ${left === 1 ? 'it' : 'the last one'} marks it done.`;
  }
  tx(() => {
    run('UPDATE inbox SET status = ?, answer = ?, answered_at = ? WHERE id = ?', input.dismiss ? 'dismissed' : 'answered', answer || 'Dismissed', now(), id);
    bindAttachments(files, 'inbox', id);
    needsAnswered(id);
  });
  // A question linked to a pinned proposal: its answer is recorded there as the choice (pins.ts).
  if (!input.dismiss) noteRequestAnswered(id);
  // A test request (testbuilds.ts): its build has its feedback, answered or dismissed; the cleanup counts from here.
  onTestBuildAnswer(id);
  // Helm's pause after a second progress flag: Resume or Drop act on the task (progress.ts).
  if (!input.dismiss && item.kind === 'question') onProgressAnswer(item, input.choice);
  // The watchdog's Stalled request: Resume wakes the driver, Drop drops the task (watchdog.ts).
  if (!input.dismiss && item.kind === 'question') onWatchdogAnswer(item, input.choice);
  // A watch's command waiting for approval (watches.ts): Approve lets exactly that command run, Decline pauses it.
  if (!input.dismiss && item.kind === 'question') onWatchAnswer(item, input.choice);
  // A tool proposal (toolbox.ts): Decline declines the item; Install already ran as the request's action.
  if (!input.dismiss && item.kind === 'question') onToolboxAnswer(item, input.choice, input.text);
  // A publish confirmation (releases.ts): Publish brings the director the project's publish instructions.
  const release = !input.dismiss && item.kind === 'question' ? onReleaseAnswer(item, input.choice) : '';
  // A work request to another project (crossproject.ts): Allow delivers it to that project's director, else nothing goes.
  const work = !input.dismiss && item.kind === 'question' ? await onWorkAnswer(item, input.choice) : '';
  // "Not now": Helm asks again later (reminders.ts); the third time it stops and tells the director.
  const deferred = !input.dismiss && defers(item, input.choice) ? await deferRequest(item) : null;
  if (item.task_id) run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), item.task_id);
  touchProject(item.project_id);
  if (input.dismiss) return null;

  const project = getProject(item.project_id)!;
  let target = item.agent_id ? getAgent(item.agent_id) : undefined;
  if (!target || target.status === 'closed') target = rootAgent(project);
  // An answer to a question about a task carries the task, so the reply to it goes to that task's thread.
  const about = (item.task_id ? ` task="${item.task_id}"` : '') + (item.kind === 'action' ? ' kind="to-do"' : '');
  const later = deferred ? (deferred.status === 'pending' ? '\n(Helm will ask the user again later, as a new request. To stop that, withdraw_request this one.)' : '\n(Deferred a third time: Helm stops reminding them.)') : '';
  await sendToAgent(target.id, `<user-answer request="${item.title}"${about}>\n${answer}${release}${work}${later}\n</user-answer>`, { kind: 'user', name: 'You' }, files, false);
  return null;
}
