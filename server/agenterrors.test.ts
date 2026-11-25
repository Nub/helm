import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A Claude Code that exits at once with an error, as a crashed process does.
const crash = join(SCRATCH, 'claude-crash');
writeFileSync(crash, '#!/bin/sh\necho boom >&2\nexit 1\n');
chmodSync(crash, 0o755);
process.env.HELM_CLAUDE_PATH = crash;

/**
 * Agents that stop with an error (agenterrors.ts): which ends count, one entry per agent with a count, withdrawn when
 * the agent runs again or is closed, and the director told once. The Claude binary is a script that exits with code 1,
 * so an agent sent a message really starts a process that ends at once: the "process crashed" path, end to end.
 */

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const errs = await import('./agenterrors.ts');
const view = await import('./errorview.ts');
const clock = await import('./clock.ts');

const sent: { to: string; text: string; from: string }[] = [];
errs.setAgentErrorHooks({
  send: async (to, text, from) => void sent.push({ to, text, from: from.kind }),
  close: (id) => runtime.closeAgent(id, 'closed'),
  root: (p) => runtime.rootAgent(p),
});

const projectPath = mkdtempSync(join(SCRATCH, 'proj-'));
function makeProject() {
  const id = db.newId('pr');
  db.run(
    'INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    id, 'p', projectPath, 'Build', 'supervised', JSON.stringify(defaultStructure()), db.now(), db.now(),
  );
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root)!;
  const worker = runtime.createAgent(project, director, role, 'Engineer', 'Build it.');
  return { project, director, worker };
}
const entries = (agentId: string) => db.all("SELECT * FROM inbox WHERE agent_id = ? AND kind = 'agent_error' ORDER BY created_at", agentId);
const agentOf = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

test('classification: error kinds, and deliberate stops are not errors', () => {
  const rows: [string, Parameters<typeof errs.turnFailure>[0], string | null][] = [
    ['real case: weekly limit', { ok: false, subtype: 'success', apiError: 'rate_limit', text: "You've hit your weekly limit · resets Nov 21, 12pm (UTC)" }, 'usage_limit'],
    ['limit text without the code', { ok: false, subtype: 'success', text: "You've hit your session limit · resets 3am" }, 'usage_limit'],
    ['sign-in', { ok: false, subtype: 'success', apiError: 'authentication_failed', text: 'Invalid API key · Please run /login' }, 'sign_in'],
    ['OAuth expired, text only', { ok: false, subtype: 'success', text: 'OAuth token has expired. Please obtain a new token or refresh your existing token.' }, 'sign_in'],
    ['billing', { ok: false, subtype: 'success', apiError: 'billing_error', text: 'Credit balance is too low' }, 'billing'],
    ['overloaded', { ok: false, subtype: 'success', apiError: 'overloaded', text: 'API Error: 529 Overloaded' }, 'overloaded'],
    ['server error', { ok: false, subtype: 'success', text: 'API Error: 500 Internal server error' }, 'overloaded'],
    ['turn limit', { ok: false, subtype: 'error_max_turns', text: 'Turn ended early (error_max_turns). ' }, 'turn_limit'],
    ['budget', { ok: false, subtype: 'error_max_budget_usd', text: 'Turn ended early (error_max_budget_usd). ' }, 'budget'],
    ['too long', { ok: false, subtype: 'success', text: 'Prompt is too long' }, 'too_long'],
    ['model', { ok: false, subtype: 'success', apiError: 'model_not_found', text: 'model: claude-x not found' }, 'model'],
    ['process crashed', { thrown: 'Claude Code process exited with code 1' }, 'crashed'],
    ['anything else', { ok: false, subtype: 'error_during_execution', text: 'Turn ended early (error_during_execution). boom' }, 'other'],
    // Not errors.
    ['success', { ok: true, subtype: 'success', text: 'Done.' }, null],
    ['stopped by the user', { interrupted: true, ok: false, subtype: 'error_during_execution', text: 'aborted' }, null],
    ['closed on purpose (idle timeout, update, restart, close)', { closing: true, thrown: 'Claude Code process exited with code 143' }, null],
  ];
  for (const [name, end, kind] of rows) assert.equal(errs.turnFailure(end)?.kind ?? null, kind, name);
  const limit = errs.turnFailure(rows[0][1])!;
  // The reset time read from Claude Code's text, shown in the user's zone through clock.ts: never its own '(UTC)'.
  assert.ok(limit.resetsAt);
  assert.ok(limit.plain.includes(`resets ${clock.clockText(limit.resetsAt!)}`), limit.plain);
  assert.doesNotMatch(limit.plain, /UTC|12pm/);
  assert.equal(limit.raw, "You've hit your weekly limit · resets Nov 21, 12pm (UTC)");
  // A reset time from the rate-limit event wins over the text, in seconds or ms.
  assert.equal(errs.turnFailure({ ok: false, apiError: 'rate_limit', text: 'limit', resetsAt: 1_800_000_000 })!.resetsAt, 1_800_000_000_000);
});

test('a crashing worker: one entry with a count, withdrawn while it runs, the director told once, closed with the agent', async () => {
  const { worker, director } = makeProject();
  sent.length = 0;
  await runtime.sendToAgent(worker.id, 'Start.', { kind: 'agent', name: 'Director' });
  await until(() => agentOf(worker.id).status === 'error' && entries(worker.id).length === 1);
  let [e] = entries(worker.id);
  assert.equal(e.status, 'open');
  assert.match(e.title, /^Engineer stopped: process crashed$/);
  const p = JSON.parse(e.payload);
  assert.equal(p.error_kind, 'crashed');
  assert.equal(p.count, 1);
  assert.match(p.raw, /exited/);
  assert.deepEqual(JSON.parse(e.options).map((o: any) => o.label), ['Resume', 'Ask the director', 'Close the agent']);
  // Homed like a permission request: the agent has no task, so its standing holder.
  assert.ok(db.get('SELECT 1 AS x FROM tasks WHERE id = ? AND requests_agent_id = ?', e.task_id, worker.id));
  const notes = () => sent.filter((s) => s.to === director.id && s.text.includes('kind="agent-error"'));
  await until(() => notes().length === 1);
  assert.match(notes()[0].text, /Engineer \(ag_[^)]+\) stopped with an error/);

  // It runs again: withdrawn at once. It fails again: the same entry comes back with count 2, and no second note.
  const again = runtime.sendToAgent(worker.id, 'Try again.', { kind: 'agent', name: 'Director' });
  assert.equal(entries(worker.id)[0].status, 'dismissed');
  await again;
  await until(() => agentOf(worker.id).status === 'error' && entries(worker.id)[0].status === 'open');
  assert.equal(entries(worker.id).length, 1);
  [e] = entries(worker.id);
  assert.equal(JSON.parse(e.payload).count, 2);
  await sleep(50);
  assert.equal(notes().length, 1);

  await runtime.closeAgent(worker.id, 'closed');
  [e] = entries(worker.id);
  assert.deepEqual([e.status, e.answer], ['dismissed', 'Agent closed']);
});

test('the director: no Ask the director, no note to itself; a success in between starts a new entry', async () => {
  const { director } = makeProject();
  sent.length = 0;
  const f = errs.turnFailure({ ok: false, apiError: 'rate_limit', text: 'weekly limit', resetsAt: Math.round(Date.now() / 1000) + 3600 })!;
  db.run("UPDATE agents SET status = 'error' WHERE id = ?", director.id);
  assert.equal(errs.agentErrored(director.id, f), null);
  const [e] = entries(director.id);
  assert.deepEqual(JSON.parse(e.options).map((o: any) => o.label), ['Resume', 'Resume when the limit resets', 'Close the agent']);
  assert.equal(await runtime.answerInbox(e.id, { choice: 'Ask the director' }), 'Choose Resume, Resume when the limit resets or Close the agent.');
  errs.agentErrored(director.id, f);
  assert.equal(entries(director.id).length, 1);
  assert.equal(JSON.parse(entries(director.id)[0].payload).count, 2);
  // A successful turn: the next failure is a new streak and a new entry.
  errs.agentRunning(director.id);
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)", director.project_id, director.id, db.now() + 1, 'result', JSON.stringify({ ok: true, text: 'fine' }));
  await sleep(5);
  errs.agentErrored(director.id, f);
  const all = entries(director.id);
  assert.deepEqual(all.map((r) => r.status), ['dismissed', 'open']);
  assert.equal(JSON.parse(all[1].payload).count, 1);
  assert.equal(sent.length, 0);
});

test('answers: Ask the director sends it a note; Resume re-queues the agent with the note; usage limits do not wake the director', async () => {
  const { worker, director } = makeProject();
  db.run("UPDATE agents SET status = 'error' WHERE id = ?", worker.id);
  sent.length = 0;
  const limit = errs.turnFailure({ ok: false, apiError: 'rate_limit', text: 'weekly limit' })!;
  errs.agentErrored(worker.id, limit);
  assert.equal(sent.length, 0, 'account-wide: the director would hit the same wall');
  const [e] = entries(worker.id);
  assert.equal(await runtime.answerInbox(e.id, { choice: 'Ask the director', text: 'Swap it for a fresh one.' }), null);
  assert.equal(entries(worker.id)[0].status, 'answered');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, director.id);
  assert.match(sent[0].text, /The user asks you to deal with Engineer/);
  assert.match(sent[0].text, /The user's note: Swap it for a fresh one\./);

  // Fails again before any success: the answered entry reopens (count 2); Resume sends the agent the note.
  errs.agentErrored(worker.id, limit);
  const [r] = entries(worker.id);
  assert.deepEqual([r.status, JSON.parse(r.payload).count], ['open', 2]);
  sent.length = 0;
  assert.equal(await runtime.answerInbox(r.id, { choice: 'Resume', text: 'The limit has reset.' }), null);
  assert.equal(sent[0].to, worker.id);
  assert.match(sent[0].text, /resumed you[\s\S]*The user's note: The limit has reset\./);
});

test('reset times in what Claude Code says', () => {
  const at = Date.UTC(2026, 10, 19, 1, 0); // Thu Nov 19, 1:00 am UTC
  assert.equal(view.parseResetText("You've hit your weekly limit · resets Nov 21, 12pm (UTC)", at), Date.UTC(2026, 10, 21, 12, 0));
  // A time with no date is the next one; the zone in brackets counts (PST is UTC-8 in November).
  assert.equal(view.parseResetText('resets 3am (America/Los_Angeles)', at), Date.UTC(2026, 10, 19, 11, 0));
  assert.equal(view.parseResetText('resets 12:30am (UTC)', at), Date.UTC(2026, 10, 20, 0, 30));
  assert.equal(view.parseResetText('Jan 2 seen in December · resets Jan 2, 9am (UTC)', Date.UTC(2026, 11, 30)), Date.UTC(2027, 0, 2, 9, 0));
  assert.equal(view.parseResetText('no time here', at), null);
});

/** An agent stopped by a usage limit that resets at `resetsAt`, with its open entry. */
function stoppedByLimit(project: any, director: any, name: string, resetsAt: number) {
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root)!;
  const a = runtime.createAgent(project, director, role, name, 'Work.');
  db.run("UPDATE agents SET status = 'error' WHERE id = ?", a.id);
  errs.agentErrored(a.id, { kind: 'usage_limit', short: 'usage limit reached', plain: view.usagePlain(resetsAt), raw: 'limit', resetsAt });
  return { agent: a, entry: entries(a.id)[0] };
}

test('Resume when the limit resets: scheduled in the database, survives a restart, runs once, and all N at once', async () => {
  const { project, director } = makeProject();
  const reset = db.now() + 3_600_000;
  const one = stoppedByLimit(project, director, 'One', reset);
  const two = stoppedByLimit(project, director, 'Two', reset);
  const other = stoppedByLimit(project, director, 'Other', reset + 86_400_000); // a different limit
  // The entry offers the wait, and knows two agents share this limit.
  const shown = db.all("SELECT * FROM inbox WHERE id = ?", one.entry.id).map((r) => ({ ...r, payload: view.errorPayload(r, JSON.parse(r.payload)) }))[0];
  assert.equal(shown.payload.can_wait, true);
  assert.equal(shown.payload.limit_peers, 2);
  assert.match(shown.payload.plain, new RegExp(`resets ${clock.clockText(reset)}`));

  sent.length = 0;
  assert.equal(await runtime.answerInbox(one.entry.id, { choice: 'Resume when the limit resets', all: true }), null);
  for (const a of [one.agent, two.agent]) assert.equal(agentOf(a.id).resume_at, reset + 60_000);
  assert.equal(agentOf(other.agent.id).resume_at, null);
  assert.deepEqual([entries(one.agent.id)[0].status, entries(two.agent.id)[0].status, entries(other.agent.id)[0].status], ['answered', 'answered', 'open']);
  assert.match(entries(two.agent.id)[0].answer, /^Resume when the limit resets: resumes /);
  assert.equal(view.resumesText(agentOf(one.agent.id).resume_at), `Resumes ${clock.clockText(reset + 60_000)}`);
  assert.equal(sent.length, 0, 'nothing is sent before the reset');

  // Not yet due: nothing happens.
  assert.equal(await errs.runDueResumes(reset), 0);
  // A restart: only the database remembers. Helm comes back after the reset and checks at once (setAgentErrorHooks).
  errs.setAgentErrorHooks({ send: async (to, text, from) => void sent.push({ to, text, from: from.kind }), close: (id) => runtime.closeAgent(id, 'closed'), root: (p) => runtime.rootAgent(p) });
  assert.equal(await errs.runDueResumes(reset + 61_000), 2);
  assert.deepEqual(sent.map((s) => s.to).sort(), [one.agent.id, two.agent.id].sort());
  assert.match(sent[0].text, /usage limit has reset/);
  for (const a of [one.agent, two.agent]) assert.equal(agentOf(a.id).resume_at, null);
  // Once only.
  assert.equal(await errs.runDueResumes(reset + 120_000), 0);
});

test('a scheduled resume can be cancelled: the entry is back under Needs you and nothing runs', async () => {
  const { project, director } = makeProject();
  const reset = db.now() + 3_600_000;
  const { agent, entry } = stoppedByLimit(project, director, 'Solo', reset);
  sent.length = 0;
  await runtime.answerInbox(entry.id, { choice: 'Resume when the limit resets' });
  assert.equal(entries(agent.id)[0].status, 'answered');
  assert.equal(errs.cancelResume(agent.id), null);
  assert.equal(agentOf(agent.id).resume_at, null);
  assert.equal(entries(agent.id)[0].status, 'open');
  assert.equal(await errs.runDueResumes(reset + 120_000), 0);
  assert.equal(sent.length, 0);
  assert.equal(errs.cancelResume(agent.id), 'No resume is scheduled for this agent.');
  // Resume with all: every agent stopped by this limit is resumed now.
  const second = stoppedByLimit(project, director, 'Solo 2', reset);
  await runtime.answerInbox(entry.id, { choice: 'Resume', all: true });
  assert.deepEqual(sent.map((s) => s.to).sort(), [agent.id, second.agent.id].sort());
});
