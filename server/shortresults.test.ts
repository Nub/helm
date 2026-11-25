import { SCRATCH } from './testenv.ts';
// The director's tools answer in a line, not with the whole list: update_task, set_importance, list_agents (unfinished
// agents unless all: true). `node --test server/shortresults.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

test('update_task and set_importance say one line; list_agents leaves finished agents out unless asked', async () => {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'sr', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const ts = Array.from({ length: 30 }, (_, i) => tasks.createTask(id, { title: `Task number ${i}`, state: 'waiting', origin: 'user' }, { author: 'user', name: 'You' }));
  const old = runtime.createAgent(project, director, role, 'Old engineer', 'x');
  db.run("UPDATE agents SET status = 'closed' WHERE id = ?", old.id);
  runtime.createAgent(project, director, role, 'Current engineer', 'x');
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(structure, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => ((await tools.find((x: any) => x.name === name)!.handler(input, {})) as any).content[0].text as string;
  const upd = await call('update_task', { task: ts[3].id, status_summary: 'Half way.' });
  assert.match(upd, new RegExp(`^Updated the task "Task number 3" \\[\\[${ts[3].id}\\]\\]: Waiting\\.`));
  assert.ok(!upd.includes('Task number 7'), 'not the whole list');
  const imp = await call('set_importance', { changes: [{ id: ts[5].id, importance: 2 }] });
  assert.ok(!imp.includes('Task number 9'));
  const agents = await call('list_agents', {});
  assert.ok(agents.includes('Current engineer') && !agents.includes('Old engineer'));
  assert.ok((await call('list_agents', { all: true })).includes('Old engineer'));
});
