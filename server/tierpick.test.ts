import { SCRATCH } from './testenv.ts';
// The user changes a task's tier by hand (taskapi.ts POST /api/tasks/:id/tier, workrules.ts userTier): stored, pinned,
// recorded in the thread; agents' update_task tier is refused afterwards and escalation leaves it; Deep needs no
// reason; the agent on it runs at the new tier (runtime.ts tierFor). `node --test server/tierpick.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const rules = await import('./workrules.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'tp', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  return { project, director, s, call };
}
const pick = (id: string, tier: string) => app.inject({ method: 'POST', url: `/api/tasks/${id}/tier`, headers: { cookie }, payload: { tier } });
const thread = (id: string) => db.all('SELECT author, kind, body FROM task_messages WHERE task_id = ? ORDER BY id', id);

test('the user sets the tier: stored, pinned, in the thread; update_task tier refused after; escalation leaves it', async () => {
  const { project, call } = setup();
  const t = tasks.createTask(project.id, { title: 'Fix it', state: 'scheduled', origin: 'user' }, USER);
  // Before the user sets it, the director may.
  assert.equal((await call('update_task', { task: t.id, tier: 'skilled' })).error, false);

  const res = await pick(t.id, 'routine');
  assert.equal(res.statusCode, 200, res.body);
  const row = tasks.getTask(t.id)!;
  assert.equal(row.tier, 'routine');
  assert.equal(row.tier_pinned, 1);
  const last = thread(t.id).at(-1)!;
  assert.deepEqual([last.author, last.kind, last.body], ['user', 'state', 'You set the tier to Routine.']);

  const refused = await call('update_task', { task: t.id, tier: 'light', tier_reason: 'well specified' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /user set the tier/);
  assert.equal(tasks.getTask(t.id)!.tier, 'routine');
  // Naming the same tier is no change, and the rest of the call goes through.
  const same = await call('update_task', { task: t.id, tier: 'routine', tier_reason: 'agree', title: 'Fix it now' });
  assert.equal(same.error, false, same.text);
  assert.equal(tasks.getTask(t.id)!.title, 'Fix it now');
  assert.equal(tasks.getTask(t.id)!.tier_reason, 'set by the user');

  assert.equal(rules.escalate(t.id, 'after a review with changes needed'), false);
  assert.equal(tasks.getTask(t.id)!.tier, 'routine');

  // A tier that does not exist is refused.
  assert.equal((await pick(t.id, 'huge')).statusCode, 400);
});

test('Deep by the user needs no reason; the agent on the task runs at it', async () => {
  const { project, director, s } = setup();
  const t = tasks.createTask(project.id, { title: 'Design', state: 'scheduled', origin: 'user' }, USER);
  const eng = runtime.createAgent(project, director, s.roles.find((r: any) => r.id === 'builder')!, 'Engineer', 'x');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, eng.id);
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', eng.id, t.id);
  const res = await pick(t.id, 'deep');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(tasks.getTask(t.id)!.tier, 'deep');
  assert.equal(runtime.tierFor(db.get('SELECT * FROM agents WHERE id = ?', eng.id)!).id, 'deep');
  await pick(t.id, 'light');
  assert.equal(runtime.tierFor(db.get('SELECT * FROM agents WHERE id = ?', eng.id)!).id, 'light');
  assert.deepEqual(thread(t.id).filter((m) => m.author === 'user').map((m) => m.body), ['You set the tier to Deep.', 'You set the tier to Light.']);
});
