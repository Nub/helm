// Token counts and the plan's usage windows as short muted text (server/usage.ts records them).
import { when } from './time.ts';

/** "980", "12.3k", "1.2M": tokens in a few characters. */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  const short = (v: number, unit: string) => `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)}${unit}`;
  if (a < 1000) return String(Math.round(n));
  if (a < 999_500) return short(n / 1000, 'k');
  if (a < 999_500_000) return short(n / 1e6, 'M');
  return short(n / 1e9, 'B');
}

/** "1.2M tokens", or null when nothing was recorded. */
export const tokensText = (n: number | null | undefined) => (n ? `${compactNumber(n)}\u00a0tokens` : null); // never split across lines

/** A plan window from /api/plan: percent used (0-100), when it resets and when that was read (ms). */
export type PlanWindow = { name: string; percent: number; resetsAt: number | null; at?: number };

const LABEL: Record<string, string> = {
  five_hour: 'Plan',
  seven_day: 'Plan (week)',
  seven_day_opus: 'Plan (week, Opus)',
  seven_day_sonnet: 'Plan (week, Sonnet)',
};

/** A figure read longer ago than this says when it was read. */
const STALE_MS = 15 * 60_000;

/** "Plan: 42% used · resets 4:00 pm", one per window that is known; "· as of 3:10 pm" when read over 15 min ago. */
export function planLines(windows: PlanWindow[], now = Date.now()): string[] {
  return windows.map((w) => {
    const model = w.name.startsWith('model:') ? w.name.slice(6) : null;
    const label = LABEL[w.name] ?? (model ? `Plan (week, ${model})` : `Plan (${w.name.replace(/_/g, ' ')})`);
    const reset = w.resetsAt ? ` · resets ${when(w.resetsAt, now)}` : '';
    const asOf = w.at && now - w.at > STALE_MS ? ` · as of ${when(w.at, now)}` : '';
    return `${label}: ${Math.round(w.percent)}% used${reset}${asOf}`;
  });
}
