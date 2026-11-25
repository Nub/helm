import { SCRATCH } from './testenv.ts';
// A task's parts (taskparts.ts): merge_tasks records one per merged task with its source and takes the umbrella
// title; update_task add_part appends one with its source; the task view lists them. `node --test server/taskparts.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { recordOwnerActivity } = await import('./sessions.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };

test('merge_tasks makes each merged task a part with its source; add_part appends one; the view lists them', async () => {
  const pid = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'tp', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  recordOwnerActivity(pid);
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const mk = (title: string, description: string) => tasks.createTask(pid, { title, description, state: 'waiting', origin: 'user' }, USER);
  const a = mk('Request card actions', '## Features\n- Open, Ask, Dismiss in the card\n\n## Done when\n- Shots');
  const b = mk('Pager under the card', '## Features\n- A pager\n\n## Done when\n- Arrows and dots move');
  const c = mk('Running cards on Home', '## Features\n- The title card on Home\n\n## Done when\n- Shot');

  // The umbrella title is asked for.
  assert.equal((await call('merge_tasks', { into: a.id, from: [b.id], why: 'Same card' })).error, true);
  const m = await call('merge_tasks', { into: a.id, from: [b.id, c.id], why: 'All Home cards', title: 'Home and request cards' });
  assert.ok(!m.error, m.text);
  const kept = tasks.getTask(a.id)!;
  assert.equal(kept.title, 'Home and request cards');
  let parts = db.all('SELECT * FROM task_parts WHERE task_id = ? ORDER BY position', a.id);
  assert.deepEqual(parts.map((p) => [p.title, p.source_kind, p.source_id]), [
    ['Request card actions', 'self', a.id],
    ['Pager under the card', 'task', b.id],
    ['Running cards on Home', 'task', c.id],
  ]);
  assert.match(parts[1].body, /## Done when\n- Arrows and dots move/);

  // A new ask from the thread folded in as one more part.
  const msg = tasks.addTaskMessage(kept, USER, 'Also show a share button on the running cards.');
  const add = await call('update_task', { task: a.id, add_part: { title: 'Share on running cards', source: String(msg), body: '## Features\n- Share\n\n## Done when\n- It shares' } });
  assert.ok(!add.error, add.text);
  parts = db.all('SELECT * FROM task_parts WHERE task_id = ? ORDER BY position', a.id);
  assert.equal(parts.length, 4);
  assert.deepEqual([parts[3].source_kind, parts[3].source_id], ['message', String(msg)]);
  const bad = await call('update_task', { task: a.id, add_part: { title: 'X', source: '99999' } });
  assert.equal(bad.error, true);

  const view = (await app.inject({ method: 'GET', url: `/api/tasks/${a.id}`, headers: { cookie } })).json();
  assert.equal(view.task.parts, 4);
  assert.deepEqual(view.parts.map((p: any) => p.source.label), ['The task itself', 'Merged task', 'Merged task', 'Your message']);
  assert.equal(view.parts[1].source.ref, b.id);
  assert.match(view.parts[3].source.excerpt, /share button/);
});
