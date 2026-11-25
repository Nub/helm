import { SCRATCH } from './testenv.ts';
// Builders (builder.ts; dispatch.ts has its own tests): review only when marked, the hold, usage by who, the user's
// queue actions, a new project's roles. `node --test server/builder.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const b = await import('./builder.ts');
const { setSetting } = await import('./settings.ts');
const { recordOwnerActivity } = await import('./sessions.ts');
const { recordTurnUsage, tokensByWho } = await import('./usage.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
const GB = 1024 ** 3;

function setup(mode: 'builder' | 'team' = 'builder') {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'bd', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now()); // tests of other rules: no Spec links needed (specadherence.ts)
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  recordOwnerActivity(id);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const tools = helmTools(director.id, { send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const task = (title: string, state: string, extra: Record<string, unknown> = {}) => {
    const t = tasks.createTask(id, { title, state, origin: 'director', description: `Do ${title}.`, ...extra } as any, USER);
    db.run("UPDATE tasks SET check_how = 'npm test' WHERE id = ?", t.id);
    return tasks.getTask(t.id)!;
  };
  return { project, director, builder, call, task };
}
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const batchRecords = (projectId: string) => db.all("SELECT title, body FROM journal WHERE project_id = ? AND title LIKE 'Batch:%' ORDER BY id", projectId);
const settle = () => new Promise((r) => setTimeout(r, 20));

test('review is opt-in: only a task marked for review is reviewed, whatever its text names', async () => {
  for (const text of ['Change server/runtime.ts session start.', 'Touch releases.ts', 'nix/live-update.sh', 'Rotate the API credentials']) {
    assert.equal(b.isRisky({ title: 'x', description: text }), false, text);
  }
  assert.equal(b.isRisky({ title: 'Rename a button', description: '', risky: 1 }), true);
  assert.equal(b.isRisky({ title: 'Touch releases.ts', description: '', risky: 0 }), false);
  const { project, call } = setup();
  const plain = await call('create_task', { title: 'Tidy server/runtime.ts comments', description: 'In server/runtime.ts and releases.ts.', state: 'waiting' });
  const flagged = await call('create_task', { title: 'Change the update path', description: 'nix/live-update.sh', state: 'waiting', review: true });
  assert.ok(!plain.error && !flagged.error, plain.text + flagged.text);
  const row = (title: string) => db.get('SELECT * FROM tasks WHERE project_id = ? AND title = ?', project.id, title)!;
  assert.equal(row('Change the update path').risky, 1);
  // risky stays accepted as the old name.
  await call('update_task', { task: row('Tidy server/runtime.ts comments').id, risky: true });
  assert.equal(row('Tidy server/runtime.ts comments').risky, 1);
});

test('a hold (wind down, stop, low disk): no builder starts for Scheduled work', async () => {
  const disk = await import('./disk.ts');
  const { dispatchProject } = await import('./dispatch.ts');
  for (const hold of ['winding_down', 'stopped', 'disk'] as const) {
    const { project, task } = setup();
    const next = task('Next', 'scheduled');
    db.run("UPDATE tasks SET touches = '[\"n.ts\"]' WHERE id = ?", next.id);
    if (hold === 'disk') disk._internal.setCurrent([{ dev: 1, holds: [{ label: 'Helm data', path: SCRATCH }], size: 100 * GB, free: 1 * GB, level: 'critical', warning: 40 * GB, critical: 10 * GB } as any]);
    else db.run('UPDATE projects SET mode = ? WHERE id = ?', hold, project.id);
    assert.deepEqual(await dispatchProject(project.id), [], hold);
    assert.equal(tasks.getTask(next.id)!.state, 'scheduled', hold);
    if (hold === 'disk') disk._internal.setCurrent([{ dev: 1, holds: [{ label: 'Helm data', path: SCRATCH }], size: 100 * GB, free: 80 * GB, level: 'ok', warning: 40 * GB, critical: 10 * GB } as any]);
  }
});

test('usage is split into directing and building', () => {
  const { project, director, builder } = setup();
  recordTurnUsage({ ...director, usage_seen: 0 }, { m: { inputTokens: 500 } } as any, 'deep', 'director');
  recordTurnUsage({ ...builder, usage_seen: 0 }, { m: { inputTokens: 900 } } as any, 'skilled', 'builder');
  const by = tokensByWho(project.id);
  assert.deepEqual([by.director, by.builder], [500, 900]);
});

test('Unschedule takes a Scheduled task back to Waiting, and Schedule puts it back; Pause and Resume are the user\'s actions', async () => {
  const { task, builder } = setup();
  const { taskAction } = await import('./taskactions.ts');
  // The builder is at work, so a task put back in the queue waits there.
  db.run("UPDATE agents SET status = 'working' WHERE id = ?", builder.id);
  const t = task('Queued thing', 'scheduled');
  assert.deepEqual(await taskAction(tasks.getTask(t.id)!, 'unschedule'), {});
  assert.equal(tasks.getTask(t.id)!.state, 'waiting');
  assert.match((await taskAction(tasks.getTask(t.id)!, 'unschedule')).error ?? '', /applies to Scheduled/);
  assert.deepEqual(await taskAction(tasks.getTask(t.id)!, 'approve'), {});
  assert.ok(['scheduled', 'active'].includes(tasks.getTask(t.id)!.state), 'Schedule undoes it (and Helm may start its builder at once)');
  const active = task('Running thing', 'active');
  assert.deepEqual(await taskAction(tasks.getTask(active.id)!, 'interrupt'), {});
  assert.equal(tasks.getTask(active.id)!.state, 'paused');
  assert.deepEqual(await taskAction(tasks.getTask(active.id)!, 'resume'), {});
  assert.equal(tasks.getTask(active.id)!.state, 'active');
});

test('a new project has the director and the builder whatever template is sent, and Setup has no work-mode switch', async () => {
  const { default: Fastify } = await import('fastify');
  const { config } = await import('./config.ts');
  const { registerApi } = await import('./api.ts');
  const { mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const app = Fastify();
  registerApi(app);
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const dir = join(SCRATCH, `newproj-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const r = await app.inject({ method: 'POST', url: '/api/projects', headers: { cookie }, payload: { mode: 'existing', path: dir, templateId: 'research' } });
  assert.equal(r.statusCode, 200, r.body);
  const p = db.get('SELECT * FROM projects WHERE id = ?', r.json().id)!;
  assert.deepEqual(JSON.parse(p.structure).roles.map((r: any) => r.id), ['director', 'builder']);
  assert.ok(b.builderMode(p.id));
  const s = await app.inject({ method: 'GET', url: `/api/projects/${p.id}/settings?all=1`, headers: { cookie } });
  assert.ok(!JSON.stringify(s.json()).includes('work_mode'));
  assert.ok(JSON.stringify(s.json()).includes('builder_subagents'));
  assert.ok(JSON.stringify(s.json()).includes('builders_at_once'));
  await app.close();
});
