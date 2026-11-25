import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { globMatch } from './tilescope.ts';
import { namedPaths, ownFiles } from './affects.ts';
import { USER, addTaskMessage, taskRef } from './tasks.ts';
import { DEFAULT_REASON, DEFAULT_TIER, isTier, tierName, tierUp } from './tiers.ts';

/**
 * The rules Helm enforces for the director's work (the user's plan for areas and tiers):
 * - a task names its check (how it will be shown to work) before it goes Active;
 * - every Active task has a tier: Skilled unless the director gives another with a one-line reason (no reason for
 *   Skilled: "default: hard to judge");
 * - parallel work only when it splits cleanly: a task is not made Active beside an Active task touching the same files,
 *   unless the director says why they are independent (parallel_reason, shown on both);
 * - two review rounds at most: each changes_needed moves the task up one tier; a third is refused until the director
 *   narrows the task or sets its tier;
 * - nothing moves a task to Deep by itself: escalation stops at Skilled, and Deep is the director's explicit choice for
 *   one of DEEP_REASONS, with a line saying why (Fable is for directing; work runs on Opus or below).
 */

/** The only reasons a task may run at Deep (Fable), each with its words in the task's tier reason. */
export const DEEP_REASONS = {
  system_design: 'System-wide design decision',
  survived_skilled: 'A defect that survived two Skilled attempts',
  costly_analysis: 'A proof or analysis where being wrong is very costly',
} as const;
export type DeepReason = keyof typeof DEEP_REASONS;
export const DEEP_REASON_IDS = Object.keys(DEEP_REASONS) as DeepReason[];

/**
 * A tier as the director gives it: Deep only with one of DEEP_REASONS and a line; then the tier reason to record
 * ("System-wide design decision: …"). Other tiers pass through.
 */
export function deepTier(tier: string | undefined, deepReason: string | undefined, line: string | undefined): { reason?: string } | { error: string } {
  if (tier !== 'deep') return {};
  if (!deepReason || !(deepReason in DEEP_REASONS)) {
    return { error: `Deep (Fable) is for directing, not for work: a task runs at Deep only for one of these, given as deep_reason: ${DEEP_REASON_IDS.map((k) => `${k} (${DEEP_REASONS[k]})`).join('; ')}. "Open-ended" is not enough: use Skilled, and narrow or split the task if it is too big. Nothing was changed.` };
  }
  if (!line?.trim()) return { error: 'Deep needs tier_reason too: one line on why this task meets that reason. Nothing was changed.' };
  return { reason: `${DEEP_REASONS[deepReason as DeepReason]}: ${line.trim()}` };
}

const HELM = { author: 'system' as const, name: 'Helm' };

export type Activation = { tier: string; tier_reason: string } | { error: string };

/**
 * Before `t` becomes Active (with the fields the call is about to set): its check, its tier, and what it would run
 * beside. Returns the tier to record, or why it may not start.
 */
export async function checkActivation(t: Row, next: { check?: string; tier?: string; tier_reason?: string; parallel_reason?: string; driver?: string | null }): Promise<Activation> {
  const check = (next.check ?? t.check_how ?? '').trim();
  if (!check) return { error: `${taskRef(t)} has no check yet. Give check: how it will be shown to work (a test, a command, a before/after screenshot). Nothing was changed.` };
  let tier = next.tier ?? t.tier;
  let reason = (next.tier_reason ?? (next.tier ? '' : t.tier_reason) ?? '').trim();
  if (!isTier(tier)) [tier, reason] = [DEFAULT_TIER, reason || DEFAULT_REASON];
  if (tier !== DEFAULT_TIER && !reason) return { error: `Tier ${tierName(tier)} needs tier_reason: one line on why (Routine or Light: well specified with a named check; Deep: only with deep_reason). Nothing was changed.` };
  if (tier === DEFAULT_TIER && !reason) reason = DEFAULT_REASON;
  const parallel = (next.parallel_reason ?? t.parallel_reason ?? '').trim();
  if (!parallel) {
    const beside = await overlapping({ ...t, description: t.description, check_how: check });
    if (beside.length) {
      return { error: `Not started: ${beside.map((b) => `[[${b.task.id}]] (${b.why})`).join(', ')} ${beside.length === 1 ? 'is' : 'are'} Active. Work runs in parallel only when it splits cleanly: wait for it, or give parallel_reason (one line on why they are independent). Nothing was changed.` };
    }
  }
  return { tier, tier_reason: reason };
}

/** Active tasks `t` would run beside that touch its files. */
export async function overlapping(t: Row): Promise<{ task: Row; why: string }[]> {
  const others = all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' AND id != ?", t.project_id, t.id);
  if (!others.length) return [];
  const out: { task: Row; why: string }[] = [];
  const paths = namedPaths(`${t.title}\n${t.description ?? ''}`);
  const mine = t.state === 'active' ? await ownFiles(t) : [];
  for (const o of others) {
    if (!paths.length && !mine.length) continue;
    const theirs = await ownFiles(o);
    const hit = theirs.find((f) => mine.includes(f) || paths.some((p) => p === f || globMatch(p, f)));
    if (hit) out.push({ task: o, why: `both touch ${hit}` });
  }
  return out;
}

/** Record what checkActivation decided (and the parallel reason on both tasks' threads). */
export function applyActivation(t: Row, a: { tier: string; tier_reason: string }, next: { check?: string; parallel_reason?: string }) {
  const changedTier = a.tier !== t.tier;
  run(
    'UPDATE tasks SET tier = ?, tier_reason = ?, check_how = COALESCE(?, check_how), parallel_reason = COALESCE(?, parallel_reason), rounds_from = COALESCE(rounds_from, ?) WHERE id = ?',
    a.tier, a.tier_reason, next.check?.trim() || null, next.parallel_reason?.trim() || null, now(), t.id,
  );
  if (changedTier) addTaskMessage(t, HELM, `Tier: ${tierName(a.tier)} (${a.tier_reason}).`, 'state');
}

/** The director set a task's tier or narrowed it: recorded, and its review rounds count afresh. */
export function retier(t: Row, tier: string, reason: string) {
  run('UPDATE tasks SET tier = ?, tier_reason = ?, rounds_from = ? WHERE id = ?', tier, reason, now(), t.id);
  addTaskMessage(t, HELM, `Tier set to ${tierName(tier)}${reason ? ` (${reason})` : ''}.`, 'state');
}
/**
 * The user sets a task's tier (the task page): any tier, Deep included, with no reason asked. It is pinned: update_task
 * refuses another tier and escalation leaves it. The agent on it takes the new tier at its next turn (runtime.ts
 * switchTier reads the task's tier when a message is delivered). Returns an error, or null.
 */
export function userTier(t: Row, tier: string): string | null {
  if (!isTier(tier)) return `No tier "${tier}".`;
  if (t.kind !== 'task') return 'Only tasks have a tier.';
  if (t.tier === tier && t.tier_pinned) return null;
  run("UPDATE tasks SET tier = ?, tier_reason = 'set by the user', tier_pinned = 1, rounds_from = ? WHERE id = ?", tier, now(), t.id);
  addTaskMessage(t, USER, `You set the tier to ${tierName(tier)}.`, 'state');
  return null;
}

/** Why an agent may not change `t`'s tier (the user set it), or null. */
export const tierPinnedError = (t: Row): string | null =>
  t.tier_pinned
    ? `The user set the tier of ${taskRef(t)} to ${tierName(t.tier)} themselves, so it is pinned: agents and the director cannot change it. If you think it should change, say so with your reason in its thread (task_post). Nothing was changed.`
    : null;

export const resetRounds = (taskId: string) => run('UPDATE tasks SET rounds_from = ? WHERE id = ?', now(), taskId);

/** Review rounds answered changes_needed on the task since its rounds last started counting. */
export function reviewRounds(t: Row): number {
  return Number(get("SELECT COUNT(*) AS n FROM consults WHERE task_id = ? AND kind = 'review' AND verdict = 'changes_needed' AND answered_at >= ?", t.id, t.rounds_from ?? t.started_at ?? 0)?.n ?? 0);
}
export const MAX_ROUNDS = 2;
export const ROUNDS_TEXT = 'Two review rounds at most: accept it, narrow the task (update_task description), or set its tier (update_task tier).';

/**
 * One tier up, with a line in the thread, but never to Deep: a Skilled task stays Skilled, for the director to narrow
 * or split (Deep is an explicit exception, deepTier). `why`: "after a review with changes needed".
 */
export function escalate(taskId: string, why: string): boolean {
  const t = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t || t.kind !== 'task') return false;
  const from = isTier(t.tier) ? t.tier : DEFAULT_TIER;
  const to = tierUp(from);
  if (to === from) return false;
  // A tier the user set stands (userTier).
  if (t.tier_pinned) return false;
  if (to === 'deep') {
    addTaskMessage(t, HELM, `Stays at ${tierName(from)} ${why}: Helm never moves work to Deep by itself. Narrow or split the task.`, 'state');
    return false;
  }
  run('UPDATE tasks SET tier = ?, tier_reason = ? WHERE id = ?', to, `moved up ${why}`, t.id);
  addTaskMessage(t, HELM, `Moved up from ${tierName(from)} to ${tierName(to)} ${why}.`, 'state');
  return true;
}

/**
 * Open tasks that reached Deep only by escalation (their reason says "moved up"), from before escalation stopped at
 * Skilled, go back to Skilled with a line in their thread. Idempotent. Returns how many.
 */
export function resetEscalatedDeep(): number {
  const rows = all("SELECT * FROM tasks WHERE kind = 'task' AND tier = 'deep' AND tier_reason LIKE 'moved up%' AND state IN ('active', 'scheduled', 'waiting', 'paused', 'planning')");
  for (const t of rows) {
    run("UPDATE tasks SET tier = 'skilled', tier_reason = ? WHERE id = ?", 'reset from Deep: it got there only by escalation', t.id);
    addTaskMessage(t, HELM, 'Tier set back to Skilled: it reached Deep only by escalation, and Deep (Fable) is now for directing and listed reasons only. Narrow or split it if it is too big.', 'state');
  }
  return rows.length;
}
