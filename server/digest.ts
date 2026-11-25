import { all, get, now } from './db.ts';
import { presence } from './sessions.ts';

/**
 * Home's digest, "since you were last here" (web/src/home.tsx Digest): from the end of the user's last session (or,
 * during the first session, its start; with no session at all, the last day), the tasks that finished and the
 * releases that failed. What is running and what needs the user the page reads from the project's state, which is live.
 * Only the API reads this (not the runner).
 */
export type Digest = {
  since: number;
  finished: { id: string; title: string; finished_at: number }[];
  failed: { kind: 'release'; id: string; title: string; at: number }[];
};

export function digestSince(projectId: string, at = now()): number {
  const p = presence(projectId);
  if (p.state === 'away' && p.since) return p.since;
  const last = get('SELECT ended_at FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1', projectId);
  if (last?.ended_at) return last.ended_at;
  return p.since ?? at - 24 * 3600_000;
}

export function digest(projectId: string, at = now()): Digest {
  const since = digestSince(projectId, at);
  const finished = all(
    "SELECT id, title, finished_at FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND finished_at >= ? ORDER BY finished_at DESC LIMIT 50",
    projectId,
    since,
  ) as Digest['finished'];
  const failed = all("SELECT id, version, updated_at FROM releases WHERE project_id = ? AND state = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 10", projectId, since).map(
    (r) => ({ kind: 'release' as const, id: r.id, title: `Release ${r.version}`, at: r.updated_at }),
  );
  return { since, finished, failed };
}
