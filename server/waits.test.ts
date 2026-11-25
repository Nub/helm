import { SCRATCH } from './testenv.ts';
// A task that waits for other tasks (waits.ts): links both ways, no cycles, no start while a blocker is open, a ready
// note when the last one is done. `node --test server/waits.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const waits = await import('./waits.ts');
const { taskAction } = await import('./taskactions.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const rt = { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} };
const DIRECTOR = { author: 'director' as const, name: 'Director', id: 'x' };

function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'w', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const tools = helmTools(director.id, rt as any, toolAccess(JSON.parse(project.structure), director.role_id, director.parent_id));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const task = (title: string, state = 'scheduled') => tasks.createTask(id, { title, state, origin: 'user' }, tasks.USER);
  return { project, director, call, task };
}

test('waits_for links both ways and refuses cycles, itself and other projects', async () => {
  const { call, task } = setup();
  const a = task('A');
  const b = task('B');
  const c = task('C');
  const res = await call('update_task', { task: c.id, waits_for: [a.id, b.id] });
  assert.ok(!res.error, res.text);
  assert.deepEqual(waits.waitsView(c.id).waits_for.map((t: any) => t.id), [a.id, b.id]);
  assert.deepEqual(waits.waitsView(a.id).blocks.map((t: any) => t.id), [c.id]);
  assert.match((await call('update_task', { task: a.id, waits_for: [c.id] })).text, /would be a cycle/);
  assert.match(waits.setWaits(a.id, [a.id])!, /cannot wait for itself/);
  const other = setup().task('Elsewhere');
  assert.match(waits.setWaits(a.id, [other.id])!, /No task .* on this project/);
  assert.equal((await call('update_task', { task: c.id, waits_for: [] })).error, false);
  assert.deepEqual(waits.waitsView(c.id).waits_for, []);
  const made = await call('create_task', { title: 'D', description: 'x', state: 'planning', waits_for: [a.id] });
  assert.ok(!made.error, made.text);
  const d = db.get("SELECT id FROM tasks WHERE title = 'D' AND project_id = ?", a.project_id)!;
  assert.deepEqual(waits.waitsView(d.id).waits_for.map((t: any) => t.id), [a.id]);
});

test('the row view (taskView, as in the Work list) carries what it waits for and what waits on it', () => {
  const { project, task } = setup();
  const a = task('First');
  const b = task('Second');
  const c = task('Third');
  assert.equal(waits.setWaits(c.id, [a.id, b.id]), null);
  assert.equal(waits.setWaits(b.id, [a.id]), null);
  const row = (id: string): any => tasks.listTasks(project.id).find((t: any) => t.id === id)!;
  assert.deepEqual(row(c.id).waits_for.map((t: any) => [t.id, t.title]), [[a.id, 'First'], [b.id, 'Second']]);
  assert.deepEqual(row(c.id).blocks, []);
  assert.deepEqual(row(a.id).blocks.map((t: any) => t.id).sort(), [b.id, c.id].sort());
  assert.deepEqual(row(b.id).waits_for.map((t: any) => t.title), ['First']);
  assert.deepEqual(row(b.id).blocks.map((t: any) => [t.id, t.title]), [[c.id, 'Third']]);
});

test('no start while a blocker is open, for agents and the user; a ready note when the last one is done', async () => {
  const { call, task } = setup();
  const a = task('First');
  const b = task('Second');
  waits.setWaits(b.id, [a.id]);
  const agent = await call('update_task', { task: b.id, state: 'active' });
  assert.ok(agent.error);
  assert.match(agent.text, /cannot become Active: It waits for/);
  const user = await taskAction(tasks.getTask(b.id)!, 'start');
  assert.match(user.error!, /It waits for "First"/);
  assert.equal(tasks.getTask(b.id)!.state, 'scheduled');
  tasks.setTaskState(tasks.getTask(a.id)!, 'active', DIRECTOR);
  tasks.setTaskState(tasks.getTask(a.id)!, 'done', DIRECTOR);
  assert.ok(db.get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE 'Ready:%'", b.id), 'its thread says it is ready');
  assert.deepEqual(waits.waitsView(b.id).waits_for, [], 'a done blocker no longer shows');
  assert.equal((await taskAction(tasks.getTask(b.id)!, 'start')).error, undefined);
  assert.equal(tasks.getTask(b.id)!.state, 'active');
});
