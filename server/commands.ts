import { all, db, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getAgent, touchProject } from './store.ts';

/**
 * Commands and heavy jobs: what Helm knows about the shell commands agents run, so waiting on them costs nothing.
 *
 * - Every Bash call is a row in running_commands from its start to its end (its result, or for a background command
 *   the SDK's task_notification), on the task it runs for: the task card lists the running ones with host and elapsed
 *   time. When it ends its duration is kept per project and command (command_durations): the last one is what Helm
 *   expects next time.
 * - A command that took over LONG_MS last time is a heavy job (a build, a suite, a render). The builder's Bash calls
 *   pass bashCheck: a heavy job starts in the background (so light work fills the wait) and under a heavy claim on a
 *   host (claim_host heavy: true, hosts.ts): one heavy job at a time on each host, across every project. The command
 *   is bound to that claim, and Helm releases the claim when the command ends.
 * - heavy_jobs keeps each heavy claim from when it was first asked for (a refusal: no host free) to its start and
 *   end. A job that queued records how long a host of the project sat free meanwhile (free_ms); telemetry sums it
 *   per task, with the time commands ran while nothing else was in hand (idleWaitMs).
 */

db.exec(`
CREATE TABLE IF NOT EXISTS command_durations (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  ms INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);
CREATE TABLE IF NOT EXISTS running_commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_agent_id TEXT NOT NULL,
  task_id TEXT,
  command TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  host_id TEXT,
  host_name TEXT,
  claim_id TEXT,
  background INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS running_commands_task ON running_commands(task_id, ended_at);
CREATE INDEX IF NOT EXISTS running_commands_session ON running_commands(session_agent_id, ended_at);
CREATE TABLE IF NOT EXISTS heavy_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  host_id TEXT,
  asked_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  free_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS heavy_jobs_task ON heavy_jobs(task_id);
`);

/** A command that took longer than this last time is a heavy job. */
export const LONG_MS = 60_000;

/** What identifies "the same command" next time: without a leading cd, whitespace collapsed. */
export function commandKey(command: string): string {
  return String(command ?? '').replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** How long this command took the last time it ran in the project, or null. */
export function lastDuration(projectId: string, command: string): number | null {
  const r = get('SELECT ms FROM command_durations WHERE project_id = ? AND key = ?', projectId, commandKey(command));
  return r ? Number(r.ms) : null;
}

const minutes = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** Heavy claims an agent holds that no running command is bound to yet. */
function freeHeavyClaims(agentId: string): Row[] {
  return all(
    `SELECT c.id, c.host_id, h.name FROM host_claims c JOIN hosts h ON h.id = c.host_id
      WHERE c.agent_id = ? AND c.heavy = 1 AND NOT EXISTS (SELECT 1 FROM running_commands r WHERE r.claim_id = c.id AND r.ended_at IS NULL) ORDER BY c.created_at`,
    agentId,
  );
}

/**
 * A builder is about to run a shell command: null to let it, or why not. A command known to be long starts in the
 * background, under a heavy claim of its own.
 */
export function bashCheck(agent: Row, input: Row): string | null {
  const command = String(input.command ?? '');
  if (input.run_in_background !== true) {
    const wait = waitSeconds(command);
    if (wait > WAIT_LOOP_S) return `This waits ${Number.isFinite(wait) ? `up to ${minutes(wait * 1000)}` : 'with no bound'} (a sleep or poll loop). Run it in the background and carry on: run_in_background: true, then do other work; Helm tells you when it ends. A short wait is fine, e.g. one bounded by timeout 60.`;
  }
  const last = lastDuration(agent.project_id, command);
  if (last === null || last <= LONG_MS) return null;
  if (input.run_in_background !== true) {
    return `This command took ${minutes(last)} last time. Start it with run_in_background: true and carry on with work that does not need its result (reading, the next part, a light subagent); come back to it when it finishes.`;
  }
  if (!freeHeavyClaims(agent.id).length) {
    return `This is a heavy job (${minutes(last)} last time), and one runs at a time on each host. First claim a free host for it with claim_host heavy: true (list_hosts shows who is on which), then start it there; Helm releases the claim when the command ends. If no host is free, do light work meanwhile: Helm tells you when one frees.`;
  }
  return null;
}

/** A foreground wait (sleep or poll loop) longer than this, in seconds, is refused: run it in the background instead. */
export const WAIT_LOOP_S = 60;

const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };
const seconds = (n: string, unit: string) => Number(n) * (UNIT[unit] ?? 1);

/**
 * How long a command may sit waiting, in seconds, from its sleeps and poll loops: 0 when it does not sleep. A while or
 * until loop that sleeps has no bound (Infinity); a for loop sleeps once per item; a timeout around a poll bounds it.
 * Only sleeps count, so ordinary loops and long builds are never taken for waits.
 */
export function waitSeconds(command: string): number {
  const c = String(command ?? '');
  const sleeps = [...c.matchAll(/(?:^|[\s;&|(`'"])sleep\s+((?:\d+(?:\.\d+)?[smhd]?\s*)+)/g)].map((m) =>
    [...m[1].matchAll(/(\d+(?:\.\d+)?)([smhd]?)/g)].reduce((s, x) => s + seconds(x[1], x[2]), 0),
  );
  const sum = sleeps.reduce((a, b) => a + b, 0);
  if (!sum) return 0;
  let wait = sum;
  if (/\b(while|until)\b[\s\S]*\bdo\b/.test(c)) wait = Infinity;
  else {
    const loop = /\bfor\s+\w+\s+in\s+([^;\n]*?)\s*(?:;|\n)\s*do\b/.exec(c);
    if (loop) {
      const items = loop[1].trim();
      const brace = /^\{(\d+)\.\.(\d+)\}$/.exec(items);
      const seq = /^\$\(seq\s+(?:(\d+)\s+)?(?:\d+\s+)?(\d+)\)$/.exec(items);
      const n = brace ? Math.abs(Number(brace[2]) - Number(brace[1])) + 1 : seq ? Number(seq[2]) - Number(seq[1] ?? 1) + 1 : items.split(/\s+/).filter(Boolean).length;
      wait = Math.max(1, n) * sum;
    }
  }
  const t = /\btimeout\s+(?:-\S+\s+(?:\d+\s+)?)*(\d+(?:\.\d+)?)([smhd]?)(?=\s)/.exec(c);
  return t ? Math.min(wait, seconds(t[1], t[2])) : wait;
}

/**
 * A Bash call started (its tool_use event): `agent` is whose call it is (a subagent's row for its calls), `session` the
 * session's agent. Returns whether it is new (a repeated event for the same call changes nothing).
 */
export function commandStarted(agent: Row, session: Row, toolUseId: string, input: Row): boolean {
  const command = String(input?.command ?? '');
  if (!toolUseId || !command.trim()) return false;
  const claim = freeHeavyClaims(session.id)[0];
  const last = lastDuration(agent.project_id, command);
  // Bound to a heavy claim when the session holds a free one and the command is not known to be short.
  const bind = claim && (last === null ? input.run_in_background === true : last > LONG_MS) ? claim : undefined;
  const res = run(
    'INSERT OR IGNORE INTO running_commands (id, project_id, agent_id, session_agent_id, task_id, command, label, host_id, host_name, claim_id, background, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    toolUseId, agent.project_id, agent.id, session.id, agent.task_id ?? null, command.slice(0, 2000), String(input.description ?? '').slice(0, 200), bind?.host_id ?? null, bind?.name ?? null, bind?.id ?? null,
    input.run_in_background === true ? 1 : 0, now(),
  );
  touchProject(agent.project_id);
  return Number(res.changes) > 0;
}

/** Hooks set by hosts.ts (the claim to release) without a circular import. */
let releaseClaim: (claimId: string) => void = () => {};
export const onCommandClaimEnd = (fn: (claimId: string) => void) => {
  releaseClaim = fn;
};

/**
 * A command ended: `how` is 'result' (its tool_result: the end of a foreground command, nothing for a background one)
 * or 'notification' (a background command's end). Its duration is remembered and its heavy claim released.
 */
export function commandEnded(toolUseId: string | undefined, how: 'result' | 'notification'): boolean {
  if (!toolUseId) return false;
  const r = get('SELECT * FROM running_commands WHERE id = ? AND ended_at IS NULL', toolUseId);
  if (!r || (how === 'result' && r.background)) return false;
  const ms = Math.max(0, now() - Number(r.started_at));
  run('UPDATE running_commands SET ended_at = ? WHERE id = ?', now(), r.id);
  run('INSERT INTO command_durations (project_id, key, ms, at) VALUES (?,?,?,?) ON CONFLICT(project_id, key) DO UPDATE SET ms = excluded.ms, at = excluded.at', r.project_id, commandKey(r.command), ms, now());
  if (r.claim_id) releaseClaim(r.claim_id);
  touchProject(r.project_id);
  return true;
}

/** A session ended or was stopped: its commands stopped with it (no duration is learned from a cut-off run). */
export function endCommandsOf(sessionAgentId: string) {
  const open = all('SELECT id, project_id, claim_id FROM running_commands WHERE session_agent_id = ? AND ended_at IS NULL', sessionAgentId);
  for (const r of open) {
    run('UPDATE running_commands SET ended_at = ? WHERE id = ?', now(), r.id);
    if (r.claim_id) releaseClaim(r.claim_id);
  }
  if (open.length) touchProject(open[0].project_id);
}

/** Whether a session has a command running (started within the last two hours): its process must stay open for it. */
export const hasRunningCommands = (sessionAgentId: string) => !!get('SELECT 1 FROM running_commands WHERE session_agent_id = ? AND ended_at IS NULL AND started_at > ?', sessionAgentId, now() - 2 * 3600_000);

/** At boot no command runs. */
export function recoverCommands() {
  run('UPDATE running_commands SET ended_at = ? WHERE ended_at IS NULL', now());
  run('UPDATE heavy_jobs SET ended_at = ? WHERE ended_at IS NULL AND started_at IS NOT NULL', now());
}

/** The commands running for a task now, oldest first: what the task card lists. */
export function runningCommands(taskId: string): Row[] {
  return all('SELECT r.id, r.agent_id, a.name AS agent_name, r.command, r.label, r.host_name, r.background, r.started_at FROM running_commands r LEFT JOIN agents a ON a.id = r.agent_id WHERE r.task_id = ? AND r.ended_at IS NULL ORDER BY r.started_at', taskId).map(
    (r) => ({ ...r, expected_ms: lastDuration(String(get('SELECT project_id FROM tasks WHERE id = ?', taskId)?.project_id ?? ''), r.command) }),
  );
}

// ---------- heavy jobs ----------

/** A heavy claim was refused (no room on that host): the job queues from now, once per agent and task. */
export function heavyAsked(agent: Row) {
  if (get('SELECT 1 FROM heavy_jobs WHERE agent_id = ? AND started_at IS NULL AND ended_at IS NULL', agent.id)) return;
  run('INSERT INTO heavy_jobs (id, project_id, agent_id, task_id, asked_at) VALUES (?,?,?,?,?)', newId('hj'), agent.project_id, agent.id, agent.task_id ?? null, now());
}

/**
 * Time within [from, to] during which at least one of `hostIds` ran no heavy job. Exact, from the heavy_jobs
 * intervals.
 */
export function hostFreeMs(hostIds: string[], from: number, to: number): number {
  if (!hostIds.length || to <= from) return 0;
  const jobs = all(`SELECT host_id, started_at, COALESCE(ended_at, ?) AS ended_at FROM heavy_jobs WHERE started_at IS NOT NULL AND host_id IN (${hostIds.map(() => '?').join(',')}) AND started_at < ? AND COALESCE(ended_at, ?) > ?`, to, ...hostIds, to, to, from);
  const cuts = [...new Set([from, to, ...jobs.flatMap((j) => [Number(j.started_at), Number(j.ended_at)]).filter((t) => t > from && t < to)])].sort((a, b) => a - b);
  let free = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const mid = (cuts[i] + cuts[i + 1]) / 2;
    const busy = new Set(jobs.filter((j) => j.started_at <= mid && j.ended_at > mid).map((j) => j.host_id));
    if (busy.size < hostIds.length) free += cuts[i + 1] - cuts[i];
  }
  return free;
}

/** A heavy claim was granted on a host: the job starts (a queued one records how long a host sat free meanwhile). */
export function heavyStarted(agent: Row, hostId: string, projectHostIds: string[]) {
  const queued = get('SELECT * FROM heavy_jobs WHERE agent_id = ? AND started_at IS NULL AND ended_at IS NULL', agent.id);
  if (queued) {
    run('UPDATE heavy_jobs SET host_id = ?, started_at = ?, free_ms = ?, task_id = COALESCE(task_id, ?) WHERE id = ?', hostId, now(), hostFreeMs(projectHostIds, Number(queued.asked_at), now()), agent.task_id ?? null, queued.id);
  } else run('INSERT INTO heavy_jobs (id, project_id, agent_id, task_id, host_id, asked_at, started_at) VALUES (?,?,?,?,?,?,?)', newId('hj'), agent.project_id, agent.id, agent.task_id ?? null, hostId, now(), now());
}

/** A heavy claim ended (released, or its agent stopped). Returns the agents whose heavy job is queued, to be told. */
export function heavyEnded(agentId: string, hostId: string): Row[] {
  run('UPDATE heavy_jobs SET ended_at = ? WHERE agent_id = ? AND host_id = ? AND started_at IS NOT NULL AND ended_at IS NULL', now(), agentId, hostId);
  return all('SELECT DISTINCT agent_id FROM heavy_jobs WHERE started_at IS NULL AND ended_at IS NULL AND agent_id != ?', agentId)
    .map((r) => getAgent(r.agent_id))
    .filter((a): a is Row => !!a && a.status !== 'closed');
}

/** An agent stopped or finished: a heavy job it still queued for is dropped. */
export function heavyDropped(agentId: string) {
  run('UPDATE heavy_jobs SET ended_at = ? WHERE agent_id = ? AND started_at IS NULL AND ended_at IS NULL', now(), agentId);
}

// ---------- telemetry ----------

/** A gap this long between an agent's actions while a command runs counts as waiting on it. */
const IDLE_GAP_MS = 20_000;

/**
 * Time a task's commands ran with nothing else in hand: within the stretches when a command of the task was running,
 * the gaps between its agents' other actions (tool calls, results, text) beyond IDLE_GAP_MS.
 */
export function idleWaitMs(taskId: string, end = now()): number {
  const cmds = all('SELECT id, session_agent_id, agent_id, started_at, COALESCE(ended_at, ?) AS ended_at FROM running_commands WHERE task_id = ?', end, taskId);
  if (!cmds.length) return 0;
  // The stretches a command ran, merged.
  const spans: [number, number][] = [];
  for (const c of [...cmds].sort((a, b) => a.started_at - b.started_at)) {
    const lastSpan = spans[spans.length - 1];
    if (lastSpan && c.started_at <= lastSpan[1]) lastSpan[1] = Math.max(lastSpan[1], c.ended_at);
    else spans.push([Number(c.started_at), Number(c.ended_at)]);
  }
  const agents = [...new Set(cmds.flatMap((c) => [c.session_agent_id, c.agent_id]))];
  const own = new Set(cmds.map((c) => c.id));
  let idle = 0;
  for (const [a, b] of spans) {
    const acts: number[] = [];
    for (const e of all(`SELECT ts, kind, data FROM events WHERE agent_id IN (${agents.map(() => '?').join(',')}) AND ts > ? AND ts < ? AND kind IN ('tool', 'tool_result', 'text') ORDER BY ts`, ...agents, a, b)) {
      // The command's own start and end are not other work.
      if (e.kind !== 'text') {
        try {
          if (own.has(JSON.parse(e.data).id)) continue;
        } catch {}
      }
      acts.push(Number(e.ts));
    }
    // Subagents of the session working for the task are work in hand too.
    for (const e of all("SELECT e.ts FROM events e JOIN agents s ON s.id = e.agent_id WHERE s.role_id = 'subagent' AND s.task_id = ? AND e.ts > ? AND e.ts < ? AND e.kind IN ('tool', 'tool_result') ORDER BY e.ts", taskId, a, b)) acts.push(Number(e.ts));
    const points = [a, ...acts.sort((x, y) => x - y), b];
    for (let i = 0; i + 1 < points.length; i++) idle += Math.max(0, points[i + 1] - points[i] - IDLE_GAP_MS);
  }
  return idle;
}

/** Time a host of the project sat free while a heavy job of this task queued. */
export const hostFreeWaitMs = (taskId: string) => Number(get('SELECT COALESCE(SUM(free_ms), 0) AS n FROM heavy_jobs WHERE task_id = ?', taskId)?.n ?? 0);
