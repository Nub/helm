import { useLive } from './api';
import { href } from './ui';
import { dateTime } from './time';
import { compactNumber, planLines } from './usage.ts';
import type { PlanWindow } from './usage.ts';

/** "Plan: 42% used · resets 4:00 pm", one muted line per plan window the runner has seen (server/usage.ts). */
export function PlanLine({ className = '' }: { className?: string }) {
  const plan = useLive<{ windows: PlanWindow[] }>('/api/plan', (m) => m.type === 'projects').data;
  const lines = planLines(plan?.windows ?? []);
  if (!lines.length) return null;
  return (
    <p className={`muted small plan-line ${className}`}>
      {lines.map((l, i) => (
        <span key={i} className="one-line">{l}</span>
      ))}
    </p>
  );
}

type Summary = { id: number; project_id: string; project_name: string | null; agent_id: string; agent_name: string | null; at: number; pre_tokens: number | null; post_tokens: number | null; saved_first: number };

/**
 * Context summaries (server/contextsave.ts): when Claude summarised an agent's context, and how much it held before
 * and after; "not saved first" when the save turn did not come before it.
 */
export function ContextSummaries() {
  const list = useLive<{ summaries?: Summary[] }>('/api/plan', (m) => m.type === 'projects').data?.summaries ?? [];
  if (!list.length) return null;
  return (
    <>
      <h2>Context summaries</h2>
      <ul className="card context-summaries small">
        {list.map((s) => (
          <li key={s.id}>
            <a className="one-line" href={href('p', s.project_id, 'agents', s.agent_id)}>
              {s.agent_name ?? 'Agent'}
              <span className="muted"> · {s.project_name}</span>
            </a>
            <span className="muted mono">
              {compactNumber(s.pre_tokens ?? 0)} → {compactNumber(s.post_tokens ?? 0)}
            </span>
            <span className="muted">
              {dateTime(s.at)}
              {s.saved_first ? '' : ' · not saved first'}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

type Share = { timeShare: number | null; tokenShare?: number | null; findMs: number; activeMs: number };
type FindingStat = { project_id: string; name: string; at: number; thisWeek: Share; lastWeek: Share };

/**
 * Time finding code (server/findingcode.ts): per project, the share of agents' active time spent searching and reading
 * code they did not then change, this week, with last week beside it; then the share of all the tokens used that went
 * into finding-code results, when it can be had.
 */
export function FindingCode({ src = '/api/plan' }: { src?: string } = {}) {
  const list = useLive<{ finding?: FindingStat[] }>(src, (m) => m.type === 'projects').data?.finding ?? [];
  if (!list.length) return null;
  return (
    <>
      <h2>Time finding code</h2>
      <ul className="card finding-code small">
        {list.map((f) => {
          const now = f.thisWeek.timeShare;
          const before = f.lastWeek.timeShare;
          const tokens = f.thisWeek.tokenShare;
          return (
            <li key={f.project_id}>
              <a className="one-line" href={href('p', f.project_id, 'overview')}>
                {f.name}
              </a>
              <b className={`mono ${now != null && now > 15 ? 'warn' : ''}`}>{now == null ? '–' : `${now}%`}</b>
              <span className="muted">
                of agent time{before != null ? ` · last week ${before}%` : ''}
                {tokens != null ? ` · ${tokens}% of all tokens` : ''}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="muted small">Last 7 days: time spent searching and reading code not then changed; tokens are those results over all tokens used (at least).</p>
    </>
  );
}

const TIER_ORDER: [string, string][] = [['light', 'Light'], ['routine', 'Routine'], ['skilled', 'Skilled'], ['deep', 'Deep']];

/** Tokens used per work tier (server/tiers.ts, usage.ts), one muted line: "By tier: Light 12k · Skilled 2.1M". */
export function TierUsageLine({ src = '/api/plan' }: { src?: string } = {}) {
  const by = useLive<{ by_tier?: Record<string, number> }>(src, (m) => m.type === 'projects').data?.by_tier ?? {};
  const parts = TIER_ORDER.filter(([id]) => by[id]).map(([id, n]) => `${n} ${compactNumber(by[id])}`);
  if (!parts.length) return null;
  return (
    <p className="muted small plan-line">
      <span className="one-line">By tier: {parts.join(' · ')}</span>
    </p>
  );
}
