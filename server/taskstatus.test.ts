import { SCRATCH } from './testenv.ts';
// The task page's Status data (taskstatus.ts): "Done when" items parsed from the description, ticked by update_task
// (and report_status on the agent's own task), shown at once in the task view. `node --test server/taskstatus.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { doneWhenItems } = await import('./taskstatus.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };
const DESC = '## Features\n- A thing\n\n## Done when\n- The test passes\n- Shots at 390 px\n1. Desktop shot\n\n## Notes\n- not an item';

const callAs = (agentId: string, s: any, roleId: string, taskId: string | null) => {
  const tools = helmTools(agentId, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, roleId, taskId));
  return async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
};
const statusOf = async (id: string) => (await app.inject({ method: 'GET', url: `/api/tasks/${id}`, headers: { cookie } })).json().status;

test('Done when items are parsed from the description', () => {
  assert.deepEqual(doneWhenItems(DESC), ['The test passes', 'Shots at 390 px', 'Desktop shot']);
  assert.deepEqual(doneWhenItems('No lists here.'), []);
});

test('update_task done_when ticks show at once in the task view; report_status ticks the agent its own task', async () => {
  const pid = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'st', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', pid)!;
  const director = runtime.rootAgent(project);
  const t = tasks.createTask(pid, { title: 'Status work', description: DESC, state: 'waiting', origin: 'user' }, USER);
  assert.deepEqual((await statusOf(t.id)).done_when.map((d: any) => d.done), [false, false, false]);

  const boss = callAs(director.id, s, director.role_id, null);
  const r = await boss('update_task', { task: t.id, done_when: [1, 3] });
  assert.ok(!r.error, r.text);
  assert.deepEqual((await statusOf(t.id)).done_when.map((d: any) => d.done), [true, false, true]);
  const bad = await boss('update_task', { task: t.id, done_when: [4] });
  assert.equal(bad.error, true);
  assert.match(bad.text, /3 items; 4 is not among them/);

  const builder = runtime.createAgent(project, director, s.roles.find((x) => x.id === 'builder')!, 'Builder', 'Build.');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, builder.id);
  const b = callAs(builder.id, s, 'builder', t.id);
  const rs = await b('report_status', { status: 'Shooting', done_when: [1, 2, 3] });
  assert.ok(!rs.error, rs.text);
  assert.deepEqual((await statusOf(t.id)).done_when.map((d: any) => d.done), [true, true, true]);
});
