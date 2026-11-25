import { all, get, run } from './db.ts';
import type { Row } from './db.ts';

/**
 * Work tiers: what a piece of work costs. One table per install (tiers), edited by the user only (the API). Model and
 * effort live only here: a task carries a tier, and the agent working on it runs at that tier's model and effort
 * (runtime.ts; a resumed session takes the new model). The director always runs at the strongest tier, quick helpers
 * at the lightest. Skilled is the default when the director has no clear case ("default: hard to judge").
 */

export const TIER_IDS = ['light', 'routine', 'skilled', 'deep'] as const;
export type TierId = (typeof TIER_IDS)[number];
export type Tier = { id: TierId; name: string; model: string; effort: string };

export const DEFAULT_TIER: TierId = 'skilled';
export const DEFAULT_REASON = 'default: hard to judge';
export const STRONGEST: TierId = 'deep';
export const LIGHTEST: TierId = 'light';

const NAMES: Record<TierId, string> = { light: 'Light', routine: 'Routine', skilled: 'Skilled', deep: 'Deep' };
/** Effort '' is the model's own default. */
export const TIER_DEFAULTS: Tier[] = [
  { id: 'light', name: 'Light', model: 'claude-haiku-5-5', effort: 'low' },
  { id: 'routine', name: 'Routine', model: 'claude-sonnet-5-5', effort: 'medium' },
  { id: 'skilled', name: 'Skilled', model: 'claude-opus-5-5', effort: '' },
  { id: 'deep', name: 'Deep', model: 'claude-fable-5-2', effort: '' },
];

export const isTier = (x: unknown): x is TierId => typeof x === 'string' && (TIER_IDS as readonly string[]).includes(x);
export const tierName = (id: string) => NAMES[id as TierId] ?? id;

/** The four tiers as the user set them (defaults for any row not set). */
export function getTiers(): Tier[] {
  const set = new Map(all('SELECT id, model, effort FROM tiers').map((r) => [r.id as string, r]));
  return TIER_DEFAULTS.map((d) => {
    const r = set.get(d.id);
    return r ? { ...d, model: String(r.model), effort: String(r.effort ?? '') } : { ...d };
  });
}
export const tierOf = (id: string | null | undefined): Tier => getTiers().find((t) => t.id === id) ?? getTiers().find((t) => t.id === DEFAULT_TIER)!;

/** The user changes a tier's model or effort. Returns an error, or null. */
export function setTier(id: string, model: string, effort: string, models: string[], efforts: readonly string[]): string | null {
  if (!isTier(id)) return `No tier "${id}". Tiers: ${TIER_IDS.join(', ')}.`;
  if (!models.includes(model)) return `Unknown model "${model}". Use one of: ${models.join(', ')}.`;
  if (!efforts.includes(effort)) return `Unknown effort "${effort}". Use one of: ${efforts.map((e) => `"${e}"`).join(', ')} ("" is the model's default).`;
  run('INSERT OR REPLACE INTO tiers (id, model, effort) VALUES (?, ?, ?)', id, model, effort);
  return null;
}

/** One tier up (Deep stays Deep). */
export const tierUp = (id: string | null | undefined): TierId => TIER_IDS[Math.min(TIER_IDS.length - 1, TIER_IDS.indexOf((isTier(id) ? id : DEFAULT_TIER) as TierId) + 1)];

/** The tier closest to a role's model and effort: for converting roles to areas. */
export function nearestTier(model: string | undefined, effort: string | undefined): TierId {
  const m = String(model ?? '');
  if (m.includes('haiku')) return 'light';
  if (m.includes('sonnet')) return 'routine';
  if (m.includes('fable')) return 'deep';
  if (m.includes('opus')) return effort === 'max' || effort === 'xhigh' ? 'deep' : 'skilled';
  return DEFAULT_TIER;
}

/**
 * The tier an agent runs at now: the director the strongest, a quick helper the lightest, an area agent its current
 * task's tier, else its area's default tier, else Skilled.
 */
export function agentTier(agent: Row, opts: { root: boolean; quick: boolean; areaTier?: string }): TierId {
  if (opts.root) return STRONGEST;
  if (opts.quick) return LIGHTEST;
  const t = agent.task_id ? get('SELECT tier FROM tasks WHERE id = ?', agent.task_id)?.tier : null;
  if (isTier(t)) return t;
  return isTier(opts.areaTier) ? opts.areaTier : DEFAULT_TIER;
}
