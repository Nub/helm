import { SCRATCH } from './testenv.ts';
// A builder's status, ticks and previews land on the task they are about (task_3508723a80): with two tasks in hand it
// reports a status line per task, a tick or a preview without task is refused, and a subagent's activity and report
// show only on its task. `node --test server/taskline.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const sub = await import('./subagents.ts');
const { addEvent } = await import('./store.ts');
const { projectOverview } = await import('./overview.ts');
const { noteCwd } = await import('./triage.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };

/** A task the standing Builder held alongside its own before fresh builders (take_task is gone; dispatch.ts sends it back to the queue). */
function takeAlongside(builderId: string, taskId: string) {
  db.run("UPDATE tasks SET state = 'active', driver_agent_id = ?, started_at = ? WHERE id = ?", builderId, db.now(), taskId);
}

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'tl', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const tools = helmTools(builder.id, { send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, 'builder', director.role_id));
  const call = async (n: string, input: Record<string, unknown>) => {
    const r: any = await tools.find((x: any) => x.name === n)!.handler(input, {});
    return { text: r.content[0].text as string, error: !!r.isError };
  };
  const own = tasks.createTask(id, { title: 'Own work', state: 'active', origin: 'director', description: 'Edit src/own.ts.\n\n## Done when\n- one\n- two', driver_agent_id: builder.id } as any, USER);
  const other = tasks.createTask(id, { title: 'Alongside', state: 'scheduled', origin: 'director', description: 'Edit src/other.ts.\n\n## Done when\n- three' } as any, USER);
  db.run("UPDATE agents SET status = 'working' WHERE id = ?", builder.id);
  return { id, project, builder, call, own, other };
}

const agentOn = (taskId: string, agentId: string) => tasks.taskDetail(taskId)!.agents.find((a: any) => a.id === agentId)!;
const driverOf = (taskId: string) => tasks.taskView(tasks.getTask(taskId)!).driver;

test('two tasks in hand: each task shows its own status line', async () => {
  const { id, builder, call, own, other } = setup();
  takeAlongside(builder.id, other.id);

  const r1 = await call('report_status', { status: 'Editing the own file', task: own.id });
  assert.equal(r1.error, false, r1.text);
  const r2 = await call('report_status', { status: 'Merging the alongside branch', task: other.id, progress: 40 });
  assert.equal(r2.error, false, r2.text);
  assert.match(r2.text, new RegExp(other.id));

  // The card (taskView driver) and the Status section (taskDetail agents) of each.
  assert.equal(driverOf(own.id).status_line, 'Editing the own file');
  assert.equal(driverOf(other.id).status_line, 'Merging the alongside branch');
  // Progress is what Helm counts (its Done when ticks, none yet), not the number reported.
  assert.equal(driverOf(other.id).progress, 0);
  assert.equal(agentOn(own.id, builder.id).status_line, 'Editing the own file');
  assert.equal(agentOn(other.id, builder.id).status_line, 'Merging the alongside branch');
  // The agent's own line stays its current task's.
  assert.equal(db.get('SELECT status_line FROM agents WHERE id = ?', builder.id)!.status_line, 'Editing the own file');
  // Home: each running task with its own line.
  const home = projectOverview({ id, name: 'tl', updated_at: db.now() });
  assert.equal(home.running.find((t) => t.id === own.id)?.line, 'Editing the own file');
  assert.equal(home.running.find((t) => t.id === other.id)?.line, 'Merging the alongside branch');

  // A task it does not drive is refused.
  const stranger = tasks.createTask(id, { title: 'Not mine', state: 'scheduled', origin: 'director', description: 'x' } as any, USER);
  assert.equal((await call('report_status', { status: 'x', task: stranger.id })).error, true);
});

test('without task: the worktree the last command ran in, else the current task', async () => {
  const { project, builder, call, own, other } = setup();
  takeAlongside(builder.id, other.id);
  // No cwd known: the current task.
  await call('report_status', { status: 'On my own' });
  assert.equal(driverOf(own.id).status_line, 'On my own');
  assert.equal(driverOf(other.id).status_line, '');
  // A registered worktree naming the other task.
  const wt = `${SCRATCH}/wt-${other.id}`;
  db.run("INSERT INTO artifacts (id, project_id, agent_id, path, kind, disposable, note, created_at) VALUES (?,?,?,?,'worktree',0,'',?)", db.newId('art'), project.id, builder.id, wt, db.now());
  noteCwd(builder.id, `${wt}/server`);
  await call('report_status', { status: 'Checking the alongside work' });
  assert.equal(driverOf(other.id).status_line, 'Checking the alongside work');
  assert.equal(driverOf(own.id).status_line, 'On my own');
});

test('a tick, a preview or a journal entry without task is refused with two in hand', async () => {
  const { builder, call, own, other } = setup();
  // One in hand: the default works.
  assert.equal((await call('report_status', { status: 'Working', done_when: [1] })).error, false);
  takeAlongside(builder.id, other.id);

  const tick = await call('report_status', { status: 'Working', done_when: [1, 2] });
  assert.equal(tick.error, true);
  assert.match(tick.text, /name the task/);
  assert.equal(tasks.getTask(own.id)!.done_when_ticks, '[1]');
  const named = await call('report_status', { status: 'Done with three', done_when: [1], task: other.id });
  assert.equal(named.error, false, named.text);
  assert.equal(tasks.getTask(other.id)!.done_when_ticks, '[1]');
  assert.equal(driverOf(other.id).status_line, 'Done with three');

  const prev = await call('post_preview', { title: 'A result', content: 'hello', kind: 'markdown' });
  assert.equal(prev.error, true);
  assert.match(prev.text, /name the task/);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM previews WHERE agent_id = ?', builder.id)!.n, 0);
  const prevNamed = await call('post_preview', { title: 'A result', content: 'hello', kind: 'markdown', task: other.id });
  assert.equal(prevNamed.error, false, prevNamed.text);
  assert.equal(db.get('SELECT task_id FROM previews WHERE agent_id = ?', builder.id)!.task_id, other.id);

  const j = await call('log_journal', { kind: 'note', title: 'Something' });
  assert.equal(j.error, true);
  assert.match(j.text, /name the task/);
  assert.equal((await call('log_journal', { kind: 'note', title: 'Something', task: own.id })).error, false);
});

test("a subagent's command and report show only on its task", async () => {
  const { builder, call, own, other } = setup();
  takeAlongside(builder.id, other.id);
  await call('report_status', { status: 'Editing the own file', task: own.id });
  db.run("UPDATE agents SET status = 'working' WHERE id = ?", builder.id);
  const b = () => db.get('SELECT * FROM agents WHERE id = ?', builder.id)!;

  // A foreground Agent call for the other task: the builder's pending call is the subagent's, shown on that task only.
  assert.equal(sub.agentCallCheck(b(), 'tu_sub', { subagent_type: 'skilled', description: `${other.id}: build it`, prompt: 'p', isolation: 'worktree' }), null);
  addEvent(b(), 'tool', { id: 'tu_sub', name: 'Agent', summary: `${other.id}: build it` });
  sub.subagentEvent('tu_sub', 'tool', { id: 'tu_x', name: 'Bash', summary: 'npm test' });
  const subRow = sub.subagentFor('tu_sub')!;
  // A subagent is booked to its builder's own task now; one of the standing Builder's, on a task held alongside, stays there.
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', other.id, subRow.id);

  assert.equal(agentOn(own.id, builder.id).current_tool, null);
  assert.equal(tasks.taskDetail(own.id)!.agents.some((a: any) => a.id === subRow.id), false);
  const onOther = agentOn(other.id, subRow.id);
  assert.equal(onOther.current_tool?.summary, 'npm test');

  // Its report becomes the builder's line on that task, not on the builder's own.
  sub.subagentEnded('tu_sub', 'completed', 'Built it; npm test passes.\nDetails follow.');
  assert.equal(driverOf(other.id).status_line, 'Built it; npm test passes.');
  assert.equal(agentOn(other.id, builder.id).status_line, 'Built it; npm test passes.');
  assert.equal(driverOf(own.id).status_line, 'Editing the own file');
});
