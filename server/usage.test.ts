import './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Token usage (usage.ts): per-turn amounts from running session totals, summed per agent, task and project; plan windows. */

const db = await import('./db.ts');
const u = await import('./usage.ts');

function agent(projectId: string, taskId: string | null) {
  const id = db.newId('ag');
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, created_at, updated_at, task_id) VALUES (?, ?, 'engineer', 'E', 'm', ?, ?, ?)", id, projectId, db.now(), db.now(), taskId);
  return id;
}
const row = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const mu = (input: number, output: number, write: number, read = 0) => ({ m: { inputTokens: input, outputTokens: output, cacheCreationInputTokens: write, cacheReadInputTokens: read } });

test('the total is input + output + cache writes over every model; cache reads are left out', () => {
  assert.equal(u.usageTotal({ ...mu(100, 20, 300, 99_999), other: { inputTokens: 5, outputTokens: 5, cacheCreationInputTokens: 0 } }), 430);
  assert.equal(u.usageTotal(undefined), 0);
});

test('a turn adds what the running total grew by; a lower total starts the count again', () => {
  assert.equal(u.turnDelta(1500, 1000), 500);
  assert.equal(u.turnDelta(1000, 1000), 0);
  assert.equal(u.turnDelta(300, 1000), 300);
});

test('turns are recorded per agent and summed per task and project', () => {
  const p = db.newId('pr');
  db.run("INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?, 'p', '/nonexistent', 'Build', 'supervised', '{}', ?, ?)", p, db.now(), db.now());
  const a = agent(p, 'task_a');
  const b = agent(p, 'task_a');
  const c = agent(p, null);
  u.recordTurnUsage(row(a), mu(1000, 200, 0)); // 1200
  u.recordTurnUsage(row(a), mu(1500, 300, 200, 50_000)); // running 2000: +800
  u.recordTurnUsage(row(a), {}); // a crash result with zeroes: nothing, and the total seen is kept
  u.recordTurnUsage(row(a), mu(2000, 500, 200)); // 2700: +700
  u.recordTurnUsage(row(b), mu(500, 0, 0)); // 500
  u.recordTurnUsage(row(b), mu(100, 0, 0)); // a new session's count: +100
  u.recordTurnUsage(row(c), mu(40, 0, 0));
  assert.equal(u.agentTokens(a), 2700);
  assert.equal(u.agentTokens(b), 600);
  assert.equal(u.taskTokens('task_a'), 3300);
  assert.equal(u.projectTokens(p), 3340);
  assert.deepEqual(u.agentTokensIn(p), { [a]: 2700, [b]: 600, [c]: 40 });
  assert.deepEqual(u.taskTokensIn(p), { task_a: 3300 });
});

test('work tokens: output and context growth; cache reads, re-writes and a repeated message are not counted again', () => {
  const t = u.newWorkTracker();
  const call = (id: string, i: number, w: number, r: number, o: number) => u.noteCall(t, id, { input_tokens: i, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o });
  call('m1', 5, 500_000, 0, 100); // the first call a process sees: only its uncached input
  call('m1', 5, 500_000, 0, 300); // the same message streamed again, more output
  call('m2', 1, 12_000, 500_005, 200); // grew by 12_001 - 300 (its output) = 11_701
  call('m3', 1, 512_000, 0, 50); // the cache expired: grew by 512_001 - 512_006 - 200 -> nothing new
  assert.deepEqual(u.takeWork(t), { input: 5 + 11_701, output: 550 });
  assert.deepEqual(u.takeWork(t), { input: 0, output: 0 });
  call('m4', 1, 3_000, 512_001, 10); // the tracker keeps the last call across takes
  assert.deepEqual(u.takeWork(t), { input: 2_951, output: 10 });
});

test('turns record their work; a row without it counts its tokens in full', () => {
  const p = db.newId('pr');
  db.run("INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?, 'p', '/nonexistent', 'Build', 'supervised', '{}', ?, ?)", p, db.now(), db.now());
  const a = agent(p, 'task_w');
  const s = agent(p, 'task_w');
  u.recordTurnUsage(row(a), mu(900_000, 0, 0), null, 'builder', { work: { input: 4_000, output: 1_000 }, sub: 50_000, subagents: [{ agent: row(s), tokens: 100_000, tier: null, work: { input: 30_000, output: 3_000 } }] });
  assert.deepEqual(u.taskWork('task_w'), { input: 4_000, output: 1_000, subagents: 33_000 + 50_000, full: false });
  assert.equal(u.taskTokens('task_w'), 900_000);
});

test('plan windows: fraction to percent, seconds to ms, overage and passed windows left out', () => {
  const t = db.now();
  const in1h = Math.floor(t / 1000) + 3600;
  u.recordRateLimit({ rateLimitType: 'seven_day', utilization: 0.18, resetsAt: in1h + 86_400 });
  u.recordRateLimit({ rateLimitType: 'five_hour', utilization: 0.4, resetsAt: in1h });
  u.recordRateLimit({ rateLimitType: 'five_hour', utilization: 0.42, resetsAt: in1h }); // the latest wins
  u.recordRateLimit({ rateLimitType: 'overage', utilization: 0.9, resetsAt: in1h });
  u.recordRateLimit({ rateLimitType: 'seven_day_opus' }); // no figure: not known
  u.recordRateLimit({ rateLimitType: 'seven_day_sonnet', utilization: 0.5, resetsAt: Math.floor(t / 1000) - 10 }); // reset already
  const w = u.planWindows();
  assert.deepEqual(w.map((x) => x.name), ['five_hour', 'seven_day']);
  assert.equal(Math.round(w[0].percent), 42);
  assert.equal(w[0].resetsAt, in1h * 1000);
});

test('the /usage answer: every plan window in percent, per-model windows, odd shapes skipped', () => {
  db.run('DELETE FROM plan_usage');
  const later = new Date(db.now() + 3_600_000).toISOString();
  const n = u.recordPlanUsage({
    rate_limits: {
      five_hour: { utilization: 37, resets_at: later },
      seven_day: { utilization: 12.5, resets_at: later },
      seven_day_opus: null,
      seven_day_oauth_apps: { utilization: 1, resets_at: later },
      extra_usage: { is_enabled: true, utilization: 50 },
      model_scoped: [{ display_name: 'Fable', utilization: 4, resets_at: later }, { utilization: 9 }],
    },
  });
  assert.equal(n, 3);
  assert.deepEqual(u.planWindows().map((w) => [w.name, w.percent]), [['five_hour', 37], ['seven_day', 12.5], ['model:Fable', 4]]);
  u.recordPlanUsage({ rate_limits: { five_hour: { utilization: null, resets_at: null } } }); // known window, unknown figure
  assert.deepEqual(u.planWindows().map((w) => w.name), ['seven_day', 'model:Fable']);
  assert.equal(u.recordPlanUsage({ rate_limits: null }), 0);
  assert.equal(u.recordPlanUsage('nonsense'), 0);
});

test('pollPlanUsage never throws, asks at most every few minutes', async () => {
  let asked = 0;
  await u.pollPlanUsage({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { asked++; throw new Error('gone'); } });
  await u.pollPlanUsage({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { asked++; return {}; } });
  await u.pollPlanUsage({});
  assert.equal(asked, 1);
});
