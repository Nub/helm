import { SCRATCH } from './testenv.ts';
// What agents spend their time on (activity.ts, activitystats.ts): a scripted transcript with known durations per
// category, the categories summing to the active time, who and tier, the stored days, and the director's tool text.
// `node --test server/activity.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const act = await import('./activity.ts');
const stats = await import('./activitystats.ts');
const { addEvent } = await import('./store.ts');

const MIN = 60_000;
const SEC = 1000;
const USER = { author: 'user' as const, name: 'You' };
db.freezeClock();

test('command kinds', () => {
  const k = act.commandKind;
  assert.equal(k('cd /x && npm test'), 'cmd_test');
  assert.equal(k('npm run typecheck'), 'cmd_build');
  assert.equal(k('git commit -qm x'), 'cmd_git');
  assert.equal(k('rg -n foo server'), 'searching');
  assert.equal(k("node .claude/skills/helm-ui-check/scripts/shoot.mjs --routes '#/'"), 'cmd_run');
  assert.equal(k('F=/x/a.log; until grep -q done $F; do sleep 5; done'), 'cmd_wait');
  assert.equal(k('export PATH=/x:$PATH; node -e "1"'), 'cmd_script');
  assert.equal(k("sed -i 's/a/b/' server/x.ts"), 'editing');
  assert.equal(k('rm -rf /tmp/scratch'), 'cmd_other');
});

test('a scripted transcript: each category gets its known time, and they sum to the active time', () => {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'act', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const b = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'x');
  const t = tasks.createTask(id, { title: 'T', state: 'active', origin: 'user', description: '', driver_agent_id: b.id } as any, USER);
  db.run("UPDATE tasks SET tier = 'routine' WHERE id = ?", t.id);
  const a = () => db.get('SELECT * FROM agents WHERE id = ?', b.id)!;
  const t0 = db.now();
  const step = (ms: number) => db.advanceClock(ms);
  const call = (n: string, name: string, summary: string, input: Record<string, unknown>, before: number, run: number, out = '') => {
    step(before);
    addEvent(a(), 'tool', { id: n, name, summary, input: JSON.stringify(input) });
    step(run);
    addEvent(a(), 'tool_result', { id: n, text: out });
  };
  addEvent(a(), 'inbound', { text: 'Your next task' });
  call('1', 'Bash', 'rg -n exporter src', { command: 'rg -n exporter src' }, 20 * SEC, 10 * SEC, 'x'.repeat(400)); // searching 30 s
  call('2', 'Read', '/p/src/a.ts', { file_path: '/p/src/a.ts' }, 10 * SEC, 5 * SEC, 'y'.repeat(800)); // reading 15 s (edited below)
  call('3', 'Edit', '/p/src/a.ts', { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' }, 50 * SEC, 10 * SEC); // editing 60 s
  call('4', 'Bash', 'npm run build', { command: 'npm run build' }, 5 * SEC, 55 * SEC); // build 60 s
  call('5', 'Bash', 'npm test', { command: 'npm test' }, 0, 3 * MIN); // tests 60 s, waiting 2 min (past COMMAND_IDLE_MS)
  call('6', 'mcp__helm__report_status', 'Testing', {}, 10 * SEC, 2 * SEC); // Helm 12 s
  step(4 * MIN);
  addEvent(a(), 'text', { text: 'Done thinking' }); // thinking 2 min, idle 2 min
  step(30 * SEC);
  addEvent(a(), 'result', { ok: true, text: 'All done.' }); // thinking 30 s
  // A permission prompt held a command for 40 s of its 60.
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, created_at, answered_at, status) VALUES ('perm1', ?, ?, 'permission', 'Bash', ?, ?, 'answered')", id, b.id, db.now() + 10 * SEC, db.now() + 50 * SEC);
  call('7', 'Bash', 'git push', { command: 'git push' }, 0, 60 * SEC); // git 20 s, waiting on the user 40 s
  step(3 * 3600_000);
  addEvent(a(), 'inbound', { text: 'A new message much later' }); // between turns: not active
  const end = db.now() + 1;

  const buckets = act.activity(db.all, id, t0, end, () => 0, (ag) => (!ag.parent_id ? 'deep' : 'routine'));
  const sum = act.emptySplit();
  for (const x of buckets) for (const c of act.CATEGORIES) (sum[c].ms += x.split[c].ms), (sum[c].tokens += x.split[c].tokens);
  const want: Partial<Record<string, number>> = {
    searching: 30 * SEC, reading: 15 * SEC, editing: 60 * SEC, cmd_build: 60 * SEC, cmd_test: 60 * SEC, cmd_wait: 2 * MIN,
    helm: 12 * SEC, thinking: 2 * MIN + 30 * SEC, idle: 2 * MIN, cmd_git: 20 * SEC, waiting_user: 40 * SEC,
  };
  for (const c of act.CATEGORIES) assert.equal(sum[c].ms, want[c] ?? 0, c);
  const active = act.CATEGORIES.reduce((n, c) => n + sum[c].ms, 0);
  assert.equal(active, end - 1 - t0 - 3 * 3600_000, 'every second of the turns, nothing between turns');
  assert.ok(buckets.every((x) => x.who === 'builder' && x.tier === 'routine'));
  // Tokens (an estimate): results by their tool's kind, what the model wrote as thinking.
  assert.equal(sum.searching.tokens, 100);
  assert.equal(sum.reading.tokens, 200);
  assert.ok(sum.thinking.tokens > 0);

  // Stored per day, read back per project with who and tier; the director's tool text.
  stats.refreshActivity(id, t0 - 1, end);
  const [view] = stats.activityView({ project: id }, end);
  assert.equal(view.activeMs, active);
  assert.equal(Math.round(view.categories.reduce((n, c) => n + c.share, 0)), 100);
  assert.match(view.top[0], /^thinking and writing 2[0-9]\.\d%$/);
  assert.equal(stats.activityView({ project: id, who: 'director' }, end).length, 0);
  assert.equal(stats.activityView({ project: id, tier: 'routine' }, end)[0].activeMs, active);
  assert.match(stats.activityText(id), /^What agents spent time on, last 7 days \(\d+ min of agent time/);
});

test('command groups: arguments that do not matter group, release and test suites stay apart', async () => {
  const { commandGroup } = await import('./commandgroups.ts');
  const k = (c: string) => commandGroup(c).key;
  assert.equal(k('cd /p/game && cargo build -p engine 2>&1 | tail -20'), 'cargo build');
  assert.equal(k('CARGO_TARGET_DIR=/x cargo build --features fast -p game'), 'cargo build');
  assert.equal(k('cargo build --release -p game'), 'cargo build --release');
  assert.equal(k('cargo test parser::tokens -- --nocapture'), 'cargo test');
  assert.equal(k('cargo test --test integration'), 'cargo test --test integration');
  assert.equal(k('npm run build'), 'npm run build');
  assert.equal(k('npm run typecheck && npm test'), 'npm run typecheck');
  assert.equal(k('node --test server/progress.test.ts'), 'node --test progress');
  assert.equal(k('node --test server/a.test.ts server/b.test.ts'), 'node --test several suites');
  assert.equal(k('node .claude/skills/helm-ui-check/scripts/shoot.mjs --routes "#/" --devices phone'), 'node shoot.mjs');
  assert.equal(k('nix build --no-link'), 'nix build');
  assert.equal(k('nix build .#server'), 'nix build #server');
  assert.equal(k('until grep -q done /tmp/x.log; do sleep 5; done'), 'wait loop');
  assert.equal(k("bash -c 'cargo build --release'"), 'cargo build --release');
  assert.equal(commandGroup('cargo build --release').intent, 'Build in release mode');
  assert.equal(commandGroup('cargo test').intent, 'Run the tests');
});

test('waiting on commands by command: grouped, intent from the agent, background waits and the time other work filled', () => {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'cmds', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const b = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'x');
  const a = () => db.get('SELECT * FROM agents WHERE id = ?', b.id)!;
  const t0 = db.now();
  let n = 0;
  const bash = (input: Record<string, unknown>, run: number) => {
    const cid = `c${++n}`;
    db.advanceClock(5 * SEC);
    addEvent(a(), 'tool', { id: cid, name: 'Bash', summary: String(input.command), input: JSON.stringify(input) });
    db.advanceClock(run);
    addEvent(a(), 'tool_result', { id: cid, text: 'ok' });
    return cid;
  };
  addEvent(a(), 'inbound', { text: 'Go' });
  // Two debug builds with different crates and the agent's description: one group, waited 2 + 1 min past the first minute.
  bash({ command: 'cargo build -p game', description: 'Build the game' }, 3 * MIN);
  bash({ command: 'cd /p && cargo build -p engine 2>&1 | tail', description: 'Build the game' }, 2 * MIN);
  // A release build, no description: its own group, intent derived.
  bash({ command: 'cargo build --release' }, 90 * SEC);
  // A background test run of 10 min; the agent works 6 min, then waits on it in a loop for 4.
  const bgStart = db.now() + 5 * SEC;
  const bg = bash({ command: 'cargo test --workspace', description: 'Run the whole test suite', run_in_background: true }, SEC);
  db.run("INSERT INTO running_commands (id, project_id, agent_id, session_agent_id, task_id, command, label, background, started_at, ended_at) VALUES (?,?,?,?,NULL,?,?,1,?,?)", bg, id, b.id, b.id, 'cargo test --workspace', 'Run the whole test suite', bgStart, bgStart + 10 * MIN);
  for (let i = 0; i < 6; i++) {
    db.advanceClock(MIN - 5 * SEC);
    addEvent(a(), 'tool', { id: `e${i}`, name: 'Edit', summary: '/p/src/a.rs', input: JSON.stringify({ file_path: '/p/src/a.rs' }) });
    addEvent(a(), 'tool_result', { id: `e${i}`, text: '' });
  }
  bash({ command: 'until grep -q "test result" /tmp/t.log; do sleep 5; done', description: 'Wait for the tests' }, 4 * MIN - 50 * SEC);
  addEvent(a(), 'result', { ok: true, text: 'done' });
  const end = db.now() + 1;

  stats.refreshActivity(id, t0 - 1, end);
  const [view] = stats.activityView({ project: id }, end);
  const cmds = Object.fromEntries(view.commands.map((c) => [c.group, c]));
  assert.deepEqual(Object.keys(cmds).sort(), ['cargo build', 'cargo build --release', 'cargo test'], 'the wait loop\'s time went to the run it waited on');
  assert.equal(cmds['cargo build'].intent, 'Build the game');
  assert.equal(cmds['cargo build'].waitedMs, 3 * MIN);
  assert.equal(cmds['cargo build'].runs, 2);
  assert.equal(cmds['cargo build'].avgMs, 2.5 * MIN);
  assert.equal(cmds['cargo build'].maxMs, 3 * MIN);
  assert.equal(cmds['cargo build --release'].intent, 'Build in release mode');
  assert.equal(cmds['cargo build --release'].waitedMs, 30 * SEC);
  assert.equal(cmds['cargo test'].intent, 'Run the whole test suite');
  assert.equal(cmds['cargo test'].waitedMs, 4 * MIN - 45 * SEC, 'the loop, and the moment before it');
  assert.equal(cmds['cargo test'].filledMs, 10 * MIN - (4 * MIN - 45 * SEC), 'the rest of its run other work filled');
  assert.equal(cmds['cargo test'].runs, 1);
  // Biggest first; the waits per command sum to the category.
  assert.deepEqual(view.commands.map((c) => c.group), ['cargo test', 'cargo build', 'cargo build --release']);
  const waitRow = view.categories.find((c) => c.category === 'cmd_wait')!;
  assert.equal(view.commands.reduce((n, c) => n + c.waitedMs, 0), waitRow.ms);
  assert.equal(view.commandsTop, 'Most of the waiting was to run the whole test suite (3 min), build the game (3 min) and build in release mode (30 s).');
  // The director's tool text: the top ten with intent and the raw group.
  assert.match(stats.activityText(id), /Waiting on commands, by command \(top ten\)\. Most of the waiting[\s\S]*- Build the game \(`cargo build`\): waited 3 min with nothing else in hand/);
});

test('a wait loop is charged to the earlier command that writes the file it waits on', () => {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'loops', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const b = runtime.createAgent(project, runtime.rootAgent(project), s.roles.find((r) => r.id === 'builder')!, 'Builder', 'x');
  const a = () => db.get('SELECT * FROM agents WHERE id = ?', b.id)!;
  const t0 = db.now();
  let n = 0;
  const bash = (input: Record<string, unknown>, run: number) => {
    const cid = `l${++n}`;
    db.advanceClock(5 * SEC);
    addEvent(a(), 'tool', { id: cid, name: 'Bash', summary: String(input.command), input: JSON.stringify(input) });
    db.advanceClock(run);
    addEvent(a(), 'tool_result', { id: cid, text: 'ok' });
  };
  addEvent(a(), 'inbound', { text: 'Go' });
  bash({ command: '(cd /p && cargo bench > /tmp/bench_a.log 2>&1; touch /tmp/bench_a.done) &', description: 'Benchmark the renderer' }, SEC);
  bash({ command: 'until [ -e /tmp/bench_a.done ]; do sleep 10; done; cat /tmp/bench_a.log' }, 3 * MIN);
  bash({ command: 'until curl -s localhost:9/health; do sleep 2; done' }, MIN);
  addEvent(a(), 'result', { ok: true, text: 'done' });
  const end = db.now() + 1;
  stats.refreshActivity(id, t0 - 1, end);
  const [view] = stats.activityView({ project: id }, end);
  const cmds = Object.fromEntries(view.commands.map((c) => [c.group, c]));
  assert.equal(cmds['cargo bench'].waitedMs, 3 * MIN + 5 * SEC);
  assert.equal(cmds['cargo bench'].intent, 'Benchmark the renderer');
  assert.equal(cmds['wait loop'].waitedMs, MIN + 5 * SEC, 'a loop with nothing to link stays a wait loop');
});

test('task_11ca06b799: a wait goes to the background run or subagent waited on, never to the quick git chain that comes next', () => {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'solari', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const b = runtime.createAgent(project, runtime.rootAgent(project), s.roles.find((r) => r.id === 'builder')!, 'Builder', 'x');
  const a = () => db.get('SELECT * FROM agents WHERE id = ?', b.id)!;
  const t0 = db.now();
  let n = 0;
  const tool = (name: string, input: Record<string, unknown>, run: number, out = 'ok', before = 3 * SEC) => {
    const cid = `w${++n}`;
    db.advanceClock(before);
    addEvent(a(), 'tool', { id: cid, name, summary: String(input.command ?? input.description ?? name), input: JSON.stringify(input) });
    db.advanceClock(run);
    addEvent(a(), 'tool_result', { id: cid, text: out });
  };
  addEvent(a(), 'inbound', { text: 'Your next task' });
  // The bevy_solari_opt sequence: a quick git chain whose output names bench/ files, then a long background capture
  // into bench/out/meshlet, then the turn ends and the agent sits until the capture is done.
  tool('Bash', { command: 'git status --short | grep -v "^??" ; git add crates/a.rs; git commit -qm "meshlet decode"' }, SEC, ' M bench/solari_capture.rs\n M bench/out/meshlet/result.json');
  tool('Bash', { command: 'time (timeout 900 nix develop -c ./target/release/examples/solari_capture --view sponza_meshlet --dlss --out bench/out/meshlet 2>&1 | tail -5)', run_in_background: true, description: 'Capture the meshlet view' }, 0, 'Command running in background with ID: b8ikcnh4p. Output is being written to: /tmp/x/tasks/b8ikcnh4p.output');
  db.advanceClock(2 * SEC);
  addEvent(a(), 'result', { ok: true, text: 'Waiting on the capture.' });
  db.advanceClock(2 * 3600_000); // the capture runs; the agent waits for it
  tool('Bash', { command: 'git status --short | head; git log --oneline -1' }, SEC, ' M bench/out/meshlet/result.json', 0);
  // Then a subagent: the turn ends and the agent waits 40 minutes for it.
  tool('Agent', { description: 'task_x firefly fixes', prompt: 'p', subagent_type: 'skilled' }, 0, 'Async agent launched successfully.');
  db.advanceClock(SEC);
  addEvent(a(), 'result', { ok: true, text: 'Waiting on the subagent.' });
  db.advanceClock(40 * MIN);
  tool('Bash', { command: 'git status --short | head; git merge --no-edit worktree-agent-x 2>&1 | tail -3' }, SEC, 'merged', 0);
  addEvent(a(), 'result', { ok: true, text: 'done' });
  const end = db.now() + 1;

  const waited = new Map<string, number>();
  const buckets = act.activity(db.all, id, t0, end, () => 0, () => 'skilled', (c) => {
    if (c.waitedMs) waited.set(c.command, (waited.get(c.command) ?? 0) + c.waitedMs);
  });
  const sum = act.emptySplit();
  for (const x of buckets) for (const c of act.CATEGORIES) sum[c].ms += x.split[c].ms;
  const capture = [...waited].find(([c]) => c.includes('solari_capture'));
  assert.ok(capture, 'the wait is charged to the capture');
  assert.equal(capture![1], 2 * 3600_000);
  assert.ok(![...waited].some(([c]) => /^git status/.test(c)), 'nothing charged to the git chains');
  assert.ok(sum.subagents.ms >= 40 * MIN, 'the wait for the subagent is subagent time');

  stats.refreshActivity(id, t0 - 1, end);
  const [view] = stats.activityView({ project: id }, end);
  const groups = Object.fromEntries(view.commands.map((c) => [c.group, c.waitedMs]));
  assert.ok(!groups['git status'] && !groups['git commit'] && !groups['git merge'], 'git is not among the waits');
  assert.ok(Object.keys(groups).some((g) => /solari_capture/.test(g)), Object.keys(groups).join(', '));
});

test('task_11ca06b799: a chain groups as its main step, and a wait matches only files a command writes', async () => {
  const { commandGroup, writtenTargets, waitTargets } = await import('./commandgroups.ts');
  assert.equal(commandGroup('git status && cargo build').key, 'cargo build');
  assert.equal(commandGroup('cd /p && git status --short; git add a.rs; git commit -qm x').key, 'git commit');
  assert.equal(commandGroup('git status --short | head').key, 'git status');
  assert.deepEqual(writtenTargets('git status --short; cat bench/out/meshlet/result.json'), []);
  const out = writtenTargets('./solari_capture --out bench/out/meshlet > /tmp/cap.log 2>&1 #tasks/b8ikcnh4p');
  assert.ok(out.includes('out/meshlet') && out.includes('tmp/cap') && out.includes('tasks/b8ikcnh4p'), out.join(','));
  // A wait on a file inside the folder the capture writes matches it.
  const loop = ['until [ -e bench/out/meshlet/done ];', 'do sleep 5;', 'done'].join(' ');
  assert.ok(waitTargets(loop).some((t) => out.includes(t)));
});
