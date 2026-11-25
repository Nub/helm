import { SCRATCH } from './testenv.ts';
// Work time and time to ship (worktime.ts): waiting on the user is never time a task took; time to ship is its own
// number with its parts. `node --test server/worktime.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const tasks = await import('./tasks.ts');
const tel = await import('./telemetry.ts');
const wt = await import('./worktime.ts');
const runtime = await import('./runtime.ts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const USER = { author: 'user' as const, name: 'You' };
db.freezeClock();

function project() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'wt', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  return id;
}
const question = (p: string, taskId: string) => {
  const id = db.newId('in');
  db.run("INSERT INTO inbox (id, project_id, agent_id, task_id, kind, title, created_at, status) VALUES (?,?,NULL,?,'question','Which way?',?,'open')", id, p, taskId, db.now());
  return id;
};
const answer = (id: string) => db.run("UPDATE inbox SET status = 'answered', answered_at = ? WHERE id = ?", db.now(), id);

test('20 min of work, 3 h on an open question and 1 h in Planning: took 20 min, 4 h 20 min to ship', () => {
  const p = project();
  const t0 = db.now();
  const t = tasks.createTask(p, { title: 'Port the parser', state: 'planning', origin: 'director' }, USER);
  db.advanceClock(HOUR); // in Planning, waiting for the user's approval
  tasks.setTaskState(tasks.getTask(t.id)!, 'active', USER);
  db.advanceClock(10 * MIN); // work
  const q = question(p, t.id);
  db.advanceClock(3 * HOUR); // waiting on the user's answer
  // While it waits, the work time does not grow, and the page is not told to count it up.
  const waiting = wt.taskTimes(tasks.getTask(t.id)!);
  assert.equal(waiting.workMs, 10 * MIN);
  assert.equal(waiting.workSince, null);
  answer(q);
  db.advanceClock(10 * MIN); // work
  const running = wt.taskTimes(tasks.getTask(t.id)!);
  assert.equal(running.workMs, 20 * MIN);
  assert.equal(running.workSince, db.now(), 'working now: the page counts on from here');
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);

  const done = tasks.getTask(t.id)!;
  const x = wt.taskTimes(done);
  assert.equal(x.workMs, 20 * MIN);
  assert.equal(x.shipMs, 4 * HOUR + 20 * MIN);
  assert.deepEqual(x.parts, { queuedMs: 0, workingMs: 20 * MIN, waitingYouMs: 4 * HOUR, reviewMs: 0 });
  assert.equal(wt.shipText(x), '4 h 20 min to ship: working 20 min · waiting on you 4 h');
  assert.equal(done.created_at, t0);

  // Every place that says what it took says 20 min; time to ship only under its name.
  assert.match(tasks.timingText(done), /took 20 min of work; 4 h 20 min to ship/);
  const view = tasks.taskView(done);
  assert.equal(view.work_ms, 20 * MIN);
  assert.equal(view.ship_ms, 4 * HOUR + 20 * MIN);
  const row = db.get('SELECT * FROM task_telemetry WHERE task_id = ?', t.id)!;
  assert.equal(row.work_ms, 20 * MIN);
  assert.equal(row.ship_ms, 4 * HOUR + 20 * MIN);
  assert.equal(row.wait_you_ms, 4 * HOUR);
  const m = tel.metricsOf([row]);
  assert.equal(m.cycle.value, 20 * MIN, 'the median work time');
  assert.equal(m.rate.value, 3, 'three tasks per work hour');
  const s = tel.telemetrySummary({ project: p });
  assert.equal(s.metrics.find((k) => k.key === 'cycle')!.label, 'Median work time');
  assert.equal(s.table[0].work_ms, 20 * MIN);
  assert.equal(s.table[0].ship_ms, 4 * HOUR + 20 * MIN);
  assert.deepEqual(s.ship.shares, { queued: 0, working: 8, waitingYou: 92, review: 0 });
  assert.match(tel.telemetryText(p), /took 20 min of work, 4 h 20 min to ship/);
});

test('the queue and a review it asked for are not work; a request the director decided is not a wait on the user', () => {
  const p = project();
  const t = tasks.createTask(p, { title: 'Queued', state: 'scheduled', origin: 'director' }, USER);
  db.advanceClock(2 * HOUR);
  tasks.setTaskState(tasks.getTask(t.id)!, 'active', USER);
  db.advanceClock(30 * MIN);
  // A permission the director decided after 5 minutes: work goes on meanwhile as far as the user is concerned.
  db.run("INSERT INTO inbox (id, project_id, task_id, kind, title, created_at, answered_at, status, decided_by) VALUES (?,?,?,'permission','Bash',?,?,'answered','director')", db.newId('in'), p, t.id, db.now(), db.now() + 5 * MIN);
  db.advanceClock(10 * MIN);
  // The builder asks for review; 40 minutes until the verdict.
  const dir = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', p)!);
  db.run("INSERT INTO consults (id, project_id, asker_id, manager_id, task_id, kind, question, status, verdict, created_at, answered_at) VALUES (?,?,?,?,?,'review','q','answered','accepted',?,?)", db.newId('cs'), p, dir.id, dir.id, t.id, db.now(), db.now() + 40 * MIN);
  db.advanceClock(40 * MIN);
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);
  const x = wt.taskTimes(tasks.getTask(t.id)!);
  assert.equal(x.workMs, 40 * MIN);
  assert.deepEqual(x.parts, { queuedMs: 2 * HOUR, workingMs: 40 * MIN, waitingYouMs: 0, reviewMs: 40 * MIN });
});

test('no state history but a request on it: unknown, never the waiting folded in', () => {
  const p = project();
  const t = tasks.createTask(p, { title: 'Old', state: 'active', origin: 'director' }, USER);
  db.run('DELETE FROM task_states WHERE task_id = ?', t.id);
  question(p, t.id);
  db.advanceClock(HOUR);
  const x = wt.taskTimes(tasks.getTask(t.id)!);
  assert.equal(x.workMs, null);
  assert.equal(wt.durationText(x.workMs), 'unknown');
});
