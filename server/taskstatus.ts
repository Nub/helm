import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { workView } from './tasks.ts';
import { taskTokens } from './usage.ts';
import { relatedHits } from './related.ts';
import { doneWhenItems, doneWhenTicks } from './donewhen.ts';

export { doneWhenItems, doneWhenTicks };

/**
 * What the task page's Status section needs beyond the task view (web/src/tasks.tsx TaskStatus): its "Done when"
 * items with the ticks agents set (update_task done_when), the median work time and tokens of similar finished tasks,
 * and the latest number of a dashboard tile the task refreshed or owns.
 */

/** Record which Done when items are met (1-based numbers, replacing the list). Returns an error, or null. */
export function setDoneWhen(t: Row, numbers: number[]): string | null {
  const items = doneWhenItems(t.description);
  if (!items.length) return 'Its description has no "## Done when" list to tick.';
  const bad = numbers.filter((n) => n < 1 || n > items.length);
  if (bad.length) return `Done when has ${items.length} item${items.length === 1 ? '' : 's'}; ${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not among them.`;
  run('UPDATE tasks SET done_when_ticks = ?, updated_at = ? WHERE id = ?', JSON.stringify([...new Set(numbers)].sort((a, b) => a - b)), now(), t.id);
  return null;
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** At least this many similar finished tasks, or the median uses the project's recent finished tasks instead. */
export const SIMILAR_MIN = 3;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Row | null }>();

/** Median work time and tokens of similar finished tasks (related.ts), else of the project's last 20 finished ones. */
export function similarMedian(t: Row): { work_ms: number | null; tokens: number | null; n: number; basis: 'similar' | 'recent' } | null {
  const hit = cache.get(t.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as never;
  let basis: 'similar' | 'recent' = 'similar';
  let rows = relatedHits(t, 12)
    .filter((h) => h.kind === 'task')
    .map((h) => get('SELECT * FROM tasks WHERE id = ?', h.row.id))
    .filter((r): r is Row => !!r && r.state === 'done');
  if (rows.length < SIMILAR_MIN) {
    basis = 'recent';
    rows = all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND id != ? ORDER BY finished_at DESC LIMIT 20", t.project_id, t.id);
  }
  const value = rows.length < SIMILAR_MIN ? null : { work_ms: median(rows.map((r) => workView(r).work_ms ?? 0)), tokens: median(rows.map((r) => taskTokens(r.id))), n: rows.length, basis };
  if (cache.size > 500) cache.clear();
  cache.set(t.id, { at: Date.now(), value });
  return value;
}

/** The newest number a tile showed after this task refreshed it, else the first number tile of the task's own dashboard. */
export function taskTileNumber(taskId: string): { tile: string; title: string; value: number; unit: string } | null {
  const h = get("SELECT h.data, t.id, t.title FROM tile_history h JOIN tiles t ON t.id = h.tile_id WHERE h.task_id = ? AND t.kind = 'number' ORDER BY h.id DESC LIMIT 1", taskId)
    ?? get("SELECT t.data, t.id, t.title FROM tiles t JOIN dashboards d ON d.id = t.dashboard_id WHERE d.task_id = ? AND t.kind = 'number' AND t.data IS NOT NULL ORDER BY t.position LIMIT 1", taskId);
  if (!h) return null;
  try {
    const d = JSON.parse(h.data);
    return typeof d?.value === 'number' ? { tile: h.id, title: h.title, value: d.value, unit: String(d.unit ?? '') } : null;
  } catch {
    return null;
  }
}

export function taskStatus(t: Row) {
  const ticks = doneWhenTicks(t);
  return {
    done_when: doneWhenItems(t.description).map((text, i) => ({ text, done: ticks.includes(i + 1) })),
    median: t.state === 'done' || t.state === 'dropped' ? null : similarMedian(t),
    tile: taskTileNumber(t.id),
  };
}
