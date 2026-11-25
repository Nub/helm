import './testenv.ts';
// Host stats collectors (hoststats.ts) on sample outputs: Linux and Windows with and without nvidia-smi, macOS, and
// missing tools giving null ("—" on the page), never an error. `node --test server/hoststats.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseUnixStats, parseWindowsStats, unixScript, windowsScript } = await import('./hoststats.ts');

const LINUX = `@load
6.41 5.30 2.41 14/1041 29128
@cpus
32
@stat
cpu  242115 0 27352 1211270 4013 2359 704 0 0 0
cpu  242211 0 27426 1212739 4014 2362 705 0 0 0
@meminfo
MemTotal:       31933032 kB
MemAvailable:   15526220 kB
@disk
/dev/nvme0n1p2   959783148 697047784 213907300      77% /
@gpu
21, 6608, 10240
`;

test('Linux with nvidia-smi: CPU, load, memory, disk and the GPU', () => {
  const s = parseUnixStats(LINUX);
  assert.equal(s.cpu, 11);
  assert.equal(s.load, '6.41 5.30 2.41');
  assert.equal(s.cpus, 32);
  assert.deepEqual(s.mem, { used: (31933032 - 15526220) * 1024, total: 31933032 * 1024 });
  assert.deepEqual(s.disk, { used: 697047784 * 1024, total: (697047784 + 213907300) * 1024 });
  assert.deepEqual(s.gpus, [{ util: 21, mem: { used: 6608 * 1048576, total: 10240 * 1048576 } }]);
});

test('Linux without nvidia-smi or /proc/stat: no GPUs and no CPU %, the rest still read', () => {
  const s = parseUnixStats(LINUX.replace(/@stat[\s\S]*?@meminfo/, '@stat\n@meminfo').replace(/@gpu\n21, 6608, 10240\n/, '@gpu\n'));
  assert.equal(s.cpu, null);
  assert.deepEqual(s.gpus, []);
  assert.ok(s.mem && s.disk);
});

test('macOS: top idle, memsize and vm_stat pages', () => {
  const s = parseUnixStats(`@load
{ 1.52 1.73 1.80 }
@cpus
10
@topcpu
CPU usage: 7.14% user, 10.71% sys, 82.14% idle
@memsize
17179869184
@vmstat
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            400000.
Pages wired down:                        100000.
Pages occupied by compressor:             50000.
@disk
/dev/disk3s5  482797652 300000000 150000000    67%    /System/Volumes/Data
@gpu
`);
  assert.equal(s.cpu, 18);
  assert.equal(s.load, '1.52 1.73 1.80');
  assert.deepEqual(s.mem, { used: 550000 * 16384, total: 17179869184 });
  assert.deepEqual(s.gpus, []);
});

test('Windows with and without nvidia-smi', () => {
  const out = '@cpu\r\n37\r\n@cpus\r\n16\r\n@mem\r\n33461580 12000000\r\n@disk\r\n1000202039296 400000000000\r\n@gpu\r\n55, 2048, 8192\r\n';
  const s = parseWindowsStats(out);
  assert.equal(s.cpu, 37);
  assert.equal(s.cpus, 16);
  assert.deepEqual(s.mem, { used: (33461580 - 12000000) * 1024, total: 33461580 * 1024 });
  assert.deepEqual(s.disk, { used: 1000202039296 - 400000000000, total: 1000202039296 });
  assert.deepEqual(s.gpus, [{ util: 55, mem: { used: 2048 * 1048576, total: 8192 * 1048576 } }]);
  assert.deepEqual(parseWindowsStats(out.replace('55, 2048, 8192\r\n', '')).gpus, []);
});

test('missing tools and garbage give null, never an error', () => {
  for (const s of [parseUnixStats(''), parseUnixStats('@load\nnot a load\n@disk\ndf: no such file\n@gpu\nNVIDIA-SMI has failed\n'), parseWindowsStats('@cpu\n\n@mem\n\n')]) {
    assert.equal(s.cpu, null);
    assert.equal(s.mem, null);
    assert.equal(s.disk, null);
    assert.deepEqual(s.gpus, []);
  }
});

test('the collectors: the root path quoted for sh, Windows sent as one encoded PowerShell command', () => {
  assert.match(unixScript("~/work's"), /R="\$HOME"\/'work'\\''s'/);
  assert.match(unixScript(''), /R="\$HOME"/);
  const w = windowsScript('D:\\helm');
  assert.match(w, /^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  const ps = Buffer.from(w.split(' ').at(-1)!, 'base64').toString('utf16le');
  assert.match(ps, /\$drv = 'D:'/);
  assert.match(ps, /nvidia-smi --query-gpu/);
});

test('the page heartbeat samples at most every 15 s, and nothing samples without it', async () => {
  const hosts = await import('./hosts.ts');
  const db = await import('./db.ts');
  const local = hosts.localHost();
  assert.equal(hosts.sampleForPage(), true, 'an open page gets a sample');
  assert.equal(hosts.sampleForPage(), false, 'a second page within the window shares it');
  // The local sample lands (the same Unix collector, run with sh).
  for (let i = 0; i < 50 && !db.get('SELECT stats FROM hosts WHERE id = ?', local.id)?.stats; i++) await new Promise((r) => setTimeout(r, 100));
  const stats = JSON.parse(db.get('SELECT stats FROM hosts WHERE id = ?', local.id)!.stats);
  assert.ok(stats.mem && stats.disk, 'memory and disk read on this machine');
  const at = db.get('SELECT checked_at FROM hosts WHERE id = ?', local.id)!.checked_at;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(db.get('SELECT checked_at FROM hosts WHERE id = ?', local.id)!.checked_at, at, 'no page, no sample: nothing runs on a timer for it');
  hosts.stopHealthChecks();
});
