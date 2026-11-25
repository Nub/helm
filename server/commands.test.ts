import { SCRATCH } from './testenv.ts';
// Commands and heavy jobs (commands.ts, hosts.ts): durations remembered, a known long command must start in the
// background under a heavy claim, one heavy job per host, the claim released when the command ends, a queued job told
// when a host frees, and the two telemetry figures. `node --test server/commands.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const hosts = await import('./hosts.ts');
const cmd = await import('./commands.ts');
const { addEvent } = await import('./store.ts');

const USER = { author: 'user' as const, name: 'You' };
const MIN = 60_000;
db.freezeClock();

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'cmd', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const t = tasks.createTask(id, { title: 'Build it', state: 'active', origin: 'director', description: 'Build.', driver_agent_id: builder.id } as any, USER);
  const local = hosts.localHost();
  hosts.attachHost(id, local.id);
  const box = hosts.createHost({ name: `box-${id}`, ssh_target: 'user@192.0.2.1', purpose: 'renders', notes: '', exclusive: 0 });
  hosts.attachHost(id, box.id);
  return { project, builder, t, local, box };
}
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;

test('durations are remembered; a known long command must start in the background under a heavy claim, released at its end', () => {
  const { builder, t, local } = setup();
  const build = { command: 'cd /srv/app && make build', description: 'Build' };
  assert.equal(cmd.bashCheck(agent(builder.id), build), null, 'unknown: let through');
  cmd.commandStarted(agent(builder.id), agent(builder.id), 'c1', build);
  assert.equal(cmd.runningCommands(t.id).length, 1);
  db.advanceClock(2 * MIN);
  assert.ok(cmd.commandEnded('c1', 'result'));
  assert.equal(cmd.lastDuration(builder.project_id, 'make   build'), 2 * MIN, 'same command without the cd');
  assert.equal(cmd.runningCommands(t.id).length, 0);
  // Known long now.
  assert.match(cmd.bashCheck(agent(builder.id), build)!, /run_in_background: true/);
  assert.match(cmd.bashCheck(agent(builder.id), { ...build, run_in_background: true })!, /claim_host heavy: true/);
  assert.ok('ok' in hosts.claimHost(builder.id, local.name, 'Building', true));
  assert.equal(cmd.bashCheck(agent(builder.id), { ...build, run_in_background: true }), null);
  cmd.commandStarted(agent(builder.id), agent(builder.id), 'c2', { ...build, run_in_background: true });
  assert.equal(cmd.runningCommands(t.id)[0].host_name, local.name);
  assert.match(cmd.bashCheck(agent(builder.id), { ...build, run_in_background: true })!, /claim_host/, 'the claim is taken by the running command');
  assert.equal(cmd.commandEnded('c2', 'result'), false, 'a background command does not end with its launch result');
  db.advanceClock(2 * MIN);
  assert.ok(cmd.commandEnded('c2', 'notification'));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM host_claims WHERE agent_id = ?', builder.id)?.n, 0, 'claim released with the command');
  assert.equal(cmd.bashCheck(agent(builder.id), { command: 'ls' }), null);
});

test('one heavy job per host: a second goes to a free host or queues; the waiting agent is told; host-free time is kept', () => {
  const a = setup();
  const told: string[] = [];
  hosts.onHeavyFreed((agents, host) => told.push(...agents.map((x) => `${x.id}:${host.name}`)));
  // Another project's builder shares this machine.
  const b = setup();
  assert.ok('ok' in hosts.claimHost(a.builder.id, a.local.name, 'Suite', true));
  const refused = hosts.claimHost(b.builder.id, b.local.name, 'Build', true);
  assert.ok('error' in refused && /already runs a heavy job/.test(refused.error), JSON.stringify(refused));
  // b's other host is unreachable in this test, so nothing is free: it queues, and its own box sat free meanwhile.
  db.advanceClock(5 * MIN);
  hosts.releaseHost(a.builder.id, a.local.name);
  assert.deepEqual(told, [`${b.builder.id}:${a.local.name}`]);
  assert.ok('ok' in hosts.claimHost(b.builder.id, b.local.name, 'Build', true));
  assert.equal(cmd.hostFreeWaitMs(b.t.id), 5 * MIN, 'box was free for the five minutes it queued');
  // Two heavy jobs at once on two hosts.
  assert.ok('ok' in hosts.claimHost(b.builder.id, b.box.name, 'Render', true));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM host_claims WHERE agent_id = ? AND heavy = 1', b.builder.id)?.n, 2);
  hosts.releaseAgentClaims(b.builder.id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM heavy_jobs WHERE agent_id = ? AND ended_at IS NULL', b.builder.id)?.n, 0);
});

test('idle wait: a command running with nothing else in hand counts; light work in the wait does not', () => {
  const { builder, t } = setup();
  cmd.commandStarted(agent(builder.id), agent(builder.id), 'i1', { command: 'make build', run_in_background: true });
  // Two minutes of light work every 10 s, then two minutes of nothing.
  for (let i = 0; i < 12; i++) {
    db.advanceClock(10_000);
    addEvent(agent(builder.id), 'tool', { id: `r${i}`, name: 'Read', summary: 'docs' });
  }
  db.advanceClock(2 * MIN);
  cmd.commandEnded('i1', 'notification');
  assert.equal(cmd.idleWaitMs(t.id), 2 * MIN - 20_000);
});

test('a wait loop over a minute is refused in the foreground; short sleeps and backgrounded waits pass', () => {
  const { builder } = setup();
  const check = (command: string, bg = false) => cmd.bashCheck(agent(builder.id), { command, ...(bg ? { run_in_background: true } : {}) });
  const refused = [
    'while [ ! -f out/done ]; do sleep 10; done',
    'until curl -sf localhost:3000/health; do sleep 5; done',
    'for i in $(seq 1 24); do test -f out/done && break; sleep 5; done',
    'for i in {1..40}; do sleep 3; done',
    'sleep 120 && cat build.log',
    'sleep 2m',
    "timeout 300 bash -c 'until [ -f out/done ]; do sleep 5; done'",
  ];
  for (const c of refused) assert.match(check(c) ?? '', /Run it in the background and carry on/, c);
  const fine = [
    'sleep 2 && curl -s localhost:3000',
    'for i in 1 2 3; do sleep 2; done',
    "timeout 60 bash -c 'until [ -f out/done ]; do sleep 2; done'",
    'while read l; do echo "$l"; done < list.txt',
    'timeout 600 npm test',
    'npm run build',
  ];
  for (const c of fine) assert.equal(check(c), null, c);
  assert.equal(check('while [ ! -f out/done ]; do sleep 10; done', true), null, 'in the background it waits for no one');
  assert.equal(cmd.waitSeconds('for i in {1..24}; do sleep 5; done'), 120);
});

