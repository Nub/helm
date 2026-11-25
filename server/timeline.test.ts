import { SCRATCH } from './testenv.ts';
// The Timeline's bars (timeline.ts): segments from a task's state history and its waits on the user, and the
// projection of the Scheduled queue. `node --test server/timeline.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const tasks = await import('./tasks.ts');
const tl = await import('./timeline.ts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const USER = { author: 'user' as const, name: 'You' };
db.freezeClock();

test('segments: queued, active, waiting on you inside Active, Paused as waiting on you', () => {
  const rows = [
    { from_state: null, state: 'waiting', at: 0 },
    { from_state: 'waiting', state: 'scheduled', at: 10 },
    { from_state: 'scheduled', state: 'active', at: 30 },
    { from_state: 'active', state: 'paused', at: 100 },
    { from_state: 'paused', state: 'active', at: 120 },
    { from_state: 'active', state: 'done', at: 150 },
  ];
  const line = tl.stateLine(rows, 0, 150);
  assert.deepEqual(line, [['waiting', 0, 10], ['scheduled', 10, 30], ['active', 30, 100], ['paused', 100, 120], ['active', 120, 150]]);
  // A question open from 50 to 70 while Active.
  assert.deepEqual(tl.barSegments(line, [[50, 70]]), [
    { kind: 'queued', from: 0, to: 30 },
    { kind: 'active', from: 30, to: 50 },
    { kind: 'you', from: 50, to: 70 },
    { kind: 'active', from: 70, to: 100 },
    { kind: 'you', from: 100, to: 120 },
    { kind: 'active', from: 120, to: 150 },
  ]);
  // A wait from 90 on: the rest of the bar waits on you, Paused included, in one segment.
  assert.deepEqual(tl.barSegments(line, [[90, 200]]).map((s) => [s.kind, s.from, s.to]), [['queued', 0, 30], ['active', 30, 90], ['you', 90, 150]]);
});

test('a task from creation to done, with a question while Active, on the project timeline', () => {
  const p = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', p, 'tl', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const t0 = db.now();
  const t = tasks.createTask(p, { title: 'Port the parser', state: 'scheduled', origin: 'director' }, USER);
  db.advanceClock(2 * HOUR); // queued
  tasks.setTaskState(tasks.getTask(t.id)!, 'active', USER);
  db.advanceClock(20 * MIN);
  const q = db.newId('in');
  db.run("INSERT INTO inbox (id, project_id, agent_id, task_id, kind, title, created_at, status) VALUES (?,?,NULL,?,'question','Which way?',?,'open')", q, p, t.id, db.now());
  db.advanceClock(HOUR); // waiting on the user
  db.run("UPDATE inbox SET status = 'answered', answered_at = ? WHERE id = ?", db.now(), q);
  db.advanceClock(10 * MIN);
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);
  // A second task waits for it, still scheduled: it is projected ahead, after the first.
  const u = tasks.createTask(p, { title: 'Use the parser', state: 'scheduled', origin: 'director' }, USER);
  db.run('INSERT INTO task_waits (task_id, waits_for, created_at) VALUES (?, ?, ?)', u.id, t.id, db.now());
  db.advanceClock(5 * MIN);

  const view = tl.projectTimeline(p);
  const bar = view.tasks.find((x) => x.id === t.id)!;
  assert.deepEqual(bar.segments.map((s) => [s.kind, s.from - t0, s.to - t0]), [
    ['queued', 0, 2 * HOUR],
    ['active', 2 * HOUR, 2 * HOUR + 20 * MIN],
    ['you', 2 * HOUR + 20 * MIN, 3 * HOUR + 20 * MIN],
    ['active', 3 * HOUR + 20 * MIN, 3 * HOUR + 30 * MIN],
  ]);
  assert.equal(bar.end, t0 + 3 * HOUR + 30 * MIN);
  assert.equal(bar.work_ms, 30 * MIN);
  const next = view.tasks.find((x) => x.id === u.id)!;
  assert.deepEqual(next.waits_for, [t.id]);
  // Typical time is the done task's Active wall time (1 h 30 min); the queue starts now on the one builder.
  assert.equal(view.typical_ms, 90 * MIN);
  assert.deepEqual(next.projected, { from: db.now(), to: db.now() + 90 * MIN });
  assert.equal(next.lane, 'Builder');
});

test('the queue goes to whichever builder frees first, after what it waits for', () => {
  const ends = new Map<string, number>([['x', 500]]);
  const p = tl.projectQueue([{ id: 'a', waits: [] }, { id: 'b', waits: [] }, { id: 'c', waits: ['x'] }], [{ lane: 'Builder', free: 100 }, { lane: 'Builder 2', free: 0 }], 60, ends);
  assert.deepEqual(p.get('a'), [0, 60, 'Builder 2']);
  assert.deepEqual(p.get('b'), [60, 120, 'Builder 2']);
  assert.deepEqual(p.get('c'), [500, 560, 'Builder']);
});
