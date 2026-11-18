import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiskLevel, Filesystem } from './disk.ts';

/** The disk guard's thresholds and what happens at each level (server/disk.ts), against a scratch database. */

const db = await import('./db.ts');
const disk = await import('./disk.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const { startLiveUpdate } = await import('./liveupdate.ts');

const GB = 1e9;
const S = disk.DEFAULT_DISK_SETTINGS;

test('thresholds: the smaller of the percentage and the absolute size', () => {
  // 1 TB: 15% would be 150 GB, so 40 GB decides; 5% would be 50 GB, so 10 GB decides.
  assert.deepEqual(disk.thresholds(1000 * GB, S), { warning: 40 * GB, critical: 10 * GB });
  // 64 GB: the percentages decide (9.6 GB and 3.2 GB), or a small disk would always warn.
  const small = disk.thresholds(64 * GB, S);
  assert.ok(Math.abs(small.warning - 9.6 * GB) < 1 && Math.abs(small.critical - 3.2 * GB) < 1);
});

test('levelFor, with a 10% margin before a level is left', () => {
  const size = 1000 * GB;
  const cases: [number, DiskLevel, DiskLevel][] = [
    [100, 'ok', 'ok'],
    [41, 'ok', 'ok'],
    [39.9, 'ok', 'warning'],
    [9.9, 'ok', 'critical'],
    [9.9, 'warning', 'critical'],
    [10.5, 'critical', 'critical'], // within 10% of the critical line: stays
    [11.5, 'critical', 'warning'],
    [41, 'warning', 'warning'], // within 10% of the warning line
    [45, 'warning', 'ok'],
    [45, 'critical', 'ok'],
    [0, 'ok', 'critical'],
  ];
  for (const [freeGB, prev, want] of cases) assert.equal(disk.levelFor(freeGB * GB, size, S, prev), want, `${freeGB} GB after ${prev}`);
});

test('settings are validated', () => {
  assert.match(disk.saveDiskSettings({ warnGB: -1 }) ?? '', /0 or more/);
  assert.match(disk.saveDiskSettings({ criticalGB: 50 }) ?? '', /below the warning/);
  assert.match(disk.saveDiskSettings({ warnPercent: 95 }) ?? '', /above 90/);
  assert.match(disk.saveDiskSettings({ warnGB: 'x' }) ?? '', /number/);
  assert.equal(disk.saveDiskSettings({ warnGB: 60, criticalGB: 15 }), null);
  assert.deepEqual(disk.getDiskSettings(), { ...S, warnGB: 60, criticalGB: 15 });
  assert.equal(disk.saveDiskSettings(S), null);
});

test('HELM_DISK_FAKE_FREE sets what every watched filesystem has free', () => {
  process.env.HELM_DISK_FAKE_FREE = '5G';
  try {
    const fs = disk.sample([]);
    assert.ok(fs.length >= 1);
    assert.ok(fs.every((f) => f.free === 5 * GB && f.level === 'critical'));
    assert.ok(fs.some((f) => f.holds.some((h) => h.path === SCRATCH)), 'Helm data is watched');
  } finally {
    delete process.env.HELM_DISK_FAKE_FREE;
  }
});

function makeProject(name: string) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), Date.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  return { project, director: runtime.rootAgent(project) };
}

const fsAt = (freeGB: number, level: DiskLevel): Filesystem => ({ dev: 1, holds: [{ label: 'Helm data', path: SCRATCH }], size: 1000 * GB, free: freeGB * GB, level, warning: 40 * GB, critical: 10 * GB });

test('warning files one to-do; critical notifies, tells directors and refuses new agents; recovery lifts it', async () => {
  const a = makeProject('Alpha');
  makeProject('Beta');
  const requests: { projectId: string; title: string; body: string; steps: string; id: string }[] = [];
  const open = new Set<string>();
  const told: { projectId: string; text: string }[] = [];
  const pushes: string[] = [];
  disk.setGuardHooks({
    tellDirector: async (projectId, text) => void told.push({ projectId, text }),
    fileRequest: (projectId, title, body, steps) => {
      const id = `req${requests.length}`;
      requests.push({ projectId, title, body, steps, id });
      open.add(id);
      return id;
    },
    requestOpen: (id) => open.has(id),
    notify: (title) => void pushes.push(title),
    biggest: () => ({ lines: ['Alpha build folders: 300 GB'], projectId: a.project.id }),
  });
  const at = async (freeGB: number, level: DiskLevel) => {
    disk._internal.setCurrent([fsAt(freeGB, level)]);
    await disk.onLevel(disk.diskLevel());
  };

  await at(30, 'warning');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].projectId, a.project.id, 'filed where most of the space goes');
  assert.match(requests[0].title, /30\.0 GB left/);
  assert.match(requests[0].body, /Alpha build folders: 300 GB/);
  assert.match(requests[0].steps, /^1\. /);
  await at(28, 'warning');
  assert.equal(requests.length, 1, 'not repeated');
  await at(50, 'ok');
  await at(30, 'warning');
  assert.equal(requests.length, 1, 'not filed again while the first is open');
  assert.equal(disk.refusal('new agents'), null, 'warning does not refuse anything');

  await at(5, 'critical');
  assert.deepEqual(pushes, ['Disk nearly full']);
  assert.deepEqual(told.map((t) => t.projectId).sort(), [a.project.id, db.get("SELECT id FROM projects WHERE name = 'Beta'")!.id].sort());
  assert.match(told[0].text, /stop builds/);
  assert.match(disk.refusal('new agents') ?? '', /disk is nearly full \(5\.0 GB free of 1000 GB/);
  const refused = await runtime.runtimeApi.spawn(a.director, defaultStructure().roles.find((r) => r.id !== defaultStructure().root)!.id, 'Builder', 'Build it.');
  assert.equal(typeof refused, 'string');
  assert.match(refused as string, /^Not started: the disk is nearly full/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM agents WHERE name = 'Builder'")!.n, 0);
  const health = disk.healthDisk();
  assert.deepEqual(health, { level: 'critical', full: false }, 'no sizes without sign-in');
  await at(4, 'critical');
  assert.equal(pushes.length, 1, 'one notification per episode');
  assert.equal(told.length, 2);

  told.length = 0;
  await at(60, 'ok');
  assert.equal(told.length, 2);
  assert.match(told[0].text, /back above the critical level/);
  assert.equal(disk.refusal('new agents'), null);

  // Answered: the next time space runs low, a new to-do.
  open.clear();
  await at(30, 'warning');
  assert.equal(requests.length, 2);
  await at(100, 'ok');
});

test('live-update builds are refused at critical', async () => {
  disk._internal.setCurrent([fsAt(1, 'critical')]);
  // Live update is not enabled in tests, which is checked first; the refusal itself is the same function.
  assert.match((await startLiveUpdate('update')) ?? '', /not enabled|disk is nearly full/);
  assert.match(disk.refusal('live-update builds') ?? '', /live-update builds/);
  disk._internal.setCurrent([]);
});

test('straight from ok to critical: one push, the to-do filed without its own; each step survives the others failing', async () => {
  disk._internal.setCurrent([]);
  await disk.onLevel('ok');
  const pushes: string[] = [];
  const filed: boolean[] = [];
  const told: string[] = [];
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  let failRequests = true;
  disk.setGuardHooks({
    tellDirector: async (pid) => void told.push(pid),
    fileRequest: (_p, _t, _b, _s, silent) => {
      if (failRequests) throw enospc();
      filed.push(silent);
      return 'reqX';
    },
    requestOpen: () => false,
    notify: (title) => void pushes.push(title),
    biggest: () => {
      throw enospc();
    },
  });
  disk._internal.setCurrent([fsAt(2, 'critical')]);
  await disk.onLevel('critical');
  assert.deepEqual(pushes, ['Disk nearly full'], 'the push goes out although the to-do could not be filed');
  assert.ok(told.length >= 1, 'directors are told although the to-do failed');
  // Still critical, and the episode never reached the database: the one in memory keeps it from repeating.
  db.run("DELETE FROM disk_state WHERE key = 'episode'");
  await disk.onLevel('critical');
  assert.equal(pushes.length, 1);
  // After a restart (memory gone) and recovery, the next episode files the to-do silently.
  disk._internal.forgetEpisode();
  db.run("DELETE FROM disk_state WHERE key = 'episode'");
  told.length = 0;
  failRequests = false;
  disk._internal.setCurrent([fsAt(60, 'ok')]);
  await disk.onLevel('ok');
  disk._internal.setCurrent([fsAt(2, 'critical')]);
  await disk.onLevel('critical');
  assert.deepEqual(filed, [true], 'filed silently: the critical push is the one notification');
  assert.equal(pushes.length, 2);
  disk._internal.setCurrent([fsAt(100, 'ok')]);
  await disk.onLevel('ok');
  disk._internal.setCurrent([]);
});

test('an SQLite I/O error counts as a full disk only when free space is at or near critical', async () => {
  const { isDiskFull } = await import('./safefs.ts');
  const ioerr = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 778, errstr: 'disk I/O error' });
  disk._internal.setCurrent([fsAt(500, 'ok')]);
  assert.equal(isDiskFull(ioerr), false, 'plenty of space: real damage stays loud');
  disk._internal.setCurrent([fsAt(14, 'warning')]);
  assert.equal(isDiskFull(ioerr), true, 'near critical (under 1.5 times the critical level)');
  disk._internal.setCurrent([]);
});
