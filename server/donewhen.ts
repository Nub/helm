import type { Row } from './db.ts';

/** A task's "## Done when" list and its ticks (tasks.done_when_ticks). Pure; taskstatus.ts re-exports it. */

/** The items of the description's "## Done when" list, in order (bullets or numbers), without their markers. */
export function doneWhenItems(description: string | null | undefined): string[] {
  const text = String(description ?? '');
  const head = /^#{1,3}\s*Done when\s*:?\s*$/im.exec(text);
  if (!head) return [];
  const rest = text.slice(head.index + head[0].length);
  const end = /^#{1,3}\s/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest)
    .split('\n')
    .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(l)?.[1]?.trim() ?? '')
    .filter(Boolean);
}

export const doneWhenTicks = (t: Row): number[] => {
  try {
    const v = JSON.parse(t.done_when_ticks || '[]');
    return Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
};

/**
 * A task's progress (0-100) from what Helm can count, or null: its Done when ticks out of its items, and its worklist's
 * progress (`worklist`, from checklistProgress); with both, their mean.
 */
export function taskProgress(t: Row | undefined, worklist: number | null): number | null {
  const n = t ? doneWhenItems(t.description).length : 0;
  if (!n) return worklist;
  const ticked = doneWhenTicks(t!).filter((x) => x >= 1 && x <= n).length;
  const dw = Math.round((100 * ticked) / n);
  return worklist === null ? dw : Math.round((dw + worklist) / 2);
}
