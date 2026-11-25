import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getProject, touchProject } from './store.ts';
import { addTaskMessage, createTask, findTask, taskRef } from './tasks.ts';
import { clockText } from './clock.ts';
import {
  MAX_TEXT_CHARS,
  OFF_TEXT,
  TILE_KINDS,
  createDashboard,
  currentCommit,
  dashboardsOn,
  getDashboard,
  getTile,
  markError,
  mayEditTiles,
  pinTile,
  recordData,
  removeDashboard,
  removeTile,
  renderDashboards,
  reorderTiles,
  saveTile,
  shapeFor,
  storeFile,
  storeHtml,
  tilesOf,
  validateData,
} from './dashboards.ts';
import { resolveCheck, reviewScope, scopeRows, scopeText } from './tilescope.ts';
import { applySections, isAnimated, lintDashboard, lintText, storeCompare, validateKey } from './dashrules.ts';
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { ScopeRow } from './tilescope.ts';
import type { RuntimeApi, ToolAccess } from './tools.ts';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

const depsSchema = z
  .object({
    paths: z.array(z.string().min(1).max(300)).max(40).optional().describe('Globs relative to the repository root: * and ? within a folder, ** across folders, {a,b}; a folder name covers everything under it. E.g. "levels/forest/**", "src/render/{settings,shaders}/**"'),
    docs: z.array(z.string()).max(20).optional().describe('Spec entry ids whose change affects it'),
    tags: z.array(z.string()).max(10).optional().describe('Spec tags: a change to an entry with one of them affects it'),
  })
  .describe('What the tile depends on: a task that changes any of it is asked to refresh the tile');
const recipeSchema = z
  .object({
    command: z.string().min(1).max(4000).describe('The exact command(s) or steps that produce the data or image, so any later agent refreshes it the same way'),
    cwd: z.string().min(1).max(500).describe('Folder to run it in, relative to the repository root ("." for the root)'),
    host: z.string().max(80).optional().describe('Host it needs (list_hosts); leave out when it runs where the agent runs'),
    duration: z.string().max(40).optional().describe('How long it takes, e.g. "20 s", "15 min"'),
    notes: z.string().max(2000).optional().describe('What to check in the output, how to turn it into the tile\'s data, pitfalls'),
  })
  .describe('How to refresh the tile');

/** The project's top-level agent (the director), if it is open. */
function director(projectId: string): Row | undefined {
  return get("SELECT id FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", projectId);
}

/** Tells the director (unless it is the caller) that expensive tiles went Stale because of a task. */
export function noteExpensive(rt: RuntimeApi, callerId: string, projectId: string, rows: ScopeRow[]) {
  if (!rows.length) return;
  const root = director(projectId);
  if (!root || root.id === callerId) return;
  const task = get('SELECT id, title FROM tasks WHERE id = ?', rows[0].task_id);
  const text = `Dashboards: ${task ? taskRef(task) : 'a task'} changed what ${rows.length === 1 ? 'an expensive tile depends' : 'expensive tiles depend'} on, so ${rows.length === 1 ? 'it is' : 'they are'} Stale: ${rows.map((r) => `"${r.tile.title}" [${r.tile_id}] on "${r.dashboard.title}"`).join(', ')}. Expensive tiles are refreshed only when you ask: batch them when it is worth it (an agent runs the recipe from list_dashboards and calls update_tile).`;
  void rt.send(root.id, `<helm-note kind="dashboards">${text}</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
}

/** The dashboard tools. list_dashboards, update_tile and set_tile for everyone (set_tile checks who may); the rest for managers. */
export function dashboardTools(agentId: string, rt: RuntimeApi, access: ToolAccess) {
  const me = () => get('SELECT * FROM agents WHERE id = ?', agentId)!;
  const pid = () => me().project_id as string;
  const tz = (ts: number) => clockText(ts);
  const by = () => ({ id: agentId, name: me().name as string });

  /** Still unanswered for this agent's task, as a line for results. */
  const left = () => {
    const a = me();
    if (!a.task_id) return '';
    const rows = scopeRows(a.task_id).filter((r) => r.status === 'pending');
    return rows.length ? `\n\nStill to answer for your task: ${rows.map((r) => `"${r.tile.title}" [${r.tile_id}]`).join(', ')}.` : '';
  };

  const tools: any[] = [
    tool(
      'list_dashboards',
      "See the project's dashboards: each tile's kind, state (current, Stale and why, last refresh failed), what its data was built from (commit, time, agent, task), what it depends on, its recipe (the exact command, folder, host and duration to refresh it) and whether it is expensive. Also what your task still has to answer about tiles it affected.",
      { dashboard: z.string().optional().describe('Only this dashboard (id or title)'), stale: z.boolean().optional().describe('Only Stale tiles') },
      async ({ dashboard, stale }) => {
        if (!dashboardsOn(pid())) return fail(OFF_TEXT);
        const a = me();
        const mine = a.task_id ? scopeRows(a.task_id) : [];
        return ok(renderDashboards(pid(), tz, dashboard, stale) + (mine.length ? `\n\nTiles your task [[${a.task_id}]] affected:\n${scopeText(a.task_id)}` : ''));
      },
    ),
    tool(
      'update_tile',
      `Send one dashboard tile new data after running its recipe, or answer for a tile your task affected. Exactly one of: new data (data for number, chart and table tiles; text for text tiles; path for image and page tiles, or html for a page), unaffected (why your change does not alter what it shows), leave_stale (why it cannot be refreshed now, e.g. it needs another machine: it stays Stale and the director is told), or failed (the error of a refresh that failed: the last good data stays and the error is shown). Helm records the commit, time, you and your task with the data and keeps the tile's history. Only refresh tiles your task affected (complete_task names them) or that your manager asked for. Name Helm items (tasks, Spec entries...) in labels, cells and text as [[id]]: they show as links with the item's title. Shapes: number ${shapeFor('number').slice(6)}; chart ${shapeFor('chart').slice(6)}; table ${shapeFor('table').slice(6)}; scores ${shapeFor('scores').slice(6)}; compare ${shapeFor('compare')}. Animated images are refused: images of one view are a compare tile.`,
      {
        tile: z.string().min(1).describe('Tile id (list_dashboards)'),
        data: z.any().optional().describe('For number, chart and table tiles: the data object (shapes above)'),
        text: z.string().max(MAX_TEXT_CHARS).optional().describe('For a text tile: markdown'),
        path: z.string().max(1000).optional().describe('For an image or page tile: the file (absolute, or relative to your worktree or the project folder)'),
        html: z.string().optional().describe('For a page tile: a self-contained HTML page, instead of path'),
        caption: z.string().max(400).optional().describe('For an image: a caption for this picture'),
        images: z.array(z.object({ label: z.string().min(1).max(40), path: z.string().min(1).max(1000), caption: z.string().max(400).optional() })).max(8).optional().describe('For a compare tile: 2 to 8 images of the same viewpoint, each with its label'),
        reference: z.string().max(40).optional().describe('For a compare tile: the label of the reference image (Difference compares against it)'),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/).optional().describe('The commit the data was built from; default: your worktree\'s HEAD, else the project folder\'s'),
        unaffected: z.string().min(1).max(600).optional().describe('Your task affected this tile, but your change does not alter what it shows: why'),
        leave_stale: z.string().min(1).max(600).optional().describe('It cannot be refreshed now: why (it stays Stale, the director is told)'),
        failed: z.string().min(1).max(2000).optional().describe('The refresh failed: the error'),
      },
      async (input) => {
        const project = getProject(pid())!;
        if (!dashboardsOn(project.id)) return fail(OFF_TEXT);
        const tile = getTile(project.id, input.tile);
        if (!tile) return fail(`No tile ${input.tile} on this project. list_dashboards shows the ids.`);
        const modes = [input.data !== undefined || input.text !== undefined || input.path !== undefined || input.html !== undefined || input.images !== undefined, !!input.unaffected, !!input.leave_stale, !!input.failed].filter(Boolean).length;
        if (modes !== 1) return fail('Give exactly one of: new data (data, text, path or html), unaffected, leave_stale or failed.');
        const a = me();
        if (input.unaffected) {
          const res = resolveCheck(a, tile, 'unaffected', input.unaffected.trim());
          if (res !== 'resolved') return fail(`"${tile.title}" is not among the tiles your task affected, so there is nothing to declare. Leave it alone.`);
          const stale = tile.stale ? JSON.parse(tile.stale) : null;
          if (stale?.task_id === a.task_id) run('UPDATE tiles SET stale = NULL, updated_at = ? WHERE id = ?', now(), tile.id);
          touchProject(project.id);
          return ok(`Recorded: "${tile.title}" is unaffected by your task (${input.unaffected.trim()}). Its data and "as of" stay as they were.${left()}`);
        }
        if (input.leave_stale || input.failed) {
          const reason = input.failed ? `refresh failed: ${input.failed.trim()}` : input.leave_stale!.trim();
          if (input.failed) markError(tile, input.failed.trim(), a.name);
          resolveCheck(a, tile, 'stale', reason);
          if (!tile.stale) run('UPDATE tiles SET stale = ?, updated_at = ? WHERE id = ?', JSON.stringify({ reason, task_id: a.task_id ?? null, files: [], at: now() }), now(), tile.id);
          const root = director(project.id);
          if (root && root.id !== agentId) {
            void rt.send(root.id, `<helm-note kind="dashboards">${a.name} left the tile "${tile.title}" [${tile.id}] Stale${a.task_id ? ` for [[${a.task_id}]]` : ''}: ${reason}</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
          }
          touchProject(project.id);
          return ok(`Recorded: "${tile.title}" stays Stale (${reason})${input.failed ? '; its last good data stays and the error is shown' : ''}. The director is told.${left()}`);
        }
        // New data.
        let value: Row;
        let file: { file: string; bytes: number } | null = null;
        const wtRow = get("SELECT path FROM artifacts WHERE agent_id = ? AND kind = 'worktree' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1", agentId);
        if (tile.kind === 'compare') {
          if (!input.images || input.data !== undefined || input.text !== undefined || input.path !== undefined || input.html !== undefined) return fail(`A compare tile takes ${shapeFor('compare')}.`);
          const stored = storeCompare(project, tile, input.images, input.reference, wtRow?.path ? [wtRow.path] : []);
          if ('error' in stored) return fail(`Not updated. ${stored.error}`);
          value = stored.value;
          file = { file: null as unknown as string, bytes: stored.bytes };
        } else if (input.images !== undefined) {
          return fail(`images is for a compare tile; this is a ${tile.kind} tile, which takes ${shapeFor(tile.kind)}.`);
        } else if (tile.kind === 'image' || tile.kind === 'page') {
          // The rules (dashrules.ts): no animated image where a compare fits; a page states why it is free HTML.
          if (tile.kind === 'page' && !tile.page_reason) return fail('Not updated: this page tile has no stated reason. Give one with set_tile page_reason (why no widget fits), or replace it with a widget (a compare tile for images of one view).');
          if (tile.kind === 'image' && input.path) {
            const abs = [isAbsolute(input.path) ? input.path : null, ...(wtRow?.path ? [resolve(wtRow.path, input.path)] : []), resolve(project.path, input.path)].find((p) => p && existsSync(p));
            if (abs && isAnimated(abs)) return fail('Not updated: the image is animated. Give its frames as a compare tile (set_tile kind compare, then update_tile images: [{label, path}…]): it flips, slides and diffs them in the viewer.');
          }
          if (input.data !== undefined || input.text !== undefined) return fail(`A ${tile.kind} tile takes ${shapeFor(tile.kind)}.`);
          if (tile.kind === 'image' && input.html !== undefined) return fail(`An image tile takes ${shapeFor('image')}.`);
          const wt = wtRow;
          const stored = input.html !== undefined ? storeHtml(project, tile, input.html) : input.path ? storeFile(project, tile, input.path, wt?.path ? [wt.path] : []) : { error: `A ${tile.kind} tile takes ${shapeFor(tile.kind)}.` };
          if ('error' in stored) return fail(stored.error);
          file = stored;
          value = { ...stored, ...(input.caption?.trim() ? { caption: input.caption.trim() } : {}) };
        } else if (tile.kind === 'text') {
          if (input.text === undefined || input.data !== undefined || input.path !== undefined || input.html !== undefined) return fail(`A text tile takes ${shapeFor('text')}.`);
          if (!input.text.trim()) return fail('The text is empty.');
          value = { markdown: input.text };
        } else {
          if (input.data === undefined || input.text !== undefined || input.path !== undefined || input.html !== undefined) return fail(`A ${tile.kind} tile takes ${shapeFor(tile.kind)}.`);
          let data = input.data;
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch {
              return fail(`data must be a JSON object: ${shapeFor(tile.kind)}`);
            }
          }
          const v = validateData(tile.kind, data);
          if ('error' in v) return fail(`Not updated. ${v.error}`);
          value = JSON.parse(JSON.stringify(v.data));
        }
        const commit = input.commit ?? (await currentCommit(project, agentId));
        // The director building a dashboard has no task of its own: its data was built for the dashboard's task.
        const forTask = a.task_id ?? get('SELECT task_id FROM dashboards WHERE id = ?', tile.dashboard_id)?.task_id ?? null;
        recordData(tile, value, { commit, at: now(), agent_id: agentId, agent: a.name, task_id: forTask }, file);
        const res = resolveCheck(a, tile, 'refreshed', '');
        touchProject(project.id);
        return ok(
          `Updated "${tile.title}" as of ${commit ? commit.slice(0, 7) : 'an unknown commit'}.` +
            (res === 'extra' ? ' Note: your task did not affect this tile, so this refresh is recorded as unasked for the director to see. Refresh only the tiles your task affected or that your manager asked for.' : '') +
            left(),
        );
      },
    ),
    tool(
      'set_tile',
      `Create, edit or remove a tile on a dashboard. Managers may on any dashboard; other agents on a dashboard whose task they work on (or that the director opened to their task). A new tile needs kind (${TILE_KINDS.join(', ')}), section, title, depends_on and recipe. Rules: every tile is in a section (at most 8 tiles each, then a sub-section); title at most 40 characters, caption one line (120), the rest in info; images of one viewpoint are ONE compare tile (2 to 8 labelled images, optional reference), never separate image tiles, a flip animation or a viewer page; numbers that score those images are a scores tile with the same row labels; a gallery (different views) is image tiles sharing a group; a page tile (free HTML) needs page_reason. Then produce its first data by the recipe and send it with update_tile.`,
      {
        dashboard: z.string().min(1).describe('Dashboard id or title'),
        tile: z.string().optional().describe('Tile id to edit or remove; leave out to create one'),
        kind: z.enum(TILE_KINDS).optional(),
        title: z.string().min(1).max(120).optional().describe('At most 40 characters'),
        caption: z.string().max(400).optional().describe('One line (at most 120 characters) under the title: what it shows, how to read it'),
        info: z.string().max(1500).optional().describe('Longer notes (method, settings, caveats), shown behind an info tap'),
        section: z.string().max(80).optional().describe('The section it belongs to: id or title; a new title makes a new section at the end'),
        size: z.enum(['s', 'm', 'l']).optional().describe('Its size on the grid: s (a number), m (most), l (a compare, a wide chart)'),
        page_reason: z.string().max(300).optional().describe('For a page tile only: why free HTML and not a widget'),
        group: z.string().max(80).optional().describe('Tiles with the same group show together as a gallery'),
        position: z.number().int().min(0).max(1000).optional().describe('Order on the dashboard (lower first)'),
        depends_on: depsSchema.optional(),
        recipe: recipeSchema.optional(),
        expensive: z.boolean().optional().describe('True: refreshed only when the director asks (a long profiling run); a task that affects it leaves it Stale for the director'),
        remove: z.boolean().optional().describe('Remove the tile, its history and its files'),
      },
      async (input) => {
        if (!dashboardsOn(pid())) return fail(OFF_TEXT);
        const d = getDashboard(pid(), input.dashboard);
        if (!d) return fail(`No dashboard "${input.dashboard}" on this project. list_dashboards shows them.`);
        if (!mayEditTiles(d, me(), access.manager)) return fail(`You may not edit the tiles of "${d.title}": only managers, and agents working on its task${d.task_id ? ` [[${d.task_id}]]` : ''} or one the director opened to it with set_dashboard allow_tasks.`);
        const tile = input.tile ? getTile(pid(), input.tile) : undefined;
        if (input.tile && (!tile || tile.dashboard_id !== d.id)) return fail(`No tile ${input.tile} on "${d.title}".`);
        if (input.remove) {
          if (!tile) return fail('remove needs the tile id.');
          removeTile(tile);
          touchProject(pid());
          return ok(`Removed "${tile.title}" with its history and files.`);
        }
        const res = saveTile(d, tile, input);
        if ('error' in res) return fail(`${res.error} Nothing was changed.`);
        touchProject(pid());
        return ok(
          `${tile ? 'Updated' : 'Created'} the ${res.tile.kind} tile "${res.tile.title}" [${res.tile.id}] on "${d.title}".${res.notes.length ? ` ${res.notes.join(' ')}` : ''}` +
            (!res.tile.data ? ` Next: run its recipe and send the first data with update_tile (${shapeFor(res.tile.kind)}).` : ''),
        );
      },
    ),
  ];

  if (access.manager) {
    tools.push(
      tool(
        'set_dashboard',
        'Create, rename, describe, reorder, mark ready or remove a dashboard. A dashboard starts from what the user described (description: their words) and is "being built" until you have checked every tile against that description and mark it ready. Creating one without a task makes an active task for it, driven by you, whose thread is the dashboard\'s thread. allow_tasks lets the agents of other tasks create and edit its tiles (name that in their brief).',
        {
          dashboard: z.string().optional().describe('Id or title of the dashboard to change; leave out to create one'),
          title: z.string().min(1).max(120).optional(),
          description: z.string().max(4000).optional().describe("What the user asked it to show, in their words"),
          task: z.string().optional().describe('The task that builds it (default when creating: a new active task driven by you)'),
          state: z.enum(['building', 'ready']).optional().describe('ready once every tile has data and the whole matches the description'),
          allow_tasks: z.array(z.string()).max(10).optional().describe('Tasks whose agents may create and edit its tiles (replaces the list)'),
          order: z.array(z.string()).max(60).optional().describe('Tile ids in the order to show them (within their sections)'),
          sections: z.array(z.object({ section: z.string().optional().describe('An existing section (id or title) to rename, move or remove'), title: z.string().max(60).optional(), parent: z.string().optional().describe('Put it under this section (one level)'), remove: z.boolean().optional() })).max(30).optional().describe('The sections in the order to show them: new ones by title, existing ones by section'),
          key: z.array(z.object({ name: z.string().min(1).max(40), color: z.number().int().min(1).max(8).optional() })).max(8).optional().describe('Name the series once, each with a palette colour (1 to 8); every tile then uses these names and colours'),
          remove: z.boolean().optional().describe('Remove the dashboard with all its tiles, history and files'),
        },
        async (input) => {
          const projectId = pid();
          if (!dashboardsOn(projectId)) return fail(OFF_TEXT);
          let d = input.dashboard ? getDashboard(projectId, input.dashboard) : undefined;
          if (input.dashboard && !d) return fail(`No dashboard "${input.dashboard}" on this project.`);
          const task = input.task ? findTask(projectId, input.task) : undefined;
          if (input.task && (!task || task.kind !== 'task')) return fail(`No task ${input.task} on this project.`);
          for (const t of input.allow_tasks ?? []) if (!findTask(projectId, t)) return fail(`No task ${t} on this project. Nothing was changed.`);
          if (input.remove) {
            if (!d) return fail('remove needs the dashboard.');
            removeDashboard(d);
            touchProject(projectId);
            return ok(`Removed the dashboard "${d.title}" with its tiles, history and files.`);
          }
          let created = '';
          if (!d) {
            if (!input.title?.trim() || !input.description?.trim()) return fail('A new dashboard needs a title and a description (what the user asked it to show).');
            const t =
              task ??
              createTask(projectId, { title: `Dashboard: ${input.title.trim()}`, description: `Build the dashboard "${input.title.trim()}".\n\nWhat the user asked for:\n\n${input.description.trim()}`, state: 'active', driver_agent_id: agentId, origin: 'director' }, { author: 'director', name: me().name });
            d = createDashboard(projectId, { title: input.title, description: input.description, taskId: t.id, by: me().name });
            created = `Created the dashboard "${d.title}" [${d.id}], being built in ${taskRef(t)}. `;
          }
          const key = input.key ? validateKey(input.key) : null;
          if (key && 'error' in key) return fail(`${key.error} Nothing was changed.`);
          const secErr = input.sections ? applySections(d, input.sections) : null;
          if (secErr) return fail(`${secErr} Nothing was changed.`);
          if (key) run('UPDATE dashboards SET series_key = ? WHERE id = ?', JSON.stringify(key.key), d.id);
          const err = input.order ? reorderTiles(d, input.order) : null;
          if (err) return fail(`${err} Nothing else was changed.`);
          if (input.state === 'ready') {
            const tiles = tilesOf(d.id);
            const empty = tiles.filter((t) => !t.data);
            if (!tiles.length) return fail(`"${d.title}" has no tiles yet; it cannot be ready.`);
            if (empty.length) return fail(`These tiles have no data yet, so "${d.title}" is not ready: ${empty.map((t) => `"${t.title}" [${t.id}]`).join(', ')}.`);
            const issues = lintDashboard(d);
            if (issues.length) return fail(`"${d.title}" breaks the dashboard rules, so it is not ready:\n${lintText(d, issues)}`);
          }
          run(
            'UPDATE dashboards SET title = ?, description = ?, task_id = ?, state = ?, allow_tasks = ?, ready_at = ?, updated_at = ? WHERE id = ?',
            input.title?.trim() ?? d.title, input.description?.trim() ?? d.description, task?.id ?? d.task_id, input.state ?? d.state,
            input.allow_tasks ? JSON.stringify(input.allow_tasks.map((t) => findTask(projectId, t)!.id)) : d.allow_tasks,
            input.state === 'ready' && d.state !== 'ready' ? now() : d.ready_at, now(), d.id,
          );
          const after = get('SELECT * FROM dashboards WHERE id = ?', d.id)!;
          if (input.state === 'ready' && d.state !== 'ready' && after.task_id) {
            const t = get('SELECT * FROM tasks WHERE id = ?', after.task_id);
            if (t) addTaskMessage(t, { author: 'director', name: me().name }, `The dashboard "${after.title}" is ready: ${tilesOf(d.id).length} tiles, each with its dependencies and recipe. [[page:dashboards]]`);
          }
          touchProject(projectId);
          return ok(`${created || `Updated "${after.title}". `}State: ${after.state === 'ready' ? 'ready' : 'being built'}.${created ? ' Next: set_tile for each tile (kind, dependencies, recipe), then its first data with update_tile; mark it ready when every tile matches what the user asked for.' : ''}`);
        },
      ),
      tool(
        'dashboard_lint',
        "Check the project's dashboards against the rules: tiles without a section, titles over 40 characters, captions over one line, page tiles without a reason, animated images, image tiles of one view that should be one compare tile, sections over 8 tiles. Lists each problem by tile.",
        { dashboard: z.string().optional().describe('Only this dashboard (id or title)') },
        async ({ dashboard }) => {
          const projectId = pid();
          if (!dashboardsOn(projectId)) return fail(OFF_TEXT);
          const ds = dashboard ? [getDashboard(projectId, dashboard)].filter(Boolean) : all('SELECT * FROM dashboards WHERE project_id = ? ORDER BY position', projectId);
          if (!ds.length) return fail(dashboard ? `No dashboard "${dashboard}" on this project.` : 'This project has no dashboards.');
          return ok(ds.map((d) => lintText(d!)).join('\n\n'));
        },
      ),
      tool(
        'review_dashboard_scope',
        "Check which dashboard tiles a finished task affected (Helm's list, from the files it changed and each tile's dependencies) and what its agent did about each: refreshed, declared unaffected (with the reason), or left stale. Without decision it only shows the scope. decision accept records that every affected tile was refreshed or rightly justified and nothing was refreshed needlessly; send_back names tiles the agent must refresh (also tiles Helm missed); dependencies corrects a tile's dependencies when the list was too wide or too narrow, so the next task's list is right. Do it before you close the agent or mark the task done.",
        {
          task: z.string().min(1).describe('Task id'),
          decision: z.enum(['accept', 'send_back']).optional(),
          send_back: z.array(z.object({ tile: z.string(), why: z.string().min(1).max(400) })).max(30).optional(),
          dependencies: z.array(z.object({ tile: z.string(), paths: z.array(z.string()).max(40).optional(), docs: z.array(z.string()).max(20).optional(), tags: z.array(z.string()).max(10).optional() })).max(30).optional().describe('Replacement dependencies for tiles (only the parts given change)'),
          note: z.string().max(600).optional(),
        },
        async (input) => {
          const projectId = pid();
          if (!dashboardsOn(projectId)) return fail(OFF_TEXT);
          const t = findTask(projectId, input.task);
          if (!t || t.kind !== 'task') return fail(`No task ${input.task} on this project.`);
          if (!input.decision) {
            if (input.send_back || input.dependencies) return fail('Give decision (accept or send_back) with send_back or dependencies. Nothing was changed.');
            return ok(`Dashboard scope of ${taskRef(t)}:\n${scopeText(t.id)}`);
          }
          const res = reviewScope(t, by(), { ...input, decision: input.decision });
          if ('error' in res) return fail(res.error);
          let told = '';
          if (res.sendBack.length) {
            const workers = all("SELECT id, name FROM agents WHERE task_id = ? AND status NOT IN ('closed', 'done') AND quick = 0 AND id != ?", t.id, agentId);
            const msg = `Your manager checked the dashboard tiles your task affected and asks you to refresh ${res.sendBack.length === 1 ? 'this one' : 'these'} by its recipe (list_dashboards), then send the result with update_tile:\n${res.sendBack.map((s) => `- "${s.title}" [${s.id}]: ${s.why}`).join('\n')}`;
            for (const w of workers) void rt.send(w.id, msg, { kind: 'agent', name: me().name }).catch(() => {});
            told = workers.length ? ` Told ${workers.map((w) => w.name).join(', ')}.` : ' No agent is working on the task any more: refresh them yourself or start one with their recipes.';
          }
          touchProject(projectId);
          return ok(res.text + told);
        },
      ),
    );
  }
  return tools;
}
