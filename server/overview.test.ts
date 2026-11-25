import { SCRATCH } from './testenv.ts';
// The global Home (overview.ts): a card per project with what runs (and its agent's status line), what finished since
// the user last looked (with its picture), what failed or is stuck, and the digest across projects.
// `node --test server/overview.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const { overview } = await import('./overview.ts');

const HOUR = 3600_000;
db.freezeClock();

function project(name: string) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  // The user's last session ended an hour ago: "since" is then.
  db.run("INSERT INTO sessions (id, project_id, started_at, last_activity_at, ended_at, ended_reason) VALUES (?,?,?,?,?,'idle')", db.newId('ses'), id, db.now() - 2 * HOUR, db.now() - HOUR, db.now() - HOUR);
  return id;
}
const task = (p: string, title: string, state: string, at: number) => {
  const id = db.newId('task');
  db.run("INSERT INTO tasks (id, project_id, kind, title, state, started_at, finished_at, created_at, updated_at) VALUES (?,?,'task',?,?,?,?,?,?)", id, p, title, state, at, state === 'done' ? at : null, at, at);
  return id;
};

test('cards: running with the status line, done since with its picture, failed agents; the digest adds up across projects', () => {
  const a = project('Alpha');
  const b = project('Beta');
  const t0 = db.now();
  const run = task(a, 'Build the thing', 'active', t0 - HOUR / 2);
  db.run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, status, status_line, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", db.newId('ag'), a, 'x', 'builder', 'Builder', 'm', 'working', 'running the tests', run, t0, t0);
  const done = task(a, 'Ship the page', 'done', t0 - HOUR / 4);
  db.run("INSERT INTO previews (id, project_id, task_id, kind, title, file, created_at) VALUES (?,?,?,'image','After','x/after.png',?)", db.newId('pv'), a, done, t0);
  task(a, 'Old work', 'done', t0 - 3 * HOUR);
  task(b, 'Other done', 'done', t0 - HOUR / 3);
  db.run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, status, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", db.newId('ag'), b, 'x', 'builder', 'Builder', 'm', 'error', null, t0, t0);

  const o = overview();
  const ca = o.projects.find((p) => p.id === a)!;
  const cb = o.projects.find((p) => p.id === b)!;
  assert.deepEqual(ca.running, [{ id: run, title: 'Build the thing', line: 'running the tests' }]);
  assert.deepEqual(ca.finished.map((t) => t.title), ['Ship the page'], 'only what finished since the last session');
  assert.equal(ca.finished[0].preview?.file, 'x/after.png');
  assert.deepEqual(cb.failed.map((f) => f.title), ['Builder stopped with an error']);
  const mine = o.projects.filter((p) => p.id === a || p.id === b);
  assert.equal(mine.length, 2);
  // The digest counts every project; these two contribute 2 done in 2 projects, 1 running, 1 failed.
  assert.ok(o.digest.done >= 2 && o.digest.projects >= 2 && o.digest.running >= 1 && o.digest.failed >= 1);
  assert.equal(o.since, t0 - HOUR);
});
