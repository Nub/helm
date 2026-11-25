import { SCRATCH } from './testenv.ts';
// Progress checks (progress.ts): each flag and its importance scaling; a first flag stops the work until replan_task,
// a second pauses it and asks the user once; the count survives a re-plan and resets on the user's Resume.
// `node --test server/progress.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Metrics } from './progress.ts';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const pg = await import('./progress.ts');
const { setSetting } = await import('./settings.ts');
const { answerInbox } = await import('./answers.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { addEvent } = await import('./store.ts');
const usage = await import('./usage.ts');

const sent: { to: string; text: string }[] = [];
const interrupted: string[] = [];
pg.setProgressHooks({
  send: async (to, text) => void sent.push({ to, text }),
  interrupt: async (id) => void interrupted.push(id),
});

const MIN = 60_000;
db.freezeClock();
const USER = { author: 'user' as const, name: 'You' };

function setup(importance = 3) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'pg', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  // These tests are about team mode (areas at once); builder mode is covered in builder.test.ts.
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const worker = runtime.createAgent(project, director, role, 'Engineer', 'Build it.');
  const task = tasks.createTask(id, { title: 'Work', state: 'active', origin: 'user' }, USER);
  db.run('UPDATE tasks SET importance = ?, driver_agent_id = ? WHERE id = ?', importance, worker.id, task.id);
  db.run("UPDATE agents SET task_id = ?, status = 'working' WHERE id = ?", task.id, worker.id);
  const t0 = Number(db.get('SELECT active_since FROM tasks WHERE id = ?', task.id)!.active_since);
  sent.length = 0;
  interrupted.length = 0;
  return { project, director, worker, task, t0 };
}
const notes = (to: string) => sent.filter((s) => s.to === to && s.text.includes('kind="progress"'));
const tokens = (p: any, t: any, n: number) => db.run('INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at) VALUES (?,?,?,?,?)', p.id, 'ag_test', t.id, n, db.now());
const done = (agent: any, n: number) => {
  for (let i = 0; i < n; i++) db.run("INSERT INTO checklist (agent_id, text, state, sort, updated_at) VALUES (?, ?, 'done', ?, ?)", agent.id, `step ${i}`, i, db.now());
};
const base: Metrics = { importance: 3, activeMs: 0, stillMs: 0, tokens: 0, rounds: 0, errors: 0, median: null, waitingOnUser: false };
const keys = (m: Partial<Metrics>) => pg.flagsFor({ ...base, ...m }).map((f) => f.key);

test('each flag at its level, scaled by importance', () => {
  assert.deepEqual(keys({}), []);
  assert.deepEqual(keys({ stillMs: 59 * MIN }), []);
  assert.deepEqual(keys({ stillMs: 60 * MIN }), ['stalled']);
  assert.deepEqual(keys({ stillMs: 60 * MIN, waitingOnUser: true }), [], 'waiting on the user is not stuck');
  assert.deepEqual(keys({ rounds: 3 }), ['rounds']);
  assert.deepEqual(keys({ tokens: pg.TOKEN_FLOOR }), ['tokens']);
  assert.deepEqual(keys({ tokens: 2_900_000, median: 1_000_000 }), []);
  assert.deepEqual(keys({ tokens: 3_000_000, median: 1_000_000 }), ['tokens']);
  assert.deepEqual(keys({ errors: 3 }), ['errors']);
  // Critical work earns twice the time and more rounds; Low less.
  assert.deepEqual(keys({ importance: 5, stillMs: 100 * MIN, rounds: 5 }), []);
  assert.deepEqual(keys({ importance: 5, stillMs: 120 * MIN, rounds: 6 }), ['stalled', 'rounds']);
  assert.deepEqual(keys({ importance: 2, stillMs: 45 * MIN }), ['stalled']);
});


/** Move the frozen clock to t0 + ms and run a check there. */
const at = (t0: number, ms: number) => {
  db.advanceClock(t0 + ms - db.now());
  return db.now();
};
const check = (p: any, t0: number, ms: number) => pg.checkProject(p.id, at(t0, ms));
const view = (task: any) => tasks.taskView(tasks.getTask(task.id)!).check;
const prow = (task: any) => db.get('SELECT * FROM task_progress WHERE task_id = ?', task.id)!;
const replanTool = (p: any, director: any) => helmTools(director.id, {} as any, toolAccess(JSON.parse(p.structure), director.role_id, null)).find((t: any) => t.name === 'replan_task')!;
const replan = (p: any, director: any, task: any) => replanTool(p, director).handler({ task: task.id, what_was_wrong: 'It looped on one test.', new_approach: 'Fix the fixture first, then the test.', scope: 'Only the parser.' }, {});
const openRequests = (task: any) => db.all("SELECT * FROM inbox WHERE task_id = ? AND kind = 'question' AND status IN ('open', 'held')", task.id);

test('a first flag stops the agents, marks the task Re-planning and wakes the director, in builder mode too; no tier change', async () => {
  const { project, director, worker, task, t0 } = setup();
  db.run("UPDATE tasks SET tier = 'routine' WHERE id = ?", task.id);
  await check(project, t0, 0);
  await check(project, t0, 30 * MIN);
  assert.equal(notes(director.id).length, 0);
  assert.deepEqual(interrupted, []);
  await check(project, t0, 61 * MIN);
  assert.equal(tasks.getTask(task.id)!.tier, 'routine', 'a flag never changes the tier');
  assert.deepEqual(interrupted, [worker.id]);
  assert.equal(tasks.getTask(task.id)!.state, 'active');
  assert.equal(notes(director.id).length, 1);
  assert.match(notes(director.id)[0].text, new RegExp(`stopped the work on \\[\\[${task.id}\\]\\].*no worklist item done`));
  assert.match(notes(director.id)[0].text, /replan_task/);
  assert.match(view(task), /^Re-planning: no worklist item done/);
  assert.ok(db.get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE 'Progress check:%'", task.id));
  // Until the re-plan, nothing works on it: a working agent is stopped again; no second note, no pause, no new flag.
  tokens(project, task, pg.TOKEN_FLOOR);
  await check(project, t0, 70 * MIN);
  assert.equal(notes(director.id).length, 1);
  assert.deepEqual(interrupted, [worker.id, worker.id]);
  assert.equal(tasks.getTask(task.id)!.state, 'active');
  assert.equal(openRequests(task).length, 0);
});

test('work resumes only after replan_task: it records the plan, restarts the driver and starts a fresh allowance', async () => {
  const { project, director, worker, task, t0 } = setup();
  await check(project, t0, 0);
  const early = await replan(project, director, task);
  assert.ok(early.isError, 'nothing to re-plan before a flag');
  tokens(project, task, pg.TOKEN_FLOOR);
  await check(project, t0, MIN);
  assert.match(view(task), /^Re-planning/);
  sent.length = 0;
  const res = await replan(project, director, task);
  assert.ok(!res.isError, JSON.stringify(res));
  assert.ok(db.get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE '%Fix the fixture first%' AND body LIKE '%Only the parser%'", task.id));
  const toWorker = sent.filter((s) => s.to === worker.id);
  assert.equal(toWorker.length, 1);
  assert.match(toWorker[0].text, /Start again from this plan:[\s\S]*Fix the fixture first/);
  assert.equal(view(task), 'Re-planned once');
  assert.ok((await replan(project, director, task)).isError, 'only once per flag');
  // Measured from the re-plan: the tokens before it do not flag again.
  interrupted.length = 0;
  await check(project, t0, 5 * MIN);
  assert.deepEqual(interrupted, []);
  assert.equal(view(task), 'Re-planned once');
});

test('a second flag pauses the task and files one request; the count survives a re-plan and resets on Resume', async () => {
  const { project, director, worker, task, t0 } = setup();
  await check(project, t0, 0);
  await check(project, t0, 61 * MIN);
  assert.ok(!(await replan(project, director, task)).isError);
  assert.equal(prow(task).strikes, 1, 'a re-plan keeps the count');
  interrupted.length = 0;
  tokens(project, task, pg.TOKEN_FLOOR);
  await check(project, t0, 65 * MIN);
  const t = tasks.getTask(task.id)!;
  assert.equal(t.state, 'paused');
  assert.equal(t.paused_by, 'user', 'only the user resumes it');
  assert.deepEqual(interrupted, [worker.id]);
  await check(project, t0, 70 * MIN);
  const reqs = openRequests(task);
  assert.equal(reqs.length, 1);
  assert.deepEqual(JSON.parse(reqs[0].options).map((o: any) => o.label), ['Resume once more', 'Narrow it with the director', 'Drop']);
  assert.match(reqs[0].body, /First flag: no worklist item done/);
  assert.match(reqs[0].body, /Re-plan: Fix the fixture first/);
  assert.match(reqs[0].body, /Second flag: work tokens 3\.0M \(new input 3\.0M\), far above the usual/);
  assert.match(reqs[0].body, /Spent: 1 h 5 min and 3\.0M tokens in total/);
  assert.match(notes(director.id).at(-1)!.text, /second progress flag/);
  // Telemetry keeps both flags and the re-plan.
  assert.equal(prow(task).flags_total, 2);
  assert.equal(prow(task).replans_total, 1);
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", reqs[0].id);
  assert.equal(await answerInbox(reqs[0].id, { choice: 'Resume once more' }), null);
  assert.equal(tasks.getTask(task.id)!.state, 'active');
  assert.equal(prow(task).strikes, 0, "the user's Resume resets the count");
  assert.equal(view(task), null);
  // The next flag is a first one again: re-plan, not pause.
  await check(project, t0, 140 * MIN);
  assert.equal(tasks.getTask(task.id)!.state, 'active');
  assert.match(view(task), /^Re-planning/);
  assert.equal(prow(task).flags_total, 3);
});

test('no re-plan within 30 minutes of a first flag counts as the second', async () => {
  const { project, task, t0 } = setup();
  await check(project, t0, 0);
  await check(project, t0, 61 * MIN);
  await check(project, t0, 90 * MIN);
  assert.equal(tasks.getTask(task.id)!.state, 'active');
  await check(project, t0, 91 * MIN);
  assert.equal(tasks.getTask(task.id)!.state, 'paused');
  const [req] = openRequests(task);
  assert.match(req.body, /Second flag: no re-plan within 30 min/);
  assert.match(req.body, /Re-plan: none recorded/);
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", req.id);
  await answerInbox(req.id, { choice: 'Drop' });
  assert.equal(tasks.getTask(task.id)!.state, 'dropped');
});

test('a background command is not a stall', async () => {
  const { project, director, worker, task, t0 } = setup();
  await check(project, t0, 0);
  db.run("INSERT INTO running_commands (id, project_id, agent_id, session_agent_id, task_id, command, background, started_at) VALUES ('cmd1', ?, ?, ?, ?, 'npm test', 1, ?)", project.id, worker.id, worker.id, task.id, t0 + 10 * MIN);
  await check(project, t0, 90 * MIN);
  assert.equal(notes(director.id).length, 0);
  assert.equal(view(task), null);
  db.run("UPDATE running_commands SET ended_at = ? WHERE id = 'cmd1'", t0 + 90 * MIN);
  // The stall clock starts again when it ends.
  await check(project, t0, 140 * MIN);
  assert.equal(notes(director.id).length, 0);
  await check(project, t0, 151 * MIN);
  assert.equal(notes(director.id).length, 1);
});

test('review rounds and failed turns count since the allowance', async () => {
  const { project, director, worker, task, t0 } = setup();
  await check(project, t0, 0);
  for (let i = 0; i < 3; i++) {
    db.run("INSERT INTO consults (id, project_id, asker_id, manager_id, task_id, kind, question, status, verdict, created_at, answered_at) VALUES (?,?,?,?,?,'review','q','answered','changes_needed',?,?)", db.newId('cs'), project.id, worker.id, director.id, task.id, t0 + 1, t0 + 1);
  }
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, payload, created_at, status) VALUES (?,?,?,'agent_error','x',?,?, 'dismissed')", db.newId('in'), project.id, worker.id, JSON.stringify({ count: 3 }), t0 + 1);
  await check(project, t0, 5 * MIN);
  const line = pg.progressLines(project.id, db.now())[0];
  assert.deepEqual(line.flags.map((f) => f.key), ['rounds', 'errors']);
  assert.equal(notes(director.id).length, 1);
});

test('tokens far above the median of finished tasks of the same importance', async () => {
  const { project, director, task, t0 } = setup();
  for (const n of [100_000, 200_000, 300_000]) {
    const d = tasks.createTask(project.id, { title: `Done ${n}`, state: 'active', origin: 'user' }, USER);
    tokens(project, d, n);
    tasks.setTaskState(d, 'done', USER);
  }
  assert.equal(pg.medianTokens(project.id, 3), 200_000);
  await check(project, t0, 0);
  tokens(project, task, 700_000);
  await check(project, t0, MIN);
  assert.match(notes(director.id)[0]?.text ?? '', /work tokens 700k \(new input 700k\) vs median 200k \(3\.5×\)/);
});

/** A project with three finished tasks of 100k work tokens each, recorded with the split: the median is 100k. */
function withMedian() {
  const s = setup();
  for (let i = 0; i < 3; i++) {
    const d = tasks.createTask(s.project.id, { title: `Done ${i}`, state: 'active', origin: 'user' }, USER);
    db.run('INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, work_in, work_out) VALUES (?,?,?,?,?,?,?)', s.project.id, 'ag_test', d.id, 900_000, db.now(), 80_000, 20_000);
    tasks.setTaskState(d, 'done', USER);
  }
  // One finished before the split, counted in full: left out once three have it.
  const old = tasks.createTask(s.project.id, { title: 'Done before', state: 'active', origin: 'user' }, USER);
  tokens(s.project, old, 5_000_000);
  tasks.setTaskState(old, 'done', USER);
  assert.equal(pg.medianTokens(s.project.id, 3), 100_000);
  return s;
}
/** Feed a conversation's calls to a tracker: [input, cache writes, cache reads, output]. */
const calls = (t: ReturnType<typeof usage.newWorkTracker>, xs: [number, number, number, number][]) =>
  xs.forEach(([i, w, r, o]) => usage.noteCall(t, db.newId('msg'), { input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o }));
const mu = (n: number) => ({ m: { inputTokens: n, outputTokens: 0, cacheCreationInputTokens: 0 } });

test("a builder re-reading its long context is not flagged: cache reads and re-writes are not work", async () => {
  const { project, director, worker, task, t0 } = withMedian();
  await check(project, t0, 0);
  // A resumed session: the first call writes the whole 800k context again, then the turn reads it from the cache.
  const main = usage.newWorkTracker();
  calls(main, [[3, 800_000, 0, 900], [2, 6_000, 800_000, 1_200], [2, 4_000, 807_000, 800]]);
  // Later, in the same process, the cache expired while it waited: the whole context written again, little new.
  calls(main, [[2, 820_000, 0, 600]]);
  const work = usage.takeWork(main);
  assert.ok(work.input < 20_000 && work.output === 3_500, JSON.stringify(work));
  usage.recordTurnUsage(db.get('SELECT * FROM agents WHERE id = ?', worker.id)!, mu(1_650_000), null, 'builder', { work });
  assert.ok(usage.taskTokens(task.id) >= 1_600_000, 'the cost is still counted where cost is shown');
  await check(project, t0, 3 * MIN);
  assert.equal(notes(director.id).length, 0);
  assert.equal(view(task), null);
  const line = pg.progressLines(project.id, db.now())[0];
  assert.ok(line.m.tokens < 30_000, String(line.m.tokens));
});

test('a subagent burning well past the median flags, and the text names the subagents', async () => {
  const { project, director, worker, task, t0 } = withMedian();
  await check(project, t0, 0);
  const sub = { id: db.newId('ag') };
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, created_at, updated_at, task_id, parent_id) VALUES (?, ?, 'subagent', 'Explorer', 'm', ?, ?, ?, ?)", sub.id, project.id, db.now(), db.now(), task.id, worker.id);
  // The subagent reads 40 large files: its context grows 10k a call, each new to it.
  const t = usage.newWorkTracker();
  let ctx = 20_000;
  const xs: [number, number, number, number][] = [[20_000, 0, 0, 500]];
  for (let i = 0; i < 40; i++) {
    xs.push([2, 10_000, ctx, 500]);
    ctx += 10_500;
  }
  calls(t, xs);
  const subWork = usage.takeWork(t);
  usage.recordTurnUsage(db.get('SELECT * FROM agents WHERE id = ?', worker.id)!, mu(2_000_000), null, 'builder', {
    work: { input: 5_000, output: 2_000 },
    subagents: [{ agent: db.get('SELECT * FROM agents WHERE id = ?', sub.id)!, tokens: 1_000_000, tier: null, work: subWork }],
  });
  await check(project, t0, 3 * MIN);
  const [note] = notes(director.id);
  assert.ok(note, 'flagged');
  assert.match(note.text, /work tokens 447k \(new input 5k, output 2k, subagents 440k\) vs median 100k \(4\.5×\)/);
  assert.equal(usage.taskWork(task.id).subagents, 440_002);
});

test('the switch off sends nothing and clears the marker; list_progress still works', async () => {
  const a = setup();
  await check(a.project, a.t0, 0);
  await check(a.project, a.t0, 61 * MIN);
  assert.ok(view(a.task));
  setSetting(a.project.id, 'progress_checks', false);
  assert.equal(view(a.task), null);

  const b = setup();
  setSetting(b.project.id, 'progress_checks', false);
  await check(b.project, b.t0, 0);
  pg.progressLines(b.project.id, db.now());
  await check(b.project, b.t0, 500 * MIN);
  assert.equal(notes(b.director.id).length, 0);
  assert.deepEqual(interrupted, []);
  assert.equal(tasks.getTask(b.task.id)!.state, 'active');
  assert.equal(pg.progressLines(b.project.id, db.now())[0].flags[0].key, 'stalled', 'list_progress still works');
});

test('editing and committing for two hours with no worklist change is not stalled; reading and rerunning a failing command is', async () => {
  const a = setup();
  const call = (agent: any, name: string, input: Record<string, unknown>) => addEvent(agent, 'tool', { id: db.newId('tu'), name, summary: String(input.command ?? input.file_path ?? ''), input: JSON.stringify(input) });
  await check(a.project, a.t0, 0);
  for (let m = 20; m <= 120; m += 20) {
    at(a.t0, m * MIN - MIN);
    if (m % 40) call(a.worker, 'Edit', { file_path: '/p/src/port.ts', old_string: 'a', new_string: 'b' });
    else call(a.worker, 'Bash', { command: 'cd /p && git commit -qam "Port the parser"' });
    call(a.worker, 'Read', { file_path: '/p/src/port.ts' });
    await check(a.project, a.t0, m * MIN);
  }
  assert.equal(notes(a.director.id).length, 0);
  assert.equal(view(a.task), null);
  assert.equal(tasks.getTask(a.task.id)!.state, 'active');

  const b = setup();
  await check(b.project, b.t0, 0);
  for (let m = 10; m <= 50; m += 10) {
    at(b.t0, m * MIN - MIN);
    call(b.worker, 'Read', { file_path: '/p/src/port.ts' });
    call(b.worker, 'Bash', { command: 'rg -n parse src' });
    call(b.worker, 'Bash', { command: 'npm test -- parser' });
    await check(b.project, b.t0, m * MIN);
  }
  assert.equal(notes(b.director.id).length, 0);
  await check(b.project, b.t0, 61 * MIN);
  assert.equal(notes(b.director.id).length, 1);
  assert.match(view(b.task), /^Re-planning: no worklist item done/);
});
