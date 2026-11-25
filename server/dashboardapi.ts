import type { FastifyInstance, FastifyReply } from 'fastify';
import { builderTask } from './buildtask.ts';
import { all, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getProject, touchProject } from './store.ts';
import { USER, addTaskMessage, createTask, getTask, taskRef } from './tasks.ts';
import { holdsNewWork } from './projectmode.ts';
import { sendThreadMessage } from './taskapi.ts';
import { dispatchWork, tellDirector } from './agents.ts';
import { dashboardView, dashboardsOn, dashboardsView, pinTile, removeDashboard, removeTile, reorderTiles, tileView } from './dashboards.ts';

/**
 * The Dashboards page (web/src/dashboards.tsx). The user describes a dashboard and asks for changes in words; the
 * director builds them (a scheduled task each). The user can also rename, reorder, remove and pin, and ask the
 * director to refresh a tile. Nothing here runs a recipe.
 */

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}
const OPEN = ['planning', 'waiting', 'scheduled', 'active', 'paused'];

/** A short title from the user's description until the director names it. */
export function titleFrom(description: string): string {
  const first = description.trim().split(/\n|(?<=[.!?])\s/)[0].trim().replace(/[.!?:]+$/, '');
  return first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, '')}…` : first || 'New dashboard';
}

export function registerDashboardApi(app: FastifyInstance) {
  app.get('/api/projects/:id/dashboards', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return dashboardsView(project.id);
  });

  app.get('/api/tiles/:id', async (req, reply) => {
    const t = get('SELECT * FROM tiles WHERE id = ?', (req.params as any).id);
    if (!t) return bad(reply, 'No such tile', 404);
    return tileView(t, true);
  });

  /** "New dashboard": the user's description becomes a dashboard being built and a scheduled task for the director. */
  app.post('/api/projects/:id/dashboards', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    if (!dashboardsOn(project.id)) return bad(reply, 'Dashboards are off for this project (Setup › Agent context).');
    const b = (req.body ?? {}) as Record<string, any>;
    const description = String(b.description ?? '').trim();
    if (description.length < 8) return bad(reply, 'Describe what the dashboard should show.');
    if (description.length > 4000) return bad(reply, 'Keep the description under 4000 characters.');
    const title = String(b.title ?? '').trim().slice(0, 120) || titleFrom(description);
    const id = newId('dash');
    // Agreed work, not a Spec edit: Scheduled, so the director takes it up in queue order without an approval step.
    // Winding down, at rest or stopped (projectmode.ts): Waiting, like any new task, until the user resumes.
    const held = holdsNewWork(project.id);
    const task = createTask(
      project.id,
      { title: `Dashboard: ${title}`, description: `What the user asked for:\n\n${description}\n\nThis task's thread is the dashboard's thread: ask for changes here. [[page:dashboards]]`, state: held ? 'waiting' : 'scheduled', origin: 'user' },
      USER,
    );
    if (held) addTaskMessage(task, { author: 'system', name: 'Helm' }, 'Added as Waiting: the project is not running. Schedule it once you resume.', 'state');
    const pos = ((get('SELECT MAX(position) AS m FROM dashboards WHERE project_id = ?', project.id)?.m as number) ?? 0) + 1;
    run(
      'INSERT INTO dashboards (id, project_id, title, description, state, task_id, position, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, project.id, title, description, 'building', task.id, pos, 'user', now(), now(),
    );
    await tellDirector(
      project.id,
      `The user described a dashboard they want: ${taskRef(task)}, dashboard "${title}" [${id}], now shown as being built.\n\nTheir words:\n${description}\n\n` +
        (held ? 'The project is winding down, at rest or stopped, so this waits: do not start it until the user resumes and schedules it. ' : '') + `Helm starts a fresh builder on it in queue order: it designs the tiles (set_tile with kind, depends_on and recipe for each), writes the recipes and produces the first data (update_tile). You own the result: answer its questions, ask the user only what neither of you can decide, check it against their words, rename it with set_dashboard if a better title fits, and mark it ready (set_dashboard state ready).`,
    );
    if (!held) dispatchWork(project.id);
    touchProject(project.id);
    return { id, task_id: task.id };
  });

  app.patch('/api/dashboards/:id', async (req, reply) => {
    const d = get('SELECT * FROM dashboards WHERE id = ?', (req.params as any).id);
    if (!d) return bad(reply, 'No such dashboard', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120)) return bad(reply, 'A title is 1 to 120 characters.');
    if (b.order !== undefined) {
      if (!Array.isArray(b.order) || b.order.some((x: unknown) => typeof x !== 'string')) return bad(reply, 'order is a list of tile ids.');
      const err = reorderTiles(d, b.order);
      if (err) return bad(reply, err);
    }
    if (b.title !== undefined) run('UPDATE dashboards SET title = ?, updated_at = ? WHERE id = ?', b.title.trim(), now(), d.id);
    touchProject(d.project_id);
    return dashboardView(get('SELECT * FROM dashboards WHERE id = ?', d.id)!);
  });

  app.delete('/api/dashboards/:id', async (req, reply) => {
    const d = get('SELECT * FROM dashboards WHERE id = ?', (req.params as any).id);
    if (!d) return bad(reply, 'No such dashboard', 404);
    removeDashboard(d);
    const task = d.task_id ? getTask(d.task_id) : undefined;
    if (task && OPEN.includes(task.state)) await tellDirector(d.project_id, `The user removed the dashboard "${d.title}" that ${taskRef(task)} was for. Stop work on it and settle that task.`);
    touchProject(d.project_id);
    return { ok: true };
  });

  /** "Change this dashboard": to the director in the dashboard's task thread, or a new scheduled task once that is finished. */
  app.post('/api/dashboards/:id/change', async (req, reply) => {
    const d = get('SELECT * FROM dashboards WHERE id = ?', (req.params as any).id);
    if (!d) return bad(reply, 'No such dashboard', 404);
    const text = String((req.body as any)?.text ?? '').trim();
    if (!text) return bad(reply, 'Say what to add, change or drop.');
    const open = d.task_id ? getTask(d.task_id) : undefined;
    if (open && OPEN.includes(open.state)) {
      await sendThreadMessage(open, `Change to the dashboard "${d.title}" [${d.id}]: ${text}`, []);
      return { task_id: open.id };
    }
    const held = holdsNewWork(d.project_id);
    const task = createTask(
      d.project_id,
      { title: `Change dashboard: ${d.title}`, description: `What the user asked for:\n\n${text}\n\nThe dashboard was built for: ${d.description}\n\n[[page:dashboards]]`, state: held ? 'waiting' : 'scheduled', origin: 'user' },
      USER,
    );
    if (held) addTaskMessage(task, { author: 'system', name: 'Helm' }, 'Added as Waiting: the project is not running. Schedule it once you resume.', 'state');
    run("UPDATE dashboards SET task_id = ?, updated_at = ? WHERE id = ?", task.id, now(), d.id);
    await tellDirector(
      d.project_id,
      `The user asked for a change to the dashboard "${d.title}" [${d.id}]: ${taskRef(task)}.\n\nTheir words:\n${text}\n\nHelm starts a fresh builder on it to adjust the tiles (set_tile, update_tile); check the result against their words. ${held ? 'The project is not running, so this waits until the user resumes and schedules it.' : 'It runs in queue order.'}`,
    );
    if (!held) dispatchWork(d.project_id);
    touchProject(d.project_id);
    return { task_id: task.id };
  });

  app.patch('/api/tiles/:id', async (req, reply) => {
    const t = get('SELECT * FROM tiles WHERE id = ?', (req.params as any).id);
    if (!t) return bad(reply, 'No such tile', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120)) return bad(reply, 'A title is 1 to 120 characters.');
    if (b.pinned !== undefined) {
      const err = pinTile(t, !!b.pinned);
      if (err) return bad(reply, err);
    }
    if (b.title !== undefined) run('UPDATE tiles SET title = ?, updated_at = ? WHERE id = ?', b.title.trim(), now(), t.id);
    touchProject(t.project_id);
    return tileView(get('SELECT * FROM tiles WHERE id = ?', t.id)!);
  });

  app.delete('/api/tiles/:id', async (req, reply) => {
    const t = get('SELECT * FROM tiles WHERE id = ?', (req.params as any).id);
    if (!t) return bad(reply, 'No such tile', 404);
    removeTile(t);
    touchProject(t.project_id);
    return { ok: true };
  });

  /** "Ask the director to refresh": a note naming the tile, why it may be out of date, and its recipe. */
  app.post('/api/tiles/:id/ask-refresh', async (req, reply) => {
    const t = get('SELECT * FROM tiles WHERE id = ?', (req.params as any).id);
    if (!t) return bad(reply, 'No such tile', 404);
    const d = get('SELECT title FROM dashboards WHERE id = ?', t.dashboard_id);
    const note = String((req.body as any)?.note ?? '').trim().slice(0, 600);
    const v = tileView(t);
    const why = v.stale ? `It is Stale: ${v.stale.reason}.` : v.error ? `Its last refresh failed: ${v.error.message}.` : 'It is not marked stale.';
    // A fresh builder runs the recipe (buildtask.ts), at Routine: the director does not build.
    refreshTask(t.project_id, t.dashboard_id, d?.title ?? '', [t], `The user asked to refresh the tile "${t.title}" [${t.id}] on the dashboard "${d?.title ?? ''}". ${why}${note ? ` They said: ${note}` : ''} Its recipe and dependencies are in list_dashboards: run the recipe and send the result with update_tile${t.expensive ? ' (it is expensive: the user asked, so it is worth it now)' : ''}.`);
    run('UPDATE tiles SET asked_at = ? WHERE id = ?', now(), t.id);
    touchProject(t.project_id);
    return { ok: true };
  });

  /** "Refresh" on a whole dashboard: one note to the director naming every tile not already asked for. */
  app.post('/api/dashboards/:id/ask-refresh', async (req, reply) => {
    const d = get('SELECT * FROM dashboards WHERE id = ?', (req.params as any).id);
    if (!d) return bad(reply, 'No such dashboard', 404);
    const tiles = all('SELECT * FROM tiles WHERE dashboard_id = ? ORDER BY position', d.id).filter((t: any) => !t.asked_at);
    if (!tiles.length) return { ok: true, asked: 0 };
    const lines = tiles.map((t: any) => {
      const v = tileView(t);
      return `- "${t.title}" [${t.id}]${t.expensive ? ' (expensive)' : ''}${v.stale ? `: Stale, ${v.stale.reason}` : v.error ? `: last refresh failed, ${v.error.message}` : ''}`;
    });
    refreshTask(d.project_id, d.id, d.title, tiles, `The user asked to refresh every tile on the dashboard "${d.title}" [${d.id}], whether or not it is marked stale (expensive ones too: they asked).\n${lines.join('\n')}\n\nTheir recipes and dependencies are in list_dashboards: run each recipe and send each result with update_tile.`);
    run('UPDATE tiles SET asked_at = ? WHERE dashboard_id = ? AND asked_at IS NULL', now(), d.id);
    touchProject(d.project_id);
    return { ok: true, asked: tiles.length };
  });
}

/**
 * A refresh the user asked for: a Scheduled task at Routine whose brief names the tiles, done by a fresh builder
 * (buildtask.ts); its task may edit the dashboard's tiles (allow_tasks).
 */
function refreshTask(projectId: string, dashboardId: string, title: string, tiles: Row[], brief: string): Row {
  const t = builderTask(projectId, {
    title: tiles.length === 1 ? `Refresh tile: ${tiles[0].title}` : `Refresh dashboard: ${title}`,
    brief,
    touches: [`dashboards/${dashboardId}`],
    check: `update_tile sent for ${tiles.map((x) => x.id).join(', ')}`,
    tier: 'routine',
    tierReason: 'running a tile recipe with a named check',
  });
  const d = get('SELECT allow_tasks FROM dashboards WHERE id = ?', dashboardId);
  const allowed = (() => { try { return JSON.parse(d?.allow_tasks || '[]') as string[]; } catch { return []; } })();
  run('UPDATE dashboards SET allow_tasks = ? WHERE id = ?', JSON.stringify([...allowed, t.id].slice(-10)), dashboardId);
  return t;
}
