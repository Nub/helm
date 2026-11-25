import { SCRATCH } from './testenv.ts';
// Short tool results (task_b7e9fd8087): list_tasks and list_agents stay under 8k characters by default however long a
// project's history is; any Helm tool result over RESULT_MAX is cut with a pointer to filters and paging; the
// director's context window follows its setting. `node --test server/shortlists.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const agents = await import('./agents.ts');
const { createTask } = await import('./tasks.ts');
const { helmTools, toolAccess, capResult, RESULT_MAX } = await import('./tools.ts');
const { directorWindow } = await import('./contextsave.ts');
const { setSetting } = await import('./settings.ts');

agents.bindAgentOps('test', { send: async () => {}, close: async () => {}, interrupt: async () => {}, restartForProjects: () => {}, resolvePermission: () => {}, liveAgentIds: () => new Set() });

const by = { author: 'director' as const, name: 'Director' };
const long = 'A status summary that goes on about what was done and what is left, at the length agents really write them. '.repeat(4);

function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'short', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = agents.rootAgent(project);
  // A long history: 200 done tasks with long summaries, 120 finished agents with worklists; a few open of each.
  for (let i = 0; i < 200; i++) {
    const t = createTask(id, { title: `Finished piece of work number ${i} with a fairly long descriptive title`, state: 'active', origin: 'director' }, by);
    db.run("UPDATE tasks SET state = 'done', status_summary = ? WHERE id = ?", long, t.id);
  }
  for (let i = 0; i < 4; i++) {
    const t = createTask(id, { title: `Open task ${i}`, state: 'scheduled', origin: 'director' }, by);
    db.run('UPDATE tasks SET status_summary = ? WHERE id = ?', long, t.id);
  }
  for (let i = 0; i < 120; i++) {
    const a = db.newId('ag');
    db.run("INSERT INTO agents (id, project_id, name, role_id, parent_id, model, status, status_line, created_at, updated_at) VALUES (?,?,?,?,?,'m','done',?,?,?)", a, id, `Builder ${i}`, 'builder', director.id, long, db.now() + i, db.now() + i);
    for (let k = 0; k < 6; k++) db.run("INSERT INTO checklist (agent_id, sort, text, state, updated_at) VALUES (?,?,?,'done',?)", a, k, `Step ${k} of a worklist item with words`, db.now());
  }
  return { project, director };
}

function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const ts = helmTools(agent.id, { send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown> = {}) => {
    const t: any = ts.find((x: any) => x.name === name);
    const res: any = await t.handler(input, {});
    return res.content[0].text as string;
  };
}

test('list_tasks and list_agents stay under 8k characters by default on a long history', async () => {
  const { director } = setup();
  const call = toolsFor(director);
  const tasks = await call('list_tasks');
  assert.ok(tasks.length < 8000, `list_tasks is ${tasks.length} characters`);
  assert.match(tasks, /Open task 3/);
  assert.doesNotMatch(tasks, /Finished piece of work/);
  assert.match(tasks, /200 done or dropped not listed \(all: true/);
  const agentsText = await call('list_agents');
  assert.ok(agentsText.length < 8000, `list_agents is ${agentsText.length} characters`);
  // all: true pages instead of dumping: every page fits, and the pages cover every task.
  const p1 = await call('list_tasks', { all: true });
  assert.ok(p1.length < 8000 && /Page 1 of 9; page: 2 for the next/.test(p1), p1.slice(-200));
  const p9 = await call('list_tasks', { all: true, page: 9 });
  assert.match(p9, /^201\. /m);
  assert.match(p9, /Page 9 of 9\./);
  const a1 = await call('list_agents', { all: true });
  assert.ok(a1.length < 8000 && /Page 1 of \d+; page: 2/.test(a1), `list_agents all is ${a1.length}`);
  assert.match(a1, /^- Builder 119 \[\[ag_\w+\]\], done: /m);
});

test('a tool result over RESULT_MAX is cut, naming the tool\'s filters', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const out = capResult({ content: [{ type: 'text', text }] }, ['topic', 'page']);
  const cut = out.content[0].text;
  assert.ok(cut.length < RESULT_MAX + 200);
  assert.match(cut, new RegExp(`Cut at ${RESULT_MAX} of ${text.length} characters\\. Use filters or paging \\(topic, page\\)`));
  assert.match(cut.split('\n\n[Cut')[0], /line \d+$/, 'cut at a line end');
  const small = { content: [{ type: 'text', text: 'short' }] };
  assert.equal(capResult(small), small);
});

test("the director's context window follows its setting", () => {
  const { project } = setup();
  assert.equal(directorWindow(project.id), 250_000);
  assert.equal(setSetting(project.id, 'director_context', '150000'), null);
  assert.equal(directorWindow(project.id), 150_000);
  assert.equal(setSetting(project.id, 'director_context', 'model'), null);
  assert.equal(directorWindow(project.id), null);
});

test('list_tasks filters by state and driver; list_agents by task and status (task_9b43317cb3)', async () => {
  const { director, project } = setup();
  const call = toolsFor(director);
  const b = db.newId('ag');
  db.run("INSERT INTO agents (id, project_id, name, role_id, parent_id, model, status, status_line, created_at, updated_at) VALUES (?,?,?,?,?,'m','working','x',?,?)", b, project.id, 'Driver Bee', 'builder', director.id, db.now(), db.now());
  const t = createTask(project.id, { title: 'Driven one', state: 'paused', origin: 'director', driver_agent_id: b } as any, by);
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, b);
  // state
  const paused = await call('list_tasks', { state: ['paused'] });
  assert.match(paused, /Driven one/); assert.doesNotMatch(paused, /Open task/);
  const sched = await call('list_tasks', { state: ['scheduled'] });
  assert.match(sched, /Open task 0/); assert.doesNotMatch(sched, /Driven one/);
  // closed states without all; with page
  const done = await call('list_tasks', { state: ['done'] });
  assert.match(done, /Finished piece/); assert.match(done, /Page 1 of 8; page: 2/);
  assert.match(await call('list_tasks', { state: ['done'], page: 2 }), /Page 2 of 8/);
  assert.doesNotMatch(await call('list_tasks', { state: ['done'], all: true, page: 8 }), /Open task/);
  // driver by name and id; me
  for (const d of ['Driver Bee', b]) { const r = await call('list_tasks', { driver: d }); assert.match(r, /Driven one/); assert.doesNotMatch(r, /Open task/); }
  assert.match(await call('list_tasks', { driver: 'Driver Bee', state: ['scheduled'], all: true }), /No tasks match/);
  assert.match(await call('list_tasks', { driver: 'me' }), /No tasks match/);
  assert.match(await call('list_tasks', { driver: 'nobody' }), /No agent/);
  // agents
  const byTask = await call('list_agents', { task: t.id });
  assert.match(byTask, /Driver Bee/); assert.doesNotMatch(byTask, /Builder 1/);
  const working = await call('list_agents', { status: 'working' });
  assert.match(working, /Driver Bee/); assert.doesNotMatch(working, /Builder 1/);
  const doneA = await call('list_agents', { status: 'done' });
  assert.match(doneA, /Builder 119/); assert.doesNotMatch(doneA, /Driver Bee/); assert.match(doneA, /Page 1 of 4/);
  assert.doesNotMatch(await call('list_agents', { status: 'done', all: true, page: 4 }), /Driver Bee/);
  assert.match(await call('list_agents', { task: 'nope' }), /No agents match/);
});

test('list_docs tag, read_knowledge paths, list_importance, list_dashboards stale, get_telemetry section (task_9b43317cb3)', async () => {
  const { director, project } = setup();
  const call = toolsFor(director);
  const now = db.now();
  const doc = (title: string, tags: string[]) => db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, tags, status, importance, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", db.newId('doc'), project.id, 'entry', title, 's', 'b', JSON.stringify(tags), 'active', 3, now, now);
  doc('Tagged alpha', ['alpha']); doc('Tagged beta', ['beta']);
  const a = await call('list_docs', { tag: 'alpha' });
  assert.match(a, /Tagged alpha/); assert.doesNotMatch(a, /Tagged beta/);
  assert.match(await call('list_docs', { tag: 'zzz' }), /No entry is tagged/);
  // importance
  const imp = await call('list_importance', { target: 'task', min_level: 1 });
  assert.match(imp, /^# Tasks/); assert.doesNotMatch(imp, /Spec entries/);
  assert.match(await call('list_importance', { target: 'doc' }), /^# Spec entries/);
  // telemetry sections
  const f = await call('get_telemetry', { section: 'focus' });
  assert.match(f, /^Focus/); assert.ok(f.length < (await call('get_telemetry', {})).length);
});
