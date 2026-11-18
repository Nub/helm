/**
 * Checks for sessions, away periods, attribution, task timing and the away limits on create_task, against a scratch
 * database with a controllable clock. Run: npm run check:sessions (uses a fresh temporary HELM_DATA).
 */
import '../testenv.ts';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_SESSION_IDLE_SECONDS = '';
const { advanceClock, freezeClock, now, run, get } = await import('../db.ts');
freezeClock();
const S = await import('../sessions.ts');
const T = await import('../tasks.ts');
const { helmTools } = await import('../tools.ts');
const W = await import('../taskwatch.ts');
const { defaultStructure } = await import('../structure.ts');

const MIN = 60_000;
const notes: string[] = [];
S.setSessionNotifier((_p, text) => {
  notes.push(text);
});
let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(
    () => {
      passed++;
      console.log(`ok   ${name}`);
    },
    (err) => {
      console.log(`FAIL ${name}\n${err.stack}`);
      process.exitCode = 1;
    },
  );
}

const pid = 'pr_check';
run('INSERT INTO projects (id, name, path, structure, created_at, updated_at, sessions_backfilled) VALUES (?,?,?,?,?,?,1)', pid, 'Check', '/tmp', JSON.stringify(defaultStructure()), now(), now());
run("INSERT INTO agents (id, project_id, role_id, name, model, status, created_at, updated_at) VALUES ('ag_dir', ?, 'director', 'Director', 'x', 'idle', ?, ?)", pid, now(), now());
const sessions = () => S.listPeriods(pid);

await check('first activity opens a session; more activity extends it', () => {
  assert.equal(S.presence(pid).state, 'away');
  const t0 = now();
  S.recordOwnerActivity(pid);
  advanceClock(10 * MIN);
  S.recordOwnerActivity(pid);
  const p = S.presence(pid);
  assert.equal(p.state, 'session');
  assert.equal(p.since, t0);
  assert.equal(get('SELECT actions FROM sessions WHERE id = ?', p.session_id)!.actions, 2);
});

await check('idle period ends it at the last activity, not when the timer ran', () => {
  const last = get('SELECT last_activity_at FROM sessions WHERE ended_at IS NULL')!.last_activity_at;
  advanceClock(29 * MIN);
  S.sessionTick();
  assert.equal(S.presence(pid).state, 'session', 'not yet idle at 29 min');
  advanceClock(5 * MIN);
  S.sessionTick();
  const p = S.presence(pid);
  assert.equal(p.state, 'away');
  assert.equal(p.since, last);
  assert.equal(get('SELECT ended_reason FROM sessions ORDER BY started_at DESC')!.ended_reason, 'idle');
});

await check('a two-action session with nothing queued asks for a summary', () => {
  assert.equal(notes.length, 1);
  assert.match(notes[0], /summarize_session/);
  assert.match(notes[0], /nothing to start/);
  notes.length = 0;
});

await check('the owner coming back after an empty away period costs no turn', () => {
  advanceClock(60 * MIN);
  S.recordOwnerActivity(pid);
  assert.equal(notes.length, 0);
  const latest = get('SELECT * FROM sessions ORDER BY started_at DESC')!;
  assert.equal(latest.away_summary_by, 'auto');
  assert.match(latest.away_summary, /Quiet/);
});

await check('stepping away ends the session at once; a single-action session with queued work only says to carry on', () => {
  const t = T.createTask(pid, { title: 'Queued thing', state: 'scheduled', origin: 'user' }, T.USER);
  assert.ok(S.stepAway(pid));
  assert.equal(S.presence(pid).state, 'away');
  assert.equal(get('SELECT ended_reason FROM sessions ORDER BY started_at DESC')!.ended_reason, 'stepped_away');
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /summarize_session/);
  assert.match(notes[0], /1 scheduled/);
  notes.length = 0;
  assert.equal(S.stepAway(pid), false, 'nothing open to end');
  run('DELETE FROM tasks WHERE id = ?', t.id);
});

await check('task timing excludes paused stretches; done shows time taken', () => {
  const t = T.createTask(pid, { title: 'Timed', state: 'scheduled', origin: 'director' }, { author: 'director', name: 'Director' });
  advanceClock(5 * MIN);
  const startAt = now();
  T.setTaskState(T.getTask(t.id)!, 'active', { author: 'director', name: 'Director' });
  advanceClock(20 * MIN);
  T.setTaskState(T.getTask(t.id)!, 'paused', { author: 'director', name: 'Director', id: 'ag_dir' });
  advanceClock(60 * MIN);
  T.setTaskState(T.getTask(t.id)!, 'active', { author: 'director', name: 'Director', id: 'ag_dir' });
  advanceClock(10 * MIN);
  const running = T.getTask(t.id)!;
  assert.equal(running.started_at, startAt);
  assert.equal(T.activeMs(running), 30 * MIN);
  advanceClock(7 * MIN);
  T.setTaskState(T.getTask(t.id)!, 'done', { author: 'director', name: 'Director' });
  const done = T.getTask(t.id)!;
  assert.equal(done.active_ms, 37 * MIN);
  assert.equal(done.active_since, null);
  assert.equal(done.finished_at, now());
  assert.match(T.timingText(done), /took 37 min/);
});

await check('the away period attributes what the director did alone; coming back asks for its summary', () => {
  const awayStart = S.presence(pid).since!;
  run("INSERT INTO previews (id, project_id, kind, title, created_at) VALUES ('pv_x', ?, 'text', 'A shot', ?)", pid, now());
  advanceClock(30 * MIN);
  S.recordOwnerActivity(pid);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /The user is back/);
  notes.length = 0;
  const away = sessions().find((p) => p.kind === 'away' && p.start === awayStart + 0)!;
  assert.ok(away, 'away period listed');
  const detail = S.getPeriod(pid, away.id)!.detail;
  assert.equal(detail.tasks_finished.length, 1);
  assert.equal(detail.tasks_finished[0].took_ms, 37 * MIN);
  assert.equal(detail.tasks_started.length, 1);
  assert.equal(detail.previews.length, 1);
  assert.equal(detail.owner.length, 0, 'the owner did nothing while away');
});

await check('summaries from the director land on the right record', () => {
  assert.match(S.writeSummary(pid, 'away', 'Finished Timed alone.'), /Saved/);
  const open = get('SELECT * FROM sessions WHERE ended_at IS NULL')!;
  assert.equal(open.away_summary, 'Finished Timed alone.');
  assert.equal(open.away_summary_by, 'director');
  assert.match(S.writeSummary(pid, 'session', 'Set up the queue.'), /Saved/);
  const last = get('SELECT * FROM sessions WHERE ended_at IS NOT NULL ORDER BY ended_at DESC')!;
  assert.equal(last.summary, 'Set up the queue.');
  const listed = sessions();
  assert.equal(listed[0].kind, 'session');
  assert.equal(listed[1].kind, 'away');
  assert.equal(listed[1].summary, 'Finished Timed alone.');
});

await check('restart: an open session past its idle period closes at boot; a recent one stays open', () => {
  advanceClock(5 * MIN);
  S.sessionTick();
  assert.equal(S.presence(pid).state, 'session');
  advanceClock(3 * 60 * MIN); // "Helm was down"
  S.sessionTick(); // what startSessionTimer runs first
  assert.equal(S.presence(pid).state, 'away');
  notes.length = 0;
});

await check('owner activity is recognised from the route; views and global pages are not', () => {
  const t = T.createTask(pid, { title: 'Routed', state: 'waiting', origin: 'user' }, T.USER);
  assert.equal(S.activityProject('POST', '/api/tasks/:id/approve', { id: t.id }), pid);
  assert.equal(S.activityProject('POST', '/api/projects/:id/message', { id: pid }), pid);
  assert.equal(S.activityProject('GET', '/api/projects/:id', { id: pid }), null);
  assert.equal(S.activityProject('POST', '/api/projects/:id/away', { id: pid }), null);
  assert.equal(S.activityProject('POST', '/api/hosts/:id/check', { id: 'h' }), null);
  assert.equal(S.activityProject('POST', '/api/toolbox/:id/install', { id: 'x' }), null);
  assert.equal(S.activityProject('POST', '/api/toolbox/:id/projects/:projectId', { id: 'x', projectId: pid }), pid);
  run('DELETE FROM tasks WHERE id = ?', t.id);
});

await check('while away, create_task is limited to found-while-away work with a reason, a few per away period', async () => {
  const tools = helmTools('ag_dir', { spawn: async () => 'x', send: async () => {}, close: async () => {}, markComplete: () => {} }, { manager: true, root: true, consult: false });
  const create = tools.find((t: any) => t.name === 'create_task') as any;
  const call = (args: any) => create.handler({ description: '', ...args }, {});
  let r = await call({ title: 'New idea', state: 'scheduled' });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /do not create new work/);
  r = await call({ title: 'Proposal', state: 'planning' });
  assert.ok(!r.isError, 'planning still allowed');
  r = await call({ title: 'Fix', state: 'scheduled', origin: 'away' });
  assert.ok(r.isError, 'needs found_because');
  r = await call({ title: 'Fix', state: 'waiting', origin: 'away', found_because: 'build broke' });
  assert.ok(r.isError, 'waiting refused');
  for (let i = 1; i <= S.AWAY_TASK_LIMIT; i++) {
    r = await call({ title: `Fix ${i}`, state: 'scheduled', origin: 'away', found_because: `check ${i} fails on master` });
    assert.ok(!r.isError, r.content[0].text);
  }
  r = await call({ title: 'One too many', state: 'scheduled', origin: 'away', found_because: 'x' });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /limit/);
  const found = get("SELECT * FROM tasks WHERE title = 'Fix 1'")!;
  assert.equal(found.origin, 'away');
  assert.equal(found.origin_note, 'check 1 fails on master');
  // Back in a session, origin away is refused and normal creation works.
  S.recordOwnerActivity(pid);
  r = await call({ title: 'Normal', state: 'scheduled' });
  assert.ok(!r.isError);
  r = await call({ title: 'Away?', state: 'scheduled', origin: 'away', found_because: 'x' });
  assert.ok(r.isError);
  notes.length = 0;
});

await check('nudges only while away, only with work and nobody working, and back off', () => {
  S.stepAway(pid);
  notes.length = 0;
  // Stall reminders share the timer; count only the nudges here.
  const nudges = () => notes.filter((n) => n.includes('still away and nothing is running'));
  S.sessionTick();
  assert.equal(nudges().length, 0, 'not before the nudge interval');
  advanceClock(S.AWAY_NUDGE_MS + MIN);
  run("UPDATE agents SET status = 'working' WHERE id = 'ag_dir'");
  S.sessionTick();
  assert.equal(nudges().length, 0, 'not while the director works');
  run("UPDATE agents SET status = 'idle' WHERE id = 'ag_dir'");
  S.sessionTick();
  assert.equal(nudges().length, 1);
  assert.match(nudges()[0], /still away and nothing is running/);
  for (let i = 0; i < 5; i++) {
    advanceClock(S.AWAY_NUDGE_MS + MIN);
    S.sessionTick();
  }
  assert.equal(nudges().length, 3, 'stops after three nudges that changed nothing');
  // Something moves: nudging may resume.
  const t = get("SELECT * FROM tasks WHERE project_id = ? AND state = 'scheduled' LIMIT 1", pid)!;
  T.setTaskState(t, 'active', { author: 'director', name: 'Director' });
  advanceClock(S.AWAY_NUDGE_MS + MIN);
  S.sessionTick();
  assert.equal(nudges().length, 4);
  S.recordOwnerActivity(pid);
  notes.length = 0;
  advanceClock(S.AWAY_NUDGE_MS + MIN);
  S.recordOwnerActivity(pid);
  S.sessionTick();
  assert.equal(nudges().length, 0, 'no nudges during a session');
});

await check('the presence tag says here or away and since when', () => {
  assert.match(S.presenceTag(pid), /user="here"/);
  S.stepAway(pid);
  assert.match(S.presenceTag(pid), /user="away" since="/);
});


await check('what an action records while it is handled stays in its session; the end note lists the facts', () => {
  if (S.presence(pid).state === 'session') S.stepAway(pid);
  advanceClock(60 * MIN);
  notes.length = 0;
  S.recordOwnerActivity(pid);
  S.recordOwnerActivity(pid);
  advanceClock(2000); // the handler delivers the message a moment later
  run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?, 'ag_dir', ?, 'inbound', ?)", pid, now(), JSON.stringify({ from: { kind: 'user' }, text: 'Please tidy the notes' }));
  S.extendSession(pid);
  advanceClock(31 * MIN);
  S.sessionTick();
  const last = S.listPeriods(pid).find((x) => x.kind === 'session')!;
  assert.equal(last.counts.owner, 1, 'the message belongs to the session');
  const end = notes.find((n) => n.includes('summarize_session'))!;
  assert.match(end, /Please tidy the notes/);
  notes.length = 0;
});

await check('while away, tasks for reports from Act-mode sources are allowed and not counted; triage sources stay planning', async () => {
  S.stepAway(pid);
  advanceClock(1000);
  notes.length = 0;
  run("INSERT INTO report_sources (id, project_id, type, name, mode, created_at, updated_at) VALUES ('rs_act', ?, 'folder', 'Act', 'act', ?, ?), ('rs_tri', ?, 'folder', 'Triage', 'triage', ?, ?)", pid, now(), now(), pid, now(), now());
  run("INSERT INTO reports (id, project_id, source_id, external_id, title, changed_at, created_at, updated_at) VALUES ('rp_a', ?, 'rs_act', 'a', 'Crash on start', ?, ?, ?), ('rp_t', ?, 'rs_tri', 't', 'Idea', ?, ?, ?)", pid, now(), now(), now(), pid, now(), now(), now());
  const tools = helmTools('ag_dir', { spawn: async () => 'x', send: async () => {}, close: async () => {}, markComplete: () => {} }, { manager: true, root: true, consult: false });
  const create = tools.find((x: any) => x.name === 'create_task') as any;
  const call = (args: any) => create.handler({ description: '', ...args }, {});
  const before = S.awayTasksCreated(pid);
  let r = await call({ title: 'Fix crash', state: 'scheduled', origin: 'report' });
  assert.ok(r.isError, 'needs the report id');
  r = await call({ title: 'Do the idea', state: 'scheduled', origin: 'report', report: 'rp_t' });
  assert.ok(r.isError, 'triage source: planning only');
  assert.match(r.content[0].text, /planning/);
  r = await call({ title: 'Propose the idea', state: 'planning', origin: 'report', report: 'rp_t' });
  assert.ok(!r.isError);
  for (let i = 0; i < 4; i++) {
    r = await call({ title: `Fix crash ${i}`, state: 'scheduled', origin: 'report', report: 'rp_a' });
    assert.ok(!r.isError, r.content[0].text);
  }
  assert.equal(S.awayTasksCreated(pid), before, 'not counted against the found-while-away limit');
  assert.equal(get("SELECT origin_note FROM tasks WHERE title = 'Fix crash 0'")!.origin_note, 'Report: Crash on start');
  advanceClock(1000);
  S.recordOwnerActivity(pid);
  const back = notes.find((n) => n.includes('The user is back'))!;
  assert.match(back, /from a report: "Fix crash 0"/);
  notes.length = 0;
});

// ---------- a finished agent's task (taskwatch.ts) ----------

const DIR = { author: 'director' as const, name: 'Director', id: 'ag_dir' };
function worker(id: string, taskId: string) {
  run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, status, task_id, created_at, updated_at) VALUES (?, ?, 'ag_dir', 'engineer', ?, 'x', 'working', ?, ?, ?)", id, pid, `Eng ${id}`, taskId, now(), now());
}
const finish = (id: string) => {
  run("UPDATE agents SET status = 'done', updated_at = ? WHERE id = ?", now(), id);
  W.onAgentFinished(id);
};
const reportToDirector = () => run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?, 'ag_dir', ?, 'inbound', '{}')", pid, now());
const fakeRt = { spawn: async () => 'x', send: async () => {}, close: async (id: string) => finish(id), markComplete: () => {} };

await check('driver completes: awaiting review, a history entry, and the clock stops', () => {
  S.recordOwnerActivity(pid); // in a session, so creation is unrestricted
  notes.length = 0;
  const t = T.createTask(pid, { title: 'Reviewed', state: 'active', origin: 'director' }, DIR);
  worker('ag_w1', t.id);
  run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', 'ag_w1', t.id);
  advanceClock(12 * MIN);
  finish('ag_w1');
  const after = T.getTask(t.id)!;
  const view = T.taskView(after);
  assert.equal(view.awaiting_review, true);
  assert.equal(view.review_agent, 'Eng ag_w1');
  assert.equal(after.active_since, null);
  assert.equal(after.active_ms, 12 * MIN);
  advanceClock(10 * MIN);
  assert.equal(T.activeMs(T.getTask(t.id)!), 12 * MIN, 'not counting while it waits for review');
  assert.ok(get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE '%finished; waiting for Director to review%'", t.id));
});

await check("the director's turn ends without settling it: exactly one note", () => {
  const t = get("SELECT * FROM tasks WHERE title = 'Reviewed'")!;
  const director = get("SELECT * FROM agents WHERE id = 'ag_dir'")!;
  W.afterDirectorTurn(director);
  assert.equal(notes.length, 0, 'not before the director has received the report');
  reportToDirector();
  W.afterDirectorTurn(director);
  W.afterDirectorTurn(director);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Reviewed/);
  assert.match(notes[0], /still Active with nobody working on it/);
  notes.length = 0;
  void t;
});

await check('sent back to the agent: flags clear and a new stretch starts', () => {
  const t = get("SELECT * FROM tasks WHERE title = 'Reviewed'")!;
  run("UPDATE agents SET status = 'working' WHERE id = 'ag_w1'");
  W.onAgentResumed('ag_w1');
  const back = T.getTask(t.id)!;
  assert.equal(T.taskView(back).awaiting_review, false);
  assert.ok(back.active_since);
  advanceClock(3 * MIN);
  assert.equal(T.activeMs(T.getTask(t.id)!), 15 * MIN);
  assert.ok(get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE '%working on it again%'", t.id));
});

await check('close_agent without task_state says the task is left with nobody on it', async () => {
  const tools = helmTools('ag_dir', fakeRt as any, { manager: true, root: true, consult: false });
  const close = tools.find((x: any) => x.name === 'close_agent') as any;
  const r = await close.handler({ agent: 'ag_w1' }, {});
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /still Active and now has nobody working on it/);
  const t = get("SELECT * FROM tasks WHERE title = 'Reviewed'")!;
  assert.equal(t.state, 'active');
  assert.ok(T.taskView(t).awaiting_review, 'closing the driver leaves it awaiting review');
});

await check('close_agent with task_state settles the task in the same call', async () => {
  const tools = helmTools('ag_dir', fakeRt as any, { manager: true, root: true, consult: false });
  const close = tools.find((x: any) => x.name === 'close_agent') as any;
  const t = T.createTask(pid, { title: 'Settled on close', state: 'active', origin: 'director' }, DIR);
  worker('ag_w2', t.id);
  run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', 'ag_w2', t.id);
  let r = await close.handler({ agent: 'ag_w2', task_state: 'done' }, {});
  assert.ok(r.isError, 'needs a status summary');
  assert.equal(get("SELECT status FROM agents WHERE id = 'ag_w2'")!.status, 'working', 'nothing changed');
  r = await close.handler({ agent: 'ag_w2', task_state: 'done', status_summary: 'Built and checked.' }, {});
  assert.ok(!r.isError, r.content[0].text);
  const done = T.getTask(t.id)!;
  assert.equal(done.state, 'done');
  assert.equal(done.status_summary, 'Built and checked.');
  assert.equal(T.taskView(done).awaiting_review, false);
});

await check('stalled: flagged after the quiet period, one reminder, and again only after new activity', () => {
  notes.length = 0;
  const t = get("SELECT * FROM tasks WHERE title = 'Reviewed'")!;
  W.checkStalls();
  assert.equal(T.taskView(T.getTask(t.id)!).stalled, false, 'not yet');
  advanceClock(W.STALL_MS + MIN);
  assert.equal(T.taskView(T.getTask(t.id)!).stalled, true);
  assert.equal(W.attention(pid).stalled >= 1, true);
  W.checkStalls();
  W.checkStalls();
  const mine = notes.filter((n) => n.includes('Reviewed'));
  assert.equal(mine.length, 1);
  assert.match(mine[0], /nobody has worked on it/);
  // A director-driven task: stalled when the director is idle that long; not while it works.
  const own = T.createTask(pid, { title: 'Director drives', state: 'active', origin: 'director', driver_agent_id: 'ag_dir' }, DIR);
  advanceClock(W.STALL_MS + MIN);
  run("UPDATE agents SET status = 'working' WHERE id = 'ag_dir'");
  assert.equal(T.taskView(T.getTask(own.id)!).stalled, false, 'the director is on it');
  run("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = 'ag_dir'", now() - W.STALL_MS - MIN);
  assert.equal(T.taskView(T.getTask(own.id)!).stalled, true);
  // Activity on the stalled task, then quiet again: a second reminder.
  notes.length = 0;
  T.addTaskMessage(T.getTask(t.id)!, DIR, 'Looking at it.');
  W.checkStalls();
  assert.equal(notes.filter((n) => n.includes('"Reviewed"')).length, 0, 'activity unstalls it');
  advanceClock(W.STALL_MS + MIN);
  W.checkStalls();
  assert.equal(notes.filter((n) => n.includes('"Reviewed"')).length, 1);
  // Settled: no longer stalled.
  T.setTaskState(T.getTask(t.id)!, 'done', DIR);
  assert.equal(T.taskView(T.getTask(t.id)!).stalled, false);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', some FAILED' : ''}. Data: ${process.env.HELM_DATA}`);
process.exit(process.exitCode ?? 0);
