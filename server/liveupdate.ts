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
  kind: 'update' | 'rollback';
  stage: string;
  message: string;
  log: string;
  fromRev: string;
  toRev: string;
  startedAt: number;
  updatedAt: number;
};

/** Stages after which nothing more happens. */
const FINAL = ['healthy', 'unchanged', 'failed', 'rolled-back'];
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
  return !!s && !FINAL.includes(s.stage) && Date.now() - s.updatedAt < STALE_MS;
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

let availableCache: { at: number; value: Awaited<ReturnType<typeof readAvailable>> } | null = null;

/** What the release ref holds and the commits between the running revision and it. Read-only git in the repo. */
async function readAvailable() {
  const head = parseLog(await git('log', '-1', '--format=%H%x1f%h%x1f%ct%x1f%s', `${LIVE.ref}^{commit}`, '--'))[0];
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
  return { head, commits, behind };
}

export async function versionInfo() {
  let available = null;
  let error: string | null = null;
  if (liveUpdateEnabled()) {
    try {
      if (!availableCache || Date.now() - availableCache.at > 10_000) availableCache = { at: Date.now(), value: await readAvailable() };
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
    previous: existsSync(join(LIVE.dir, 'previous')) ? (revOfBuild(join(LIVE.dir, 'previous')) ?? 'unknown') : null,
    working: { agents: working.length, projects: new Set(working.map((w) => w.project_id)).size },
  };
}

/** Start helm-update.service or helm-rollback.service (polkit lets the service user do exactly this). */
export async function startLiveUpdate(kind: 'update' | 'rollback'): Promise<string | null> {
  if (!liveUpdateEnabled()) return 'Live update is not enabled (services.helm.liveUpdate).';
  if (!liveWritable()) return `This server's live update directory (${LIVE.dir}) is not inside its data directory (${DATA_DIR}): it would act on another Helm's update. Unset the HELM_LIVE_UPDATE_ variables.`;
  if (inProgress(readStatus())) return 'An update is already running.';
  if (kind === 'rollback' && !existsSync(join(LIVE.dir, 'previous'))) return 'There is no previous version to roll back to.';
  // A build needs space; a rollback only switches to a build already there.
  if (kind === 'update') {
    const noSpace = refusal('live-update builds');
    if (noSpace) return noSpace;
  }
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

/**
 * Called on SIGTERM before the agents are stopped. If the stop is the restart step of an update or rollback (the
 * script says "restarting"), remember which agents were mid-turn so the new server can resume them. Any other stop
 * (a crash, a manual restart, the rollback of a failed update) records nothing.
 */
export function recordPlannedRestart() {
  if (!liveWritable()) return;
  const s = readStatus();
  if (!s || s.stage !== 'restarting' || Date.now() - s.updatedAt > 5 * 60 * 1000) return;
  // Mid-turn, or holding queued input (sendToAgent marks the agent working as soon as a message is queued). Agents
  // waiting on a question the user has not answered are not mid-turn: the answer will wake them as usual.
  const agents = all(
    "SELECT agents.id FROM agents JOIN projects ON projects.id = agents.project_id WHERE projects.archived = 0 AND agents.status IN ('working', 'waiting') AND agents.id NOT IN (SELECT agent_id FROM inbox WHERE status = 'open' AND kind != 'permission' AND blocking = 1 AND agent_id IS NOT NULL)",
  ).map((r) => r.id as string);
  try {
    mkdirSync(LIVE.dir, { recursive: true });
    writeFileAtomic(RESUME(), JSON.stringify({ statusId: s.id, kind: s.kind, at: Date.now(), agents }) + '\n');
    console.log(`Planned restart (${s.kind}): ${agents.length} agent(s) to resume once the new server is healthy`);
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
  const tick = async () => {
    const s = readStatus();
    if (!s || s.id !== pending.statusId) return drop('the update status no longer matches');
    if (s.stage === 'rolled-back' || s.stage === 'failed') return drop(`the ${s.kind} was ${s.stage}`);
    if (s.stage !== 'healthy') {
      if (Date.now() > deadline) return drop(`no healthy report within 5 minutes (last stage: ${s.stage})`);
      setTimeout(() => void tick(), 1000);
      return;
    }
    rmSync(RESUME(), { force: true });
    const what = s.kind === 'rollback' ? `rolled back to ${VERSION.shortRev}` : `updated to ${VERSION.shortRev}`;
    const note =
      `<helm-note>Helm was ${what} and restarted while you were working, which cut your turn short. Your conversation is intact, ` +
      'but any scratch servers, watchers or other background processes you started are gone. Check your worklist and the ' +
      'state of the files, restart anything you still need, and continue where you left off.</helm-note>';
    let n = 0;
    for (const id of pending.agents) {
      const a = getAgent(id);
      // Only agents still where the restart left them: not resumed, closed or answered by the user meanwhile.
      if (!a || a.status !== 'interrupted') continue;
      if (n++) await new Promise((r) => setTimeout(r, staggerMs));
      await send(id, note).catch((err) => console.error(`Could not resume ${a.name}:`, err));
    }
    console.log(`Resumed ${n} agent(s) after the ${s.kind}`);
  };
  void tick();
}
