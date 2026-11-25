import { SCRATCH } from './testenv.ts';
// A task's References (taskrefs.ts) in its view: the Spec entries it implements, then related work (waits, merged
// tasks, similar done tasks found by search), capped and without itself. `node --test server/taskrefs.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const tasks = await import('./tasks.ts');
const { REFERENCES_MAX } = await import('./taskrefs.ts');
const { requestSearchRebuild, buildSearchIndexNow } = await import('./searchindex.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };

test('the task view lists its Spec entries and related work', async () => {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'tr', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  for (const [id, title] of [['doc_tr1', 'Nightly exports'], ['doc_tr2', 'Export formats']]) {
    db.run("INSERT INTO docs (id, project_id, kind, title, summary, created_at, updated_at) VALUES (?, ?, 'entry', ?, 'x', ?, ?)", id, pid, title, db.now(), db.now());
  }
  const t = tasks.createTask(pid, { title: 'Parquet nightly exporter writes partitions', description: 'The parquet nightly exporter writes one partition per day.', state: 'waiting', origin: 'user', doc_id: 'doc_tr1' }, USER);
  db.run("INSERT INTO doc_links (doc_id, task_id, relation, created_at) VALUES ('doc_tr2', ?, 'implements', ?)", t.id, db.now());
  const before = tasks.createTask(pid, { title: 'Schema first', state: 'done', origin: 'user' }, USER);
  db.run('INSERT INTO task_waits (task_id, waits_for, created_at) VALUES (?, ?, ?)', t.id, before.id, db.now());
  const merged = tasks.createTask(pid, { title: 'Old duplicate', state: 'dropped', origin: 'user' }, USER);
  db.run('UPDATE tasks SET merged_into = ? WHERE id = ?', t.id, merged.id);
  const similar = tasks.createTask(pid, { title: 'Parquet nightly exporter flushes the schema', description: 'The parquet nightly exporter flushed the schema per partition.', state: 'done', origin: 'user' }, USER);
  tasks.createTask(pid, { title: 'Login page typo', description: 'Fix the button label.', state: 'done', origin: 'user' }, USER);

  requestSearchRebuild();
  buildSearchIndexNow();
  const r = await app.inject({ method: 'GET', url: `/api/tasks/${t.id}`, headers: { cookie } });
  assert.equal(r.statusCode, 200, r.body);
  const refs = r.json().references;
  assert.deepEqual(refs.spec, ['doc_tr1', 'doc_tr2']);
  assert.deepEqual(refs.related.slice(0, 2), [before.id, merged.id], 'known links first');
  assert.ok(refs.related.includes(similar.id), 'a similar task found by search');
  assert.ok(!refs.related.includes(t.id));
  assert.ok(!refs.related.some((id: string) => db.get('SELECT title FROM tasks WHERE id = ?', id)?.title === 'Login page typo'), 'unrelated work is left out');
  assert.ok(refs.related.length <= REFERENCES_MAX);
});
