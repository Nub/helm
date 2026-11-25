import { SCRATCH } from './testenv.ts';
// Focus (focus.ts) on seeded telemetry: lines ranked by hours lost, the gap lines' hours adding up to time to ship
// minus work time (and their shares to its share), trends against the 7 days before, levers only when their condition
// holds, the weekly note once a week. `node --test server/focus.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
await import('./telemetry.ts');
const focus = await import('./focus.ts');
const { recordReset } = await import('./telemetryreset.ts');

const H = 3600_000;
const DAY = 24 * H;
db.freezeClock();
const AT = db.now();

const project = (name: string) => {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), AT - 30 * DAY, AT - 30 * DAY);
  return id;
};
const A = project('focus-a');
project('focus-b'); // shipped nothing: no note

/** A done task with its telemetry row: hours of each part; finished `ago` before now. */
function shipped(title: string, ago: number, h: { work: number; queued: number; you: number; review: number; idle?: number }) {
  const id = db.newId('task');
  const fin = AT - ago;
  const ship = (h.work + h.queued + h.you + h.review) * H;
  const created = fin - ship;
  db.run("INSERT INTO tasks (id, project_id, title, state, created_at, updated_at, finished_at, started_at) VALUES (?,?,?,'done',?,?,?,?)", id, A, title, created, fin, fin, created);
  db.run(
    "INSERT INTO task_telemetry (task_id, project_id, title, state, created_at, finished_at, recorded_at, work_ms, ship_ms, queued_ms, wait_you_ms, review_ms, wait_idle_ms) VALUES (?,?,?,'done',?,?,?,?,?,?,?,?,?)",
    id, A, title, created, fin, fin, h.work * H, ship, h.queued * H, h.you * H, h.review * H, (h.idle ?? 0) * H,
  );
  return { id, created, fin };
}
let rq = 0;
function request(taskId: string, from: number, hours: number, fields: { kind?: string; options?: unknown[]; payload?: unknown; title?: string }) {
  db.run(
    "INSERT INTO inbox (id, project_id, kind, title, options, payload, status, created_at, answered_at, task_id) VALUES (?,?,?,?,?,?,'answered',?,?,?)",
    `rq_f${++rq}`, A, fields.kind ?? 'question', fields.title ?? 'Something', JSON.stringify(fields.options ?? []), JSON.stringify(fields.payload ?? {}), from, from + hours * H, taskId,
  );
}
const kinds = (k: Record<string, [number, number]>) => Object.fromEntries(['rerun', 'edit', 'revert', 'review', 'flag', 'redo'].map((x) => [x, { n: k[x]?.[0] ?? 0, ms: (k[x]?.[1] ?? 0) * 60_000 }]));

// The last 7 days: two shipped tasks.
const t1 = shipped('Thumbnails', DAY, { work: 2, queued: 3, you: 4, review: 1 });
request(t1.id, t1.created + 3 * H, 1, { kind: 'action', title: 'Try the test build', payload: { test_build: 'tb_1' } });
request(t1.id, t1.created + 5 * H, 3, { options: [{ label: 'Grid' }, { label: 'List' }] });
db.run('INSERT INTO task_rework (task_id, project_id, finished_at, data, computed_at) VALUES (?,?,?,?,?)', t1.id, A, t1.fin, JSON.stringify({ v: 1, task_id: t1.id, project_id: A, title: 'Thumbnails', finished_at: t1.fin, work_ms: 2 * H, rework_ms: 55 * 60_000, kinds: kinds({ redo: [1, 30], review: [1, 20], rerun: [1, 5] }), errors: [] }), AT);
db.run('INSERT INTO task_time (task_id, project_id, data, computed_at) VALUES (?,?,?,?)', t1.id, A, JSON.stringify({ kinds: [{ kind: 'model', label: 'model', ms: 1.5 * H }], model: { turns: 9, slow_turns: 2, tokens: 0 } }), AT);

const t2 = shipped('Sync', 2 * DAY, { work: 3, queued: 20, you: 6, review: 1, idle: 1 });
request(t2.id, t2.created + 20 * H, 26, { kind: 'permission', title: 'Allow Bash' });
db.run('INSERT INTO task_rework (task_id, project_id, finished_at, data, computed_at) VALUES (?,?,?,?,?)', t2.id, A, t2.fin, JSON.stringify({ v: 1, task_id: t2.id, project_id: A, title: 'Sync', finished_at: t2.fin, work_ms: 3 * H, rework_ms: 0, kinds: kinds({}), errors: [] }), AT);

// The 7 days before: one, queued less and reviewed longer.
shipped('Older', 9 * DAY, { work: 2, queued: 4, you: 0, review: 4 });

const line = (v: ReturnType<typeof focus.focusView>, k: string) => v.lines.find((l) => l.key === k);

test('request kinds', () => {
  assert.equal(focus.requestClass({ kind: 'action', title: 'x', payload: '{"test_build":"tb"}' }), 'test');
  assert.equal(focus.requestClass({ kind: 'action', title: 'Try it on your phone', body: '' }), 'test');
  assert.equal(focus.requestClass({ kind: 'question', title: 'Update now', payload: '{"act":{"kind":"update_helm"}}' }), 'update');
  assert.equal(focus.requestClass({ kind: 'permission', title: 'Allow' }), 'approve');
  assert.equal(focus.requestClass({ kind: 'question', title: 'Which?', options: '[{"label":"A"},{"label":"B"}]' }), 'direction');
  assert.equal(focus.requestClass({ kind: 'question', title: 'Ship it?', options: '[{"label":"Approve"},{"label":"Not yet"}]' }), 'approve');
  assert.equal(focus.requestClass({ kind: 'action', title: 'Add the token' }), 'other');
});

test('ranked by hours lost; the gap lines add up to time to ship minus work', () => {
  const v = focus.focusView({ project: A }, AT);
  assert.equal(v.tasks, 2);
  assert.equal(v.shipMs, 40 * H);
  assert.equal(v.gapMs, 35 * H);
  const ms = v.lines.map((l) => l.ms);
  assert.deepEqual(ms, [...ms].sort((a, b) => b - a), 'ranked');
  assert.equal(v.lines[0].key, 'queue');
  assert.equal(v.lines[0].ms, 23 * H);
  assert.equal(line(v, 'you:approve')!.ms, 6 * H);
  assert.equal(line(v, 'you:direction')!.ms, 3 * H);
  assert.equal(line(v, 'you:test')!.ms, 1 * H);
  assert.equal(line(v, 'you:held'), undefined, 'every hour of the wait was under a request');
  const gap = v.lines.filter((l) => l.group === 'gap');
  assert.equal(gap.reduce((n, l) => n + l.ms, 0), v.gapMs);
  const shares = gap.reduce((n, l) => n + l.share, 0);
  assert.ok(Math.abs(shares - (v.gapMs / v.shipMs) * 100) < 0.05 * gap.length, `shares ${shares}`);
  assert.equal(line(v, 'queue')!.share, 57.5);
  // Inside the work: rework by kind, commands, model time.
  assert.equal(line(v, 'rework:redo')!.ms, 30 * 60_000);
  assert.equal(line(v, 'rework:review')!.group, 'work');
  assert.equal(line(v, 'commands')!.ms, H);
  assert.equal(line(v, 'model')!.ms, 1.5 * H);
  // The top tasks behind a line.
  assert.deepEqual(line(v, 'queue')!.top.map((t) => t.id), [t2.id, t1.id]);
  assert.equal(line(v, 'you:approve')!.top[0].title, 'Sync');
  // The weekly bar: this week's split, last week's.
  const last = v.weeks.labels.length - 1;
  assert.deepEqual([v.weeks.work[last], v.weeks.queued[last], v.weeks.waitingYou[last], v.weeks.review[last]], [5, 23, 10, 2]);
  assert.deepEqual([v.weeks.queued[last - 1], v.weeks.review[last - 1]], [4, 4]);
});

test('trends compare with the 7 days before', () => {
  const v = focus.focusView({ project: A }, AT);
  assert.deepEqual(line(v, 'queue')!.trend, { dir: 'up', pct: 475 });
  assert.equal(line(v, 'queue')!.prevMs, 4 * H);
  assert.deepEqual(line(v, 'review')!.trend, { dir: 'down', pct: -50 });
  assert.equal(line(v, 'you:approve')!.trend.dir, 'new');
});

test('levers appear only when their condition holds', () => {
  const v = focus.focusView({ project: A }, AT);
  // Queue: hours queued while the slots were full.
  assert.match(line(v, 'queue')!.lever ?? '', /raise builder subagents \(now \d+\)/);
  // A request waited over a day (the permission, 26 h); the direction question 3 h, the test request 1 h.
  assert.equal(line(v, 'you:approve')!.lever, 'Requests waiting > 1 day: 1; answer or defer');
  assert.equal(line(v, 'you:direction')!.lever, null);
  assert.equal(line(v, 'you:test')!.lever, null);
  // Review averages 1 h per task: not over an hour.
  assert.equal(line(v, 'review')!.lever, null);
  // A follow-up after done: a lever; one review sent back and one failed rerun: none.
  assert.match(line(v, 'rework:redo')!.lever ?? '', /clearer Done when/);
  assert.equal(line(v, 'rework:review')!.lever, null);
  assert.equal(line(v, 'rework:rerun')!.lever, null);
  // Two slow model turns, no independent work queued while commands ran.
  assert.equal(line(v, 'model')!.lever, null);
  assert.equal(line(v, 'commands')!.lever, null);
  // A second review sent back makes its lever appear.
  db.run('UPDATE task_rework SET data = ? WHERE task_id = ?', JSON.stringify({ v: 1, task_id: t2.id, project_id: A, title: 'Sync', finished_at: t2.fin, work_ms: 3 * H, rework_ms: 10 * 60_000, kinds: kinds({ review: [1, 10] }), errors: [] }), t2.id);
  assert.match(line(focus.focusView({ project: A }, AT), 'rework:review')!.lever ?? '', /Reviews sent back: 2/);
});

test('get_telemetry text and the weekly note, once a week per project', async () => {
  const text = focus.focusText(A, AT);
  assert.match(text, /^Focus, last 7 days/);
  assert.match(text, /1\. Waiting in the queue: 23\.0 h \(57\.5% of time to ship; ▲ 475%/);
  assert.match(text, new RegExp(`\\[\\[${t2.id}\\]\\]`));
  const sent: [string, string][] = [];
  const send = async (p: string, t: string) => void sent.push([p, t]);
  assert.deepEqual(await focus.sendFocusNotes(send, AT), [A], 'B shipped nothing: no note');
  assert.match(sent[0][1], /^<helm-note kind="focus">This week's Focus: the biggest drag on time to ship is waiting in the queue, 23\.0 h/);
  assert.match(sent[0][1], /Lever: Parallel slots full/);
  assert.deepEqual(await focus.sendFocusNotes(send, AT + 3 * DAY), []);
  assert.equal(sent.length, 1);
  // A week on: due again (nothing shipped in that week, so nothing to say).
  assert.deepEqual(await focus.sendFocusNotes(send, AT + 8 * DAY), []);
  assert.ok(Number(db.get("SELECT value FROM telemetry_state WHERE key = ?", `focus_note:${A}`)?.value) === AT + 8 * DAY);
});

test('a reset starts the view fresh: nothing before it to compare with', () => {
  recordReset(A, 'user', AT - 5 * DAY);
  const v = focus.focusView({ project: A }, AT);
  assert.equal(line(v, 'queue')!.trend.dir, 'new');
  assert.equal(line(v, 'review')!.trend.dir, 'new');
  assert.equal(v.reset?.scope, 'project');
  // Show all time ignores it.
  assert.equal(line(focus.focusView({ project: A, allTime: true }, AT), 'review')!.trend.dir, 'down');
});
