import { readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_DIR } from './config.ts';

// Imports nothing that opens the database: main.ts takes the lock before anything does, so a second runner never
// touches it, and taking it needs no space on the disk.

/**
 * Take $HELM_DATA/runner.lock for the life of this process (runner and all modes). Two runners on one database would
 * both drive the same agents, and the second's recoverOnBoot would mark the first's agents interrupted.
 *
 * The lock is a symlink whose target is the holder's pid: creating it is atomic and exclusive, and it needs no data
 * block, so it works on a full disk (a file with the pid written into it does not). A lock whose process is gone
 * (killed, crashed) is taken over under a second exclusive symlink, runner.lock.takeover, so two runners starting
 * together over a stale lock cannot both win. Returns an error message when another runner holds it.
 */
export function takeRunnerLock(): string | null {
  const file = join(DATA_DIR, 'runner.lock');
  const takeover = `${file}.takeover`;
  const mine = String(process.pid);
  const held = () => {
    process.on('exit', () => {
      if (holderOf(file) === process.pid) rmSync(file, { force: true });
    });
    return null;
  };
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      symlinkSync(mine, file);
      return held();
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return `Cannot create ${file}: ${err?.message ?? err}`;
    }
    const holder = holderOf(file);
    if (holder === 0) continue; // removed meanwhile
    if (holder > 0 && holder !== process.pid && helmFor(holder)) {
      return `Another Helm runner (pid ${holder}) already runs agents for ${DATA_DIR} (${file}). Stop it first; two runners would both drive the same agents.`;
    }
    // Its process is gone. One starter at a time takes it over.
    try {
      symlinkSync(mine, takeover);
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return `Cannot create ${takeover}: ${err?.message ?? err}`;
      const other = holderOf(takeover);
      // A takeover by a process that is gone (it crashed in the middle): clear it. Renamed aside first, which only one
      // starter can do to that link; if what was moved turns out to belong to a live process (it was replaced in the
      // meantime), it is put back.
      if (other <= 0 || (other !== process.pid && !helmFor(other))) clearStaleTakeover(takeover, other);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      continue;
    }
    try {
      // Still the same stale lock (no one took it over before we held the takeover): replace it with ours.
      if (holderOf(file) === holder) {
        rmSync(file, { force: true });
        symlinkSync(mine, file);
        return held();
      }
    } catch {
      // Someone created it in between: the next attempt sees theirs.
    } finally {
      if (holderOf(takeover) === process.pid) rmSync(takeover, { force: true });
    }
  }
  return `Could not take ${file}.`;
}

/**
 * Clear a takeover link left by a process that is gone (`seen`: the holder found in it). It is renamed aside first,
 * which only one starter can do to that link; if what was moved turns out to belong to a live process (it was replaced
 * between the look and the rename), it is put back. Exported for the tests.
 */
export function clearStaleTakeover(takeover: string, seen: number) {
  const aside = `${takeover}.stale.${process.pid}.${Date.now()}`;
  try {
    renameSync(takeover, aside);
  } catch {
    return; // gone, or moved by another starter meanwhile
  }
  const moved = holderOf(aside);
  if (moved > 0 && moved !== seen && (moved === process.pid || helmFor(moved))) {
    try {
      symlinkSync(String(moved), takeover);
    } catch {
      // Another takeover exists by now: it stands.
    }
  }
  rmSync(aside, { force: true });
}

/** The pid a lock link names; 0 when there is none, -1 when it cannot be read. */
function holderOf(path: string): number {
  try {
    return Number(readlinkSync(path));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    // Not a symlink (written by an older build): its content is the pid.
    try {
      return Number(readFileSync(path, 'utf8').trim()) || -1;
    } catch {
      return -1;
    }
  }
}

/**
 * Process `pid` is a Helm server (server/main.ts, not the web half) for this data directory, or might be: whatever
 * cannot be told counts as yes, so a live runner's lock is never taken over. Its data directory is worked out as
 * config.ts does: HELM_DATA (relative to its working folder), else ~/.helm under its HOME.
 */
export function helmFor(pid: number): boolean {
  let args: string[];
  try {
    args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    // No such process; or no /proc (or not ours to read), where a live pid is all we can check.
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === 'EPERM';
    }
  }
  if (!args.some((a) => a.endsWith('server/main.ts')) || args.includes('web')) return false;
  let env: string[];
  let cwd: string;
  try {
    env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return true; // a Helm server whose environment cannot be read: maybe ours
  }
  const value = (k: string) => env.find((e) => e.startsWith(`${k}=`))?.slice(k.length + 1) ?? '';
  const data = value('HELM_DATA');
  if (data) return resolve(cwd, data) === DATA_DIR;
  const home = value('HOME');
  if (!home) return true; // its default comes from the account's home, which we do not read: maybe ours
  return resolve(cwd, home, '.helm') === DATA_DIR;
}
