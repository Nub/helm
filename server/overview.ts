import { all, get, now } from './db.ts';
import { digest, digestSince } from './digest.ts';
import { withBusy } from './busy.ts';
import { unreadThreads } from './crossproject.ts';

/**
 * The global Home (web/src/overview.tsx, GET /api/overview): one card per project, most recent activity first, with
 * its mode, what is running now (each task with its agent's live status line), what finished since the user last
 * looked, what failed or is stuck, and its latest picture; and the digest line across all of them. Requests are the
 * page's own (/api/inbox). Only the API reads this.
 */
export type OverviewTask = { id: string; title: string; line: string };
export type OverviewProject = {
  id: string;
  name: string;
  mode: string;
  activity: number;
  since: number;
  running: OverviewTask[];
  finished: { id: string; title: string; finished_at: number; preview: OverviewPreview | null }[];
  failed: { id: string; title: string; href_kind: 'task' | 'agent' | 'release' }[];
  stuck: OverviewTask[];
  preview: OverviewPreview | null;
  /** Threads with another project's director holding a reply the user has not opened (crossproject.ts). */
  xthreads: { id: string; title: string; peer: string }[];
};
export type OverviewPreview = { id: string; kind: string; title: string; file: string | null; content: string | null };
export type Overview = {
  since: number;
  digest: { done: number; projects: number; running: number; failed: number };
  projects: OverviewProject[];
};

/** Previews whose thumbnail is a picture: an image, or a compare or guide (their JSON content names the files). */
const PICTURE_KINDS = ['image', 'compare', 'guide'];
const KINDS_IN = PICTURE_KINDS.map(() => '?').join(',');
const pictureView = (r: any): OverviewPreview | null =>
  r ? { id: String(r.id), kind: String(r.kind), title: String(r.title), file: r.file ?? null, content: r.kind === 'image' ? null : (r.content ?? null) } : null;
/** A finished task's newest picture, for its thumbnail. */
const taskPicture = (taskId: string) => pictureView(get(`SELECT id, kind, title, file, content FROM previews WHERE task_id = ? AND kind IN (${KINDS_IN}) ORDER BY created_at DESC LIMIT 1`, taskId, ...PICTURE_KINDS));

export function projectOverview(p: { id: string; name: string; mode?: string | null; updated_at: number }, at = now()): OverviewProject {
  const d = digest(p.id, at);
  const agents = all('SELECT id, name, status, task_id FROM agents WHERE project_id = ?', p.id);
  const lineOf = (taskId: string) => {
    // Its line as views show it: derived from the current tool, or what it waits on (busy.ts).
    const row = all("SELECT * FROM agents WHERE task_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1", taskId)[0];
    const a = row ? withBusy(row) : undefined;
    // A builder running it alongside its own task reports its line for it per task (agent_task_status).
    const s = get("SELECT s.status_line, s.updated_at FROM agent_task_status s JOIN agents g ON g.id = s.agent_id WHERE s.task_id = ? AND g.task_id IS NOT ? AND g.status != 'closed' AND s.status_line != '' ORDER BY s.updated_at DESC LIMIT 1", taskId, taskId);
    return String((s && (!a?.status_line || Number(s.updated_at) > Number(a.updated_at)) ? s.status_line : a?.status_line) ?? '');
  };
  const running = all("SELECT id, title FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' ORDER BY started_at DESC LIMIT 5", p.id).map((t) => ({
    id: String(t.id),
    title: String(t.title),
    line: lineOf(String(t.id)),
  }));
  const failed: OverviewProject['failed'] = [
    ...agents.filter((a) => a.status === 'error').map((a) => (a.task_id ? { id: String(a.task_id), title: `${a.name} stopped with an error`, href_kind: 'task' as const } : { id: String(a.id), title: `${a.name} stopped with an error`, href_kind: 'agent' as const })),
    ...d.failed.map((f) => ({ id: f.id, title: `${f.title} failed`, href_kind: 'release' as const })),
  ];
  // Stuck: paused by the progress check (it waits for the user's Resume), or Active with a progress flag raised.
  const stuck = all(
    "SELECT t.id, t.title FROM tasks t JOIN task_progress g ON g.task_id = t.id WHERE t.project_id = ? AND t.kind = 'task' AND (t.state = 'paused' OR (t.state = 'active' AND g.strikes > 0)) ORDER BY t.updated_at DESC LIMIT 3",
    p.id,
  ).map((t) => ({ id: String(t.id), title: String(t.title), line: '' }));
  const preview = get(
    `SELECT id, kind, title, file, content FROM previews WHERE project_id = ? AND kind IN (${PICTURE_KINDS.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
    p.id,
    ...PICTURE_KINDS,
  );
  const lastEvent = Number(get('SELECT MAX(updated_at) AS t FROM tasks WHERE project_id = ?', p.id)?.t ?? 0);
  return {
    id: p.id,
    name: p.name,
    mode: p.mode ?? 'running',
    activity: Math.max(p.updated_at ?? 0, lastEvent),
    since: d.since,
    running,
    finished: d.finished.slice(0, 5).map((t) => ({ id: t.id, title: t.title, finished_at: t.finished_at, preview: taskPicture(t.id) })),
    failed,
    stuck,
    preview: pictureView(preview),
    xthreads: unreadThreads(p.id),
  };
}

export function overview(at = now()): Overview {
  const projects = all('SELECT id, name, mode, updated_at FROM projects WHERE archived = 0').map((p) => projectOverview(p as never, at));
  projects.sort((a, b) => b.activity - a.activity);
  // "Since" for the whole page: when the user was last in Helm at all (the latest of the projects' since points).
  const since = projects.length ? Math.max(...projects.map((p) => digestSince(p.id, at))) : at - 24 * 3600_000;
  const doneIn = projects.map((p) => Number(get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND finished_at >= ?", p.id, since)?.n ?? 0));
  return {
    since,
    digest: {
      done: doneIn.reduce((a, b) => a + b, 0),
      projects: doneIn.filter((n) => n > 0).length,
      running: projects.reduce((n, p) => n + p.running.length, 0),
      failed: projects.reduce((n, p) => n + p.failed.length, 0),
    },
    projects,
  };
}
