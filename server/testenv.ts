import { lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Import this first (before any other module of the server) in every test and check script.
 *
 * An agent's shell inherits the live server's environment (HELM_DATA, HELM_LIVE_UPDATE_DIR, HELM_LAN_NO_LOGIN, …), so a
 * test that only overrides HELM_DATA still reads and writes the live server's update state. This deletes every HELM_
 * variable, marks the process as a test (liveupdate.ts then refuses to write its directory), and points Helm at a
 * fresh scratch data directory with no Claude binary. A file that needs other HELM_ settings sets them after
 * importing this and before importing the modules that read them.
 */

for (const k of Object.keys(process.env)) if (k.startsWith('HELM_')) delete process.env[k];
process.env.NODE_ENV = 'test';
// Leftovers of runs that were killed before they could clean up: folders named for a process that is gone, and
// older unnamed ones (from before the name carried the process id) not touched for an hour.
for (const name of readdirSync(tmpdir())) {
  const m = /^helm-test-(?:(\d+)-)?/.exec(name);
  if (!m) continue;
  const dir = join(tmpdir(), name);
  try {
    const gone = m[1] ? !alive(Number(m[1])) : statSync(dir).mtimeMs < Date.now() - 3600_000;
    if (gone && lstatSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
  } catch {}
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const SCRATCH = mkdtempSync(join(tmpdir(), `helm-test-${process.pid}-`));
process.env.HELM_DATA = SCRATCH;
process.env.HELM_CLAUDE_PATH = '/bin/false';

// Nothing a test or check leaves stays in /tmp: the scratch folder (and whatever the test put in it, such as project
// folders) is removed when the process exits. Keep other temporary files inside SCRATCH.
const cleanUp = () => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanUp);
// Stopped from outside (a timeout, Ctrl-C): clean up too, then end as the signal would have.
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.once(sig, () => {
    cleanUp();
    process.exit(code);
  });
}
