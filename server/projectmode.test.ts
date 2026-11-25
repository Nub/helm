import { SCRATCH } from './testenv.ts';
// The project's mode (projectmode.ts): the gating table, the end of a wind down, stop and resume, and the user's own
// actions, which the mode never blocks except starting a task (Start anyway). `node --test server/projectmode.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const pm = await import('./projectmode.ts');
const tasks = await import('./tasks.ts');
const { helmTools, toolAccess, listHelmTools } = await import('./tools.ts');
const { presenceTag } = await import('./sessions.ts');
const { registerApi } = await import('./api.ts');
const { config } = await import('./config.ts');
const { setSetting } = await import('./settings.ts');

// What the mode sends and interrupts, recorded instead of reaching a Claude process.
const sent: { to: string; text: string }[] = [];
const interrupted: string[] = [];
pm.setProjectModeHooks({
  send: async (to, text) => void sent.push({ to, text }),
  interrupt: async (id) => {
    interrupted.push(id);
    db.run("UPDATE agents SET status = 'interrupted' WHERE id = ?", id);
  },
  root: (p) => runtime.rootAgent(p),
});

function makeProject() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'pm', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const worker = runtime.createAgent(project, director, role, 'Engineer', 'Build it.');
  const by = { author: 'user' as const, name: 'You' };
  const active = tasks.createTask(id, { title: 'Running work', state: 'active', origin: 'user' }, by);
  const scheduled = tasks.createTask(id, { title: 'Queued work', state: 'scheduled', origin: 'user' }, by);
  const waiting = tasks.createTask(id, { title: 'Later work', state: 'waiting', origin: 'user' }, by);
  db.run('UPDATE agents SET task_id = ?, status = ? WHERE id = ?', active.id, 'working', worker.id);
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', worker.id, active.id);
  return { project, director, worker, structure, active, scheduled, waiting };
}

const spawned: string[] = [];
const rt = {
  spawn: async (_p: any, role: string, name: string) => {
    spawned.push(name);
    return { id: 'ag_fake', name } as any;
  },
  send: async () => {},
  close: async () => {},
  markComplete: () => {},
};
function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const tools = helmTools(agent.id, rt as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown>) => {
    const t = tools.find((x: any) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const res: any = await t.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
}
const setMode = (projectId: string, mode: string) => db.run('UPDATE projects SET mode = ?, mode_since = ? WHERE id = ?', mode, db.now(), projectId);
const modeOf = (projectId: string) => db.get('SELECT mode, mode_data FROM projects WHERE id = ?', projectId)!;

test('every Helm tool has a category, so the rules cover tools by what they do', () => {
  const s = defaultStructure();
  const names = new Set<string>();
  for (const r of s.roles) for (const parent of [null, 'ag_x']) for (const t of listHelmTools(s, r.id, parent)) names.add(t.name);
  for (const t of listHelmTools(s, s.roles.find((r) => r.id !== s.root)!.id, 'ag_x', true)) names.add(t.name);
  const missing = [...names].filter((n) => !pm.TOOL_CATEGORIES[n]);
  assert.deepEqual(missing, [], `give these a category in TOOL_CATEGORIES (projectmode.ts): ${missing.join(', ')}`);
  // Unknown tools fall back on their name: reads by prefix, anything else acts (refused while stopped).
  assert.equal(pm.toolCategory('list_dashboards'), 'read');
  assert.equal(pm.toolCategory('get_tile'), 'read');
  assert.equal(pm.toolCategory('refresh_tile'), 'act');
});

test('the gating table: category × mode', () => {
  const { project } = makeProject();
  const table: [string, Record<string, unknown>, Record<string, boolean>][] = [
    // tool, input, refused in: running, winding_down, at_rest, stopped
    ['list_tasks', {}, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['task_post', { task: 'x', message: 'hi' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['set_doc', { id: 'd' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['ask_user', { title: 't', question: 'q' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['close_agent', { agent: 'x' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['complete_task', { summary: 's' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['spawn_agent', { role: 'r', name: 'n', task: 't' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['quick_job', { job: 'j' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['message_agent', { agent: 'x', message: 'm' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['answer_helper', { ref: 'r', answer: 'a' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['decide_permission', {}, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['claim_host', { host: 'h', activity: 'a' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['refresh_tile', {}, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['list_dashboards', {}, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['update_tile', { tile: 't' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['review_dashboard_scope', {}, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['set_tile', { dashboard: 'd' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['set_dashboard', { dashboard: 'd', title: 'x' }, { running: false, winding_down: false, at_rest: false, stopped: true }],
    ['set_dashboard', { title: 'New', description: 'x' }, { running: false, winding_down: true, at_rest: true, stopped: true }],
    ['create_task', { state: 'planning' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['create_task', { state: 'waiting' }, { running: false, winding_down: true, at_rest: true, stopped: false }],
    ['create_task', { state: 'scheduled' }, { running: false, winding_down: true, at_rest: true, stopped: false }],
    ['create_task', { state: 'active' }, { running: false, winding_down: true, at_rest: true, stopped: true }],
    ['convert', { to: 'task' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
    ['convert', { to: 'task', state: 'waiting' }, { running: false, winding_down: true, at_rest: true, stopped: false }],
    // update_task is judged against the task (stateRefusal below): restating a task's own state is no change.
    ['update_task', { state: 'active' }, { running: false, winding_down: false, at_rest: false, stopped: false }],
  ];
  for (const mode of pm.MODES) {
    setMode(project.id, mode);
    for (const [name, input, want] of table) {
      // Queue only: like Autopilot, except the director's new task lined up or started (no user message this turn).
      const expected = mode === 'queue_only' ? name === 'create_task' && ['scheduled', 'active'].includes(String(input.state)) : want[mode];
      assert.equal(!!pm.toolRefusal(project.id, name, input), expected, `${name} ${JSON.stringify(input)} in ${mode}`);
    }
    const st = (s: string) => !!pm.stateRefusal(project.id, s);
    assert.deepEqual([st('active'), st('scheduled'), st('paused'), st('done'), st('waiting')], mode === 'running' || mode === 'queue_only' ? [false, false, false, false, false] : mode === 'stopped' ? [true, false, false, false, false] : [true, true, false, false, false], `states in ${mode}`);
    // Built-in tools: only background work, only while stopped.
    assert.equal(!!pm.builtinRefusal(project.id, 'Agent'), mode === 'stopped');
    assert.equal(!!pm.builtinRefusal(project.id, 'Bash', { run_in_background: true }), mode === 'stopped');
    assert.equal(!!pm.builtinRefusal(project.id, 'Bash', { command: 'git log' }), false);
    assert.equal(!!pm.builtinRefusal(project.id, 'Read', {}), false);
  }
});

test('winding down, through the tools: no builder starts for Scheduled work, the director only proposes', async () => {
  const { project, director, worker, active, scheduled } = makeProject();
  setMode(project.id, 'winding_down');
  const d = toolsFor(director);
  const { plan } = await import('./dispatch.ts');
  assert.ok(!plan(project.id).some((t) => t.id === scheduled.id), 'the scheduled task does not start');
  // Moving work along is refused; restating a task's state and settling are not.
  assert.ok((await d('update_task', { task: scheduled.id, state: 'active' })).error);
  assert.ok((await d('update_task', { task: tasks.createTask(project.id, { title: 'W', state: 'waiting', origin: 'user' }, tasks.USER).id, state: 'scheduled' })).error);
  assert.ok(!(await d('update_task', { task: active.id, state: 'active', status_summary: 'Going well.' })).error);
  assert.ok((await d('create_task', { title: 'Idea', description: 'x', state: 'scheduled' })).error);
  const plan2 = await d('create_task', { title: 'Idea for later', description: 'x', state: 'planning' });
  assert.ok(!plan2.error, plan2.text);
  // Stopped: the director's tools that message agents are refused; reading and posting are not, and nothing starts.
  setMode(project.id, 'stopped');
  assert.match((await d('message_agent', { agent: worker.id, message: 'go on' })).text, /the project is stopped/);
  assert.ok(!(await d('list_tasks', {})).error);
  assert.ok(!(await d('task_post', { task: active.id, message: 'Answering the user.' })).error);
  assert.deepEqual(plan(project.id), []);
});

test('the wind down ends at rest when the last Active task settles and nobody works; the director is asked for a close-out', async () => {
  const { project, director, worker, active } = makeProject();
  sent.length = 0;
  assert.equal(await pm.windDown(project.id, 'release testing'), null);
  assert.equal(modeOf(project.id).mode, 'winding_down');
  assert.match(sent[0].text, /set the project to Finish up/);
  assert.match(sent[0].text, /release testing/);
  assert.equal(await pm.windDown(project.id), 'The project is already finishing up.');
  // The worker finishes; the task is still Active: not yet.
  db.run("UPDATE agents SET status = 'done' WHERE id = ?", worker.id);
  assert.equal(await pm.checkAtRest(project.id), false);
  // The director settles it while working: not yet either.
  db.run("UPDATE agents SET status = 'working' WHERE id = ?", director.id);
  tasks.setTaskState(tasks.getTask(active.id)!, 'done', { author: 'director', name: 'Director' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(modeOf(project.id).mode, 'winding_down');
  // Its turn ends.
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", director.id);
  sent.length = 0;
  assert.equal(await pm.checkAtRest(project.id), true);
  assert.equal(await pm.checkAtRest(project.id), false, 'once');
  const m = modeOf(project.id);
  assert.equal(m.mode, 'at_rest');
  const data = JSON.parse(m.mode_data);
  assert.deepEqual(data.finished.map((t: any) => t.id), [active.id]);
  assert.deepEqual([data.scheduled, data.waiting], [1, 1]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Close-out:/);
  assert.ok(db.get("SELECT 1 AS x FROM journal WHERE project_id = ? AND title LIKE 'Wind down finished%'", project.id));
  // The close-out shows on the view once written.
  db.run("INSERT INTO journal (project_id, agent_id, kind, title, body, ts) VALUES (?,?,?,?,?,?)", project.id, director.id, 'milestone', 'Close-out: ready to test', 'Build 12 is ready.', db.now() + 1);
  assert.equal(pm.modeView(project.id).closeout?.title, 'Close-out: ready to test');
  // Resume from at rest: running, and the director takes up the queue.
  sent.length = 0;
  assert.equal(await pm.resume(project.id), null);
  assert.equal(modeOf(project.id).mode, 'running');
  assert.match(sent[0].text, /set the project to Autopilot/);
});

test('a wind down with nothing running is at rest at once, with one note', async () => {
  const { project, worker, active } = makeProject();
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", worker.id);
  db.run("UPDATE tasks SET state = 'done' WHERE id = ?", active.id);
  sent.length = 0;
  assert.equal(await pm.windDown(project.id), null);
  assert.equal(modeOf(project.id).mode, 'at_rest');
  assert.equal(sent.length, 1);
});

test('stop records and interrupts the agents mid-turn; messages are held; resume restarts the chosen ones and delivers', async () => {
  const { project, director, worker } = makeProject();
  const helper = runtime.createAgent(project, worker, defaultStructure().roles.find((r) => r.id !== defaultStructure().root)!, 'Helper', 'x');
  db.run("UPDATE agents SET status = 'working', status_line = 'Renaming' WHERE id = ?", helper.id);
  db.run("UPDATE agents SET status = 'working', status_line = 'Settling' WHERE id = ?", director.id);
  db.run("UPDATE agents SET status_line = 'Writing the parser' WHERE id = ?", worker.id);
  interrupted.length = 0;
  assert.equal(await pm.stopAll(project.id, 'checking something'), null);
  assert.deepEqual(new Set(interrupted), new Set([director.id, worker.id, helper.id]));
  const rec = JSON.parse(modeOf(project.id).mode_data).interrupted;
  assert.equal(rec.find((a: any) => a.id === worker.id).doing, 'Writing the parser');
  assert.equal(rec.find((a: any) => a.id === worker.id).task_title, 'Running work');
  assert.equal(await pm.stopAll(project.id), 'The project is already stopped.');

  // Held: a manager's message to a worker, Helm's notes to the director. Not held: the user's own message to the director.
  await runtime.sendToAgent(worker.id, 'Please also fix the tests.', { kind: 'agent', name: 'Director' });
  await runtime.sendToAgent(director.id, '<helm-note>A report came in.</helm-note>', { kind: 'system', name: 'Helm' });
  await runtime.sendToAgent(helper.id, 'more', { kind: 'agent', name: 'Engineer' });
  const heldFor = (id: string) => db.all('SELECT text FROM held_messages WHERE agent_id = ? ORDER BY id', id).map((r) => r.text);
  assert.deepEqual(heldFor(worker.id), ['Please also fix the tests.']);
  assert.deepEqual(heldFor(director.id), ['<helm-note>A report came in.</helm-note>']);
  const inbound = (id: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", id).map((e) => JSON.parse(e.data).text as string);
  assert.equal(inbound(worker.id).length, 0, 'nothing reached the worker');
  await runtime.sendToAgent(director.id, 'What is the state of things?', { kind: 'user', name: 'You' });
  assert.deepEqual(inbound(director.id), ['What is the state of things?'], 'the user reaches the director');
  assert.match(presenceTag(project.id), /project="Stopped"/);

  // Resume the worker only. The project returns to running; the director is told who resumed and who did not.
  sent.length = 0;
  assert.equal(await pm.resume(project.id, [worker.id]), null);
  assert.equal(modeOf(project.id).mode, 'running');
  // The director always continues (it is told either way), with what it was doing and who was left stopped.
  assert.deepEqual(sent.map((s) => s.to).sort(), [worker.id, director.id].sort());
  assert.match(sent.find((s) => s.to === worker.id)!.text, /Writing the parser/);
  assert.match(sent.find((s) => s.to === director.id)!.text, /while you were: Settling.*Left stopped, for the user to resume: Helper \[\[/s);
  // Held messages go first at the next delivery, in order.
  await runtime.sendToAgent(worker.id, 'Carry on.', { kind: 'system', name: 'Helm' });
  assert.deepEqual(inbound(worker.id).slice(0, 2), ['Please also fix the tests.', 'Carry on.']);
  assert.deepEqual(heldFor(worker.id), []);
  assert.deepEqual(heldFor(helper.id), ['more'], 'kept for the agent not resumed, until it is next messaged');
});

test('stop while winding down; resume goes back to winding down', async () => {
  const { project } = makeProject();
  await pm.windDown(project.id);
  await pm.stopAll(project.id);
  assert.equal(modeOf(project.id).mode, 'stopped');
  assert.equal(await pm.windDown(project.id), 'The project is stopped. Resume it first; then you can finish up.');
  await pm.resume(project.id);
  assert.equal(modeOf(project.id).mode, 'winding_down');
});

test('agents are told: the prompt section, and one note per change', () => {
  const { project, director, worker } = makeProject();
  assert.equal(pm.modePromptSection(director, true), '');
  assert.equal(pm.modeChangeNote(db.get('SELECT * FROM agents WHERE id = ?', director.id)!, true), '');
  setMode(project.id, 'winding_down');
  const again = () => db.get('SELECT * FROM agents WHERE id = ?', director.id)!;
  assert.match(pm.modeChangeNote(again(), true), /# The project is finishing up/);
  assert.equal(pm.modeChangeNote(again(), true), '', 'once');
  assert.match(pm.modePromptSection(worker, false), /finish the task you are on/);
  db.run("UPDATE projects SET mode = 'running', mode_since = ? WHERE id = ?", db.now() + 5, project.id);
  assert.match(pm.modeChangeNote(again(), true), /The project is on Autopilot: the earlier rules about finishing up/);
});

test('the user is never blocked by the mode, except that starting a task asks first and starts only that one', async () => {
  const { project, active, scheduled, waiting } = makeProject();
  const app = Fastify();
  registerApi(app);
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as any });

  const wd = await post(`/api/projects/${project.id}/mode`, { action: 'wind_down', note: 'release' });
  assert.equal(wd.statusCode, 200, wd.body);
  assert.equal(wd.json().mode, 'winding_down');
  // A new task lands in Waiting, with a note.
  const add = await post(`/api/projects/${project.id}/tasks`, { title: 'New idea', scheduled: true });
  assert.equal(add.statusCode, 200);
  assert.equal(tasks.getTask(add.json().id)!.state, 'waiting');
  assert.match(add.json().note, /finishing up/);
  // Start asks first; Start anyway starts just that task.
  const start = await post(`/api/tasks/${scheduled.id}/start`);
  assert.equal(start.statusCode, 409);
  assert.equal(start.json().needsConfirm, true);
  assert.equal(tasks.getTask(scheduled.id)!.state, 'scheduled');
  const anyway = await post(`/api/tasks/${scheduled.id}/start`, { anyway: true });
  assert.equal(anyway.statusCode, 200, anyway.body);
  assert.equal(tasks.getTask(scheduled.id)!.state, 'active');
  assert.equal(tasks.getTask(waiting.id)!.state, 'waiting', 'only that one');
  // A dashboard the user describes lands Waiting too.
  setSetting(project.id, 'dashboards', true);
  const dash = await post(`/api/projects/${project.id}/dashboards`, { description: 'Frame time per level, as a chart.' });
  assert.equal(dash.statusCode, 200, dash.body);
  assert.equal(tasks.getTask(dash.json().task_id)!.state, 'waiting');
  // Everything else goes through as usual.
  for (const [url, body] of [
    [`/api/tasks/${waiting.id}/approve`, {}],
    [`/api/tasks/${active.id}/interrupt`, {}],
    [`/api/tasks/${add.json().id}/drop`, {}],
    [`/api/tasks/${active.id}/message`, { text: 'How is it going?' }],
    [`/api/projects/${project.id}/message`, { text: 'Hello' }],
  ] as const) {
    const r = await post(url, body);
    assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
  }
  assert.equal(tasks.getTask(waiting.id)!.state, 'scheduled', 'approving queues it; it stays held');
  // Stopped: the user still talks to the director; a message to a worker is held, not refused.
  const stop = await post(`/api/projects/${project.id}/mode`, { action: 'stop' });
  assert.equal(stop.json().mode, 'stopped');
  const worker = db.get('SELECT * FROM agents WHERE project_id = ? AND parent_id IS NOT NULL', project.id)!;
  const m = await post(`/api/agents/${worker.id}/message`, { text: 'hi' });
  assert.equal(m.statusCode, 200);
  assert.equal(m.json().held, true);
  assert.equal((await post(`/api/projects/${project.id}/message`, { text: 'Status?' })).statusCode, 200);
  const res = await post(`/api/projects/${project.id}/mode`, { action: 'resume' });
  assert.equal(res.json().mode, 'winding_down', 'back to where it was');
  const run = await post(`/api/projects/${project.id}/mode`, { action: 'resume' });
  assert.equal(run.json().mode, 'running');
  assert.equal((await post(`/api/projects/${project.id}/mode`, { action: 'resume' })).statusCode, 409);
  await app.close();
});

// ---------- Queue only ----------

const userSays = (agent: any, text: string) => db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)", agent.project_id, agent.id, db.now(), 'inbound', JSON.stringify({ from: { kind: 'user', name: 'You' }, text }));
const turnEnds = (agent: any) => db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)", agent.project_id, agent.id, db.now(), 'result', '{}');

test('Queue only: the director never lines up a waiting task unless the user asked for it this turn; scheduled work runs', async () => {
  const { project, director, scheduled, waiting } = makeProject();
  assert.equal(await pm.changeMode(project.id, 'queue_only'), null);
  assert.equal(modeOf(project.id).mode, 'queue_only');
  // The director scheduling or starting a Waiting task by itself: refused, with the reason.
  const err = tasks.agentStateChangeError(waiting, 'scheduled', director.id);
  assert.match(err ?? '', /Queue only/);
  assert.ok(tasks.agentStateChangeError(waiting, 'active', director.id));
  assert.ok(pm.toolRefusal(project.id, 'create_task', { state: 'scheduled' }, director.id));
  // Scheduled work goes on: it starts, and the builder still takes it (the queue is not held).
  assert.equal(tasks.agentStateChangeError(scheduled, 'active', director.id), null);
  const { queueHeld } = await import('./builder.ts');
  assert.equal(queueHeld(project), null);
  // The user's own message this turn asks for that task (by title or id): allowed; another task still is not.
  userSays(director, 'Please do the later work next.');
  assert.equal(tasks.agentStateChangeError(waiting, 'scheduled', director.id), null);
  assert.equal(pm.toolRefusal(project.id, 'create_task', { state: 'scheduled' }, director.id), null);
  const other = tasks.createTask(project.id, { title: 'Unrelated polish', state: 'waiting', origin: 'user' }, { author: 'user', name: 'You' });
  assert.ok(tasks.agentStateChangeError(other, 'scheduled', director.id));
  // A report or Helm note is not the user; the next turn starts afresh.
  turnEnds(director);
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)", project.id, director.id, db.now(), 'inbound', JSON.stringify({ from: { kind: 'system', name: 'Helm' }, text: `later work ${waiting.id}` }));
  assert.ok(tasks.agentStateChangeError(waiting, 'scheduled', director.id));
  userSays(director, `Start [[${other.id}]]`);
  assert.equal(tasks.agentStateChangeError(other, 'active', director.id), null);
  // The director's rules say so, and the away nudge never asks it to schedule waiting work.
  assert.match(pm.modeRules(project.id, true, true), /never move a Waiting, Planning or Paused task/i);
  assert.equal(pm.modeRules(project.id, false, false), '');
});

test('Queue only: when the queue empties the user is told once', async () => {
  const { project, worker, active, scheduled } = makeProject();
  // A new project starts in Queue only with nothing ever queued: nothing to tell.
  const fresh = makeProject();
  db.run("UPDATE tasks SET state = 'waiting' WHERE project_id = ? AND state IN ('active', 'scheduled')", fresh.project.id);
  db.run("UPDATE agents SET status = 'idle' WHERE project_id = ?", fresh.project.id);
  db.run("UPDATE projects SET mode = 'queue_only', mode_data = '{}' WHERE id = ?", fresh.project.id);
  assert.equal(await pm.checkAtRest(fresh.project.id), false);

  assert.equal(await pm.changeMode(project.id, 'queue_only'), null);
  assert.equal(await pm.checkAtRest(project.id), false, 'work is queued');
  db.run("UPDATE tasks SET state = 'done' WHERE id IN (?, ?)", active.id, scheduled.id);
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", worker.id);
  assert.equal(await pm.checkAtRest(project.id), true, 'told');
  assert.equal(await pm.checkAtRest(project.id), false, 'once');
  // Work comes back and empties again: told again, once.
  db.run("UPDATE tasks SET state = 'scheduled' WHERE id = ?", scheduled.id);
  assert.equal(await pm.checkAtRest(project.id), false);
  db.run("UPDATE tasks SET state = 'done' WHERE id = ?", scheduled.id);
  assert.equal(await pm.checkAtRest(project.id), true);
  assert.equal(await pm.checkAtRest(project.id), false);
  assert.equal(modeOf(project.id).mode, 'queue_only');
});

test('the four choices: set from the menu or Setup, Stopped and back to the chosen mode', async () => {
  const { project, worker } = makeProject();
  assert.match(await pm.changeMode(project.id, 'at_rest') ?? '', /Choose a mode/);
  assert.equal(await pm.changeMode(project.id, 'queue_only'), null);
  assert.equal(await pm.changeMode(project.id, 'stopped'), null);
  assert.ok(interrupted.includes(worker.id));
  assert.equal(await pm.changeMode(project.id, 'running'), null);
  assert.equal(modeOf(project.id).mode, 'running');
  assert.equal(await pm.changeMode(project.id, 'winding_down'), null);
  assert.equal(modeOf(project.id).mode, 'winding_down');
  assert.equal(await pm.changeMode(project.id, 'queue_only'), null);
  assert.equal(modeOf(project.id).mode, 'queue_only');
  assert.match(await pm.changeMode(project.id, 'queue_only') ?? '', /already/);
});
