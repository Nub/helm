import { all, db, get, now, run } from './db.ts';

/**
 * Telemetry resets: the user starts the Telemetry views fresh, for one project or for all of them, without deleting
 * anything. Each reset is a row (when, who, which project; NULL for all). A project's views count only data after its
 * floor: the later of its own last reset and the last reset of all projects. "Show all time" ignores the floor for
 * that view only. Per-task telemetry (a task page) never looks at it.
 */

db.exec(`CREATE TABLE IF NOT EXISTS telemetry_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  at INTEGER NOT NULL,
  who TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_resets_project ON telemetry_resets(project_id, at);`);

export type Reset = { project_id: string | null; at: number; who: string };

/** Record a reset (projectId null: all projects). Nothing is deleted. */
export function recordReset(projectId: string | null, who = 'user', at = now()): Reset {
  run('INSERT INTO telemetry_resets (project_id, at, who) VALUES (?, ?, ?)', projectId, at, who);
  return { project_id: projectId, at, who };
}

/** A project's floor (0 when never reset); with null, the last reset of all projects only. */
export function resetFloor(projectId: string | null): number {
  const r = projectId
    ? get('SELECT MAX(at) AS at FROM telemetry_resets WHERE project_id IS NULL OR project_id = ?', projectId)
    : get('SELECT MAX(at) AS at FROM telemetry_resets WHERE project_id IS NULL');
  return Number(r?.at ?? 0);
}

/** The floor of a view: 0 under "Show all time". */
export const floorOf = (projectId: string | null, allTime?: boolean) => (allTime ? 0 : resetFloor(projectId));

/**
 * SQL that keeps a row only when `timeCol` is at or after its project's floor (`projCol` names the row's project), so
 * a view over all projects honours each project's own reset. Empty under "Show all time".
 */
export function sinceSql(timeCol: string, projCol: string, allTime?: boolean): string {
  if (allTime) return '';
  return ` AND ${timeCol} >= COALESCE((SELECT MAX(rs.at) FROM telemetry_resets rs WHERE rs.project_id IS NULL OR rs.project_id = ${projCol}), 0)`;
}

/** Every project's floor that is set (the reset of all projects included), for views that filter in code. */
export function floors(): Map<string, number> {
  const global = resetFloor(null);
  const out = new Map<string, number>();
  for (const p of all('SELECT id FROM projects')) {
    const f = Math.max(global, Number(get('SELECT MAX(at) AS at FROM telemetry_resets WHERE project_id = ?', p.id)?.at ?? 0));
    if (f) out.set(String(p.id), f);
  }
  return out;
}

/**
 * What the page says above the numbers: the reset that applies to the view (a project's, or that of all projects), and
 * how many projects have one of their own (shown when viewing all projects with no reset of all).
 */
export function resetInfo(projectId: string | null): { at: number; who: string; scope: 'project' | 'all' } | null {
  const r = projectId
    ? get('SELECT project_id, at, who FROM telemetry_resets WHERE project_id IS NULL OR project_id = ? ORDER BY at DESC, id DESC LIMIT 1', projectId)
    : get('SELECT project_id, at, who FROM telemetry_resets WHERE project_id IS NULL ORDER BY at DESC, id DESC LIMIT 1');
  return r ? { at: Number(r.at), who: String(r.who), scope: r.project_id ? 'project' : 'all' } : null;
}
export const projectsReset = (): number => Number(get('SELECT COUNT(DISTINCT project_id) AS n FROM telemetry_resets WHERE project_id IS NOT NULL')?.n ?? 0);
