import { SCRATCH } from './testenv.ts';
// Helm dispatches fresh builders (dispatch.ts): one per task in queue order with its brief, side by side when their
// files do not overlap, Builder A/B/C names reused after closing, the batch record, the hold, the standing Builder and
// area agents retired, subagents booked to their builder's task, telemetry fresh vs standing, and no spawn_agent or
// areas left. `node --test server/dispatch.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const d = await import('./dispatch.ts');
const b = await import('./builder.ts');
const sub = await import('./subagents.ts');
const { setSetting } = await import('./settings.ts');
const { recordOwnerActivity } = await import('./sessions.ts');
const { helmTools, listHelmTools, toolAccess } = await import('./tools.ts');
const { BRIEF_START } = await import('./freshworker.ts');
const { telemetryRow, freshSplit, freshSplitText, recordTaskTelemetry } = await import('./telemetry.ts');
const { setWaits } = await import('./waits.ts');

const USER = { author: 'user' as const, name: 'You' };

function setup(atOnce = '2') {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'fresh', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now());
  setSetting(id, 'builders_at_once', atOnce);
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  recordOwnerActivity(id);
  const task = (title: string, touches: string[] | null, state = 'scheduled', extra: Record<string, unknown> = {}) => {
    const t = tasks.createTask(id, { title, state, origin: 'director', description: `## Features\n- ${title}\n\n## Done when\n1. ${title} works`, ...extra } as any, USER);
    db.run("UPDATE tasks SET check_how = 'npm test' WHERE id = ?", t.id);
    if (touches) sub.setTouches(t.id, touches);
    return tasks.getTask(t.id)!;
  };
  return { project, director, task, s };
}
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const task = (id: string) => tasks.getTask(id)!;
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const builders = (projectId: string) => db.all("SELECT * FROM agents WHERE project_id = ? AND role_id = 'builder' AND per_task = 1 ORDER BY created_at", projectId);

test('scheduling a task starts a fresh builder with the brief: named, its driver, Active at its tier', async () => {
  const { project, director, s } = setup();
  const tools = helmTools(director.id, runtime.runtimeApi, toolAccess(s, director.role_id, null));
  const r: any = await tools.find((x: any) => x.name === 'create_task')!.handler({ title: 'Tune the login form', description: '## Features\n- Inline error\n\n## Done when\n1. The error shows', state: 'scheduled', touches: ['web/src/login.tsx'], check: 'npm test -- login' }, {});
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /Helm starts a fresh builder for it/);
  for (let i = 0; i < 50 && !builders(project.id).length; i++) await settle(10);
  const [a] = builders(project.id);
  assert.ok(a, 'a builder was started');
  const t = db.get("SELECT * FROM tasks WHERE project_id = ? AND title = 'Tune the login form'", project.id)!;
  assert.equal(a.name, 'Builder A');
  assert.deepEqual([a.task_id, a.parent_id, a.per_task], [t.id, director.id, 1]);
  assert.deepEqual([t.state, t.driver_agent_id, t.tier], ['active', a.id, 'skilled']);
  const brief = inbound(a.id)[0];
  assert.match(brief, /^You are Builder A\. Helm started you for/);
  assert.ok(brief.includes(BRIEF_START));
  assert.ok(brief.includes(`Task ${t.id}: Tune the login form`));
  assert.match(brief, /Touches: web\/src\/login\.tsx/);
  assert.match(brief, /## Done when/);
  assert.match(brief, /Check: npm test -- login/);
  assert.match(brief, /merge --ff-only/);
  assert.match(brief, /complete_task/);
  assert.match(brief, /note_knowledge/);
  assert.doesNotMatch(brief, /request_review/, 'not marked for review');
});

test('two tasks that touch different files get Builder A and Builder B; one overlapping waits; a finished builder closes and its letter is reused', async () => {
  const { project, task: mk } = setup('3');
  const one = mk('Exporter', ['src/export.ts']);
  const two = mk('Importer', ['src/import.ts']);
  const three = mk('Exporter docs', ['src/export.ts', 'docs/export.md']);
  const started = await d.dispatchProject(project.id);
  assert.deepEqual(started.map((a) => a.name), ['Builder A', 'Builder B']);
  assert.deepEqual([task(one.id).state, task(two.id).state, task(three.id).state], ['active', 'active', 'scheduled']);
  assert.match(d.parallelHint(task(three.id))!, new RegExp(`Waits: \\[\\[${one.id}\\]\\] also touches src/export.ts`));
  // Builder A finishes: its task is done, it is closed, and the waiting task starts under the letter A again.
  const a = agent(task(one.id).driver_agent_id);
  await d.builderDone(a, 'Exporter changed; npm test passes.');
  await settle();
  assert.equal(task(one.id).state, 'done');
  assert.equal(task(one.id).status_summary, 'Exporter changed; npm test passes.');
  assert.equal(agent(a.id).status, 'closed');
  const next = agent(task(three.id).driver_agent_id);
  assert.equal(task(three.id).state, 'active');
  assert.equal(next.name, 'Builder A', 'the lowest letter no open builder holds');
  assert.notEqual(next.id, a.id, 'a fresh agent, not the closed one');
  assert.equal(agent(task(two.id).driver_agent_id).name, 'Builder B');
});

test('builders at once, a task with no files runs alone, waits_for and the hold are respected', async () => {
  const { project, task: mk } = setup('1');
  const a = mk('A', ['a.ts']);
  const bb = mk('B', ['b.ts']);
  await d.dispatchProject(project.id);
  assert.deepEqual([task(a.id).state, task(bb.id).state], ['active', 'scheduled'], 'one at once');
  setSetting(project.id, 'builders_at_once', '3');
  const loose = mk('Loose', null);
  await d.dispatchProject(project.id);
  assert.equal(task(bb.id).state, 'active');
  assert.equal(task(loose.id).state, 'scheduled', 'no files named: it waits until nothing else runs');
  assert.match(d.parallelHint(task(loose.id))!, /Runs alone/);
  // Waits for another task: stays queued.
  const after = mk('After', ['c.ts']);
  assert.equal(setWaits(after.id, [a.id]), null);
  await d.dispatchProject(project.id);
  assert.equal(task(after.id).state, 'scheduled');
  // Finish up holds Scheduled work.
  db.run("UPDATE projects SET mode = 'winding_down' WHERE id = ?", project.id);
  const held = mk('Held', ['d.ts']);
  await d.dispatchProject(project.id);
  assert.equal(task(held.id).state, 'scheduled');
});

test('a batch record when nothing is left running or queued; the batch clerk follows', async () => {
  const { project, task: mk } = setup('2');
  const x = mk('X', ['x.ts']);
  const y = mk('Y', ['y.ts']);
  await d.dispatchProject(project.id);
  await d.builderDone(agent(task(x.id).driver_agent_id), 'X done.');
  assert.equal(db.all("SELECT 1 FROM journal WHERE project_id = ? AND title LIKE 'Batch:%'", project.id).length, 0, 'Y still runs');
  await d.builderDone(agent(task(y.id).driver_agent_id), 'Y done.');
  const rec = db.all("SELECT title, body FROM journal WHERE project_id = ? AND title LIKE 'Batch:%'", project.id);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].title, 'Batch: 2 tasks finished by builders');
  assert.match(rec[0].body, /^The queue is empty\./);
});

test('a task marked for review says so in its brief', async () => {
  const { project, task: mk } = setup();
  const t = mk('Change the update path', ['nix/live-update.sh'], 'scheduled', { risky: 1 });
  db.run('UPDATE tasks SET risky = 1 WHERE id = ?', t.id);
  const [a] = await d.dispatchProject(project.id);
  await settle();
  assert.match(inbound(a.id)[0], /marked for review: request_review before you merge/);
});

test('the standing Builder finishes its Active task, gets no new one and is closed; idle area agents are closed', async () => {
  const { project, director, task: mk, s } = setup('3');
  const standing = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const own = mk('Own', ['own.ts'], 'active', { driver_agent_id: standing.id });
  const alongside = mk('Alongside', ['side.ts'], 'active', { driver_agent_id: standing.id });
  db.run('UPDATE agents SET task_id = ?, status = ? WHERE id = ?', own.id, 'idle', standing.id);
  const engineer = runtime.createAgent(project, director, { id: 'engineer', name: 'Engineer', model: 'claude-opus-5-5', effort: '', description: '', prompt: '', canSpawn: [] }, 'Engineer', '');
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", engineer.id);
  const queued = mk('Queued', ['q.ts']);
  await d.retireStanding(project.id);
  assert.equal(agent(standing.id).status, 'idle', 'it still has its own Active task');
  assert.equal(agent(engineer.id).status, 'closed', 'an area agent with nothing in hand is closed');
  assert.deepEqual([task(alongside.id).state, task(alongside.id).driver_agent_id], ['scheduled', null], 'a task held alongside goes back to the queue');
  await d.dispatchProject(project.id);
  assert.notEqual(task(queued.id).driver_agent_id, standing.id, 'the standing Builder gets no new task');
  assert.equal(agent(task(queued.id).driver_agent_id).per_task, 1);
  // Its task finishes through the same path: done, then closed.
  await d.builderDone(agent(standing.id), 'Own done.');
  assert.equal(task(own.id).state, 'done');
  assert.equal(agent(standing.id).status, 'closed');
  assert.equal(db.all("SELECT 1 FROM tasks WHERE driver_agent_id = ? AND state = 'active'", standing.id).length, 0);
});

test('a subagent is booked only to the task its builder was started for, whatever its brief names', async () => {
  const { project, task: mk } = setup('2');
  const mine = mk('Mine', ['m.ts']);
  const other = mk('Other', ['o.ts']);
  await d.dispatchProject(project.id);
  setSetting(project.id, 'builder_subagents', '3');
  const a = agent(task(mine.id).driver_agent_id);
  assert.equal(sub.agentCallCheck(a, 'tu-x', { subagent_type: 'skilled', description: `Part of ${other.id}`, prompt: `Also see [[${other.id}]]`, isolation: 'worktree' }), null);
  const row = sub.subagentFor('tu-x')!;
  assert.equal(row.task_id, mine.id);
  assert.equal(row.parent_id, a.id);
  sub.subagentEnded('tu-x', 'completed', 'Part done');
  assert.ok(db.get("SELECT 1 FROM task_messages WHERE task_id = ? AND body LIKE '%Part done%'", mine.id));
  assert.equal(db.get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE '%Part done%'", other.id), undefined);
});

test('telemetry: ran_fresh is 1 for a fresh builder, 0 for the standing Builder; get_telemetry splits tokens per task by it', async () => {
  const { project, director, task: mk, s } = setup('2');
  const f = mk('Fresh one', ['f.ts']);
  await d.dispatchProject(project.id);
  const fb = agent(task(f.id).driver_agent_id);
  db.run('INSERT INTO token_usage (project_id, agent_id, task_id, who, tokens, tier, at) VALUES (?,?,?,?,?,?,?)', project.id, fb.id, f.id, 'builder', 1000, 'skilled', db.now());
  await d.builderDone(fb, 'Done.');
  const standing = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const o = mk('Old one', ['o.ts'], 'active', { driver_agent_id: standing.id });
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', o.id, standing.id);
  db.run('INSERT INTO token_usage (project_id, agent_id, task_id, who, tokens, tier, at) VALUES (?,?,?,?,?,?,?)', project.id, standing.id, o.id, 'builder', 5000, 'skilled', db.now());
  await d.builderDone(agent(standing.id), 'Done.');
  recordTaskTelemetry(f.id, true);
  recordTaskTelemetry(o.id, true);
  assert.equal(telemetryRow(task(f.id)).ran_fresh, 1);
  assert.equal(telemetryRow(task(o.id)).ran_fresh, 0);
  const split = freshSplit({ project: project.id } as any, 0, db.now() + 1000);
  assert.deepEqual([split.fresh.n, split.own.n], [1, 1]);
  assert.match(freshSplitText(split), /^Fresh builders: 1 task, 1k tokens per task.*Standing Builder: 1 task, 5k tokens per task/);
});

test('spawn_agent, quick helpers, take_task and the team tools are gone; the structure holds only the director and the builder', () => {
  const s = structure.defaultStructure();
  assert.deepEqual(s.roles.map((r) => r.id), ['director', 'builder']);
  const gone = ['spawn_agent', 'quick_job', 'answer_helper', 'take_task', 'finish_task', 'get_structure', 'update_structure'];
  for (const [role, parent] of [['director', null], ['builder', 'ag_x']] as const) {
    const names = listHelmTools(s, role, parent).map((t) => t.name);
    for (const g of gone) assert.ok(!names.includes(g), `${role} has no ${g}`);
  }
  const directorNames = listHelmTools(s, 'director', null).map((t) => t.name);
  for (const keep of ['create_task', 'message_agent', 'close_agent', 'list_agents']) assert.ok(directorNames.includes(keep), keep);
  const builderNames = listHelmTools(s, 'builder', 'ag_x').map((t) => t.name);
  for (const keep of ['complete_task', 'ask_manager', 'request_review', 'note_knowledge']) assert.ok(builderNames.includes(keep), keep);
  void b;
});
