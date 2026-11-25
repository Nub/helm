import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getAgent, getChecklist, touchProject } from './store.ts';
import { createRequest } from './requests.ts';
import { closeAgent, rootAgent, sendToAgent } from './agents.ts';
import { clockText } from './clock.ts';
import { limitPeers, parseResetText, resumeAfter, usagePlain } from './errorview.ts';
import { holdsNewWork } from './projectmode.ts';

/**
 * Agents that stop with an error: one request of kind 'agent_error' per agent, so the user finds it under Needs you.
 *
 * What counts as an error: a turn that ended without success while nobody stopped it on purpose, or a Claude Code
 * process that ended by itself (threw) while Helm was not closing it. Not errors: the user stopping a turn
 * (interrupted), Helm closing the process (idle timeout, an update or restart, a Toolbox change, closing the agent),
 * and the restart recovery (recoverOnBoot marks those interrupted; they resume). turnFailure decides it; the runtime
 * sets the agent's status to 'error' exactly when it returns something.
 *
 * The entry lives on the agent's task (or its standing "Requests from" holder when it has none, requests.ts). A turn
 * that fails again before any successful one bumps the same entry's count instead of filing another; the entry is
 * withdrawn when the agent runs again and closed with the agent. The director hears once per errored agent (not per
 * retry), unless the cause is account-wide (it would hit the same wall) or the director is itself stopped.
 */

export type ErrorKind = 'usage_limit' | 'sign_in' | 'billing' | 'overloaded' | 'crashed' | 'turn_limit' | 'budget' | 'too_long' | 'model' | 'other';

export type Failure = {
  kind: ErrorKind;
  /** A few words for the title: "usage limit reached". */
  short: string;
  /** The error in plain words, with what to do about it. */
  plain: string;
  /** What Claude Code said, kept for a disclosure. */
  raw: string;
  /** When a usage limit resets (ms), if known. */
  resetsAt: number | null;
};

/** How a turn or process ended, as the runtime saw it. */
export type TurnEnd = {
  /** The user stopped the turn (Stop turn). */
  interrupted?: boolean;
  /** Helm was closing the process on purpose (idle, update, restart, close, Toolbox change). */
  closing?: boolean;
  /** The result message said success. */
  ok?: boolean;
  /** The result message's subtype, when there was one. */
  subtype?: string;
  /** The result's text (or its errors joined). */
  text?: string;
  /** The last assistant message's error code this turn (SDKAssistantMessageError). */
  apiError?: string | null;
  /** The process threw: its message ("Claude Code process exited with code 1"). */
  thrown?: string;
  /** From a rejected rate_limit_event: when the limit resets, in seconds or ms. */
  resetsAt?: number | null;
};

/** Account-wide causes: every agent on the account hits them, so waking the director to act on them is no use. */
const ACCOUNT_WIDE: ErrorKind[] = ['usage_limit', 'sign_in', 'billing'];

/** Whether a turn's end is an error, and which: null for success and for every deliberate stop. */
export function turnFailure(end: TurnEnd): Failure | null {
  if (end.interrupted || end.closing) return null;
  if (end.thrown === undefined && end.ok) return null;
  const raw = (end.thrown ?? end.text ?? '').trim();
  const api = end.apiError ?? '';
  // The rate-limit event's reset time (seconds or ms), else the one Claude Code wrote ("resets Nov 21, 12pm (UTC)").
  const resetsAt = end.resetsAt ? (end.resetsAt < 1e12 ? end.resetsAt * 1000 : end.resetsAt) : parseResetText(raw);
  const make = (kind: ErrorKind, short: string, plain: string): Failure => ({ kind, short, plain, raw: raw.slice(0, 4000), resetsAt: kind === 'usage_limit' ? resetsAt : null });

  if (api === 'rate_limit' || /\b(usage|weekly|session|daily|5-hour|five-hour|opus|sonnet) limit\b|hit your limit|limit reached|resets? at\b|\bresets\b/i.test(raw)) {
    return make('usage_limit', 'usage limit reached', usagePlain(resetsAt));
  }
  if (['authentication_failed', 'oauth_org_not_allowed'].includes(api) || /\b(oauth|authenticat|log ?in|sign ?in|invalid api key|api key|unauthori[sz]ed|401|token (has )?expired)/i.test(raw)) {
    return make('sign_in', 'sign-in expired', "Claude's sign-in has expired or was refused. Sign in again on the machine Helm runs on (run claude, then /login), then resume it.");
  }
  if (['billing_error', 'account_on_hold', 'verification_required', 'cloud_credential_error'].includes(api) || /\b(billing|credit balance|payment|account (is )?on hold)\b/i.test(raw)) {
    return make('billing', 'account problem', 'The Claude account has a billing or account problem. Fix it in the account, then resume it.');
  }
  if (['overloaded', 'server_error'].includes(api) || /overloaded|\b529\b|\b50[0234]\b|internal server error|service unavailable|api error|connection (error|reset|refused)|timed? ?out|econnreset|fetch failed/i.test(raw)) {
    return make('overloaded', 'Claude overloaded', "Claude's servers were overloaded or failing when its turn ran. That usually passes: resume it.");
  }
  if (end.subtype === 'error_max_turns') return make('turn_limit', 'turn limit reached', 'It used up the number of steps one run may take. Resume it to carry on.');
  if (end.subtype === 'error_max_budget_usd') return make('budget', 'budget reached', 'It reached the spending limit set for one run. Resume it to carry on.');
  if (/prompt is too long|context (window|length)|too many tokens|max_output_tokens/i.test(raw) || api === 'max_output_tokens') {
    return make('too_long', 'conversation too long', 'Its conversation grew too long for the model. Resume it (it compacts), or close it and start a fresh agent on the work.');
  }
  if (api === 'model_not_found' || /model.*(not found|not available|does not exist)/i.test(raw)) {
    return make('model', 'model unavailable', 'The model its role uses is not available to this account. Change the role\'s model in Setup › Team, then resume it.');
  }
  if (end.thrown !== undefined) {
    return make('crashed', 'process crashed', `Its Claude Code process stopped unexpectedly${raw ? ` (${raw.split('\n')[0].slice(0, 160)})` : ''}. Resume it to start a new one.`);
  }
  return make('other', 'stopped with an error', 'Its turn ended with an error. The details below say what Claude Code reported; resuming often works.');
}

// ---------- hooks into the runtime (set by runtime.ts; tests replace them) ----------

type Hooks = {
  send: (agentId: string, text: string, from: { kind: 'agent' | 'user' | 'system'; name: string }) => Promise<void>;
  close: (agentId: string) => Promise<void>;
  root: (project: Row) => Row;
};
let hooks: Hooks | null = null;
let timer: NodeJS.Timeout | null = null;
/** Set by the process that runs agents; it also starts the check for scheduled resumes (and runs it once now, after a restart). */
export function setAgentErrorHooks(h: Hooks) {
  hooks = h;
  if (!timer) {
    timer = setInterval(() => void runDueResumes().catch((err) => console.error('Scheduled resume failed:', err)), 20_000);
    timer.unref();
  }
  void runDueResumes().catch(() => {});
}


const openEntry = (agentId: string) => get("SELECT * FROM inbox WHERE agent_id = ? AND kind = 'agent_error' AND status = 'open' ORDER BY created_at DESC LIMIT 1", agentId);

/** What the agent was doing: the worklist item in progress, else its status line. */
function doingOf(agent: Row): string {
  const doing = getChecklist(agent.id).find((i) => i.state === 'doing');
  return (doing?.text ?? agent.status_line ?? '').trim();
}

/** The note for the director about an errored agent. `asked`: the user chose Ask the director, with their note. */
export function directorNote(agent: Row, f: { short: string; plain: string; raw: string }, asked?: { note: string }): string {
  const task = agent.task_id ? get('SELECT id, title FROM tasks WHERE id = ?', agent.task_id) : undefined;
  const on = task ? ` working on [[${task.id}]]` : '';
  const lead = asked
    ? `The user asks you to deal with ${agent.name} (${agent.id}), which stopped with an error${on}: ${f.short}.`
    : `${agent.name} (${agent.id}) stopped with an error${on}: ${f.short}. The user has an entry for it under Needs you.`;
  return [
    `<helm-note kind="agent-error" agent="${agent.id}"${task ? ` task="${task.id}"` : ''}>`,
    lead,
    f.plain,
    `What Claude Code said: ${f.raw.slice(0, 600) || '(nothing)'}`,
    ...(asked?.note ? [`The user's note: ${asked.note}`] : []),
    `Resume it with message_agent when the cause has passed, or close it (close_agent) and give its work to a new agent. Say in its task's thread what you did.`,
    '</helm-note>',
  ].join('\n');
}

/**
 * An agent's turn ended in error (status already set to 'error'). Files its entry, or bumps the open one, or reopens
 * the last one if no turn has succeeded since. Returns the note for the director when this is the first entry of the
 * streak and the director should hear of it; `deliver` false means the caller sends it (with the agent-report).
 */
export function agentErrored(agentId: string, f: Failure, deliver = true): string | null {
  const agent = getAgent(agentId);
  if (!agent || agent.status === 'closed') return null;
  const at = now();
  const doing = doingOf(agent);
  const latest = get("SELECT * FROM inbox WHERE agent_id = ? AND kind = 'agent_error' ORDER BY created_at DESC LIMIT 1", agentId);
  const lastOk = Number(get("SELECT MAX(ts) AS t FROM events WHERE agent_id = ? AND kind = 'result' AND json_extract(data, '$.ok') = 1", agentId)?.t ?? 0);
  // The same streak: its entry is still open, or was withdrawn or answered (not closed) and no turn has succeeded since.
  const same = latest && (latest.status === 'open' || (latest.answer !== 'Agent closed' && lastOk < latest.created_at));
  if (same) {
    const p = JSON.parse(latest.payload);
    const payload = { ...p, error_kind: f.kind, plain: f.plain, raw: f.raw, resets_at: f.resetsAt, count: (p.count ?? 1) + 1, last_at: at, doing: doing || p.doing };
    tx(() => {
      run("UPDATE inbox SET status = 'open', answer = '', answered_at = NULL, title = ?, body = ?, payload = ? WHERE id = ?", titleOf(agent, f), f.plain, JSON.stringify(payload), latest.id);
      if (latest.task_id) run('UPDATE tasks SET updated_at = ? WHERE id = ?', at, latest.task_id);
    });
    touchProject(agent.project_id);
    return null;
  }
  const root = !agent.parent_id;
  createRequest({
    projectId: agent.project_id,
    agentId,
    kind: 'agent_error',
    title: titleOf(agent, f),
    body: f.plain,
    options: choicesFor({ error_kind: f.kind, resets_at: f.resetsAt, root }).map((label) => ({ label })),
    payload: { error_kind: f.kind, plain: f.plain, raw: f.raw, resets_at: f.resetsAt, count: 1, last_at: at, doing, root },
    importance: 4,
    blocking: false,
  });
  if (root || ACCOUNT_WIDE.includes(f.kind)) return null;
  const director = get("SELECT * FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", agent.project_id);
  if (!director || director.status === 'error') return null;
  const note = directorNote(agent, f);
  if (deliver) void hooks?.send(director.id, note, { kind: 'system', name: 'Helm' }).catch(() => {});
  return note;
}

const titleOf = (agent: Row, f: Failure) => `${agent.name} stopped: ${f.short}`;

/** The agent runs again (any message started a turn) or was closed: its open entry is withdrawn, and a resume it had scheduled is moot. */
export function agentRunning(agentId: string, why = 'Withdrawn: the agent ran again') {
  run('UPDATE agents SET resume_at = NULL WHERE id = ? AND resume_at IS NOT NULL', agentId);
  const r = openEntry(agentId);
  if (!r) return;
  run("UPDATE inbox SET status = 'dismissed', answer = ?, answered_at = ? WHERE id = ?", why, now(), r.id);
  touchProject(r.project_id);
}

/** The usage limit's words now (the reset time in the user's zone), else what was stored. */
const plainOf = (payload: Row) => (payload.error_kind === 'usage_limit' ? usagePlain(payload.resets_at) : payload.plain ?? '');

/** The choices an entry takes now: Resume when the limit resets only while the reset is ahead; no Ask the director for the director. */
export function choicesFor(payload: Row): string[] {
  const wait = payload.error_kind === 'usage_limit' && !!payload.resets_at && payload.resets_at > now() - 60_000;
  return ['Resume', ...(wait ? [WAIT] : []), ...(payload.root ? [] : ['Ask the director']), 'Close the agent'];
}

const resumeNote = (why: string, note = '') =>
  `<helm-note>${why} Pick up where you left off: check your worklist and the state of the files first.${note ? `\nThe user's note: ${note}` : ''}</helm-note>`;

/**
 * The user answered an agent_error request: Resume (re-queues the agent with their note), Resume when the limit
 * resets (schedules it, agents.resume_at), Ask the director (a note naming the agent, task and error), or Close the
 * agent. `all`: Resume and Resume when the limit resets apply to every open entry stopped by the same usage limit
 * in the project. Returns an error message or null.
 */
export async function answerAgentError(item: Row, input: { choice?: string; text?: string; dismiss?: boolean; all?: boolean }): Promise<string | null> {
  const payload = JSON.parse(item.payload);
  const note = input.text?.trim() ?? '';
  const choices = choicesFor(payload);
  // A note on its own: the first choice (Resume, which hands the agent the note).
  if (!input.dismiss && !input.choice && note) input = { ...input, choice: choices[0] };
  if (!input.dismiss && !choices.includes(input.choice ?? '')) return `Choose ${choices.join(', ').replace(/, ([^,]*)$/, ' or $1')}.`;
  const batch = !input.dismiss && input.all && (input.choice === 'Resume' || input.choice === WAIT);
  const items = batch ? [item, ...limitPeers(item).filter((r) => r.id !== item.id)] : [item];
  const at = input.choice === WAIT ? resumeAfter(payload.resets_at) : 0;
  const answer = input.dismiss ? 'Dismissed' : [input.choice === WAIT ? `${WAIT}: resumes ${clockText(at)}` : input.choice, note].filter(Boolean).join(' — ');
  tx(() => {
    for (const r of items) {
      run("UPDATE inbox SET status = ?, answer = ?, answered_at = ? WHERE id = ? AND status = 'open'", input.dismiss ? 'dismissed' : 'answered', answer, now(), r.id);
      if (r.task_id) run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), r.task_id);
      if (at && r.agent_id) run("UPDATE agents SET resume_at = ? WHERE id = ? AND status != 'closed'", at, r.agent_id);
    }
  });
  touchProject(item.project_id);
  if (input.dismiss || at) return null;
  // In the process that runs agents, its hooks; in the web service (server/runner.ts), the facade, which hands the
  // message or the close to the runner as a command.
  const h: Hooks = hooks ?? { send: (id, text, from) => sendToAgent(id, text, from), close: (id) => closeAgent(id, 'closed'), root: (project) => rootAgent(project) };
  for (const r of items) {
    const agent = r.agent_id ? getAgent(r.agent_id) : undefined;
    if (!agent || agent.status === 'closed') continue;
    const p = JSON.parse(r.payload);
    if (input.choice === 'Resume') {
      await h.send(agent.id, resumeNote(`The user resumed you after your last turn stopped with an error (${plainOf(p) || 'see your transcript'}).`, note), { kind: 'user', name: 'You' });
    } else if (input.choice === 'Close the agent') {
      await h.close(agent.id);
    } else {
      const project = get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
      const director = h.root(project);
      await h.send(director.id, directorNote(agent, { short: String(r.title).replace(/^.*? stopped: /, ''), plain: plainOf(p), raw: p.raw ?? '' }, { note }), { kind: 'user', name: 'You' });
    }
  }
  return null;
}

/** "Resume when the limit resets": offered when the reset time is known and ahead. */
export const WAIT = 'Resume when the limit resets';

/**
 * Cancel an agent's scheduled resume: its entry goes back under Needs you. Returns an error message or null. Only
 * the database changes, so either Helm process may call it.
 */
export function cancelResume(agentId: string): string | null {
  const agent = getAgent(agentId);
  if (!agent?.resume_at) return 'No resume is scheduled for this agent.';
  tx(() => {
    run('UPDATE agents SET resume_at = NULL WHERE id = ?', agentId);
    const latest = get("SELECT * FROM inbox WHERE agent_id = ? AND kind = 'agent_error' ORDER BY created_at DESC LIMIT 1", agentId);
    if (latest && latest.status !== 'open' && agent.status === 'error') run("UPDATE inbox SET status = 'open', answer = '', answered_at = NULL WHERE id = ?", latest.id);
  });
  touchProject(agent.project_id);
  return null;
}

/**
 * Resume every agent whose scheduled time has come (agents.resume_at), once: the time is cleared before the
 * message goes. Stored in the database, so a schedule made before a restart still runs after it (at the first
 * check, if its time passed while Helm was down). An agent no longer stopped (closed, or already running) is left be.
 */
export async function runDueResumes(at = now()): Promise<number> {
  if (!hooks) return 0;
  let n = 0;
  for (const a of all('SELECT * FROM agents WHERE resume_at IS NOT NULL AND resume_at <= ?', at)) {
    // Held while the project winds down, rests or is stopped (projectmode.ts): it runs once the user resumes it.
    if (holdsNewWork(a.project_id)) continue;
    run('UPDATE agents SET resume_at = NULL WHERE id = ?', a.id);
    touchProject(a.project_id);
    if (a.status !== 'error') continue;
    n++;
    await hooks.send(a.id, resumeNote('The usage limit has reset, and Helm resumed you as the user asked.'), { kind: 'system', name: 'Helm' }).catch(() => {});
  }
  return n;
}
