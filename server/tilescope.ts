import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getProject } from './store.ts';
import { addTaskMessage } from './tasks.ts';
import { dashboardsOn, depsOf, markStale, recipeOf, saveTile } from './dashboards.ts';
import type { Deps } from './dashboards.ts';

/**
 * Which dashboard tiles a task's work may have affected, and what was done about each (tile_checks).
 *
 * What a task changed: the files changed in the worktrees its agents registered (from the fork point recorded at
 * registration, or the merge base, to the branch's head, plus uncommitted and untracked files), or, when none of them
 * can be read any more (removed and merged), the files of the commits on the main checkout's branch since the task
 * started. Spec entries the task changed count too (doc_links relation 'changed'). A tile is affected when one of
 * those files matches one of its path globs, or an entry or tag it depends on changed.
 *
 * Helm never refreshes a tile. The finishing agent refreshes each affected tile by its recipe or says why it is
 * unaffected (complete_task asks, update_tile answers); expensive tiles go Stale for the director instead; the
 * director confirms the scope with review_dashboard_scope.
 */

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { timeout: 30_000, maxBuffer: 16 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}

// ---------- globs ----------

const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
function conv(g: string): string {
  let re = '';
  for (let i = 0; i < g.length; ) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += `(?:${g.slice(i + 1, end).split(',').map(conv).join('|')})`;
        i = end + 1;
        continue;
      }
    }
    re += esc(c);
    i++;
  }
  return re;
}

/**
 * A dependency glob, relative to the repository root: `*` and `?` within one path segment, `**` across segments,
 * `{a,b}` alternatives. A pattern naming a folder (no wildcard needed) matches everything under it.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return new RegExp(`^${conv(g)}(?:/.*)?$`);
}
export function globMatch(glob: string, file: string): boolean {
  return globToRegExp(glob).test(file.replace(/^\.\//, ''));
}

// ---------- what a task changed ----------

export type Changed = { files: string[]; how: string[] };

/**
 * Where a branch's own work starts: the newest point its reflog says it was created at, reset to or rebased onto (a
 * standing agent reuses one branch for task after task, and a rebase on master brings in other work). Null when the
 * reflog says nothing usable (then the recorded fork point, or the merge-base with master, is used).
 */
export async function reflogBase(dir: string, branch: string | null, head: string): Promise<string | null> {
  if (!branch || branch === 'HEAD') return null;
  let log = '';
  try {
    log = await git(dir, 'reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--');
  } catch {
    return null;
  }
  for (const line of log.split('\n')) {
    const [sha, ...rest] = line.split(' ');
    const subject = rest.join(' ');
    const onto = /^rebase(?: \(finish\))?: .* onto ([0-9a-f]{7,40})$/.exec(subject)?.[1];
    const at = onto ?? (/^branch: (?:Created from|Reset to) /.test(subject) ? sha : null);
    if (at && (await isAncestor(dir, at, head))) return at;
  }
  return null;
}

/** Commits made before the task started are not its own (a branch reused from an earlier task); a minute of slack. */
const SLACK_MS = 60_000;

/**
 * Files changed by the commits from `base` to `head` made since `since` (ms): the task's own commits. A rebased commit
 * is rewritten, so it carries the time of the rebase; commits that only came in from master keep their own.
 */
async function committedFiles(dir: string, base: string | null, head: string, since: number): Promise<string[]> {
  if (!base || base === head) return [];
  const out: string[] = [];
  const log = await git(dir, 'log', '--no-renames', '--name-only', '--format=%x01%ct', `${base}..${head}`);
  for (const block of log.split('\x01').slice(1)) {
    const [ct, ...files] = block.split('\n');
    if (Number(ct) * 1000 >= since - SLACK_MS) out.push(...files.map((x) => x.trim()).filter(Boolean));
  }
  return out;
}

/** Files the task changed in a checkout: its own commits since `base`, plus uncommitted and untracked files. */
async function filesIn(dir: string, base: string | null, head: string, since: number): Promise<string[]> {
  const out: string[] = [];
  out.push(...(await committedFiles(dir, base, head, since)));
  // -z: entries end in NUL; a rename would add its old name as a separate entry (with --no-renames there are none).
  for (const e of (await git(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')).split('\0')) if (e.length > 3) out.push(e.slice(3));
  return out.filter(Boolean);
}

async function isAncestor(dir: string, a: string, b: string): Promise<boolean> {
  try {
    await git(dir, 'merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
}

/** The agents whose work counts as the task's: every agent spawned for it, and its driver. */
function taskAgents(task: Row): string[] {
  const ids = new Set(all('SELECT id FROM agents WHERE task_id = ?', task.id).map((a) => a.id as string));
  if (task.driver_agent_id) ids.add(task.driver_agent_id);
  return [...ids];
}

export async function changedFiles(task: Row): Promise<Changed> {
  const project = getProject(task.project_id);
  const files = new Set<string>();
  const how: string[] = [];
  if (!project || !existsSync(project.path)) return { files: [], how: ['the project folder is missing'] };
  let mainHead = '';
  try {
    mainHead = (await git(project.path, 'rev-parse', 'HEAD')).trim();
  } catch {
    return { files: [], how: ['the project folder is not a git repository'] };
  }
  const agents = taskAgents(task);
  const wts = agents.length
    ? all(
        `SELECT * FROM artifacts WHERE project_id = ? AND kind = 'worktree'
           AND (agent_id IN (${agents.map(() => '?').join(',')}) OR EXISTS (SELECT 1 FROM json_each(artifacts.users) u WHERE u.value IN (${agents.map(() => '?').join(',')})))
         ORDER BY created_at`,
        project.id, ...agents, ...agents,
      )
    : [];
  let used = false;
  const since = Number(task.started_at ?? task.created_at);
  for (const w of wts) {
    try {
      if (existsSync(w.path) && w.removed_at == null) {
        const head = (await git(w.path, 'rev-parse', 'HEAD')).trim();
        const branch = w.wt_branch || (await git(w.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
        const base = (await reflogBase(w.path, branch, head)) ?? (w.base_commit && (await isAncestor(w.path, w.base_commit, head)) ? w.base_commit : (await git(w.path, 'merge-base', head, mainHead)).trim());
        for (const f of await filesIn(w.path, base, head, since)) files.add(f);
        how.push(`worktree ${w.path}${w.wt_branch ? ` (${w.wt_branch})` : ''} from ${base.slice(0, 7)}, with uncommitted changes`);
        used = true;
      } else if (w.wt_branch) {
        const head = (await git(project.path, 'rev-parse', '--verify', `refs/heads/${w.wt_branch}`)).trim();
        const base = (await reflogBase(project.path, w.wt_branch, head)) ?? (w.base_commit && (await isAncestor(project.path, w.base_commit, head)) ? w.base_commit : (await git(project.path, 'merge-base', head, mainHead)).trim());
        for (const f of await committedFiles(project.path, base, head, since)) files.add(f);
        how.push(`branch ${w.wt_branch} from ${base.slice(0, 7)} (its worktree is gone)`);
        used = true;
      }
    } catch {
      // A branch deleted after merging, a worktree that is no longer a checkout: the fallback below covers it.
    }
  }
  if (!used) {
    try {
      const log = await git(project.path, 'log', `--since=${new Date(since).toISOString()}`, '--name-only', '--no-renames', '--format=', '-z', 'HEAD');
      for (const f of log.split(/[\0\n]/)) if (f.trim()) files.add(f.trim());
      how.push(`commits on the main checkout's branch since the task started`);
    } catch {}
  }
  return { files: [...files].sort(), how };
}

/** Spec entries the task changed, and their tags. */
function changedDocs(task: Row): { ids: string[]; tags: string[] } {
  const rows = all("SELECT DISTINCT d.id, d.tags FROM doc_links l JOIN docs d ON d.id = l.doc_id WHERE l.task_id = ? AND l.relation = 'changed'", task.id);
  const tags = new Set<string>();
  for (const r of rows) {
    try {
      for (const t of JSON.parse(r.tags || '[]')) tags.add(String(t).toLowerCase());
    } catch {}
  }
  return { ids: rows.map((r) => r.id), tags: [...tags] };
}

/** Why `deps` is affected by these changes: the matching files and Spec entries (empty: unaffected). */
export function affects(deps: Deps, files: string[], docs: { ids: string[]; tags: string[] }): { files: string[]; docs: string[] } {
  const res = deps.paths.map(globToRegExp);
  const hitFiles = files.filter((f) => res.some((r) => r.test(f)));
  const hitDocs = [...deps.docs.filter((d) => docs.ids.includes(d)), ...deps.tags.filter((t) => docs.tags.includes(t)).map((t) => `tag ${t}`)];
  return { files: hitFiles, docs: hitDocs };
}

export type ScopeRow = Row & { tile: Row; dashboard: Row };

/**
 * Computes which tiles the task affected and records them (tile_checks), keeping what was already done about each.
 * New affected tiles go Stale with the task and files as the reason. Tiles of a dashboard this very task is building
 * are left out (its agents are making them), and so are tiles with no data yet. Returns the rows and the expensive
 * tiles newly found (for the director).
 */
export async function computeScope(task: Row): Promise<{ rows: ScopeRow[]; newExpensive: ScopeRow[]; changed: Changed }> {
  if (!dashboardsOn(task.project_id) || task.kind !== 'task') return { rows: [], newExpensive: [], changed: { files: [], how: [] } };
  const tiles = all(
    `SELECT t.* FROM tiles t JOIN dashboards d ON d.id = t.dashboard_id
     WHERE t.project_id = ? AND t.data IS NOT NULL AND (d.task_id IS NULL OR d.task_id != ?)
       AND NOT EXISTS (SELECT 1 FROM json_each(d.allow_tasks) a WHERE a.value = ?)`,
    task.project_id, task.id, task.id,
  );
  const changed = tiles.length ? await changedFiles(task) : { files: [], how: [] };
  const docs = changedDocs(task);
  const newExpensive: string[] = [];
  const title = String(task.title).replace(/"/g, "'");
  tx(() => {
    const existing = new Map(all('SELECT * FROM tile_checks WHERE task_id = ?', task.id).map((r) => [r.tile_id as string, r]));
    const seen = new Set<string>();
    for (const t of tiles) {
      const hit = affects(depsOf(t), changed.files, docs);
      if (!hit.files.length && !hit.docs.length) continue;
      seen.add(t.id);
      const prev = existing.get(t.id);
      if (prev) {
        run('UPDATE tile_checks SET files = ?, docs = ?, computed_at = ? WHERE task_id = ? AND tile_id = ?', JSON.stringify(hit.files.slice(0, 50)), JSON.stringify(hit.docs), now(), task.id, t.id);
        continue;
      }
      const status = t.expensive ? 'expensive' : 'pending';
      run(
        'INSERT INTO tile_checks (task_id, tile_id, project_id, files, docs, status, computed_at) VALUES (?,?,?,?,?,?,?)',
        task.id, t.id, task.project_id, JSON.stringify(hit.files.slice(0, 50)), JSON.stringify(hit.docs), status, now(),
      );
      const what = [...hit.files.slice(0, 5), ...hit.docs.slice(0, 3)].join(', ') + (hit.files.length > 5 ? ` and ${hit.files.length - 5} more` : '');
      markStale(t, { reason: `"${title}" changed ${what}`, task_id: task.id, files: hit.files.slice(0, 50), at: now() });
      if (t.expensive) newExpensive.push(t.id);
    }
    // The scope shrank (a file reverted, a dependency corrected): an unresolved tile no longer affected is dropped.
    for (const [tileId, r] of existing) {
      // A tile the director sent back is kept whatever the files say.
      if (seen.has(tileId) || !['pending', 'expensive'].includes(r.status) || String(r.reason).startsWith('sent back:')) continue;
      run('DELETE FROM tile_checks WHERE task_id = ? AND tile_id = ?', task.id, tileId);
      const t = get('SELECT * FROM tiles WHERE id = ?', tileId);
      if (t?.stale && JSON.parse(t.stale).task_id === task.id) run('UPDATE tiles SET stale = NULL WHERE id = ?', tileId);
    }
  });
  const rows = scopeRows(task.id);
  return { rows, newExpensive: rows.filter((r) => newExpensive.includes(r.tile_id)), changed };
}

export function scopeRows(taskId: string): ScopeRow[] {
  return all(
    `SELECT c.*, t.title AS tile_title FROM tile_checks c JOIN tiles t ON t.id = c.tile_id WHERE c.task_id = ? ORDER BY t.dashboard_id, t.position`,
    taskId,
  ).map((r) => {
    const tile = get('SELECT * FROM tiles WHERE id = ?', r.tile_id)!;
    return { ...r, tile, dashboard: get('SELECT id, title FROM dashboards WHERE id = ?', tile.dashboard_id)! };
  });
}

const fileList = (r: Row) => {
  const files = JSON.parse(r.files || '[]') as string[];
  const docs = JSON.parse(r.docs || '[]') as string[];
  return [...files.slice(0, 6), ...docs].join(', ') + (files.length > 6 ? ` and ${files.length - 6} more` : '');
};

function recipeLine(t: Row): string {
  const r = recipeOf(t);
  if (!r) return 'no recipe recorded: ask your manager';
  return `in ${r.cwd}${r.host ? ` on host ${r.host}` : ''}${r.duration ? ` (about ${r.duration})` : ''}: ${r.command.replace(/\n/g, ' ⏎ ')}`;
}

/**
 * complete_task's dashboards ask: the tiles still unresolved for the agent's task, with what to do. Null when there
 * is nothing to ask (no task, dashboards off, nothing affected, all answered).
 */
export async function finishAsk(agent: Row): Promise<{ text: string | null; newExpensive: ScopeRow[] }> {
  if (!agent.task_id || agent.quick) return { text: null, newExpensive: [] };
  const task = get('SELECT * FROM tasks WHERE id = ?', agent.task_id);
  if (!task || !dashboardsOn(task.project_id)) return { text: null, newExpensive: [] };
  const { rows, newExpensive } = await computeScope(task);
  const pending = rows.filter((r) => r.status === 'pending');
  if (!pending.length) return { text: null, newExpensive };
  const expensive = rows.filter((r) => r.status === 'expensive');
  const lines = [
    `Dashboard tiles your changes may affect. For each, before complete_task again: run its recipe and send the result with update_tile, or update_tile unaffected: "<why>". Cannot refresh here: leave_stale: "<why>"; refresh failed: failed: "<error>". Refresh no other tile.`,
    ...pending.map((r) => `- "${r.tile.title}" [${r.tile_id}] (${r.tile.kind}, dashboard "${r.dashboard.title}"): you changed ${fileList(r)}. Recipe ${recipeLine(r.tile)}`),
  ];
  if (expensive.length) lines.push(`Not for you (expensive; left Stale for the director): ${expensive.map((r) => `"${r.tile.title}"`).join(', ')}.`);
  return { text: lines.join('\n'), newExpensive };
}

/** A tile's check for the agent's task answered by update_tile. Returns 'extra' when the task did not affect it. */
export function resolveCheck(agent: Row, tile: Row, status: 'refreshed' | 'unaffected' | 'stale', reason: string): 'resolved' | 'extra' | 'none' {
  if (!agent.task_id) return 'none';
  const row = get('SELECT * FROM tile_checks WHERE task_id = ? AND tile_id = ?', agent.task_id, tile.id);
  if (row) {
    run('UPDATE tile_checks SET status = ?, reason = ?, agent_id = ?, resolved_at = ? WHERE task_id = ? AND tile_id = ?', row.status === 'expensive' && status === 'stale' ? 'expensive' : status, reason, agent.id, now(), agent.task_id, tile.id);
    return 'resolved';
  }
  // Refreshing a tile the task did not affect is recorded, so the director sees it in the scope check. The task that
  // builds the tile's dashboard is not asked about its own tiles.
  const d = get('SELECT task_id, allow_tasks FROM dashboards WHERE id = ?', tile.dashboard_id);
  const builds = d && (d.task_id === agent.task_id || (JSON.parse(d.allow_tasks || '[]') as string[]).includes(agent.task_id));
  if (status === 'refreshed' && !builds) {
    run(
      "INSERT OR IGNORE INTO tile_checks (task_id, tile_id, project_id, status, reason, agent_id, computed_at, resolved_at) VALUES (?,?,?,'extra',?,?,?,?)",
      agent.task_id, tile.id, tile.project_id, reason, agent.id, now(), now(),
    );
    return 'extra';
  }
  return 'none';
}

const STATUS_WORDS: Record<string, string> = {
  pending: 'not answered yet',
  refreshed: 'refreshed',
  unaffected: 'declared unaffected',
  stale: 'left stale',
  expensive: 'expensive: left stale for the director',
  extra: 'refreshed although the task did not affect it',
};

/** The scope in words, for the thread and the director's tools. */
export function scopeText(taskId: string): string {
  const rows = scopeRows(taskId);
  if (!rows.length) return 'No dashboard tile was affected by this task.';
  return rows
    .map((r) => `- "${r.tile.title}" [${r.tile_id}] on "${r.dashboard.title}": ${STATUS_WORDS[r.status] ?? r.status}${r.reason ? ` (${r.reason.replace(/\s+/g, ' ').slice(0, 300)})` : ''}${r.files !== '[]' || r.docs !== '[]' ? `; matched ${fileList(r)}` : ''}`)
    .join('\n');
}

/** The task page's block: the rows, the reviews, and whether anything is open. */
export function taskScope(taskId: string) {
  const rows = scopeRows(taskId).map((r) => ({
    tile_id: r.tile_id,
    tile: r.tile.title,
    kind: r.tile.kind,
    dashboard_id: r.dashboard.id,
    dashboard: r.dashboard.title,
    status: r.status,
    reason: r.reason,
    files: JSON.parse(r.files || '[]') as string[],
    docs: JSON.parse(r.docs || '[]') as string[],
    at: r.resolved_at ?? r.computed_at,
  }));
  const reviews = all('SELECT agent_name, decision, note, changes, created_at FROM dashboard_reviews WHERE task_id = ? ORDER BY id', taskId).map((r) => ({ ...r, changes: JSON.parse(r.changes || '[]') }));
  return rows.length || reviews.length ? { rows, reviews } : null;
}

/** Posted once in the task's thread when the agent finishes: what Helm computed and what was done about each tile. */
export function postScope(task: Row, by: string) {
  const rows = scopeRows(task.id);
  if (!rows.length) return;
  addTaskMessage(task, { author: 'system', name: 'Helm' }, `Dashboards: ${by} finished with ${rows.length} affected ${rows.length === 1 ? 'tile' : 'tiles'}.\n${scopeText(task.id)}`, 'state');
}

/**
 * The soft gate when a manager closes the agent or marks the task done: recomputes the scope and returns a warning
 * for the tool result while tiles are unanswered or the scope is unreviewed (never a refusal: some refreshes need
 * another machine). Unanswered tiles stay Stale; marking the task done records them as left stale.
 */
export async function closeWarning(task: Row, done: boolean): Promise<{ text: string; newExpensive: ScopeRow[] }> {
  if (!dashboardsOn(task.project_id) || task.kind !== 'task') return { text: '', newExpensive: [] };
  const { rows, newExpensive } = await computeScope(task);
  if (!rows.length) return { text: '', newExpensive };
  const pending = rows.filter((r) => r.status === 'pending');
  const reviewed = !!get('SELECT 1 AS x FROM dashboard_reviews WHERE task_id = ?', task.id);
  if (done && pending.length) {
    run("UPDATE tile_checks SET status = 'stale', reason = 'not refreshed before the task was finished', resolved_at = ? WHERE task_id = ? AND status = 'pending'", now(), task.id);
  }
  if (!pending.length && reviewed) return { text: '', newExpensive };
  const parts = [`\n\nDashboards: ${pending.length ? `${pending.length} affected ${pending.length === 1 ? 'tile was' : 'tiles were'} not refreshed or declared unaffected${done ? (pending.length === 1 ? ' and stays Stale' : ' and stay Stale') : ''}. ` : ''}${reviewed ? '' : 'Scope not checked yet: review_dashboard_scope. '}Scope:\n${scopeText(task.id)}`];
  return { text: parts.join(''), newExpensive };
}

// ---------- the director's check ----------

export type ReviewInput = {
  decision: 'accept' | 'send_back';
  send_back?: { tile: string; why: string }[];
  dependencies?: { tile: string; paths?: string[]; docs?: string[]; tags?: string[] }[];
  note?: string;
};

/**
 * Records the director's check of a task's scope. send_back marks the named tiles to refresh again for the task
 * (a tile outside the computed list too: the list was too narrow) and returns them for the caller to tell the agent;
 * dependencies corrects tiles' dependencies (too wide or too narrow), so the next task's list is right.
 */
export function reviewScope(task: Row, by: { id: string; name: string }, input: ReviewInput): { text: string; sendBack: Row[] } | { error: string } {
  const tiles = new Map<string, Row>();
  for (const ref of [...(input.send_back ?? []).map((s) => s.tile), ...(input.dependencies ?? []).map((d) => d.tile)]) {
    const t = get('SELECT * FROM tiles WHERE id = ? AND project_id = ?', ref, task.project_id);
    if (!t) return { error: `No tile ${ref} on this project (list_dashboards shows the ids). Nothing was changed.` };
    tiles.set(ref, t);
  }
  if (input.decision === 'send_back' && !input.send_back?.length) return { error: 'send_back needs the tiles to refresh: send_back: [{"tile": "...", "why": "..."}]. Nothing was changed.' };
  if (input.decision === 'accept' && input.send_back?.length) return { error: 'Either accept or send_back tiles, not both. Nothing was changed.' };
  const changes: string[] = [];
  const sendBack: Row[] = [];
  try {
  tx(() => {
    for (const dep of input.dependencies ?? []) {
      const t = tiles.get(dep.tile)!;
      const d = get('SELECT * FROM dashboards WHERE id = ?', t.dashboard_id)!;
      const cur = depsOf(t);
      const res = saveTile(d, t, { depends_on: { paths: dep.paths ?? cur.paths, docs: dep.docs ?? cur.docs, tags: dep.tags ?? cur.tags } });
      if ('error' in res) throw new Error(`Tile ${t.id}: ${res.error}`);
      const now2 = depsOf(res.tile);
      changes.push(`dependencies of "${t.title}" corrected: ${now2.paths.join(', ') || 'no paths'}${now2.docs.length ? `; Spec ${now2.docs.join(', ')}` : ''}${now2.tags.length ? `; tags ${now2.tags.join(', ')}` : ''}`);
    }
    for (const s of input.send_back ?? []) {
      const t = tiles.get(s.tile)!;
      run(
        `INSERT INTO tile_checks (task_id, tile_id, project_id, status, reason, computed_at) VALUES (?,?,?,'pending',?,?)
         ON CONFLICT (task_id, tile_id) DO UPDATE SET status = 'pending', reason = excluded.reason, resolved_at = NULL`,
        task.id, t.id, t.project_id, `sent back: ${s.why}`, now(),
      );
      markStale(t, { reason: `the director asked for a refresh for "${task.title}": ${s.why}`, task_id: task.id, files: [], at: now() });
      sendBack.push({ ...t, why: s.why });
      changes.push(`"${t.title}" sent back: ${s.why}`);
    }
    run(
      'INSERT INTO dashboard_reviews (task_id, project_id, agent_id, agent_name, decision, note, changes, created_at) VALUES (?,?,?,?,?,?,?,?)',
      task.id, task.project_id, by.id, by.name, input.decision, input.note?.trim() ?? '', JSON.stringify(changes), now(),
    );
  });
  } catch (e: any) {
    return { error: `${e.message} Nothing was changed.` };
  }
  addTaskMessage(
    task,
    { author: 'system', name: 'Helm' },
    `Dashboards: ${by.name} checked the scope: ${input.decision === 'accept' ? 'accepted' : 'sent back'}.${input.note?.trim() ? ` ${input.note.trim()}` : ''}${changes.length ? `\n${changes.map((c) => `- ${c}`).join('\n')}` : ''}`,
    'state',
  );
  return { text: `Recorded your check of the dashboard scope of [[${task.id}]] (${input.decision === 'accept' ? 'accepted' : 'sent back'}).${changes.length ? `\n${changes.map((c) => `- ${c}`).join('\n')}` : ''}\n\nScope now:\n${scopeText(task.id)}`, sendBack };
}
