import { SCRATCH } from './testenv.ts';
// "No Spec entry · Discuss" on a task (specdiscuss.ts startTaskSpecDiscussion): one linked discussion, reused by a second
// tap, and the director woken once with the task, the sections and the closest entries; finished or linked tasks refused.
// `node --test server/taskspecdiscuss.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };
const post = (url: string) => app.inject({ method: 'POST', url, headers: { cookie }, payload: {} });
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));

test('Discuss on a task with no Spec entry opens one linked discussion, reused by a second tap, and wakes the director once', async () => {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'ts', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  db.run("INSERT INTO doc_sections (id, project_id, name, position, created_at, updated_at) VALUES ('sec_ts1', ?, 'Exports', 0, ?, ?)", pid, db.now(), db.now());
  db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, section_id, created_at, updated_at) VALUES ('doc_ts1', ?, 'entry', 'Daily exports', 'Exports are written once a day.', 'CSV files.', 'sec_ts1', ?, ?)", pid, db.now(), db.now());
  const t = tasks.createTask(pid, { title: 'Faster daily exports', description: 'Make the daily export quicker.', state: 'waiting', origin: 'user' }, USER);
  const before = inbound(director.id).length;

  const r1 = await post(`/api/tasks/${t.id}/spec-discussion`);
  assert.equal(r1.statusCode, 200, r1.body);
  const { id, created } = r1.json();
  assert.equal(created, true);
  const d = tasks.getTask(id)!;
  assert.deepEqual([d.kind, d.state, d.about_task, d.title], ['discussion', 'open', t.id, 'Spec for: Faster daily exports']);
  assert.equal(tasks.taskView(d).about.id, t.id);
  const note = inbound(director.id).slice(before).join('\n');
  assert.match(note, new RegExp(`find the Spec entry for .*\\[\\[${t.id}\\]\\]`));
  assert.match(note, /Spec sections: Exports/);
  assert.match(note, /Closest entries:\n- \[\[doc_ts1\]\] Daily exports/);
  assert.match(note, /update_task doc/);

  const r2 = await post(`/api/tasks/${t.id}/spec-discussion`);
  assert.deepEqual(r2.json(), { id, created: false });
  assert.equal(inbound(director.id).length - before, 1, 'the second tap reuses it without waking the director again');
  assert.equal(db.all('SELECT 1 FROM tasks WHERE about_task = ?', t.id).length, 1);

  // A task with an entry, or a finished one, has nothing to discuss.
  const linked = tasks.createTask(pid, { title: 'Linked', state: 'waiting', origin: 'user', doc_id: 'doc_ts1' }, USER);
  assert.equal((await post(`/api/tasks/${linked.id}/spec-discussion`)).statusCode, 400);
  const done = tasks.createTask(pid, { title: 'Old', state: 'done', origin: 'user' }, USER);
  assert.equal((await post(`/api/tasks/${done.id}/spec-discussion`)).statusCode, 400);
});
