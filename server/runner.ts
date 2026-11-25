import { readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bindAgentOps, closeAgent, dispatchWork, interruptAgent, liveAgentIds, onLiveChange, resolvePermission, restartForProjects, sendToAgent } from './agents.ts';
import type { AgentOps } from './agents.ts';
import { getAttachment } from './attachments.ts';
import { bus } from './bus.ts';
import type { BusMessage } from './bus.ts';
import { APP_ROOT, DATA_DIR } from './config.ts';
import { all, db, get, now, run, tx } from './db.ts';
import { forwardNotifications, notify } from './notify.ts';
import type { NotifyEvent } from './notify.ts';
import { VERSION } from './liveupdate.ts';
import { processRole, setProcessRole } from './role.ts';
import { helmFor } from './runnerlock.ts';
export { takeRunnerLock } from './runnerlock.ts';
import type { Role } from './role.ts';
import { addEvent, getAgent, getProject } from './store.ts';
import { teamDetails } from './teamview.ts';
import { pollSource } from './reports.ts';
import { SKEW_EPOCH } from './skew.ts';

/**
 * The runner and the web service. One process (`helm all`, the default) runs everything as before. Split, the runner
 * (`helm runner`) holds the agents and every timer, and the web service (`helm web`) serves the dashboard, so an update
 * that changes only the web side restarts only the web service and agents keep working.
 *
 * They share the database and talk only through it:
 * - runner_commands: what the web service asks of agents (send a message, stop, close, a permission answer, a
 *   Toolbox change, a phone notification). Durable: asked while the runner restarts, done when it is back.
 * - bus_log: the runner's live-update messages (server/bus.ts), which the web service passes on to browsers.
 * - runner_state: the runner's heartbeat, build and the agents it holds.
 * Each side notices the other's commits through PRAGMA data_version, which changes only when another connection has
 * committed, so polling it every POLL_MS costs next to nothing while nothing happens.
 *
 * PROTOCOL: the commands and messages below. A web service may be one version newer than its runner (it restarts
 * first in an update); a runner leaves commands it does not know queued for the next runner, which will.
 */
export const PROTOCOL = 1;
const POLL_MS = Number(process.env.HELM_RUNNER_POLL_MS ?? 100);
const BEAT_MS = 5000;
/** A heartbeat older than this means the runner is not running. */
export const RUNNER_STALE_MS = 15_000;
const BUS_KEEP_MS = 10 * 60 * 1000;
const COMMANDS_KEEP_MS = 24 * 60 * 60 * 1000;

export type { Role } from './role.ts';
export { processRole } from './role.ts';
const role = () => processRole();

/** What the build says about the runner's code (nix/package.nix writes runner.json); empty from a checkout. */
export const RUNNER_BUILD: { hash: string } = (() => {
  try {
    return { hash: String(JSON.parse(readFileSync(join(APP_ROOT, 'runner.json'), 'utf8')).hash ?? '') };
  } catch {
    return { hash: '' };
  }
})();

// ---------- writes that must never stop either process ----------

let lastWarn = 0;
let unlogged = 0;
/**
 * Bookkeeping writes (heartbeat, bus log, command marks): a failure, such as a full disk or a lock the other process
 * held past busy_timeout, is logged, not thrown. Every failure counts: the first in a minute is logged with its
 * reason, the rest of that minute as a count with the next one logged.
 */
function quietly(what: string, fn: () => void) {
  try {
    fn();
  } catch (err: any) {
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      console.error(`runner link: ${what} failed (${String(err?.message ?? err)})${unlogged ? `; ${unlogged} more failed writes in the last minute` : ''}; will retry`);
      unlogged = 0;
    } else unlogged++;
  }
}

/** Calls fn every POLL_MS when another process has committed to the database since the last call. */
function onOtherCommits(fn: () => void): () => void {
  const stmt = db.prepare('PRAGMA data_version');
  let seen = -1;
  const t = setInterval(() => {
    let v: number;
    try {
      v = Number((stmt.get() as { data_version: number }).data_version);
    } catch {
      return;
    }
    if (v === seen) return;
    seen = v;
    fn();
  }, POLL_MS);
  return () => clearInterval(t);
}

// ---------- runner side ----------

type Command = { id: number; op: string; args: string };

/**
 * Agents mid-turn among those with a Claude process (`live`, the runner's live set): working, or waiting on a
 * permission answer (a question to the user is not mid-turn; its answer starts a new turn). A row marked working
 * without a process (a stale status) is not counted: nothing would be interrupted.
 */
export function workingAgents(live: Set<string>): number {
  if (!live.size) return 0;
  const ids = [...live];
  return Number(
    get(
      `SELECT COUNT(*) AS n FROM agents WHERE id IN (${ids.map(() => '?').join(',')}) AND (status = 'working' OR (status = 'waiting' AND id IN (SELECT agent_id FROM inbox WHERE kind = 'permission' AND status IN ('open', 'director', 'check') AND agent_id IS NOT NULL)))`,
      ...ids,
    )?.n ?? 0,
  );
}

/** The ops this runner does. A command with another op is left queued for a newer runner (never claimed). */
const KNOWN_OPS = ['team-details', 'send', 'close', 'interrupt', 'restart-projects', 'resolve', 'notify', 'poll-source', 'dispatch'];

async function execute(c: Command): Promise<'done' | { result: unknown }> {
  const a = JSON.parse(c.args || '{}');
  switch (c.op) {
    // Queries: the web service asks what only the runner's build can say (askRunner).
    case 'team-details': {
      const project = getProject(a.projectId);
      return { result: project ? teamDetails(project) : null };
    }
    case 'send': {
      const files = ((a.fileIds ?? []) as string[]).map((id) => getAttachment(id)).filter((r) => !!r);
      await sendToAgent(a.agentId, a.text, a.from, files, a.bindToEvent ?? true, a.viewing ?? null);
      // The live set with this agent in it, before the command is marked done: the web service's count of agents
      // mid-turn never sees the message neither queued nor working.
      beat();
      return 'done';
    }
    case 'close':
      await closeAgent(a.agentId, a.status);
      return 'done';
    case 'interrupt':
      await interruptAgent(a.agentId);
      return 'done';
    case 'restart-projects':
      restartForProjects(a.projectIds);
      return 'done';
    // Work was scheduled or started from the dashboard: the runner starts its builders (dispatch.ts).
    case 'dispatch':
      dispatchWork(a.projectId);
      return 'done';
    case 'resolve':
      resolvePermission(a.id, a.decision);
      return 'done';
    case 'notify':
      notify(a.event as NotifyEvent);
      return 'done';
    // "Check now" on a report source: the poll and the note to the director belong to the runner's report timers.
    case 'poll-source':
      pollSource(a.sourceId);
      return 'done';
    default:
      throw new Error(`unknown op ${c.op}`);
  }
}

const unknownLogged = new Set<string>();
/** This runner, as recorded on the commands it claims. */
const instance = `${process.pid}@${Date.now()}`;
let draining = false;

/** Claim a command for runner `by`: true for exactly one caller, whatever runs at the same time (exported for the tests). */
export function claimCommand(id: number, by: string): boolean {
  return Number(run('UPDATE runner_commands SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL AND done_at IS NULL', by, now(), id).changes) === 1;
}

/**
 * Start every pending command this runner knows, in order. Each is claimed first by a conditional UPDATE (claimed_by
 * still empty), so no command is done twice, by this runner or another; it is marked done (or with its error) when it
 * finishes. A command claimed by a runner that then stopped is not repeated (see startRunnerLink): at most once.
 */
function drain() {
  if (!draining) return;
  let pending: Command[];
  try {
    pending = all('SELECT id, op, args FROM runner_commands WHERE done_at IS NULL AND claimed_by IS NULL ORDER BY id') as Command[];
  } catch {
    return;
  }
  for (const c of pending) {
    if (!KNOWN_OPS.includes(c.op)) {
      if (!unknownLogged.has(c.op)) {
        unknownLogged.add(c.op);
        console.log(`runner: leaving "${c.op}" commands queued for a newer runner (this one speaks protocol ${PROTOCOL})`);
      }
      continue;
    }
    let claimed = false;
    quietly('claiming a command', () => (claimed = claimCommand(c.id, instance)));
    if (!claimed) continue;
    void execute(c).then(
      (r) => {
        const result = typeof r === 'object' ? JSON.stringify(r.result) : null;
        quietly('marking a command done', () => run('UPDATE runner_commands SET done_at = ?, result = ? WHERE id = ? AND done_at IS NULL', now(), result, c.id));
      },
      (err) => {
        quietly('recording a failed command', () => run('UPDATE runner_commands SET done_at = ?, error = ? WHERE id = ?', now(), String(err?.message ?? err).slice(0, 500), c.id));
      },
    );
  }
}

const startedAt = Date.now();
function beat() {
  quietly('heartbeat', () =>
    run(
      `INSERT INTO runner_state (id, pid, rev, hash, protocol, started_at, beat_at, live, working, info) VALUES (1,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, rev = excluded.rev, hash = excluded.hash, protocol = excluded.protocol,
         started_at = excluded.started_at, beat_at = excluded.beat_at, live = excluded.live, working = excluded.working, info = excluded.info`,
      process.pid, VERSION.rev, RUNNER_BUILD.hash, PROTOCOL, startedAt, Date.now(), JSON.stringify([...liveAgentIds()]), workingAgents(liveAgentIds()),
      // The unit's configuration this runner started with (nix/module.nix): the dashboard compares it with its own.
      JSON.stringify({ role: role(), stamp: process.env.HELM_UNIT_STAMP ?? '', skew: SKEW_EPOCH }),
    ),
  );
}

/** Publish this process's bus messages for the web service: deduplicated per tick, written in one transaction. */
function bridgeBus(): () => void {
  let batch: string[] | null = null;
  const flush = () => {
    const msgs = batch ?? [];
    batch = null;
    quietly('writing live updates', () =>
      tx(() => {
        for (const m of msgs) run('INSERT INTO bus_log (msg, ts) VALUES (?, ?)', m, Date.now());
      }),
    );
  };
  const unsubscribe = bus.subscribe((msg: BusMessage) => {
    // A transcript event goes by reference: the web service reads the row.
    const out = msg.type === 'event' ? { type: 'event', projectId: msg.projectId, agentId: msg.agentId, eventId: (msg.event as { id: number }).id } : msg;
    const json = JSON.stringify(out);
    if (!batch) {
      batch = [];
      setImmediate(flush);
    }
    if (!batch.includes(json)) batch.push(json);
  });
  return unsubscribe;
}

/**
 * Commands a runner claimed and did not finish before it stopped. Closing an agent is safe to do twice, so it is
 * repeated (at least once). A message or a stop is not (at most once: it may already have reached the agent); the
 * agent's transcript says so, so the user can send it again. The window is from the claim to the done mark:
 * milliseconds for a message.
 */
export function settleStopped() {
  quietly('settling commands of a runner that stopped', () => {
    const rows = all('SELECT id, op, args FROM runner_commands WHERE done_at IS NULL AND claimed_by IS NOT NULL AND claimed_by != ?', instance);
    for (const c of rows) {
      if (c.op === 'close') {
        run('UPDATE runner_commands SET claimed_by = NULL, claimed_at = NULL WHERE id = ?', c.id);
        continue;
      }
      run("UPDATE runner_commands SET done_at = ?, error = 'The runner stopped while doing this; not repeated.' WHERE id = ?", now(), c.id);
      let a: any = {};
      try {
        a = JSON.parse(c.args || '{}');
      } catch {
        // Unreadable: nothing to tell.
      }
      const agent = a.agentId ? getAgent(a.agentId) : undefined;
      if (!agent) continue;
      if (c.op === 'send') addEvent(agent, 'note', { text: `Not delivered: Helm restarted while handing over this message (${String(a.text ?? '').replace(/\s+/g, ' ').slice(0, 120)}). Send it again.` });
      else if (c.op === 'interrupt') addEvent(agent, 'note', { text: 'A stop was not carried out: Helm restarted while handing it over. Press Stop again if it is still needed.' });
    }
    if (rows.length) console.log(`runner: settled ${rows.length} command(s) a stopped runner had started`);
  });
}

/**
 * The runner's half: do the commands the web service queues, keep the heartbeat, and pass live updates on. Call after
 * recoverOnBoot, so commands queued while the runner was down reach agents in a known state.
 */
export function startRunnerLink(): { stopDrain: () => void; stop: () => Promise<void> } {
  setProcessRole('runner');
  settleStopped();
  const stops: (() => void)[] = [];
  stops.push(bridgeBus());
  beat();
  const beats = setInterval(beat, BEAT_MS);
  stops.push(() => clearInterval(beats));
  // The live set changes when a process starts or ends: tell the web service at once, not at the next heartbeat.
  onLiveChange(beat);
  stops.push(() => onLiveChange(() => {}));
  draining = true;
  drain();
  const stopPoll = onOtherCommits(drain);
  const stopDrain = () => {
    draining = false;
    stopPoll();
  };
  const prune = setInterval(
    () =>
      quietly('pruning', () => {
        run('DELETE FROM bus_log WHERE ts < ?', Date.now() - BUS_KEEP_MS);
        run('DELETE FROM runner_commands WHERE done_at IS NOT NULL AND done_at < ?', now() - COMMANDS_KEEP_MS);
      }),
    60_000,
  );
  stops.push(() => clearInterval(prune));
  return {
    // First on the way down: what arrives from now on waits for the next runner, rather than starting a Claude process
    // that the shutdown kills at once.
    stopDrain,
    async stop() {
      stopDrain();
      for (const s of stops) s();
      // Gone at once, not after RUNNER_STALE_MS: the dashboard says agents are restarting.
      quietly('clearing the heartbeat', () => run('UPDATE runner_state SET beat_at = 0 WHERE id = 1 AND pid = ?', process.pid));
    },
  };
}

// The runner lock and the check that a pid is a live runner for this data directory: server/runnerlock.ts.

// ---------- web side ----------

function enqueue(op: string, args: unknown): number {
  return Number(run('INSERT INTO runner_commands (op, args, created_at) VALUES (?,?,?)', op, JSON.stringify(args), now()).lastInsertRowid);
}

/** Hand the runner an operation that belongs to it (web service only), e.g. polling a report source now. */
export function runnerCommand(op: 'poll-source', args: unknown) {
  enqueue(op, args);
}

/**
 * Ask the runner something only its build can answer, such as the system prompts and tools its agents get
 * (teamview.ts), and wait up to timeoutMs. Null when the runner is down, does not know the question (an older build),
 * or does not answer in time; the question is then withdrawn so it does not wait in the queue.
 */
export async function askRunner<T>(op: string, args: unknown, timeoutMs = 3000): Promise<T | null> {
  if (role() !== 'web' || !runnerStatus().up) return null;
  const id = enqueue(op, args);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    const row = get('SELECT done_at, error, result FROM runner_commands WHERE id = ?', id);
    if (row?.done_at) return row.error || row.result === null ? null : (JSON.parse(row.result) as T);
  }
  quietly('withdrawing a question', () => run("UPDATE runner_commands SET done_at = ?, error = 'not answered in time' WHERE id = ? AND done_at IS NULL", now(), id));
  return null;
}

export type RunnerStatus = {
  mode: Role;
  up: boolean;
  rev: string;
  hash: string;
  protocol: number;
  pid: number | null;
  startedAt: number;
  beatAt: number;
  working: number;
  pending: number;
  /** HELM_UNIT_STAMP the runner started with; '' when not set (not under the NixOS module). */
  stamp: string;
};

let lookedUp: { at: number; pid: number | null } = { at: 0, pid: null };
/**
 * The pid of a runner for this data directory (server/main.ts in runner mode, with our HELM_DATA), or null. Read from
 * /proc (same user), at most every 5 s: only needed when the heartbeat is stale, which a full disk can cause.
 */
function runnerProcess(): number | null {
  if (Date.now() - lookedUp.at < 5000) return lookedUp.pid;
  let found: number | null = null;
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
        if (!args.some((a) => a.endsWith('server/main.ts')) || !args.includes('runner')) continue;
        const env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
        const data = env.find((e) => e.startsWith('HELM_DATA='))?.slice('HELM_DATA='.length);
        if (data && resolve(data) === DATA_DIR) {
          found = Number(name);
          break;
        }
      } catch {
        // Gone meanwhile, or not ours to read.
      }
    }
  } catch {
    // No /proc: only the heartbeat counts.
  }
  lookedUp = { at: Date.now(), pid: found };
  return found;
}

/** The runner as the web service sees it (in one process: this process). */
export function runnerStatus(): RunnerStatus {
  // Messages for agents not yet taken by the runner: each starts a turn. Only `send`: a command of an op the runner
  // does not know stays queued for a newer runner and must not hold up a deferred restart forever.
  const pending = Number(get("SELECT COUNT(*) AS n FROM runner_commands WHERE done_at IS NULL AND op = 'send'")?.n ?? 0);
  if (role() !== 'web') {
    return { mode: role(), up: true, rev: VERSION.rev, hash: RUNNER_BUILD.hash, protocol: PROTOCOL, pid: process.pid, startedAt, beatAt: Date.now(), working: workingAgents(liveAgentIds()), pending, stamp: process.env.HELM_UNIT_STAMP ?? '' };
  }
  const s = get('SELECT * FROM runner_state WHERE id = 1');
  // A fresh heartbeat; or, on a full disk where no heartbeat can be written, a runner process for this data directory
  // still running (one that started on the full disk has never written one).
  // A fresh heartbeat counts only while its process lives: a runner killed or crashed a moment ago is down at once, so
  // the dashboard says agents are restarting instead of waiting RUNNER_STALE_MS.
  const fresh = !!s && Date.now() - Number(s.beat_at) < RUNNER_STALE_MS && helmFor(Number(s.pid));
  const alive = fresh ? null : runnerProcess();
  const up = fresh || alive !== null;
  let live = new Set<string>();
  try {
    live = new Set(JSON.parse(s?.live ?? '[]'));
  } catch {
    // An unreadable live set: nobody counted as mid-turn.
  }
  return {
    mode: role(),
    up,
    rev: s?.rev ?? '',
    hash: s?.hash ?? '',
    protocol: Number(s?.protocol ?? 0),
    pid: alive ?? (s ? Number(s.pid) : null),
    startedAt: Number(s?.started_at ?? 0),
    beatAt: Number(s?.beat_at ?? 0),
    // Agents in the runner's live set (written at once when it changes) with a turn running now, read from the
    // database: not the heartbeat's count, which is up to BEAT_MS old (the update script waits on this).
    working: up ? workingAgents(live) : 0,
    pending,
    stamp: (() => {
      try {
        return String(JSON.parse(s?.info ?? '{}').stamp ?? '');
      } catch {
        return '';
      }
    })(),
  };
}

/**
 * The web service's half: agent operations become commands for the runner, and the runner's live updates are passed
 * on to this process's browsers.
 */
export function startWebLink(): () => void {
  setProcessRole('web');
  const queued: AgentOps = {
    async send(agentId, text, from, files = [], bindToEvent = true, viewing = null) {
      if (!get('SELECT 1 AS x FROM agents WHERE id = ?', agentId)) throw new Error(`No agent ${agentId}`);
      enqueue('send', { agentId, text, from, fileIds: files.map((f) => f.id), bindToEvent, viewing });
    },
    async close(agentId, status) {
      enqueue('close', { agentId, status });
    },
    async interrupt(agentId) {
      enqueue('interrupt', { agentId });
    },
    restartForProjects(projectIds) {
      if (projectIds.length) enqueue('restart-projects', { projectIds });
    },
    resolvePermission(id, decision) {
      enqueue('resolve', { id, decision });
    },
    dispatch(projectId) {
      enqueue('dispatch', { projectId });
    },
    liveAgentIds() {
      const s = runnerStatus();
      if (!s.up) return new Set();
      try {
        return new Set(JSON.parse(get('SELECT live FROM runner_state WHERE id = 1')?.live ?? '[]'));
      } catch {
        return new Set();
      }
    },
  };
  bindAgentOps('queue', queued);
  forwardNotifications((event) => quietly('queueing a notification', () => enqueue('notify', { event })));

  // Start after what is already there: browsers that connect refetch everything anyway.
  let last = Number(get('SELECT MAX(id) AS id FROM bus_log')?.id ?? 0);
  const event = db.prepare('SELECT id, agent_id, ts, kind, data FROM events WHERE id = ?');
  const tail = () => {
    let rows: { id: number; msg: string; ts: number }[];
    try {
      rows = all('SELECT id, msg, ts FROM bus_log WHERE id > ? ORDER BY id', last) as { id: number; msg: string; ts: number }[];
    } catch {
      return;
    }
    for (const r of rows) {
      last = r.id;
      try {
        const m = JSON.parse(r.msg);
        if (m.type === 'event') {
          const row = event.get(m.eventId) as { data: string } | undefined;
          // loggedAt: when the runner wrote it to bus_log (the event's ts is when it was recorded), for latency checks.
          if (row) bus.publish({ type: 'event', projectId: m.projectId, agentId: m.agentId, event: { ...row, data: JSON.parse(row.data) }, loggedAt: r.ts });
        } else bus.publish(m as BusMessage);
      } catch {
        // A message this version does not understand: skip it.
      }
    }
    watchRunner();
  };
  // Up or down, and which build: browsers refetch the runner's status when it changes.
  let seen = '';
  const watchRunner = () => {
    let s: RunnerStatus;
    try {
      s = runnerStatus();
    } catch {
      return;
    }
    const key = `${s.up}|${s.rev}|${s.pid}`;
    if (key !== seen) {
      if (seen) bus.publish({ type: 'runner' });
      seen = key;
    }
  };
  watchRunner();
  const stopTail = onOtherCommits(tail);
  // A runner that died commits nothing, so its silence is noticed by the clock.
  const watch = setInterval(watchRunner, 2000);
  return () => {
    stopTail();
    clearInterval(watch);
  };
}
