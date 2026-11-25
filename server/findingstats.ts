import { all, db, get, now, run } from './db.ts';
import { findingCode } from './findingcode.ts';
import type { Share } from './findingcode.ts';
import { floorOf } from './telemetryreset.ts';

/**
 * Finding code per project, this week and the week before (findingcode.ts), kept in finding_code_stats by the runner
 * every few hours: the measure reads every event of the week, a few hundred ms for a busy project, too slow for a page
 * request. The Helm page and the finding_code watch read the stored figures.
 */

db.exec(`CREATE TABLE IF NOT EXISTS finding_code_stats (
  project_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  this_week TEXT NOT NULL,
  last_week TEXT NOT NULL
)`);

const DAY = 86_400_000;
const EVERY_MS = 6 * 3600_000;

export type FindingStat = { project_id: string; name: string; at: number; thisWeek: Share; lastWeek: Share };

/** Measure one project now and keep it. */
export function refreshFindingStat(projectId: string, at = now()): FindingStat {
  const thisWeek = findingCode(all, projectId, at - 7 * DAY, at + 1).all;
  const lastWeek = findingCode(all, projectId, at - 14 * DAY, at - 7 * DAY).all;
  run('INSERT OR REPLACE INTO finding_code_stats (project_id, at, this_week, last_week) VALUES (?,?,?,?)', projectId, at, JSON.stringify(thisWeek), JSON.stringify(lastWeek));
  return { project_id: projectId, name: String(get('SELECT name FROM projects WHERE id = ?', projectId)?.name ?? projectId), at, thisWeek, lastWeek };
}

/** This week's share for a project: the stored one when it is fresh enough, else measured now. */
export function findingShareNow(projectId: string, maxAgeMs = 3600_000): number | null {
  const r = get('SELECT at, this_week FROM finding_code_stats WHERE project_id = ?', projectId);
  if (r && now() - Number(r.at) < maxAgeMs) return (JSON.parse(r.this_week) as Share).timeShare;
  return refreshFindingStat(projectId).thisWeek.timeShare;
}

/** The stored figures of every project not archived that has any, for the Helm page. */
export function findingStats(sinceReset = false): FindingStat[] {
  return all('SELECT s.*, p.name FROM finding_code_stats s JOIN projects p ON p.id = s.project_id WHERE p.archived = 0 ORDER BY p.position, p.created_at')
    .map((r) => ({ project_id: String(r.project_id), name: String(r.name), at: Number(r.at), thisWeek: JSON.parse(r.this_week), lastWeek: JSON.parse(r.last_week) }))
    .map((s) => (sinceReset ? afterReset(s) : s))
    .filter((s) => s.thisWeek.activeMs > 0 || s.lastWeek.activeMs > 0);
}

const NONE: Share = { timeShare: null, tokenShare: null, resultTokens: 0, findMs: 0, activeMs: 0, calls: 0, findCalls: 0 };
const cut = new Map<string, FindingStat>();
/**
 * The Telemetry page counts from a project's last reset (telemetryreset.ts): when it falls in the stored two weeks, both
 * weeks are measured now from it (kept ten minutes); the stored ones stay all-time.
 */
function afterReset(s: FindingStat): FindingStat {
  const floor = floorOf(s.project_id);
  const at = now();
  if (floor <= at - 14 * DAY) return s;
  const key = `${s.project_id}|${floor}|${Math.floor(at / 600_000)}`;
  const hit = cut.get(key);
  if (hit) return hit;
  const thisWeek = findingCode(all, s.project_id, Math.max(floor, at - 7 * DAY), at + 1).all;
  const lastWeek = floor >= at - 7 * DAY ? NONE : findingCode(all, s.project_id, floor, at - 7 * DAY).all;
  if (cut.size > 100) cut.clear();
  const v = { ...s, at, thisWeek, lastWeek };
  cut.set(key, v);
  return v;
}

let timer: NodeJS.Timeout | null = null;
/** Runner: every project, every six hours (the first a few minutes after start). */
export function startFindingStats() {
  if (timer) return;
  const tick = () => {
    for (const p of all('SELECT id FROM projects WHERE archived = 0')) {
      try {
        refreshFindingStat(p.id);
      } catch (err) {
        console.error(`Finding-code measure for ${p.id}:`, err);
      }
    }
  };
  timer = setInterval(tick, EVERY_MS);
  timer.unref?.();
  setTimeout(tick, 3 * 60_000).unref?.();
}
export function stopFindingStats() {
  if (timer) clearInterval(timer);
  timer = null;
}
