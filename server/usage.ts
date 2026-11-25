import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { sinceSql } from './telemetryreset.ts';

/**
 * Token usage and the subscription's plan windows.
 *
 * One number per agent, task and project: tokens = input + output + cache writes. Cache reads are not
 * added: a long session re-reads its whole context every call, so they run 10 to 100 times the rest and would drown
 * the figure, while costing about a tenth as much as fresh input.
 *
 * A result's modelUsage is a running total for the session (every model, subagents included; a resumed session goes
 * on from the total its transcript saved), so each turn records what it added since the last result. A total lower
 * than the last one seen means the count started again (a session without saved totals): the whole of it is new.
 *
 * Work tokens (the progress check, progress.ts): what a task's turns caused, apart from what they cost. A call's output,
 * plus the input that is new to the conversation: the growth of its context since the previous call (tool results,
 * the user's message), at most its uncached input and cache writes. Cache reads are excluded, and so is a cache write
 * that re-writes context the conversation already held (the cache expired, or the session resumed: a long builder
 * session writes its whole context again, 800k tokens in one call, without doing any more work). The first call a
 * process sees has no previous context: only its uncached input counts. Stored per row as work_in / work_out; rows
 * without them (recorded before) count their tokens in full.
 */

type ModelUsage = { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number };

/** A result's running total: input + output + cache writes, over every model. */
export function usageTotal(modelUsage: Record<string, ModelUsage> | null | undefined): number {
  let tokens = 0;
  for (const m of Object.values(modelUsage ?? {})) tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
  return tokens;
}

/** One API call's usage, as an assistant message carries it. */
export type CallUsage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
export type Work = { input: number; output: number };
/** One conversation's calls (a session's main thread, or one subagent): the work since the last take. */
export type WorkTracker = Work & { last: { id: string; context: number; output: number } | null };
export const newWorkTracker = (): WorkTracker => ({ input: 0, output: 0, last: null });

/** Note a call (an assistant message: one call may stream several, with the same id). */
export function noteCall(t: WorkTracker, id: string, u: CallUsage | undefined) {
  if (!u) return;
  const output = u.output_tokens ?? 0;
  if (t.last?.id === id) {
    t.output += Math.max(0, output - t.last.output);
    t.last.output = Math.max(output, t.last.output);
    return;
  }
  const fresh = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const context = fresh + (u.cache_read_input_tokens ?? 0);
  // The next call re-sends the last one's context and output: only what grew past that is new.
  t.input += t.last ? Math.min(fresh, Math.max(0, context - t.last.context - t.last.output)) : (u.input_tokens ?? 0);
  t.output += output;
  t.last = { id, context, output };
}
/** The work noted since the last take; the tracker keeps the last call, for the next one's growth. */
export function takeWork(t: WorkTracker | undefined): Work {
  if (!t) return { input: 0, output: 0 };
  const w = { input: t.input, output: t.output };
  t.input = 0;
  t.output = 0;
  return w;
}

/** What a turn added, from the session's running total now and the last one seen. */
export const turnDelta = (total: number, seen: number) => (total >= seen ? total - seen : total);

/**
 * Record the tokens an agent's turn used, from its result's modelUsage. Runner side (runtime.ts). `task`: the task the
 * turn counts for (default the agent's current task; a director's turn names the task it was about, telemetry.ts).
 * `sub`: how much of the turn its SDK subagents used, recorded as its own row (who 'subagent').
 */
export function recordTurnUsage(agent: Row, modelUsage: Record<string, ModelUsage> | null | undefined, tier: string | null = null, who: string | null = null, opts: { task?: string | null; account?: string | null; context?: number; sub?: number; subWork?: Work; work?: Work; subagents?: { agent: Row; tokens: number; tier: string | null; work?: Work }[] } = {}) {
  const total = usageTotal(modelUsage);
  if (!total) return; // a crash or start-up error result carries zeroes: keep the last total seen
  const added = turnDelta(total, Number(agent.usage_seen ?? 0));
  run('UPDATE agents SET usage_seen = ? WHERE id = ?', total, agent.id);
  if (added <= 0) return;
  const task = opts.task !== undefined ? opts.task : (agent.task_id ?? null);
  // The account it ran on (accounts.ts): NULL for the main one.
  const account = opts.account && opts.account !== 'main' ? opts.account : null;
  const sub = Math.max(0, Math.min(added, Math.round(opts.sub ?? 0)));
  const insert = (tokens: number, w: string | null, work?: Work, context?: number) =>
    run('INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, tier, who, work_in, work_out, context, account) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', agent.project_id, agent.id, task, tokens, now(), tier, w, work?.input ?? null, work?.output ?? null, context || null, account);
  // A builder's subagents (subagents.ts): each on its own row and task, at its own tier, out of what is left.
  let left = added - sub;
  const touched = new Set<string>();
  for (const s of opts.subagents ?? []) {
    const n = Math.max(0, Math.min(left, Math.round(s.tokens)));
    if (!n && !(s.work && s.work.input + s.work.output)) continue;
    left -= n;
    run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, tier, who, work_in, work_out, account) VALUES (?, ?, ?, ?, ?, ?, 'subagent', ?, ?, ?)", agent.project_id, s.agent.id, s.agent.task_id ?? task, n, now(), s.tier, s.work?.input ?? null, s.work?.output ?? null, account);
    if (s.agent.task_id) touched.add(s.agent.task_id);
  }
  if (left > 0 || (opts.work && opts.work.input + opts.work.output)) insert(Math.max(0, left), who, opts.work, opts.context);
  if (sub > 0) insert(sub, 'subagent', opts.subWork);
  // The last turn of a task usually ends after complete_task finished it: its row is brought up to date.
  if (task) touched.add(task);
  for (const t of touched) afterUsage(t);
}
/** Called with the task a turn was recorded for (telemetry.ts sets it; usage.ts stays free of imports). */
let afterUsage: (taskId: string) => void = () => {};
export const onTaskUsage = (fn: (taskId: string) => void) => {
  afterUsage = fn;
};

export const agentTokens = (agentId: string) => Number(get('SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE agent_id = ?', agentId)?.n ?? 0);
export const taskTokens = (taskId: string) => Number(get('SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE task_id = ?', taskId)?.n ?? 0);
/**
 * A task's work tokens (see the top): its agents' new input and output, and its subagents' (new input + output) apart.
 * A row without the split counts its tokens in full: as new input, or as subagents for a subagent's row. `full`: whether
 * every row has the split.
 */
export type TaskWork = { input: number; output: number; subagents: number; full: boolean };
export function taskWork(taskId: string): TaskWork {
  const r = get(
    `SELECT COALESCE(SUM(CASE WHEN who = 'subagent' THEN 0 ELSE COALESCE(work_in, tokens) END), 0) AS i,
      COALESCE(SUM(CASE WHEN who = 'subagent' THEN 0 ELSE COALESCE(work_out, 0) END), 0) AS o,
      COALESCE(SUM(CASE WHEN who = 'subagent' THEN COALESCE(work_in + work_out, tokens) ELSE 0 END), 0) AS s,
      COUNT(*) - COUNT(work_in) AS legacy
    FROM token_usage WHERE task_id = ?`,
    taskId,
  );
  return { input: Number(r?.i ?? 0), output: Number(r?.o ?? 0), subagents: Number(r?.s ?? 0), full: !Number(r?.legacy ?? 0) };
}
export const workTotal = (w: { input: number; output: number; subagents: number }) => w.input + w.output + w.subagents;
export const projectTokens = (projectId: string) => Number(get('SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE project_id = ?', projectId)?.n ?? 0);

/** Tokens per agent of a project, for the project state the dashboard reads. */
export function agentTokensIn(projectId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all('SELECT agent_id, SUM(tokens) AS n FROM token_usage WHERE project_id = ? GROUP BY agent_id', projectId)) out[r.agent_id] = Number(r.n);
  return out;
}

/**
 * Tokens per tier (tiers.ts), for a project or the whole install. Turns from before tiers count as "none". With
 * sinceReset (the Telemetry page), each project's tokens count from its last Telemetry reset (telemetryreset.ts).
 */
export function tokensByTier(projectId?: string, sinceReset = false): Record<string, number> {
  const out: Record<string, number> = {};
  const since = sinceReset ? sinceSql('token_usage.at', 'token_usage.project_id') : '';
  for (const r of all(`SELECT COALESCE(tier, 'none') AS t, SUM(tokens) AS n FROM token_usage WHERE 1 = 1 ${projectId ? 'AND project_id = ?' : ''}${since} GROUP BY t`, ...(projectId ? [projectId] : []))) out[r.t] = Number(r.n);
  return out;
}

/** Tokens split into directing and building (who: director, builder, agent), for a project or the install. */
export function tokensByWho(projectId?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all(`SELECT COALESCE(who, 'none') AS w, SUM(tokens) AS n FROM token_usage ${projectId ? 'WHERE project_id = ?' : ''} GROUP BY w`, ...(projectId ? [projectId] : []))) out[r.w] = Number(r.n);
  return out;
}

/** Tokens per task of a project. */
export function taskTokensIn(projectId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all('SELECT task_id, SUM(tokens) AS n FROM token_usage WHERE project_id = ? AND task_id IS NOT NULL GROUP BY task_id', projectId)) out[r.task_id] = Number(r.n);
  return out;
}

// ---- Plan windows ----

/** A plan window: how much of it is used (0-100), when it resets and when that was read (ms). */
export type PlanWindow = { name: string; percent: number; resetsAt: number | null; at: number };

/** The order windows are shown in; per-model windows ("model:<name>") and any other the SDK adds follow. */
const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

const toMs = (t: unknown): number | null => {
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t < 1e12 ? t * 1000 : t;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};
function store(name: string, percent: unknown, resetsAt: unknown, fraction: boolean) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    run('DELETE FROM plan_usage WHERE name = ?', name); // the window is there but its figure is not known
    return;
  }
  const p = Math.max(0, Math.min(100, fraction ? percent * 100 : percent));
  run('INSERT OR REPLACE INTO plan_usage (name, percent, resets_at, at) VALUES (?, ?, ?, ?)', name, p, toMs(resetsAt), now());
}

/**
 * Record a rate_limit_event's window: the fallback. Claude Code sends one when the figure changes, for the window that
 * currently binds (rateLimitType), with utilization as a fraction (0-1, from the API's rate-limit headers) and its
 * reset in seconds. Overage (extra usage) is spend, not plan, and is left out.
 */
export function recordRateLimit(info: { rateLimitType?: string; utilization?: number; resetsAt?: number } | null | undefined) {
  if (!info?.rateLimitType || info.rateLimitType === 'overage' || typeof info.utilization !== 'number') return;
  store(info.rateLimitType, info.utilization, info.resetsAt, info.utilization <= 1);
}

/**
 * Record the answer to the SDK's /usage request (Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET):
 * every plan window it lists, utilization in percent (0-100) and resets_at as ISO time. Its shape may change; anything
 * not as expected is skipped, and an answer without plan limits (API key, other providers) records nothing.
 */
export function recordPlanUsage(resp: unknown): number {
  const limits = (resp as any)?.rate_limits;
  if (!limits || typeof limits !== 'object') return 0;
  let n = 0;
  for (const [name, w] of Object.entries(limits as Record<string, any>)) {
    // Extra usage is money; the OAuth-apps window is not the plan's own use.
    if (name === 'extra_usage' || name === 'seven_day_oauth_apps' || name === 'model_scoped' || !w || typeof w !== 'object' || !('utilization' in w)) continue;
    store(name, w.utilization, w.resets_at, false);
    n++;
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const w of limits.model_scoped) {
      if (typeof w?.display_name !== 'string' || !w.display_name) continue;
      store(`model:${w.display_name}`, w.utilization, w.resets_at, false);
      n++;
    }
  }
  return n;
}

/** Ask a live session for the plan's windows at most this often (runner side). */
export const PLAN_POLL_MS = 5 * 60_000;
let lastPoll = 0;

/**
 * After a turn: ask the session for the plan's windows if the last ask was PLAN_POLL_MS ago. Never throws; an SDK
 * without the request, or one that does not answer within 20 s, leaves the last figures (and rate_limit_event) be.
 */
export async function pollPlanUsage(q: unknown): Promise<void> {
  const ask = (q as any)?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof ask !== 'function' || Date.now() - lastPoll < PLAN_POLL_MS) return;
  lastPoll = Date.now();
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 20_000)));
    const resp = await Promise.race([ask.call(q, { skipBehaviors: true }), timeout]);
    clearTimeout(timer);
    if (resp) recordPlanUsage(resp);
  } catch (err) {
    console.warn(`plan usage: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}

/** The windows known now: a window whose reset has passed is no longer known (its use started again from nothing). */
export function planWindows(at = now()): PlanWindow[] {
  return all('SELECT name, percent, resets_at, at FROM plan_usage')
    .filter((r) => r.resets_at == null || r.resets_at > at)
    .map((r) => ({ name: String(r.name), percent: Number(r.percent), resetsAt: r.resets_at == null ? null : Number(r.resets_at), at: Number(r.at) }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
const rank = (n: string) => (ORDER.includes(n) ? ORDER.indexOf(n) : ORDER.length);
