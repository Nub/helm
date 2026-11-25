/**
 * Clean host workspaces (hostwork.ts) end to end over real SSH, against a throwaway sshd on 127.0.0.1 (its own keys and
 * config in a scratch folder; nothing in the user's own SSH setup is touched). The sshd sets LEAKY_FROM_PROFILE in
 * every session, standing in for the user's profile. Checks: the code at the commit, isolation between two runs and
 * from the login environment, a shared cache, outputs back, removal after success, retention after failure then the
 * sweep, and nothing outside the root touched. Run: npm run check:hostwork.
 */
import { SCRATCH } from '../testenv.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const { now, run, get, advanceClock } = await import('../db.ts');
const hw = await import('../hostwork.ts');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err: any) {
    console.log(`FAIL ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

// ---------- a throwaway sshd on a free port ----------
const dir = join(SCRATCH, 'ssh');
mkdirSync(dir, { recursive: true });
const port: number = await new Promise((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = (s.address() as any).port;
    s.close(() => done(p));
  });
});
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'hostkey')]);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'clientkey')]);
writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(dir, 'clientkey.pub')));
writeFileSync(
  join(dir, 'sshd_config'),
  [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(dir, 'hostkey')}`, `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
    `PidFile ${join(dir, 'sshd.pid')}`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'SetEnv LEAKY_FROM_PROFILE=yes',
  ].join('\n') + '\n',
);
const user = execFileSync('id', ['-un']).toString().trim();
const sshConfig = join(dir, 'ssh_config');
writeFileSync(
  sshConfig,
  ['Host hwcheck', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${user}`, `  IdentityFile ${join(dir, 'clientkey')}`, '  IdentitiesOnly yes', `  UserKnownHostsFile ${join(dir, 'known_hosts')}`, '  StrictHostKeyChecking no', '  LogLevel ERROR'].join('\n') + '\n',
);
const sshdPath = existsSync('/run/current-system/sw/bin/sshd') ? '/run/current-system/sw/bin/sshd' : execFileSync('bash', ['-c', 'command -v sshd']).toString().trim();
const sshd = spawn(sshdPath, ['-D', '-f', join(dir, 'sshd_config'), '-E', join(dir, 'sshd.log')], { stdio: 'ignore' });
process.on('exit', () => sshd.kill());
for (let i = 0; i < 50; i++) {
  try {
    execFileSync('ssh', ['-F', sshConfig, '-o', 'BatchMode=yes', 'hwcheck', 'true'], { stdio: 'ignore' });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
hw.setTransport(hw.sshTransport(['-F', sshConfig]));
const ssh = (cmd: string, input?: string) => execFileSync('ssh', ['-F', sshConfig, '-o', 'BatchMode=yes', 'hwcheck', cmd], input !== undefined ? { input } : {}).toString();

// ---------- a project with a commit, and a host entry for the loopback sshd ----------
const repo = join(SCRATCH, 'repo');
mkdirSync(repo);
const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 'C', GIT_AUTHOR_EMAIL: 'c@example.com', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@example.com' } }).toString().trim();
git('init', '-q');
writeFileSync(join(repo, 'hello.txt'), 'version one\n');
writeFileSync(join(repo, 'same.txt'), 'unchanged in both commits\n');
writeFileSync(join(repo, 'gone.txt'), 'only in the first commit\n');
git('add', '.');
git('commit', '-qm', 'one');
const first = git('rev-parse', 'HEAD');
writeFileSync(join(repo, 'hello.txt'), 'version two\n');
git('rm', '-q', 'gone.txt');
git('commit', '-qam', 'two');
const second = git('rev-parse', 'HEAD');
run('INSERT INTO projects (id, name, path, structure, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'pr_hw', 'Game', repo, '{"root":"director","roles":[]}', now(), now());
const project = get("SELECT * FROM projects WHERE id = 'pr_hw'")!;
const root = join(SCRATCH, 'hostroot', '.helm-work');
const outside = join(SCRATCH, 'hostroot', 'precious.txt');
mkdirSync(join(SCRATCH, 'hostroot'), { recursive: true });
writeFileSync(outside, 'keep me');
run(
  "INSERT INTO hosts (id, name, ssh_target, created_at, updated_at, work_root, work_env, work_setup, work_caches) VALUES ('host_hw', 'loop', 'hwcheck', ?, ?, ?, '', 'export FROM_SETUP=on', 'MYCACHE')",
  now(), now(), root,
);
const host = get("SELECT * FROM hosts WHERE id = 'host_hw'")!;

// The user's login environment really has the variable (the stand-in for their profile).
await check('the login environment has LEAKY_FROM_PROFILE (the stand-in for the user\'s profile)', () => {
  assert.equal(ssh('bash --noprofile --norc', 'echo ${LEAKY_FROM_PROFILE:-unset}').trim(), 'yes');
});

let w1: any;
let w2: any;
// As agents are told: the command on stdin, so the user's login shell (fish here) never parses it.
const runIn = (w: any, cmd: string) => ssh(`${w.note}/.helm/run`, cmd).trim();

// The health check's live sample (hoststats.ts) over real SSH: the same command line Helm sends (`sh -s`, the
// collector on stdin, so the login shell never parses it), parsed as the Hosts page reads it.
await check('the host check samples CPU, memory and disk over SSH (sh -s), the login shell never parsing it', async () => {
  const { unixScript, parseUnixStats } = await import('../hoststats.ts');
  const out = execFileSync('ssh', ['-F', sshConfig, '-o', 'BatchMode=yes', '-T', 'hwcheck', 'sh -s'], { input: unixScript(root) }).toString();
  const s = parseUnixStats(out);
  assert.ok(s.mem && s.disk && s.load && s.cpu !== null, JSON.stringify(s));
});

await check('a workspace has the code at the stated commit, under the root, with a clean environment', async () => {
  const r = await hw.createWorkspace({ host, project, taskId: 'task_abc', job: 'build', commit: first });
  assert.ok('workspace' in r, JSON.stringify(r));
  w1 = (r as any).workspace;
  assert.equal(w1.path, `${root}/game/build-1`);
  assert.equal(runIn(w1, 'cat hello.txt'), 'version one');
  assert.equal(runIn(w1, 'echo ${LEAKY_FROM_PROFILE:-clean}'), 'clean');
  assert.equal(runIn(w1, 'echo $HOME'), `${w1.note}/home`);
  assert.equal(runIn(w1, 'echo $FROM_SETUP'), 'on', 'the host\'s setup line ran');
  assert.equal(runIn(w1, 'shopt -q login_shell && echo login || echo plain'), 'plain');
  runIn(w1, 'echo run1 > leftover.txt; echo cached > "$MYCACHE/c.txt"; echo r > ../out/report.txt');
});

await check('a second run of the same job is its own workspace: no files of the first, but the shared cache', async () => {
  const r = await hw.createWorkspace({ host, project, taskId: 'task_abc', job: 'build' });
  w2 = (r as any).workspace;
  assert.equal(w2.path, `${root}/game/build-2`);
  assert.equal(runIn(w2, 'cat hello.txt'), 'version two', 'HEAD by default');
  assert.equal(runIn(w2, 'ls leftover.txt 2>/dev/null || echo none'), 'none');
  assert.equal(runIn(w2, 'cat "$MYCACHE/c.txt"'), 'cached');
});

await check('success: outputs come back and the workspace is removed', async () => {
  const r = await hw.endWorkspace(w1.id, true, ['src/leftover.txt', 'out/report.txt']);
  assert.ok(!('error' in r), JSON.stringify(r));
  const res = (r as any).results;
  assert.equal(readFileSync(join(res, 'src/leftover.txt'), 'utf8').trim(), 'run1');
  assert.equal(readFileSync(join(res, 'out/report.txt'), 'utf8').trim(), 'r');
  assert.equal(existsSync(w1.path), false);
  assert.equal(existsSync(join(root, 'cache')), true, 'the cache stays');
});

await check('failure: kept for a day, then the sweep removes it; nothing outside the root is touched', async () => {
  const r = await hw.endWorkspace(w2.id, false, []);
  assert.deepEqual(r, { results: null, kept: true });
  assert.equal(existsSync(w2.path), true);
  await hw.sweepWorkspaces(now() + 25 * 3600_000);
  assert.equal(existsSync(w2.path), false);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
  // A leftover folder in the root nobody tracks goes too (older than a day); the cache does not.
  mkdirSync(join(root, 'game', 'stray-1'), { recursive: true });
  execFileSync('touch', ['-d', '2 days ago', join(root, 'game', 'stray-1')]);
  await hw.sweepWorkspaces(now());
  assert.equal(existsSync(join(root, 'game', 'stray-1')), false);
  assert.equal(existsSync(join(root, 'cache')), true);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
});

await check('removing refuses anything not under the root, even if the record says so', async () => {
  run("INSERT INTO host_workspaces (id, host_id, project_id, name, path, commit_sha, created_at) VALUES ('hws_bad', 'host_hw', 'pr_hw', 'x', ?, 'x', ?)", join(SCRATCH, 'hostroot'), now());
  assert.match((await hw.removeWorkspace('hws_bad'))!, /not under the workspace root/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
});

await check('a folder under the root swapped for a symlink is never written through or removed through', async () => {
  const { symlinkSync, renameSync } = await import('node:fs');
  const elsewhere = join(SCRATCH, 'elsewhere');
  mkdirSync(join(elsewhere, 'build-1'), { recursive: true });
  writeFileSync(join(elsewhere, 'build-1', 'precious.txt'), 'keep me too');
  // A new workspace for a project whose folder in the root is a symlink out: refused before anything is written.
  run('INSERT INTO projects (id, name, path, structure, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'pr_sym', 'Sym', repo, '{"root":"director","roles":[]}', now(), now());
  symlinkSync(elsewhere, join(root, 'sym'));
  const made = await hw.createWorkspace({ host, project: get("SELECT * FROM projects WHERE id = 'pr_sym'")!, job: 'build' });
  assert.ok('error' in made && /symlink|outside the root/.test((made as any).error), JSON.stringify(made));
  assert.deepEqual(execFileSync('ls', [elsewhere]).toString().trim().split('\n'), ['build-1'], 'nothing written there');
  // An existing workspace whose project folder a job swapped for a symlink to elsewhere: removal refuses.
  const r = await hw.createWorkspace({ host, project, job: 'swap' });
  const w = (r as any).workspace;
  renameSync(join(root, 'game'), join(root, 'game-moved'));
  mkdirSync(join(elsewhere, 'swap-1'), { recursive: true });
  writeFileSync(join(elsewhere, 'swap-1', 'precious.txt'), 'keep me three');
  symlinkSync(elsewhere, join(root, 'game'));
  assert.match((await hw.removeWorkspace(w.id))!, /outside the root|symlink|refused/);
  assert.equal(readFileSync(join(elsewhere, 'swap-1', 'precious.txt'), 'utf8'), 'keep me three');
  assert.equal(readFileSync(join(elsewhere, 'build-1', 'precious.txt'), 'utf8'), 'keep me too');
});

// ---------- build slots ----------
const slotRoot = join(SCRATCH, 'hostroot', '.helm-slots');
run(
  "INSERT INTO hosts (id, name, ssh_target, created_at, updated_at, work_root, work_env, work_setup, work_caches, work_keep) VALUES ('host_slot', 'slotbox', 'hwcheck', ?, ?, ?, '', '', '', 'MYTARGET=target')",
  now(), now(), slotRoot,
);
const slotHost = get("SELECT * FROM hosts WHERE id = 'host_slot'")!;
const notices: { agent: string; text: string }[] = [];
hw.setSlotNotice(async (agent, text) => void notices.push({ agent, text }));
const { statSync, utimesSync } = await import('node:fs');
let s1: any;
let s2: any;

await check('a slot: the same folder every time, the kept folder pointed at by its variable', async () => {
  const r = await hw.createWorkspace({ host: slotHost, project, taskId: 'task_one', agentId: 'ag_one', job: 'build', commit: first });
  assert.ok('workspace' in r, JSON.stringify(r));
  s1 = (r as any).workspace;
  assert.equal(s1.path, `${slotRoot}/game/slot`);
  assert.equal(s1.slot, 1);
  assert.equal(runIn(s1, 'echo $MYTARGET'), `${s1.note}/src/target`);
  // The "build": output in the kept folder, a stray file in src/ and home/ that the next job must not see.
  runIn(s1, 'mkdir -p "$MYTARGET" && echo built-at-one > "$MYTARGET/artifact" && echo stray > stray.txt && echo h > "$HOME/h.txt"');
  // Times in the past, as after a real build some time ago.
  const old = new Date(Date.now() - 3600_000);
  for (const name of ['same.txt', 'hello.txt']) utimesSync(join(s1.note, 'src', name), old, old);
});

await check('a second job for the slot waits for the first; its agent is told when it frees', async () => {
  const r = await hw.createWorkspace({ host: slotHost, project, taskId: 'task_two', agentId: 'ag_two', job: 'build', commit: second });
  assert.ok('error' in r && (r as any).busy, JSON.stringify(r));
  assert.match((r as any).error, /in use/);
  assert.match((await hw.removeWorkspace(s1.id))!, /in use/, 'a slot in use is not removed');
  const end = await hw.endWorkspace(s1.id, true, []);
  assert.deepEqual(end, { results: null, kept: true, slot: true });
  assert.equal(existsSync(s1.note), true, 'the slot stays after success');
  assert.deepEqual(notices.map((n) => n.agent), ['ag_two']);
  assert.match(notices[0].text, /slot on slotbox is free/);
});

await check('the next job: source reset to its commit, build output kept, unchanged files keep their times', async () => {
  const before = Date.now();
  const r = await hw.createWorkspace({ host: slotHost, project, taskId: 'task_two', agentId: 'ag_two', job: 'build', commit: second });
  assert.ok('workspace' in r, JSON.stringify(r));
  s2 = (r as any).workspace;
  assert.equal(s2.path, s1.path, 'the same folder');
  assert.equal(runIn(s2, 'cat "$MYTARGET/artifact"'), 'built-at-one', 'the kept build folder survived');
  assert.equal(runIn(s2, 'cat hello.txt'), 'version two');
  assert.equal(runIn(s2, 'ls gone.txt stray.txt 2>/dev/null || echo none'), 'none', 'what the commit does not have is gone');
  assert.equal(runIn(s2, 'ls "$HOME"'), '', 'home starts empty');
  const src = join(s2.note, 'src');
  assert.ok(statSync(join(src, 'same.txt')).mtimeMs < before - 60_000, 'an unchanged file keeps its time');
  assert.ok(statSync(join(src, 'hello.txt')).mtimeMs >= before - 2000, 'a changed file is newer than the last build');
  // The source is exactly the commit (kept folder aside).
  const files = execFileSync('bash', ['-c', `cd ${src} && find . -path ./target -prune -o -type f -print | sort`]).toString().trim().split('\n');
  assert.deepEqual(files, ['./hello.txt', './same.txt']);
  // Only the latest job of a slot is listed.
  assert.equal(hw.workspacesView('host_slot').length, 1);
});

await check('a job that edits tracked files or swaps one for a link: the next job still gets the exact commit', async () => {
  const { symlinkSync, rmSync: rm } = await import('node:fs');
  runIn(s2, 'echo tampered > hello.txt');
  rm(join(s2.note, 'src', 'same.txt'));
  symlinkSync(outside, join(s2.note, 'src', 'same.txt'));
  await hw.endWorkspace(s2.id, false, []);
  const r = await hw.createWorkspace({ host: slotHost, project, agentId: 'ag_two', job: 'build', commit: second });
  const s3 = (r as any).workspace;
  assert.equal(runIn(s3, 'cat hello.txt'), 'version two');
  assert.equal(execFileSync('bash', ['-c', `[ -L ${s3.note}/src/same.txt ] && echo link || cat ${s3.note}/src/same.txt`]).toString().trim(), 'unchanged in both commits');
  assert.equal(readFileSync(outside, 'utf8'), 'keep me');
  await hw.endWorkspace(s3.id, true, []);
  // fresh: a separate clean folder even with a slot.
  const f = await hw.createWorkspace({ host: slotHost, project, agentId: 'ag_two', job: 'clean', fresh: true });
  assert.equal((f as any).workspace.path, `${slotRoot}/game/clean-1`);
  await hw.endWorkspace((f as any).workspace.id, true, []);
  // The sweep keeps a slot in use recently, even when its folder is old.
  execFileSync('touch', ['-d', '2 days ago', s3.note]);
  await hw.sweepWorkspaces(now());
  assert.equal(existsSync(s3.note), true);
  // Remove (the Hosts page) once it is free.
  assert.equal(await hw.removeWorkspace(s3.id), null);
  assert.equal(existsSync(s3.note), false);
});

// ---------- Windows: the PowerShell scripts, run by PowerShell 7 on this machine ----------
// No Windows host here: the same scripts and the same command lines (powershell -EncodedCommand …, run.ps1) run under
// pwsh on Linux, where symlinks are reparse points as junctions are on Windows. What this cannot show: cmd.exe as the
// login shell, Windows' own tar.exe, junctions themselves, Windows PowerShell 5.1.
const pwsh = (() => {
  if (process.env.HELM_PWSH) return process.env.HELM_PWSH;
  try {
    return execFileSync('bash', ['-c', 'command -v pwsh']).toString().trim();
  } catch {}
  try {
    return `${execFileSync('nix', ['build', 'nixpkgs#powershell', '--no-link', '--print-out-paths'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}/bin/pwsh`;
  } catch {}
  return '';
})();
if (!pwsh) console.log('skip the Windows scripts: no PowerShell (set HELM_PWSH, or have pwsh or nix on PATH)');
else {
  // "powershell" on PATH is pwsh: the command line Helm sends a Windows host runs as is, minus ssh.
  const shim = join(SCRATCH, 'pwsh-shim');
  mkdirSync(shim, { recursive: true });
  const { symlinkSync, renameSync, statSync, utimesSync, rmSync: rm } = await import('node:fs');
  symlinkSync(pwsh, join(shim, 'powershell'));
  const PATH = `${shim}:${process.env.PATH}`;
  hw.setTransport((h, script, stdin, stdoutTo) =>
    new Promise((resolve) => {
      const remote = hw.remoteCommand(h, script, !!stdin);
      const child = spawn('bash', ['--noprofile', '--norc', '-c', remote.command], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PATH, LEAKY_FROM_PROFILE: 'yes' } });
      let out = '';
      let err = '';
      if (stdoutTo) child.stdout.pipe(stdoutTo);
      else child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      if (stdin) stdin.pipe(child.stdin);
      else child.stdin.end(remote.stdin ?? '');
      child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
    }),
  );
  const winRoot = join(SCRATCH, 'winhost', '.helm-work');
  const winOutside = join(SCRATCH, 'winhost', 'precious.txt');
  mkdirSync(join(SCRATCH, 'winhost'), { recursive: true });
  writeFileSync(winOutside, 'keep me');
  run(
    "INSERT INTO hosts (id, name, ssh_target, platform, created_at, updated_at, work_root, work_env, work_setup, work_caches, work_keep) VALUES ('host_win', 'winbox', 'winbox', 'windows', ?, ?, ?, '/opt/declared/bin', '$env:FROM_SETUP = \"on\"', 'MYCACHE', '')",
    now(), now(), winRoot,
  );
  let win = get("SELECT * FROM hosts WHERE id = 'host_win'")!;
  const runWin = (w: any, cmd: string) =>
    execFileSync('bash', ['--noprofile', '--norc', '-c', `powershell -NoProfile -ExecutionPolicy Bypass -File "${w.note}/.helm/run.ps1"`], { input: cmd, env: { ...process.env, PATH, LEAKY_FROM_PROFILE: 'yes' } }).toString().trim();

  let ww: any;
  await check('windows: a fresh workspace with the code at the commit and an environment built from nothing', async () => {
    const r = await hw.createWorkspace({ host: win, project, job: 'build', commit: first });
    assert.ok('workspace' in r, JSON.stringify(r));
    ww = (r as any).workspace;
    assert.equal(ww.path, `${winRoot}/game/build-1`);
    assert.equal(runWin(ww, 'Get-Content hello.txt'), 'version one');
    assert.equal(runWin(ww, 'if ($env:LEAKY_FROM_PROFILE) { "leaked" } else { "clean" }'), 'clean');
    assert.equal(runWin(ww, '$env:HOME'), `${ww.note}/home`);
    assert.equal(runWin(ww, '$env:FROM_SETUP'), 'on', 'the setup line ran');
    // PowerShell 7 on Linux puts its own folder first; Windows PowerShell does not.
    const winPath = runWin(ww, '$env:PATH').split(':');
    assert.deepEqual(winPath.filter((p) => !p.includes('powershell')), ['/opt/declared/bin', '/usr/local/bin', '/usr/bin', '/bin']);
    assert.equal(runWin(ww, '$env:MYCACHE'), `${winRoot}/cache/game/mycache`);
    assert.equal(runWin(ww, '(Get-Location).Path'), `${ww.note}/src`);
    // A failing native command's exit code comes back.
    let code = 0;
    try {
      runWin(ww, 'sh -c "exit 7"');
    } catch (e: any) {
      code = e.status;
    }
    assert.equal(code, 7);
    // A command that does not exist fails the run (PowerShell would otherwise go on and exit 0).
    assert.throws(() => runWin(ww, 'no-such-command-here; "after"'));
    runWin(ww, 'Set-Content -Path ../out/report.txt -Value r');
  });

  await check('windows: outputs come back through the byte stream; success removes it', async () => {
    const r = await hw.endWorkspace(ww.id, true, ['out/report.txt', 'src/hello.txt']);
    assert.ok(!('error' in r), JSON.stringify(r));
    assert.equal(readFileSync(join((r as any).results, 'out/report.txt'), 'utf8').trim(), 'r');
    assert.equal(readFileSync(join((r as any).results, 'src/hello.txt'), 'utf8').trim(), 'version one');
    assert.equal(existsSync(ww.path), false);
  });

  await check('windows: confinement — a link on the way is refused, a link inside is removed as itself, never followed', async () => {
    const elsewhere = join(SCRATCH, 'win-elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'precious.txt'), 'keep me too');
    // A project folder in the root swapped for a link: creating refuses before writing.
    run('INSERT INTO projects (id, name, path, structure, created_at, updated_at) VALUES (?,?,?,?,?,?)', 'pr_wsym', 'WSym', repo, '{"root":"director","roles":[]}', now(), now());
    symlinkSync(elsewhere, join(winRoot, 'wsym'));
    const made = await hw.createWorkspace({ host: win, project: get("SELECT * FROM projects WHERE id = 'pr_wsym'")!, job: 'build' });
    assert.ok('error' in made && /link/.test((made as any).error), JSON.stringify(made));
    assert.deepEqual(execFileSync('ls', [elsewhere]).toString().trim().split('\n'), ['precious.txt']);
    // A job left a link to outside inside its workspace: removal deletes the link, not what it points at.
    const r = await hw.createWorkspace({ host: win, project, job: 'links' });
    const w = (r as any).workspace;
    symlinkSync(elsewhere, join(w.note, 'src', 'escape'));
    symlinkSync(winOutside, join(w.note, 'out', 'file-link'));
    assert.equal(await hw.removeWorkspace(w.id), null);
    assert.equal(existsSync(w.note), false);
    assert.equal(readFileSync(join(elsewhere, 'precious.txt'), 'utf8'), 'keep me too');
    assert.equal(readFileSync(winOutside, 'utf8'), 'keep me');
    // The project folder swapped for a link after the workspace was made: removal refuses.
    const r2 = await hw.createWorkspace({ host: win, project, job: 'swap' });
    const w2 = (r2 as any).workspace;
    renameSync(join(winRoot, 'game'), join(winRoot, 'game-moved'));
    mkdirSync(join(elsewhere, 'swap-1'), { recursive: true });
    writeFileSync(join(elsewhere, 'swap-1', 'precious.txt'), 'keep me three');
    symlinkSync(elsewhere, join(winRoot, 'game'));
    assert.match((await hw.removeWorkspace(w2.id))!, /link/);
    assert.equal(readFileSync(join(elsewhere, 'swap-1', 'precious.txt'), 'utf8'), 'keep me three');
    rm(join(winRoot, 'game'));
    renameSync(join(winRoot, 'game-moved'), join(winRoot, 'game'));
    assert.match((await hw.removeWorkspace('hws_bad'))!, /not under the workspace root/);
  });

  await check('windows: a slot keeps its build folder and resets the code; sizes and the sweep work', async () => {
    run("UPDATE hosts SET work_keep = 'MYTARGET=target' WHERE id = 'host_win'");
    win = get("SELECT * FROM hosts WHERE id = 'host_win'")!;
    const a = (await hw.createWorkspace({ host: win, project, agentId: 'ag_w', commit: first }) as any).workspace;
    assert.equal(a.path, `${winRoot}/game/slot`);
    runWin(a, 'New-Item -ItemType Directory -Force $env:MYTARGET | Out-Null; Set-Content -Path (Join-Path $env:MYTARGET artifact) -Value built; Set-Content stray.txt x');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(a.note, 'src', 'same.txt'), old, old);
    await hw.endWorkspace(a.id, true, []);
    const before = Date.now();
    const b = (await hw.createWorkspace({ host: win, project, agentId: 'ag_w', commit: second }) as any).workspace;
    assert.equal(b.path, a.path);
    assert.equal(runWin(b, 'Get-Content (Join-Path $env:MYTARGET artifact)'), 'built');
    assert.equal(runWin(b, 'Get-Content hello.txt'), 'version two');
    assert.equal(runWin(b, 'if (Test-Path stray.txt) { "stray" } elseif (Test-Path gone.txt) { "gone" } else { "none" }'), 'none');
    assert.ok(statSync(join(b.note, 'src', 'same.txt')).mtimeMs < before - 60_000, 'unchanged keeps its time');
    assert.ok(statSync(join(b.note, 'src', 'hello.txt')).mtimeMs >= before - 2000, 'changed is newer');
    await hw.endWorkspace(b.id, true, []);
    await hw.measure(win);
    assert.ok(Number(get('SELECT bytes FROM host_workspaces WHERE id = ?', b.id)!.bytes) > 0, 'its size is measured');
    // A stray folder older than a day goes; the slot (tracked) and the cache stay.
    mkdirSync(join(winRoot, 'game', 'stray-1'), { recursive: true });
    execFileSync('touch', ['-d', '2 days ago', join(winRoot, 'game', 'stray-1'), b.note]);
    await hw.sweepWorkspaces(now());
    assert.equal(existsSync(join(winRoot, 'game', 'stray-1')), false);
    assert.equal(existsSync(b.note), true);
    assert.equal(existsSync(join(winRoot, 'cache')), true);
    assert.equal(readFileSync(winOutside, 'utf8'), 'keep me');
  });
}

void advanceClock;
sshd.kill();
console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}.`);
