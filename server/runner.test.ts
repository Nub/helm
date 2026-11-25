import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const { run, get, all } = db;
const { DATA_DIR } = await import('./config.ts');
const { defaultStructure } = await import('./structure.ts');
const { createAgent, rootAgent } = await import('./agents.ts');
const { claimCommand, settleStopped, takeRunnerLock } = await import('./runner.ts');

test('a command is claimed by exactly one runner', () => {
  const id = Number(run("INSERT INTO runner_commands (op, args, created_at) VALUES ('send', '{}', 1)").lastInsertRowid);
  assert.equal(claimCommand(id, 'a'), true);
  assert.equal(claimCommand(id, 'b'), false, 'a second runner cannot take it');
  assert.equal(claimCommand(id, 'a'), false, 'nor the same one twice');
  run('UPDATE runner_commands SET done_at = 2 WHERE id = ?', id);
  const done = Number(run("INSERT INTO runner_commands (op, args, created_at, done_at) VALUES ('send', '{}', 1, 2)").lastInsertRowid);
  assert.equal(claimCommand(done, 'a'), false, 'a done command is never claimed');
});

test('commands a stopped runner had claimed: close is repeated, a message is not and its transcript says so', () => {
  const id = db.newId('pr');
  run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'p', mkdtempSync(join(SCRATCH, 'proj-')), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = rootAgent(project);
  const worker = createAgent(project, director, defaultStructure().roles.find((r) => r.id !== defaultStructure().root)!, 'Engineer', 'x');
  const add = (op: string, args: unknown) => Number(run("INSERT INTO runner_commands (op, args, created_at, claimed_by, claimed_at) VALUES (?, ?, 1, 'gone@1', 1)", op, JSON.stringify(args)).lastInsertRowid);
  const close = add('close', { agentId: worker.id, status: 'closed' });
  const send = add('send', { agentId: director.id, text: 'Please look at the login page.' });
  const stop = add('interrupt', { agentId: worker.id });
  settleStopped();
  const row = (i: number) => get('SELECT done_at, claimed_by, error FROM runner_commands WHERE id = ?', i)!;
  assert.equal(row(close).done_at, null, 'close stays to be done');
  assert.equal(row(close).claimed_by, null, 'and unclaimed, so the next drain repeats it');
  assert.ok(row(send).done_at && /not repeated/.test(row(send).error), 'the message is settled, not repeated');
  assert.ok(row(stop).done_at, 'the stop is settled');
  const notes = (a: string) => all("SELECT data FROM events WHERE agent_id = ? AND kind = 'note'", a).map((e) => JSON.parse(e.data).text as string);
  assert.ok(notes(director.id).some((t) => /Not delivered: Helm restarted .*Please look at the login page.*Send it again/.test(t)));
  assert.ok(notes(worker.id).some((t) => /A stop was not carried out/.test(t)));
});

test('the runner lock is a symlink to the pid; a lock whose process is gone is taken over', () => {
  const file = join(DATA_DIR, 'runner.lock');
  symlinkSync('999999999', file); // no such process
  assert.equal(takeRunnerLock(), null);
  assert.equal(readlinkSync(file), String(process.pid));
  assert.ok(!existsSync(`${file}.takeover`), 'the takeover lock is released');
  // A takeover left behind by a process that is gone does not block.
  symlinkSync('999999998', `${file}.takeover`);
  assert.equal(takeRunnerLock(), null);
  assert.equal(readlinkSync(file), String(process.pid));
});

test('on a disk where no file can grow the runner lock is still taken (a lock file with the pid in it was not)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const lockModule = fileURLToPath(new URL('./runnerlock.ts', import.meta.url));
  const dir = mkdtempSync(join(SCRATCH, 'lockdisk-'));
  const env = { ...process.env, HELM_DATA: dir };
  // config.json and the artifacts folder first, as an earlier start leaves them.
  spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(lockModule)})`], { env });
  const limited = (code: string) =>
    spawnSync('bash', ['-c', `trap '' XFSZ; ulimit -f 0; exec "${process.execPath}" --input-type=module -e "$0"`, code], { env, encoding: 'utf8' });
  const before = limited(`import { openSync, writeSync } from 'node:fs'; const fd = openSync(${JSON.stringify(join(dir, 'old.lock'))}, 'wx'); try { writeSync(fd, String(process.pid)); console.log('wrote'); } catch (e) { console.log(e.code); }`);
  assert.equal(before.stdout.trim(), 'EFBIG', 'the old way, a pid written into a new file, fails there');
  const now = limited(`const { takeRunnerLock } = await import(${JSON.stringify(lockModule)}); console.log(JSON.stringify(takeRunnerLock()));`);
  assert.equal(now.stdout.trim(), 'null', `taking the lock failed: ${now.stdout}${now.stderr}`);
});

test('a session two processes both find ended is ended, and the director told, once', async () => {
  const sessions = await import('./sessions.ts');
  const id = db.newId('pr');
  run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 's', mkdtempSync(join(SCRATCH, 'proj-')), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const notes: string[] = [];
  sessions.setSessionNotifier(async (_p, text) => void notes.push(text));
  sessions.recordOwnerActivity(id);
  sessions.recordOwnerActivity(id);
  sessions.recordOwnerActivity(id);
  const open = get('SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL', id)!;
  // The web service (stepping away) and the runner (its timer, holding the same row read a moment before) both end it.
  sessions.endSession(open, 'stepped_away', db.now());
  sessions.endSession(open, 'idle', db.now());
  assert.equal(notes.length, 1, 'one note to the director');
  assert.equal(get('SELECT ended_reason FROM sessions WHERE id = ?', open.id)!.ended_reason, 'stepped_away', 'the first end stands');
});

test('a waiting run that does not end is left alone: nothing is started over it', async () => {
  const live = await import('./liveupdate.ts');
  const { mkdirSync, writeFileSync, existsSync: exists } = await import('node:fs');
  mkdirSync(live.LIVE.dir, { recursive: true });
  const status = { id: 'run-1', kind: 'update', stage: 'waiting', message: 'waiting', log: '', fromRev: 'a', toRev: 'b', startedAt: Date.now(), updatedAt: Date.now() };
  writeFileSync(join(live.LIVE.dir, 'status.json'), JSON.stringify(status));
  // Its status says it ended, but its unit is still running (it has not exited and still holds the lock).
  setTimeout(() => writeFileSync(join(live.LIVE.dir, 'status.json'), JSON.stringify({ ...status, stage: 'superseded' })), 300);
  live._internal.setUnitCheck(async () => true);
  const error = await live._internal.endWaitingRun(status as any, 'supersede', 8);
  assert.match(error ?? '', /did not end; nothing was changed/);
  assert.ok(!exists(join(live.LIVE.dir, 'supersede')), 'the signal is withdrawn');
  // Once the unit has exited, it goes ahead.
  live._internal.setUnitCheck(async () => false);
  assert.equal(await live._internal.endWaitingRun(status as any, 'supersede', 8), null);
});

test('a stale takeover link is cleared, but one a live process put there in the meantime is put back', async () => {
  const { clearStaleTakeover } = await import('./runnerlock.ts');
  const dir = mkdtempSync(join(SCRATCH, 'takeover-'));
  const link = join(dir, 'runner.lock.takeover');
  symlinkSync('999999997', link);
  clearStaleTakeover(link, 999999997);
  assert.ok(!existsSync(link), 'the dead one is gone');
  // Seen dead, but by the time it is cleared another (live: this process) has replaced it.
  symlinkSync(String(process.pid), link);
  clearStaleTakeover(link, 999999997);
  assert.equal(readlinkSync(link), String(process.pid), 'the live one stands');
});

test('a live runner whose environment has no HELM_DATA (its data is ~/.helm under its HOME) keeps its lock', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const home = mkdtempSync(join(SCRATCH, 'home-'));
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, NODE_ENV: 'test', HELM_CLAUDE_PATH: '/bin/false', HELM_PROJECTS: join(home, 'projects') };
  const first = spawn(process.execPath, ['server/main.ts', 'runner'], { cwd: repo, env, stdio: 'ignore' });
  try {
    const lock = join(home, '.helm', 'runner.lock');
    for (let i = 0; i < 100 && !existsSync(lock); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(readlinkSync(lock), String(first.pid), 'the first runner holds it');
    const second = spawnSync(process.execPath, ['server/main.ts', 'runner'], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(second.status, 3, `the second runner was not refused: ${second.stdout}${second.stderr}`);
    assert.equal(readlinkSync(lock), String(first.pid), 'and the lock is still the first one');
  } finally {
    first.kill('SIGTERM');
    await new Promise((r) => first.on('exit', r));
  }
});

test('the default data folder is never made inside a git checkout; HELM_DATA may put it there', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const config = fileURLToPath(new URL('./config.ts', import.meta.url));
  const checkout = mkdtempSync(join(SCRATCH, 'checkout-'));
  mkdirSync(join(checkout, '.git'));
  const load = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(config)})`], { cwd: checkout, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env }, encoding: 'utf8' });
  const refused = load({ HOME: '.' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to keep Helm's data in .*inside the git checkout/);
  assert.ok(!existsSync(join(checkout, '.helm')), 'nothing was written into the checkout');
  assert.equal(load({ HOME: '.', HELM_DATA: '' }).status === 0, false, 'an empty HELM_DATA is no choice either');
  assert.equal(load({ HOME: '.', HELM_DATA: join(checkout, 'data') }).status, 0, 'an explicit HELM_DATA is allowed');
});
