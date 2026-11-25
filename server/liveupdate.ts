import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, rmSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { APP_ROOT, DATA_DIR } from './config.ts';
import { all } from './db.ts';
import { getAgent } from './store.ts';
import { writeFileAtomic } from './safefs.ts';
import { refusal } from './disk.ts';

// Live update (services.helm.liveUpdate in nix/module.nix): the dashboard shows the running revision and what the
// release branch would bring, starts helm-update.service / helm-rollback.service, and reads the stages that
// nix/live-update.sh writes to <dir>/status.json. Agents a planned update interrupts are resumed once the new
// server is reported healthy (recordPlannedRestart on the way down, resumeAfterUpdate on the way up).

const exec = promisify(execFile);

export type Version = { rev: string; shortRev: string; lastModified: number };

/** The revision this server was built from (nix/package.nix writes version.json); "dev" from a checkout. */
export const VERSION: Version = (() => {
  try {
    const v = JSON.parse(readFileSync(join(APP_ROOT, 'version.json'), 'utf8'));
    return { rev: String(v.rev ?? 'unknown'), shortRev: String(v.shortRev ?? 'unknown'), lastModified: Number(v.lastModified ?? 0) };
  } catch {
    return { rev: 'dev', shortRev: 'dev', lastModified: 0 };
  }
})();

const env = process.env;
export const LIVE = {
  /** Set by the module when liveUpdate is on. */
  repo: env.HELM_LIVE_UPDATE_REPO ?? '',
  ref: env.HELM_LIVE_UPDATE_REF || 'release',
  dir: resolve(env.HELM_LIVE_UPDATE_DIR || join(DATA_DIR, 'live')),
  updateUnit: env.HELM_LIVE_UPDATE_UPDATE_UNIT || 'helm-update.service',
  rollbackUnit: env.HELM_LIVE_UPDATE_ROLLBACK_UNIT || 'helm-rollback.service',
  /** Restarts the runner once agents are idle, to apply a changed system configuration (split only). */
  restartUnit: env.HELM_LIVE_UPDATE_RESTART_UNIT || 'helm-restart-agents.service',
  /** Replaces the one-process Helm a system rebuild left running with the two services (split only). */
  adoptUnit: env.HELM_LIVE_UPDATE_ADOPT_UNIT || 'helm-split-adopt.service',
  /** The web service's unit: when it exists while this Helm runs as one process, the switch to two is still to do. */
  webUnit: env.HELM_LIVE_UPDATE_WEB_UNIT || 'helm-web.service',
  /** "user" for a scratch instance whose units are in the user's systemd manager (testing). */
  userScope: env.HELM_LIVE_UPDATE_SCOPE === 'user',
};
export const liveUpdateEnabled = () => !!LIVE.repo;

/**
 * Whether this process may write in LIVE.dir (status, resume list) or start the update units. Never under test
 * (NODE_ENV=test, set by server/testenv.ts), and only when the directory is inside this server's own HELM_DATA: an agent's
 * shell inherits the live server's environment, so a scratch server or a test that sets only HELM_DATA would otherwise
 * read and write the live server's update state.
 */
export function liveWritable(): boolean {
  return process.env.NODE_ENV !== 'test' && liveOwned();
}

/** LIVE.dir is inside this server's HELM_DATA: its update state is this server's own (reading it is then fine). */
export function liveOwned(): boolean {
  const rel = relative(DATA_DIR, LIVE.dir);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export type UpdateStatus = {
  id: string;
  kind: 'update' | 'rollback' | 'restart-runner' | 'adopt';
  stage: string;
  /** Split: 'keep' (the update leaves agents working), 'restart' (it restarts the runner), '' (not known or not split). */
  agents?: string;
  message: string;
  log: string;
  fromRev: string;
  toRev: string;
  startedAt: number;
  updatedAt: number;
  /** Split: when the run began waiting for agents to be idle (ms), 0 when it has not. */
  waitingSince?: number;
};

/**
 * The runner's files in this build (server/closure.ts, written by nix/package.nix); null from a checkout. An update
 * that changes none of them leaves the runner alone when Helm runs split.
 */
const RUNNER_FILES: string[] | null = (() => {
  try {
    return JSON.parse(readFileSync(join(APP_ROOT, 'runner.json'), 'utf8')).files ?? null;
  } catch {
    return null;
  }
})();

/** This build's runner hash (runner.json); '' from a checkout. */
const OWN_RUNNER_HASH: string = (() => {
  try {
    return String(JSON.parse(readFileSync(join(APP_ROOT, 'runner.json'), 'utf8')).hash ?? '');
  } catch {
    return '';
  }
})();

/** What versionInfo needs to know about the runner (server/runner.ts runnerStatus). */
export type RunnerView = { mode: string; up: boolean; rev: string; hash: string; working: number; stamp: string };

let lagCache: { key: string; value: { commits: number | null; committedAt: number | null } } | null = null;
/**
 * How far the runner's build is behind this web service's: commits between them and when the runner's was committed.
 * Repeated web-only updates leave the runner on an old build; the Helm page shows this and offers to restart it.
 */
async function runnerLag(runnerRev: string): Promise<{ commits: number | null; committedAt: number | null }> {
  const key = `${runnerRev}..${VERSION.rev}`;
  if (lagCache?.key === key) return lagCache.value;
  let value: { commits: number | null; committedAt: number | null } = { commits: null, committedAt: null };
  if (LIVE.repo && /^[0-9a-f]{40}$/.test(runnerRev) && /^[0-9a-f]{40}$/.test(VERSION.rev)) {
    try {
      value = {
        commits: Number(await git('rev-list', '--count', `${runnerRev}..${VERSION.rev}`, '--')),
        committedAt: Number(await git('log', '-1', '--format=%ct', runnerRev, '--')) * 1000,
      };
    } catch {
      // Not in the repository: shown without the count.
    }
  }
  lagCache = { key, value };
  return value;
}

/** Stages after which nothing more happens. */
const FINAL = ['healthy', 'unchanged', 'failed', 'rolled-back', 'superseded', 'cancelled'];
/** A run waiting for idle agents rewrites its status every minute: silent for this long, it is gone (a reboot). */
const WAITING_STALE_MS = 3 * 60 * 1000;
/** A run that has said nothing for this long is treated as dead (the unit was killed, the machine rebooted). */
const STALE_MS = 70 * 60 * 1000;

export function readStatus(): UpdateStatus | null {
  try {
    return JSON.parse(readFileSync(join(LIVE.dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(s: UpdateStatus) {
  if (!liveWritable()) throw new Error(`Refusing to write ${LIVE.dir}: it is not inside this server's data directory (${DATA_DIR}), or this is a test.`);
  mkdirSync(LIVE.dir, { recursive: true });
  writeFileAtomic(join(LIVE.dir, 'status.json'), JSON.stringify(s) + '\n');
}

export function inProgress(s: UpdateStatus | null): boolean {
  return !!s && !FINAL.includes(s.stage) && Date.now() - s.updatedAt < (s.stage === 'waiting' ? WAITING_STALE_MS : STALE_MS);
}

/**
 * A run waiting for idle agents gives way to a new Update or Roll back (Cancel): it ends as "superseded" when it sees
 * the supersede file (nix/live-update.sh), leaving the new dashboard in place, and the new run starts from there.
 * Waits up to 20 s for it to end. Returns an error when it does not.
 */
let unitCheck = (unit: string) => unitRunning(unit);
/** Tests: stand in for systemctl. */
export const _internal = {
  setUnitCheck: (fn: (unit: string) => Promise<boolean>) => (unitCheck = fn),
  endWaitingRun,
};

/** The unit is starting, running or stopping (a oneshot run is "activating" while it runs). */
async function unitRunning(unit: string): Promise<boolean> {
  try {
    const r = await exec('systemctl', [...(LIVE.userScope ? ['--user'] : []), 'is-active', unit], { timeout: 5000 });
    return /^(active|activating|deactivating|reloading)/.test(r.stdout.trim());
  } catch (err: any) {
    return /^(activating|deactivating|reloading)/.test(String(err?.stdout ?? '').trim());
  }
}

async function supersedeWaiting(): Promise<string | null> {
  const s = readStatus();
  if (!inProgress(s) || s!.stage !== 'waiting') return null;
  return endWaitingRun(s!, 'supersede');
}

/**
 * Ask the waiting run to end (nix/live-update.sh wait_for_idle: `supersede` for an update's wait, `cancel-wait` for a
 * restart-runner or adopt wait) and wait until it has: its status left 'waiting' and its unit has exited (starting a
 * unit while it still exits merges into that job and does nothing, and the run holds the update lock until it exits).
 * Changes nothing and returns an error when it has not ended within about 30 s.
 */
async function endWaitingRun(s: UpdateStatus, signal: 'supersede' | 'cancel-wait', tries = 120): Promise<string | null> {
  writeFileAtomic(join(LIVE.dir, signal), String(Date.now()) + '\n');
  const units = [LIVE.updateUnit, LIVE.restartUnit, LIVE.adoptUnit];
  const anyRunning = async () => {
    for (const u of units) if (await unitCheck(u)) return true;
    return false;
  };
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const now = readStatus();
    const ended = !now || now.id !== s.id || now.stage !== 'waiting';
    if (ended && !(await anyRunning())) return null;
  }
  rmSync(join(LIVE.dir, signal), { force: true });
  return 'The run waiting for idle agents did not end; nothing was changed. Try again in a moment.';
}

/**
 * "Don't restart": end a restart-runner or adopt run that waits for idle agents. Nothing is rolled back: the runner
 * (or, for adopt, the one-process Helm) keeps running as it is.
 */
export async function endWait(): Promise<string | null> {
  if (!liveUpdateEnabled()) return 'Live update is not enabled (services.helm.liveUpdate).';
  if (!liveWritable()) return `This server's live update directory (${LIVE.dir}) is not inside its data directory (${DATA_DIR}).`;
  const s = readStatus();
  if (!inProgress(s) || s!.stage !== 'waiting') return 'Nothing is waiting for idle agents.';
  if (s!.kind === 'update') return 'An update is waiting: use Cancel update, which puts the dashboard back on the build agents run.';
  return endWaitingRun(s!, 'cancel-wait');
}

function revOfBuild(link: string): string | null {
  try {
    const target = resolve(LIVE.dir, readlinkSync(link));
    return JSON.parse(readFileSync(join(target, 'lib', 'helm', 'version.json'), 'utf8')).rev ?? null;
  } catch {
    return null;
  }
}

const git = async (...args: string[]) => (await exec('git', ['-C', LIVE.repo, ...args], { timeout: 10_000, maxBuffer: 1 << 20 })).stdout.trim();

type Commit = { rev: string; shortRev: string; date: number; subject: string };
const parseLog = (out: string): Commit[] =>
  out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [rev, shortRev, date, subject] = line.split('\x1f');
      return { rev, shortRev, date: Number(date), subject };
    });

let availableCache: { at: number; key: string; value: Awaited<ReturnType<typeof readAvailable>> } | null = null;

/** What the release ref holds and the commits between the running revision and it. Read-only git in the repo. */
async function readAvailable(runnerRev: string | null) {
  const head = parseLog(await git('log', '-1', '--format=%H%x1f%h%x1f%ct%x1f%s', `${LIVE.ref}^{commit}`, '--'))[0];
  // Whether the update would restart the runner: a file of the runner's changed between the runner's revision and the
  // release (or a new file under server/, which a runner file may import). Null when it cannot be told. The build's
  // hash decides in the end (nix/live-update.sh); this is the forecast the panel shows before pressing Update.
  let restartsAgents: boolean | null = null;
  const base = runnerRev?.replace(/-dirty$/, '');
  if (RUNNER_FILES && base && /^[0-9a-f]{40}$/.test(base)) {
    try {
      const changed = (await git('diff', '--name-only', '--diff-filter=ACDMR', base, head.rev, '--')).split('\n').filter(Boolean);
      const added = (await git('diff', '--name-only', '--diff-filter=A', base, head.rev, '--', 'server')).split('\n').filter(Boolean);
      restartsAgents = changed.some((f) => RUNNER_FILES.includes(f)) || added.some((f) => !/\.test\.ts$|^server\/checks\//.test(f));
    } catch {
      restartsAgents = null;
    }
  }
  const running = VERSION.rev.replace(/-dirty$/, '');
  let commits: Commit[] | null = null;
  let behind = 0;
  if (/^[0-9a-f]{40}$/.test(running)) {
    try {
      await git('cat-file', '-e', `${running}^{commit}`);
      commits = parseLog(await git('log', '--max-count=50', '--format=%H%x1f%h%x1f%ct%x1f%s', `${running}..${head.rev}`, '--'));
      // Commits the running build has that the release branch no longer does (the branch was moved back).
      behind = Number(await git('rev-list', '--count', `${head.rev}..${running}`, '--'));
    } catch {
      commits = null;
    }
  }
  return { head, commits, behind, restartsAgents };
}

/** `runner`: the process that runs agents. Split, it may run an older build than this web service. */
export async function versionInfo(runner: RunnerView) {
  let available = null;
  let error: string | null = null;
  const split = runner.mode === 'web';
  if (liveUpdateEnabled()) {
    try {
      const key = split ? runner.rev : VERSION.rev;
      if (!availableCache || Date.now() - availableCache.at > 10_000 || availableCache.key !== key) availableCache = { at: Date.now(), key, value: await readAvailable(split ? runner.rev : null) };
      available = availableCache.value;
    } catch (err: any) {
      error = `Could not read ${LIVE.ref} in ${LIVE.repo}: ${String(err?.stderr || err?.message || err).trim().slice(0, 300)}`;
    }
  }
  const working = all(
    "SELECT agents.project_id FROM agents JOIN projects ON projects.id = agents.project_id WHERE agents.status IN ('working', 'waiting') AND projects.archived = 0",
  );
  const status = readStatus();
  return {
    running: VERSION,
    liveUpdate: liveUpdateEnabled() ? { ref: LIVE.ref, repo: LIVE.repo } : null,
    available: available?.head ?? null,
    commits: available?.commits ?? null,
    behind: available?.behind ?? 0,
    error,
    status,
    busy: inProgress(status),
    previous: previousRev(split),
    working: { agents: working.length, projects: new Set(working.map((w) => w.project_id)).size },
    /**
     * Helm runs as one process while the system already defines the two services (the first deploy's switch was not
     * done: "Don't restart", or it was cut short): the Helm page offers to switch now. An Update does it too.
     */
    oneProcess: runner.mode === 'all' && liveUpdateEnabled() && (await webUnitDefined()),
    /**
     * Split only (server/runner.ts): the runner's revision and whether it is up; whether the available update restarts
     * it (null: cannot tell); and whether the system configuration changed since it started (it is not restarted by a
     * system rebuild, so agents keep working; the change applies at its next restart).
     */
    split: split
      ? {
          runner: {
            rev: runner.rev,
            up: runner.up,
            working: runner.working,
            // Its code differs from the dashboard's: it runs an older build (web-only updates since it started).
            behind: !!runner.hash && !!OWN_RUNNER_HASH && runner.hash !== OWN_RUNNER_HASH,
            ...(await runnerLag(runner.rev)),
          },
          restartsAgents: available?.restartsAgents ?? null,
          configPending: !!runner.up && !!process.env.HELM_UNIT_STAMP && runner.stamp !== process.env.HELM_UNIT_STAMP,
        }
      : null,
  };
}

/** What Roll back goes to: split, after an update that changed only the dashboard, the dashboard's previous build. */
function previousRev(split: boolean): string | null {
  const webOnly = split && readText(join(LIVE.dir, 'last-kind')) === 'web' && existsSync(join(LIVE.dir, 'web-previous'));
  const link = join(LIVE.dir, webOnly ? 'web-previous' : 'previous');
  return existsSync(link) ? (revOfBuild(link) ?? 'unknown') : null;
}

function readText(f: string): string {
  try {
    return readFileSync(f, 'utf8').trim();
  } catch {
    return '';
  }
}

let webUnitCache: { at: number; value: boolean } | null = null;
/** The web service's unit is defined in this systemd (the system was rebuilt with services.helm.split). */
async function webUnitDefined(): Promise<boolean> {
  if (webUnitCache && Date.now() - webUnitCache.at < 30_000) return webUnitCache.value;
  let value = false;
  try {
    const r = await exec('systemctl', [...(LIVE.userScope ? ['--user'] : []), 'show', '-p', 'LoadState', '--value', LIVE.webUnit], { timeout: 5000 });
    value = r.stdout.trim() === 'loaded';
  } catch {
    value = false;
  }
  webUnitCache = { at: Date.now(), value };
  return value;
}

/**
 * "Switch to two services now": start the adopt run (nix/live-update.sh adopt), which replaces this one-process Helm
 * with the runner and the web service once no agent is mid-turn (Restart agents now and Don't restart as usual).
 */
export async function startAdopt(): Promise<string | null> {
  if (!liveUpdateEnabled()) return 'Live update is not enabled (services.helm.liveUpdate).';
  if (!liveWritable()) return `This server's live update directory (${LIVE.dir}) is not inside its data directory (${DATA_DIR}).`;
  if (inProgress(readStatus())) return 'An update is running; wait for it to finish.';
  if (!(await webUnitDefined())) return "The system does not define Helm's web service yet: rebuild it with services.helm.split first.";
  const st: UpdateStatus = { id: String(Date.now()), kind: 'adopt', stage: 'requested', message: 'Switch to a runner and a web service requested', log: '', fromRev: VERSION.rev, toRev: VERSION.rev, startedAt: Date.now(), updatedAt: Date.now() };
  writeStatus(st);
  try {
    await exec('systemctl', [...(LIVE.userScope ? ['--user'] : []), 'start', '--no-block', LIVE.adoptUnit], { timeout: 15_000 });
  } catch (err: any) {
    const message = `systemctl start ${LIVE.adoptUnit} failed: ${String(err?.stderr || err?.message || err).trim().slice(0, 400)}`;
    writeStatus({ ...st, stage: 'failed', message, updatedAt: Date.now() });
    return message;
  }
  return null;
}

/**
 * "Restart agents now" while an update waits for them to be idle (nix/live-update.sh polls for the file), or, with
 * nothing waiting, start the restart that applies a changed system configuration once agents are idle.
 */
export async function restartAgents(): Promise<string | null> {
  if (!liveUpdateEnabled()) return 'Live update is not enabled (services.helm.liveUpdate).';
  if (!liveWritable()) return `This server's live update directory (${LIVE.dir}) is not inside its data directory (${DATA_DIR}).`;
  const s = readStatus();
  if (inProgress(s) && s!.stage === 'waiting') {
    writeFileAtomic(join(LIVE.dir, 'restart-now'), String(Date.now()) + '\n');
    return null;
  }
  if (inProgress(s)) return 'An update is running; wait for it to finish.';
  const st: UpdateStatus = { id: String(Date.now()), kind: 'restart-runner', stage: 'requested', message: 'Restart of the agents requested', log: '', fromRev: VERSION.rev, toRev: VERSION.rev, startedAt: Date.now(), updatedAt: Date.now() };
  writeStatus(st);
  try {
    await exec('systemctl', [...(LIVE.userScope ? ['--user'] : []), 'start', '--no-block', LIVE.restartUnit], { timeout: 15_000 });
  } catch (err: any) {
    const message = `systemctl start ${LIVE.restartUnit} failed: ${String(err?.stderr || err?.message || err).trim().slice(0, 400)}`;
    writeStatus({ ...st, stage: 'failed', message, updatedAt: Date.now() });
    return message;
  }
  return null;
}

/** Start helm-update.service or helm-rollback.service (polkit lets the service user do exactly this). */
export async function startLiveUpdate(kind: 'update' | 'rollback'): Promise<string | null> {
  if (!liveUpdateEnabled()) return 'Live update is not enabled (services.helm.liveUpdate).';
  if (!liveWritable()) return `This server's live update directory (${LIVE.dir}) is not inside its data directory (${DATA_DIR}): it would act on another Helm's update. Unset the HELM_LIVE_UPDATE_ variables.`;
  const waiting = readStatus();
  if (inProgress(waiting) && waiting!.stage !== 'waiting') return 'An update is already running.';
  if (inProgress(waiting) && waiting!.kind === 'adopt') {
    return 'Helm is switching to a runner and a web service once no agent is mid-turn. Update and Roll back are available once it has (or press Restart agents now).';
  }
  if (inProgress(waiting) && waiting!.kind !== 'update') {
    return "Agents are waiting to restart. Press Don't restart first, or Restart agents now, then try again.";
  }
  // Cancel during an update's wait is a rollback: the dashboard goes back to the runner's build (nix/live-update.sh).
  const cancelling = kind === 'rollback' && inProgress(waiting);
  if (kind === 'rollback' && !cancelling && !existsSync(join(LIVE.dir, 'previous'))) return 'There is no previous version to roll back to.';
  // A build needs space; a rollback only switches to a build already there.
  if (kind === 'update') {
    const noSpace = refusal('live-update builds');
    if (noSpace) return noSpace;
  }
  const superseded = await supersedeWaiting();
  if (superseded) return superseded;
  const s: UpdateStatus = {
    id: String(Date.now()),
    kind,
    stage: 'requested',
    message: kind === 'update' ? `Update to ${LIVE.ref} requested` : 'Rollback requested',
    log: '',
    fromRev: VERSION.rev,
    toRev: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeStatus(s);
  const unit = kind === 'update' ? LIVE.updateUnit : LIVE.rollbackUnit;
  try {
    await exec('systemctl', [...(LIVE.userScope ? ['--user'] : []), 'start', '--no-block', unit], { timeout: 15_000 });
  } catch (err: any) {
    const message = `systemctl start ${unit} failed: ${String(err?.stderr || err?.message || err).trim().slice(0, 400)}`;
    writeStatus({ ...s, stage: 'failed', message, updatedAt: Date.now() });
    return message;
  }
  return null;
}

// ---------- agents interrupted by a planned update ----------

const RESUME = () => join(LIVE.dir, 'resume.json');
/** After an orderly stop outside an update, agents are resumed only if Helm is back within this long. */
const STOP_RESUME_MS = 30 * 60 * 1000;

/**
 * Called on SIGTERM before the agents are stopped: remember which agents were mid-turn so the next start resumes them.
 * The restart step of an update or rollback (the script says "restarting") is resumed once the script reports the new
 * server healthy. Any other orderly stop (a system rebuild, a reboot, systemctl restart) is resumed when the runner is
 * next up, if that is within STOP_RESUME_MS. Nothing is recorded during other stages of an update (the switch back
 * from a version that failed its health check), and a crash records nothing (no SIGTERM).
 */
export function recordPlannedRestart() {
  if (!liveWritable()) return;
  const st = readStatus();
  const planned = !!st && st.stage === 'restarting' && Date.now() - st.updatedAt <= 5 * 60 * 1000;
  // A stop while an update waits for idle agents (a reboot, a rebuild) is an orderly stop like any other.
  if (!planned && inProgress(st) && st!.stage !== 'waiting') return;
  const s = planned ? st! : { id: '', kind: 'stop' };
  // Mid-turn, or holding queued input (sendToAgent marks the agent working as soon as a message is queued). Agents
  // waiting on a question the user has not answered are not mid-turn: the answer will wake them as usual.
  const agents = all(
    "SELECT agents.id FROM agents JOIN projects ON projects.id = agents.project_id WHERE projects.archived = 0 AND agents.status IN ('working', 'waiting') AND agents.id NOT IN (SELECT agent_id FROM inbox WHERE status = 'open' AND kind != 'permission' AND blocking = 1 AND agent_id IS NOT NULL)",
  ).map((r) => r.id as string);
  // Agents an earlier stop left to resume that this run has not resumed yet (stopped again within moments): kept.
  try {
    const before = JSON.parse(readFileSync(RESUME(), 'utf8')) as Resume;
    for (const id of before.agents ?? []) if (!agents.includes(id) && getAgent(id)?.status === 'interrupted') agents.push(id);
  } catch {
    // None.
  }
  try {
    mkdirSync(LIVE.dir, { recursive: true });
    writeFileAtomic(RESUME(), JSON.stringify({ statusId: s.id, kind: s.kind, at: Date.now(), agents }) + '\n');
    console.log(planned ? `Planned restart (${s.kind}): ${agents.length} agent(s) to resume once the new server is healthy` : `Stopping: ${agents.length} agent(s) to resume at the next start`);
  } catch (err) {
    console.error('Could not record agents to resume:', err);
  }
}

type Resume = { statusId: string; kind: string; at: number; agents: string[] };

/**
 * On boot: if the last stop was a planned update, wait for the update script to declare this server healthy, then
 * resume the agents it interrupted, a few seconds apart. If the update is rolled back instead, or nothing is heard
 * for a few minutes, the list is dropped and the agents stay Stopped for the user to resume.
 */
export function resumeAfterUpdate(send: (agentId: string, text: string) => Promise<void>, staggerMs = 3000) {
  // Another Helm's resume list (a scratch server that inherited the live environment) is not ours to act on or delete.
  if (!liveWritable()) return;
  let pending: Resume;
  try {
    pending = JSON.parse(readFileSync(RESUME(), 'utf8'));
  } catch {
    return;
  }
  const deadline = Date.now() + 5 * 60 * 1000;
  const drop = (why: string) => {
    rmSync(RESUME(), { force: true });
    console.log(`Not resuming agents after the restart: ${why}`);
  };
  const resume = async (note: string, what: string) => {
    let n = 0;
    for (const id of pending.agents) {
      const a = getAgent(id);
      // Only agents still where the restart left them: not resumed, closed or answered by the user meanwhile.
      if (!a || a.status !== 'interrupted') continue;
      if (n++) await new Promise((r) => setTimeout(r, staggerMs));
      await send(id, note).catch((err) => console.error(`Could not resume ${a.name}:`, err));
    }
    rmSync(RESUME(), { force: true });
    console.log(`Resumed ${n} agent(s) after ${what}`);
  };
  if (pending.kind === 'stop') {
    // An orderly stop outside an update: resume now, unless Helm stayed down so long that the work has moved on. The
    // list is removed once they are resumed, so a stop in the meantime keeps them (recordPlannedRestart merges it).
    if (!pending.agents.length) return drop('no agent was mid-turn');
    if (Date.now() - pending.at > STOP_RESUME_MS) return drop(`it was stopped ${Math.round((Date.now() - pending.at) / 60000)} minutes ago`);
    const note =
      '<helm-note>Helm was stopped and started again (a system update, a reboot or a restart) while you were working, which cut ' +
      'your turn short. Your conversation is intact, but any scratch servers, watchers or other background processes you started ' +
      'are gone. Check your worklist and the state of the files, restart anything you still need, and continue where you left off.</helm-note>';
    setTimeout(() => void resume(note, 'the restart'), staggerMs);
    return;
  }
  const tick = async () => {
    const s = readStatus();
    if (!s || s.id !== pending.statusId) return drop('the update status no longer matches');
    if (s.stage === 'rolled-back' || s.stage === 'failed') return drop(`the ${s.kind} was ${s.stage}`);
    if (s.stage !== 'healthy') {
      if (Date.now() > deadline) return drop(`no healthy report within 5 minutes (last stage: ${s.stage})`);
      setTimeout(() => void tick(), 1000);
      return;
    }
    const what = s.kind === 'rollback' ? `rolled back to ${VERSION.shortRev}` : `updated to ${VERSION.shortRev}`;
    const note =
      `<helm-note>Helm was ${what} and restarted while you were working, which cut your turn short. Your conversation is intact, ` +
      'but any scratch servers, watchers or other background processes you started are gone. Check your worklist and the ' +
      'state of the files, restart anything you still need, and continue where you left off.</helm-note>';
    await resume(note, `the ${s.kind}`);
  };
  void tick();
}
