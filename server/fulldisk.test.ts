import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Surviving a full disk (server/safefs.ts): files are replaced whole or not at all and only when changed, and a Helm
 * started where nothing more can be written still starts, serves the UI and says the disk is full.
 *
 * The real-server part limits file size with `ulimit -f` (SIGXFSZ ignored, so writes past the limit fail with EFBIG
 * the way they fail with ENOSPC on a full disk) instead of needing a small filesystem.
 */

const { writeFileAtomic, copyFileAtomic, faults, isDiskFull, lastDiskFull, clearDiskFull, survive } = await import('./safefs.ts');

const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

test('isDiskFull knows the ways a full disk shows up', () => {
  const cases: [unknown, boolean][] = [
    [enospc(), true],
    [Object.assign(new Error('x'), { code: 'EDQUOT' }), true],
    [Object.assign(new Error('File too large'), { code: 'EFBIG' }), true],
    [Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' }), true],
    // An I/O error is a full disk only when free space says so (server/disk.test.ts); nothing sampled here.
    [Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10, errstr: 'disk I/O error' }), false],
    [Object.assign(new Error('no such table: x'), { code: 'ERR_SQLITE_ERROR', errcode: 1, errstr: 'SQL logic error' }), false],
    [Object.assign(new Error('nope'), { code: 'ENOENT' }), false],
    [new TypeError('x is undefined'), false],
    [null, false],
    ['ENOSPC', false],
  ];
  for (const [err, want] of cases) assert.equal(isDiskFull(err), want, String((err as Error)?.message ?? err));
});

test('writeFileAtomic writes only changes, and a failed write leaves the old file and no temporary', () => {
  const dir = mkdtempSync(join(SCRATCH, 'atomic-'));
  const f = join(dir, 'config.json');
  assert.equal(writeFileAtomic(f, '{"a":1}\n', { mode: 0o600 }), true);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const before = statSync(f).mtimeMs;
  assert.equal(writeFileAtomic(f, '{"a":1}\n'), false, 'unchanged content is not written');
  assert.equal(statSync(f).mtimeMs, before);

  clearDiskFull();
  faults.beforeWrite = () => {
    throw enospc();
  };
  try {
    assert.throws(() => writeFileAtomic(f, '{"a":2}\n'), /ENOSPC/);
    assert.throws(() => copyFileAtomic(f, join(dir, 'copy.json')), /ENOSPC/);
  } finally {
    faults.beforeWrite = null;
  }
  assert.equal(readFileSync(f, 'utf8'), '{"a":1}\n', 'the old content survives');
  assert.deepEqual(readdirSync(dir), ['config.json'], 'no temporary or partial file is left');
  assert.match(lastDiskFull()?.what ?? '', /copy\.json/);

  // A failure in the middle of writing (the disk fills partway) is handled the same.
  let calls = 0;
  faults.beforeWrite = () => {
    if (calls++) throw enospc();
  };
  try {
    writeFileAtomic(f, '{"a":3}\n');
    assert.throws(() => writeFileAtomic(f, '{"a":4}\n'));
  } finally {
    faults.beforeWrite = null;
  }
  assert.equal(readFileSync(f, 'utf8'), '{"a":3}\n');
  assert.deepEqual(readdirSync(dir), ['config.json']);
});

test('survive swallows only disk-full errors', () => {
  assert.equal(
    survive('x', () => {
      throw enospc();
    }, 'fallback'),
    'fallback',
  );
  assert.throws(() =>
    survive('x', () => {
      throw new TypeError('a bug');
    }, 'fallback'),
  );
});

// ---------- a real server on a "full" disk ----------

const ROOT = resolve(import.meta.dirname, '..');

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

function startServer(data: string, port: number, limitKB?: number, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HELM_') && v !== undefined) env[k] = v;
  Object.assign(env, { HELM_DATA: data, HELM_PORT: String(port), HELM_HOST: '127.0.0.1', HELM_CLAUDE_PATH: '/bin/false', HELM_PROJECTS: join(data, 'projects'), NODE_ENV: 'test', ...extra });
  const limit = limitKB ? `trap '' XFSZ; ulimit -f ${limitKB}; ` : '';
  const child = spawn('bash', ['-c', `${limit}exec "${process.execPath}" server/main.ts`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, log: () => log };
}

async function waitHealthy(port: number, exited: Promise<unknown>, log: () => string) {
  let dead = false;
  void exited.then(() => (dead = true));
  for (let i = 0; i < 150; i++) {
    if (dead) throw new Error(`The server exited:\n${log()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return (await r.json()) as { ok: boolean; disk?: { level: string; full: boolean } };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The server did not answer:\n${log()}`);
}

test('Helm starts, serves the UI and says so on a disk where nothing more fits', { timeout: 60_000 }, async () => {
  const data = mkdtempSync(join(tmpdir(), 'helm-fulldisk-'));
  let s: ReturnType<typeof startServer> | null = null;
  try {
    const port = await freePort();
    // A first, normal start creates the database and config.json.
    s = startServer(data, port);
    await waitHealthy(port, s.exited, s.log);
    s.child.kill('SIGTERM');
    await s.exited;
    const config = readFileSync(join(data, 'config.json'), 'utf8');
    const token = JSON.parse(config).token as string;

    // Now no file may grow past 40 KB: the database cannot take more. statfs reports what a full disk would (nothing
    // free): SQLite says only "disk I/O error" for a write past the limit, which counts as a full disk only then.
    s = startServer(data, port, 40, { HELM_DISK_FAKE_FREE: '0' });
    const health = await waitHealthy(port, s.exited, s.log);
    assert.equal(health.ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200, 'the UI is served');

    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    // Write until the database refuses (the first few may fit in what the limit leaves).
    let failed = false;
    for (let i = 0; i < 300 && !failed; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/push/settings`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ muted: i % 2 === 0, quiet: { start: '22:00', end: `0${i % 10}:00`, tz: 'UTC' } }) });
      failed = r.status >= 500;
    }
    assert.ok(failed, `no write failed under the size limit:\n${s.log()}`);

    const after = await waitHealthy(port, s.exited, s.log);
    assert.equal(after.disk?.level, 'critical', 'health reports the full disk');
    assert.equal(after.disk?.full, true);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/disk/status`, { headers: { cookie } })).json();
    assert.ok(status.full, 'the banner has what it needs');
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200, 'still serving');
    assert.equal(readFileSync(join(data, 'config.json'), 'utf8'), config, 'config.json is untouched');
    assert.deepEqual(readdirSync(data).filter((f) => f.endsWith('.tmp')), [], 'no temporary files left');

    s.child.kill('SIGTERM');
    await s.exited;
  } finally {
    if (s && s.child.exitCode === null) {
      s.child.kill('SIGKILL');
      await s.exited;
    }
    rmSync(data, { recursive: true, force: true });
  }
});


test('sweepTemporaries removes only our own leftovers older than an hour', async () => {
  const { sweepTemporaries } = await import('./safefs.ts');
  const { utimesSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(SCRATCH, 'sweep-'));
  mkdirSync(join(dir, 'live'));
  const old = Date.now() / 1000 - 7200;
  const files = { oldOurs: join(dir, 'live', '.status.json.123.ab12cd.tmp'), newOurs: join(dir, '.config.json.9.zz.tmp'), oldOther: join(dir, 'notes.tmp'), oldDot: join(dir, '.cache.tmp') };
  for (const f of Object.values(files)) writeFileSync(f, 'x');
  for (const f of [files.oldOurs, files.oldOther, files.oldDot]) utimesSync(f, old, old);
  assert.equal(sweepTemporaries(dir), 1);
  assert.ok(!existsSync(files.oldOurs));
  assert.ok(existsSync(files.newOurs) && existsSync(files.oldOther) && existsSync(files.oldDot));
});
