import { SCRATCH } from './testenv.ts';
// Home's digest (digest.ts): what finished and what failed since the user's last session ended.
// `node --test server/digest.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const { digest } = await import('./digest.ts');

const HOUR = 3600_000;
db.freezeClock();

function project() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'dg', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  return id;
}
const task = (p: string, title: string, finishedAt: number) => {
  const id = db.newId('task');
  db.run("INSERT INTO tasks (id, project_id, kind, title, state, finished_at, created_at, updated_at) VALUES (?,?,'task',?,'done',?,?,?)", id, p, title, finishedAt, finishedAt, finishedAt);
  return id;
};

test('away since the last session: the tasks finished and the releases failed since it ended', () => {
  const p = project();
  const t0 = db.now();
  task(p, 'Before', t0 - HOUR);
  db.run("INSERT INTO sessions (id, project_id, started_at, last_activity_at, ended_at, ended_reason) VALUES (?,?,?,?,?,'idle')", db.newId('ses'), p, t0 - 2 * HOUR, t0, t0);
  db.advanceClock(HOUR);
  const after = task(p, 'After', db.now());
  db.run("INSERT INTO releases (id, project_id, version, commit_sha, state, created_at, updated_at) VALUES (?,?,?,?,'failed',?,?)", db.newId('rel'), p, '1.2.0', 'abc', db.now(), db.now());
  const d = digest(p);
  assert.equal(d.since, t0);
  assert.deepEqual(d.finished.map((t) => t.id), [after]);
  assert.deepEqual(d.failed.map((f) => f.title), ['Release 1.2.0']);
});

test('no session yet: the last day', () => {
  const p = project();
  assert.equal(digest(p).since, db.now() - 24 * HOUR);
});
