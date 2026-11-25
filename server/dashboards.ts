import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { ARTIFACT_DIR } from './config.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getSetting } from './settings.ts';
import { imageSize } from './store.ts';
import { copyFileAtomic, writeFileAtomic } from './safefs.ts';
import { projectHosts } from './hosts.ts';
import { REF_PREFIXES, resolveRef } from './refs.ts';
import { addSection, findSection, sectionCount, sectionsOf } from './dashrules.ts';

/**
 * Dashboards: named pages of tiles a project's agents keep up to date. The user describes a dashboard in words; the
 * director designs its tiles, has agents write each tile's recipe and first data, and marks it ready. Every tile
 * carries what it depends on (repository globs, Spec entries or tags), how it is refreshed (its recipe), and what its
 * data was built from (commit, time, agent, task). Helm never runs a recipe: agents do, when their task affected the
 * tile (tilescope.ts) or the director asks.
 *
 * All state is in the database and the artifact folder (images and pages under artifacts/dashboards/<project>/), read
 * fresh on every use: the runner and the web service may be separate processes.
 */

export const TILE_KINDS = ['number', 'chart', 'table', 'scores', 'image', 'compare', 'text', 'page'] as const;
/** The rules (dashrules.ts): a title the grid shows whole, one caption line, the rest behind an info tap; sizes on one grid. */
export const TITLE_MAX = 40;
export const CAPTION_MAX = 120;
export const INFO_MAX = 1500;
export const SECTION_MAX = 8;
export const TILE_SIZES = ['s', 'm', 'l'] as const;
/** A compare tile: 2 to 8 labelled images of one viewpoint, optionally one of them the reference. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 8;
export type TileKind = (typeof TILE_KINDS)[number];
export const CHART_TYPES = ['line', 'bar', 'stacked'] as const;

/** History kept per tile: data points for numbers and charts (a trend), fewer for images and pages (before/after). */
export const HISTORY_KEEP: Record<string, number> = { number: 60, chart: 30, table: 20, scores: 20, text: 20, image: 12, compare: 8, page: 6 };
/** Files kept per tile, in bytes, oldest dropped first beyond it (the newest is always kept). */
export const TILE_FILES_CAP = 60 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_DATA_CHARS = 64 * 1024;
export const MAX_TEXT_CHARS = 20000;
export const MAX_TILES = 60;
export const MAX_PINNED = 2;
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'];

export const OFF_TEXT = 'Dashboards are off for this project (Setup › Agent context). Nothing was changed.';
export const dashboardsOn = (projectId: string) => getSetting(projectId, 'dashboards');

const exec = promisify(execFile);
const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export type Deps = { paths: string[]; docs: string[]; tags: string[] };
export type Recipe = { command: string; cwd: string; host?: string; duration?: string; notes?: string };
export type Built = { commit: string | null; at: number; agent_id: string | null; agent: string; task_id: string | null };
export type Stale = { reason: string; task_id: string | null; files: string[]; at: number };

export const depsOf = (t: Row): Deps => {
  const d = parse<Partial<Deps>>(t.deps, {});
  return { paths: d.paths ?? [], docs: d.docs ?? [], tags: d.tags ?? [] };
};
export const recipeOf = (t: Row): Recipe | null => {
  const r = parse<Partial<Recipe>>(t.recipe, {});
  return r.command ? (r as Recipe) : null;
};

export const fileDir = (projectId: string) => join(ARTIFACT_DIR, 'dashboards', projectId);
/** Files are stored relative to the artifact folder (served at /artifacts/). */
const relFile = (projectId: string, name: string) => `dashboards/${projectId}/${name}`;
/** The files a tile's data holds: an image's or page's file, a compare's images. */
export function filesOfData(data: string | Row | null | undefined): string[] {
  const d = typeof data === 'string' ? parse<Row | null>(data, null) : data;
  if (!d) return [];
  if (Array.isArray(d.images)) return d.images.map((i: Row) => i?.file).filter((x: unknown): x is string => typeof x === 'string');
  return typeof d.file === 'string' ? [d.file] : [];
}
export function removeFile(file: string | null | undefined) {
  if (!file || file.includes('..') || !file.startsWith('dashboards/')) return;
  try {
    unlinkSync(join(ARTIFACT_DIR, file));
  } catch {}
}

// ---------- validation ----------

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const shortStr = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);

const SHOWN_REF = new RegExp(`\\[\\[((?:${REF_PREFIXES.join('|')})_[0-9a-f]{10}|page:[a-z]+)(?:\\|([^\\]\\n|]{1,120}))?\\]\\]`, 'g');
/**
 * Length of tile text as the dashboard shows it: a reference ([[id]], [[id|words]]) counts as the words it renders
 * (its label, else the item's title, at most 48 characters, where rows cut long titles), not as its id.
 */
export function shownLength(s: string): number {
  return s.replace(SHOWN_REF, (_m, id: string, label?: string) => (label ?? (id.startsWith('page:') ? id.slice(5) : (resolveRef(id)?.title ?? id))).slice(0, 48)).length;
}
/** Text of at most `max` characters as shown, and at most twice that as stored. */
const shownStr = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max * 2 && shownLength(v) <= max);

/**
 * Checks data for a tile of `kind` and returns it normalised, or an error that says exactly what is wrong and the
 * shape expected. Images and pages come as a file path instead (storeFile).
 */
export function validateData(kind: string, data: unknown): { data: Row } | { error: string } {
  const shape = DATA_SHAPES[kind];
  if (!shape) return { error: `A ${kind} tile takes no data object.` };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: `data must be an object: ${shape}` };
  const d = data as Row;
  const size = JSON.stringify(d).length;
  if (size > MAX_DATA_CHARS) return { error: `data is ${Math.round(size / 1024)} KB; a tile holds at most ${MAX_DATA_CHARS / 1024} KB. Summarise it (fewer points or rows).` };
  const bad = (what: string) => ({ error: `${what} Expected: ${shape}` });
  if (kind === 'number') {
    if (!num(d.value)) return bad('"value" must be a finite number.');
    for (const k of ['target', 'min', 'max']) if (d[k] !== undefined && !num(d[k])) return bad(`"${k}" must be a number.`);
    if (num(d.min) && num(d.max) && d.min >= d.max) return bad('"min" must be below "max".');
    if (!shortStr(d.unit, 16)) return bad('"unit" must be text of at most 16 characters.');
    if (!shownStr(d.label, 80)) return bad('"label" must be text of at most 80 characters.');
    if (d.better !== undefined && !['higher', 'lower'].includes(d.better)) return bad('"better" must be "higher" or "lower".');
    const extra = Object.keys(d).filter((k) => !['value', 'unit', 'target', 'min', 'max', 'better', 'label'].includes(k));
    if (extra.length) return bad(`Unknown field${extra.length > 1 ? 's' : ''} ${extra.join(', ')}.`);
    return { data: { value: d.value, unit: d.unit, target: d.target, min: d.min, max: d.max, better: d.better, label: d.label } };
  }
  if (kind === 'chart') {
    const type = d.type ?? 'line';
    if (!CHART_TYPES.includes(type)) return bad(`"type" must be one of ${CHART_TYPES.join(', ')}.`);
    if (!Array.isArray(d.series) || !d.series.length) return bad('"series" must be a non-empty array.');
    if (d.series.length > 12) return bad('At most 12 series.');
    let n = 0;
    for (const [i, s] of d.series.entries()) {
      if (!s || typeof s !== 'object' || !Array.isArray(s.values)) return bad(`series[${i}] needs "values", an array of numbers.`);
      if (!shortStr(s.name, 60)) return bad(`series[${i}].name must be text of at most 60 characters.`);
      if (s.values.length > 500) return bad(`series[${i}] has ${s.values.length} values; at most 500.`);
      const k = s.values.findIndex((v: unknown) => v !== null && !num(v));
      if (k >= 0) return bad(`series[${i}].values[${k}] is not a number (use null for a missing point).`);
      n = Math.max(n, s.values.length);
    }
    if (!n) return bad('The series have no values.');
    if (d.labels !== undefined) {
      if (!Array.isArray(d.labels) || d.labels.some((l: unknown) => typeof l !== 'string' && !num(l))) return bad('"labels" must be an array of text or numbers.');
      if (d.labels.length !== n) return bad(`"labels" has ${d.labels.length} entries but the longest series has ${n} values.`);
    }
    if (!shortStr(d.unit, 16)) return bad('"unit" must be text of at most 16 characters.');
    return { data: { type, labels: d.labels, series: d.series.map((s: Row) => ({ name: s.name, values: s.values })), unit: d.unit } };
  }
  if (kind === 'table') {
    if (!Array.isArray(d.columns) || !d.columns.length || d.columns.length > 20 || d.columns.some((c: unknown) => typeof c !== 'string' || !c.length || c.length > 60)) {
      return bad('"columns" must be 1 to 20 names of at most 60 characters.');
    }
    if (!Array.isArray(d.rows) || d.rows.length > 300) return bad('"rows" must be an array of at most 300 rows.');
    for (const [i, r] of d.rows.entries()) {
      if (!Array.isArray(r) || r.length !== d.columns.length) return bad(`rows[${i}] must be an array of ${d.columns.length} cells, one per column.`);
      const k = r.findIndex((c: unknown) => !(c === null || typeof c === 'boolean' || num(c) || (typeof c === 'string' && shownStr(c, 400))));
      if (k >= 0) return bad(`rows[${i}][${k}] must be text (up to 400 characters), a number, true/false or null.`);
    }
    return { data: { columns: d.columns, rows: d.rows } };
  }
  if (kind === 'scores') {
    if (!Array.isArray(d.columns) || !d.columns.length || d.columns.length > 12) return bad('"columns" must be 1 to 12 columns.');
    const columns: Row[] = [];
    for (const [i, c] of d.columns.entries()) {
      if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 40) return bad(`columns[${i}] needs "name" (at most 40 characters).`);
      if (!shortStr(c.unit, 12)) return bad(`columns[${i}].unit must be text of at most 12 characters.`);
      if (c.better !== undefined && c.better !== null && !['higher', 'lower'].includes(c.better)) return bad(`columns[${i}].better must be "higher" or "lower" (or left out).`);
      columns.push({ name: c.name.trim(), unit: c.unit || undefined, better: c.better ?? undefined });
    }
    if (!Array.isArray(d.rows) || !d.rows.length || d.rows.length > 40) return bad('"rows" must be 1 to 40 rows.');
    const rows: Row[] = [];
    for (const [i, r] of d.rows.entries()) {
      if (!r || typeof r !== 'object' || typeof r.label !== 'string' || !r.label.trim() || r.label.length > 60) return bad(`rows[${i}] needs "label" (at most 60 characters; the same words as the compare tile's image labels, so they read as one).`);
      if (!Array.isArray(r.values) || r.values.length !== columns.length) return bad(`rows[${i}].values must have ${columns.length} entries, one per column.`);
      const k = r.values.findIndex((v: unknown) => !(v === null || num(v) || (typeof v === 'string' && v.length <= 40)));
      if (k >= 0) return bad(`rows[${i}].values[${k}] must be a number, null, or short text.`);
      rows.push({ label: r.label.trim(), values: r.values });
    }
    return { data: { columns, rows } };
  }
  return { error: `Unknown tile kind "${kind}".` };
}

const DATA_SHAPES: Record<string, string> = {
  number: '{"value": 16.4, "unit": "ms", "target": 16.7, "better": "lower", "min": 0, "max": 33, "label": "p95 frame time"} (only value is required; min and max draw a gauge)',
  chart: '{"type": "line"|"bar"|"stacked", "labels": ["low", "medium", "high"], "series": [{"name": "GPU ms", "values": [4.1, 6.3, 9.8]}], "unit": "ms"}',
  table: '{"columns": ["Level", "Draw calls"], "rows": [["forest", 812], ["cave", 1204]]}',
  scores: '{"columns": [{"name": "Error", "unit": "%", "better": "lower"}, {"name": "Frame", "unit": "ms", "better": "lower"}], "rows": [{"label": "Cascades", "values": [4.2, 1.9]}, {"label": "Reference", "values": [0, 410]}]} (row labels the same as the compare tile\'s image labels)',
};

/** What update_tile takes for each kind, for the tool's errors and descriptions. */
export function shapeFor(kind: string): string {
  if (kind === 'image') return 'path: an image file (PNG, JPEG, WebP, GIF, SVG or AVIF, up to 20 MB), optionally caption';
  if (kind === 'page') return 'path: a self-contained HTML file (up to 2 MB), shown sandboxed';
  if (kind === 'text') return `text: markdown, up to ${MAX_TEXT_CHARS} characters`;
  if (kind === 'compare') return `images: [{"label": "Cascades", "path": "out/cascades.png"}, …] (${COMPARE_MIN} to ${COMPARE_MAX} images of the same viewpoint, same size), optionally reference: the label of the reference image`;
  return `data: ${DATA_SHAPES[kind]}`;
}

/** Checks a file an agent names for an image or page tile and copies it into the artifact folder. */
/** A relative path is looked for in each of `bases` in turn (the agent's worktree, then the project folder). */
export function storeFile(project: Row, tile: Row, path: string, bases: string[] = []): { file: string; bytes: number; width?: number | null; height?: number | null } | { error: string } {
  const tries = isAbsolute(path) ? [path] : [...bases, project.path].filter((b) => existsSync(b)).map((b) => resolve(b, path));
  const abs = tries.find((t) => existsSync(t));
  if (!abs) return { error: `File not found: ${tries.join(' or ') || path}. Give an absolute path.` };
  const st = statSync(abs);
  if (!st.isFile()) return { error: `Not a file: ${abs}` };
  const ext = extname(abs).toLowerCase();
  if (tile.kind === 'image') {
    if (!IMAGE_EXTS.includes(ext)) return { error: `Not an image (${IMAGE_EXTS.join(' ')}): ${abs}` };
    if (st.size > MAX_IMAGE_BYTES) return { error: `The image is ${(st.size / 1048576).toFixed(1)} MB; a tile takes at most ${MAX_IMAGE_BYTES / 1048576} MB. Save it smaller (JPEG or WebP, or a smaller size).` };
  } else if (tile.kind === 'page') {
    if (!['.html', '.htm'].includes(ext)) return { error: `A page tile takes an .html file: ${abs}` };
    if (st.size > MAX_PAGE_BYTES) return { error: `The page is ${(st.size / 1048576).toFixed(1)} MB; a tile takes at most ${MAX_PAGE_BYTES / 1048576} MB. Make it self-contained and smaller.` };
  } else return { error: `A ${tile.kind} tile takes ${shapeFor(tile.kind)}, not a file.` };
  mkdirSync(fileDir(project.id), { recursive: true });
  const name = `${tile.id}-${newId('v').slice(2)}${ext === '.htm' ? '.html' : ext}`;
  copyFileAtomic(abs, join(fileDir(project.id), name));
  const size = tile.kind === 'image' ? imageSize(abs) : null;
  return { file: relFile(project.id, name), bytes: st.size, ...(tile.kind === 'image' ? { width: size?.width ?? null, height: size?.height ?? null } : {}) };
}

/** A page given as HTML text instead of a file. */
export function storeHtml(project: Row, tile: Row, html: string): { file: string; bytes: number } | { error: string } {
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_PAGE_BYTES) return { error: `The page is ${(bytes / 1048576).toFixed(1)} MB; at most ${MAX_PAGE_BYTES / 1048576} MB.` };
  mkdirSync(fileDir(project.id), { recursive: true });
  const name = `${tile.id}-${newId('v').slice(2)}.html`;
  writeFileAtomic(join(fileDir(project.id), name), html, { ifChanged: false });
  return { file: relFile(project.id, name), bytes };
}

// ---------- dependencies and recipes ----------

export function validateDeps(projectId: string, input: Partial<Deps>): { deps: Deps } | { error: string } {
  const paths = (input.paths ?? []).map((p) => p.trim().replace(/^\.\//, '')).filter(Boolean);
  for (const p of paths) {
    if (p.length > 300) return { error: `A path pattern is at most 300 characters: ${p.slice(0, 40)}…` };
    if (p.startsWith('/') || p.split('/').includes('..')) return { error: `Path patterns are relative to the repository root, without "..": ${p}` };
  }
  const docs = [...new Set(input.docs ?? [])];
  for (const d of docs) if (!get('SELECT id FROM docs WHERE id = ? AND project_id = ?', d, projectId)) return { error: `No Spec entry ${d} on this project (list_docs shows the ids).` };
  const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (paths.length > 40 || docs.length > 20 || tags.length > 10) return { error: 'At most 40 path patterns, 20 Spec entries and 10 tags per tile.' };
  return { deps: { paths: [...new Set(paths)], docs, tags } };
}

export function validateRecipe(projectId: string, input: Partial<Recipe>): { recipe: Recipe } | { error: string } {
  const command = (input.command ?? '').trim();
  const cwd = (input.cwd ?? '').trim();
  if (!command) return { error: 'The recipe needs "command": the exact command(s) or steps that produce this tile\'s data, so any agent can refresh it the same way.' };
  if (!cwd) return { error: 'The recipe needs "cwd": the folder to run it in (relative to the repository root, or "." for the root).' };
  if (command.length > 4000 || (input.notes ?? '').length > 2000) return { error: 'A recipe\'s command is at most 4000 characters and its notes 2000.' };
  let host = input.host?.trim() || undefined;
  if (host) {
    const hosts = projectHosts(projectId);
    const h = hosts.find((x) => x.name === host || x.id === host);
    if (!h) return { error: `No host "${host}" on this project. Hosts: ${hosts.map((x) => x.name).join(', ')} (list_hosts). Leave host out when it runs where the agent runs.` };
    host = h.name;
  }
  return { recipe: { command, cwd, host, duration: input.duration?.trim() || undefined, notes: input.notes?.trim() || undefined } };
}

// ---------- dashboards ----------

export function getDashboard(projectId: string, ref: string): Row | undefined {
  return get('SELECT * FROM dashboards WHERE project_id = ? AND (id = ? OR lower(title) = lower(?)) ORDER BY created_at LIMIT 1', projectId, ref, ref);
}
export function getTile(projectId: string, id: string): Row | undefined {
  return get('SELECT * FROM tiles WHERE project_id = ? AND id = ?', projectId, id);
}
export const tilesOf = (dashboardId: string) => all('SELECT * FROM tiles WHERE dashboard_id = ? ORDER BY position, created_at', dashboardId);

export function createDashboard(projectId: string, input: { title: string; description: string; taskId: string | null; by: string }): Row {
  const id = newId('dash');
  const pos = ((get('SELECT MAX(position) AS m FROM dashboards WHERE project_id = ?', projectId)?.m as number) ?? 0) + 1;
  run(
    'INSERT INTO dashboards (id, project_id, title, description, state, task_id, position, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, projectId, input.title.trim().slice(0, 120), input.description.trim(), 'building', input.taskId, pos, input.by, now(), now(),
  );
  return get('SELECT * FROM dashboards WHERE id = ?', id)!;
}

/** Removes a dashboard, its tiles and every file they kept. */
export function removeDashboard(d: Row) {
  for (const t of tilesOf(d.id)) removeTile(t);
  run('DELETE FROM dashboards WHERE id = ?', d.id);
}

export function removeTile(t: Row) {
  for (const h of all('SELECT file, data FROM tile_history WHERE tile_id = ?', t.id)) for (const f of new Set([h.file, ...filesOfData(h.data)])) removeFile(f);
  tx(() => {
    run('DELETE FROM tile_history WHERE tile_id = ?', t.id);
    run('DELETE FROM tile_checks WHERE tile_id = ?', t.id);
    run('DELETE FROM tiles WHERE id = ?', t.id);
  });
}

/** May this agent create and edit the tiles of `d`? Managers always; others when working on its task or one it allows. */
export function mayEditTiles(d: Row, agent: Row, manager: boolean): boolean {
  if (manager) return true;
  if (!agent.task_id) return false;
  return d.task_id === agent.task_id || parse<string[]>(d.allow_tasks, []).includes(agent.task_id);
}

export type TileInput = {
  kind?: string;
  title?: string;
  caption?: string;
  group?: string;
  position?: number;
  depends_on?: Partial<Deps>;
  recipe?: Partial<Recipe>;
  expensive?: boolean;
  /** The section it belongs to (id or title); a title not on the dashboard yet makes a new section at the end. */
  section?: string;
  size?: string;
  /** Longer notes, behind an info tap. */
  info?: string;
  /** A page tile: why free HTML, not a widget. */
  page_reason?: string;
};

/** Creates (no `tile`) or edits a tile. Every part is checked first, so a refused call changes nothing. */
export function saveTile(d: Row, tile: Row | undefined, input: TileInput): { tile: Row; notes: string[] } | { error: string } {
  const notes: string[] = [];
  if (!tile) {
    if (!input.kind || !TILE_KINDS.includes(input.kind as TileKind)) return { error: `kind must be one of ${TILE_KINDS.join(', ')} (a gallery is image tiles sharing a group; images of one viewpoint are one compare tile).` };
    if (!input.title?.trim()) return { error: 'A new tile needs a title.' };
    if (!input.depends_on) return { error: 'A new tile needs depends_on: the repository paths (globs), Spec entries or tags whose change makes its data out of date. Use {"paths": []} only for a tile nothing in the repository affects.' };
    if (!input.recipe) return { error: 'A new tile needs a recipe: {"command": "...", "cwd": "..."} with the exact steps that produce its data, so a later agent refreshes it the same way.' };
    if ((get('SELECT COUNT(*) AS n FROM tiles WHERE dashboard_id = ?', d.id)!.n as number) >= MAX_TILES) return { error: `A dashboard holds at most ${MAX_TILES} tiles.` };
  } else if (input.kind && input.kind !== tile.kind) return { error: `A tile's kind cannot change (it is ${tile.kind}); remove it and create another.` };
  // The rules (dashrules.ts): short titles, one caption line, a section for every tile, a reason for every page.
  if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > TITLE_MAX)) return { error: `A title is 1 to ${TITLE_MAX} characters, so the grid shows it whole; put the rest in the caption or info.` };
  if (input.caption !== undefined && (input.caption.trim().length > CAPTION_MAX || input.caption.trim().includes('\n'))) return { error: `A caption is one line of at most ${CAPTION_MAX} characters; put the rest in info (shown behind an info tap).` };
  if ((input.info ?? '').length > INFO_MAX || (input.group ?? '').length > 80) return { error: `info is at most ${INFO_MAX} characters and a group name 80.` };
  if (input.size !== undefined && !TILE_SIZES.includes(input.size as 's')) return { error: `size is one of ${TILE_SIZES.join(', ')} (small, medium, large on one grid).` };
  const kind = tile?.kind ?? input.kind;
  if (kind === 'page' && !(input.page_reason ?? tile?.page_reason ?? '').trim()) return { error: 'A page tile (free HTML) needs page_reason: why no widget fits (number, chart, table, scores, image, compare, text). It is shown marked as a custom page.' };
  if ((input.page_reason ?? '').length > 300) return { error: 'page_reason is at most 300 characters.' };
  let section: Row | undefined;
  let newSection: string | null = null;
  if (input.section !== undefined) {
    section = findSection(d, input.section);
    if (!section) {
      const t = input.section.trim();
      if (!t || t.length > 60) return { error: 'section is a section of this dashboard (id or title), or the title (1 to 60 characters) of a new one.' };
      newSection = t;
    }
  } else if (!tile?.section_id) {
    return { error: `Every tile belongs to a section: pass section (an existing one: ${sectionsOf(d.id).map((x) => `"${x.title}"`).join(', ') || 'none yet'}; or a new title). Group tiles by what they are about (one section per scene, per area).` };
  }
  if (section && sectionCount(section.id, tile?.id ?? '') >= SECTION_MAX) return { error: `"${section.title}" already holds ${SECTION_MAX} tiles: add a sub-section (set_dashboard sections: [{title, parent: "${section.title}"}]) and put this tile there.` };
  let deps: Deps | undefined;
  if (input.depends_on) {
    const r = validateDeps(d.project_id, input.depends_on);
    if ('error' in r) return r;
    deps = r.deps;
    if (!deps.paths.length && !deps.docs.length && !deps.tags.length) notes.push('It depends on nothing, so no task will ever be asked to refresh it.');
  }
  let recipe: Recipe | undefined;
  if (input.recipe) {
    const r = validateRecipe(d.project_id, { ...(tile ? (recipeOf(tile) ?? {}) : {}), ...input.recipe });
    if ('error' in r) return r;
    recipe = r.recipe;
  }
  const id = tile?.id ?? newId('tile');
  tx(() => {
    const sectionId = newSection ? addSection(d, newSection).id : section?.id ?? tile?.section_id ?? null;
    if (!tile) {
      const pos = input.position ?? ((get('SELECT MAX(position) AS m FROM tiles WHERE dashboard_id = ?', d.id)?.m as number) ?? 0) + 1;
      run(
        'INSERT INTO tiles (id, dashboard_id, project_id, kind, title, caption, grp, position, deps, recipe, expensive, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, d.id, d.project_id, input.kind, input.title!.trim(), input.caption?.trim() ?? '', input.group?.trim() ?? '', pos, JSON.stringify(deps), JSON.stringify(recipe), input.expensive ? 1 : 0, now(), now(),
      );
    } else {
      run(
        `UPDATE tiles SET title = ?, caption = ?, grp = ?, position = ?, deps = ?, recipe = ?, expensive = ?, updated_at = ? WHERE id = ?`,
        input.title?.trim() ?? tile.title, input.caption?.trim() ?? tile.caption, input.group?.trim() ?? tile.grp, input.position ?? tile.position,
        deps ? JSON.stringify(deps) : tile.deps, recipe ? JSON.stringify(recipe) : tile.recipe, input.expensive === undefined ? tile.expensive : input.expensive ? 1 : 0, now(), id,
      );
    }
    run(
      'UPDATE tiles SET section_id = ?, size = ?, info = ?, page_reason = ? WHERE id = ?',
      sectionId, input.size ?? tile?.size ?? (['compare', 'table', 'scores', 'page'].includes(kind ?? '') ? 'l' : kind === 'number' ? 's' : 'm'), input.info?.trim() ?? tile?.info ?? '', input.page_reason?.trim() ?? tile?.page_reason ?? '', id,
    );
    run('UPDATE dashboards SET updated_at = ? WHERE id = ?', now(), d.id);
  });
  return { tile: get('SELECT * FROM tiles WHERE id = ?', id)!, notes };
}

/** The tiles of a dashboard in this order (unknown ids refused; tiles left out keep their order after them). */
export function reorderTiles(d: Row, ids: string[]): string | null {
  const tiles = tilesOf(d.id);
  const bad = ids.find((id) => !tiles.some((t) => t.id === id));
  if (bad) return `No tile ${bad} on this dashboard.`;
  const order = [...ids, ...tiles.map((t) => t.id).filter((id) => !ids.includes(id))];
  tx(() => order.forEach((id, i) => run('UPDATE tiles SET position = ? WHERE id = ?', i + 1, id)));
  return null;
}

/** Pin or unpin a tile on Home; at most MAX_PINNED per project, in the order they were pinned. */
export function pinTile(t: Row, on: boolean): string | null {
  if (!on) {
    run('UPDATE tiles SET pinned = 0 WHERE id = ?', t.id);
    return null;
  }
  if (t.pinned) return null;
  const pinned = all('SELECT id FROM tiles WHERE project_id = ? AND pinned > 0 ORDER BY pinned', t.project_id);
  if (pinned.length >= MAX_PINNED) return `At most ${MAX_PINNED} tiles can be pinned to Home. Unpin one first.`;
  run('UPDATE tiles SET pinned = ? WHERE id = ?', pinned.length + 1, t.id);
  return null;
}

// ---------- refreshing ----------

/** The commit an agent's data was built from: its registered worktree's HEAD, else the project folder's. */
export async function currentCommit(project: Row, agentId: string | null): Promise<string | null> {
  const wt = agentId ? get("SELECT path FROM artifacts WHERE agent_id = ? AND kind = 'worktree' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1", agentId) : undefined;
  for (const dir of [wt?.path, project.path].filter(Boolean)) {
    if (!existsSync(dir)) continue;
    try {
      return (await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim() || null;
    } catch {}
  }
  return null;
}

/**
 * New data for a tile: kept as its current data and added to its history, which is then trimmed (files of dropped
 * entries removed). Clears Stale and the last error.
 */
export function recordData(tile: Row, value: Row, built: Built, file?: { file: string; bytes: number } | null) {
  tx(() => {
    run(
      'INSERT INTO tile_history (tile_id, project_id, data, file, bytes, commit_sha, task_id, agent_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      tile.id, tile.project_id, JSON.stringify(value), file?.file ?? null, file?.bytes ?? 0, built.commit, built.task_id, built.agent_id, built.at,
    );
    run('UPDATE tiles SET data = ?, built = ?, stale = NULL, error = NULL, asked_at = NULL, updated_at = ? WHERE id = ?', JSON.stringify(value), JSON.stringify(built), now(), tile.id);
  });
  trimHistory(tile);
}

/** Keeps the newest HISTORY_KEEP[kind] entries and at most TILE_FILES_CAP bytes of files; removes the rest's files. */
export function trimHistory(tile: Row): number {
  const keep = HISTORY_KEEP[tile.kind] ?? 20;
  const rows = all('SELECT id, file, data, bytes FROM tile_history WHERE tile_id = ? ORDER BY id DESC', tile.id);
  const drop: Row[] = [];
  let bytes = 0;
  rows.forEach((r, i) => {
    bytes += r.bytes ?? 0;
    if (i > 0 && (i >= keep || bytes > TILE_FILES_CAP)) drop.push(r);
  });
  if (!drop.length) return 0;
  for (const r of drop) for (const f of new Set([r.file, ...filesOfData(r.data)])) removeFile(f);
  run(`DELETE FROM tile_history WHERE id IN (${drop.map(() => '?').join(',')})`, ...drop.map((r) => r.id));
  return drop.length;
}

export function markError(tile: Row, message: string, agent: string) {
  run('UPDATE tiles SET error = ?, updated_at = ? WHERE id = ?', JSON.stringify({ message: message.slice(0, 2000), at: now(), agent }), now(), tile.id);
}
export function markStale(tile: Row, stale: Stale) {
  run('UPDATE tiles SET stale = ?, updated_at = ? WHERE id = ?', JSON.stringify(stale), now(), tile.id);
}

/** Bytes of dashboard files a project keeps (the Disk page counts them). */
export function dashboardBytes(projectId: string): number {
  return (get('SELECT COALESCE(SUM(bytes), 0) AS n FROM tile_history WHERE project_id = ?', projectId)?.n as number) ?? 0;
}

// ---------- views ----------

const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : null);

export function tileView(t: Row, withHistory = false) {
  const hist = all('SELECT id, data, file, commit_sha, task_id, agent_id, created_at FROM tile_history WHERE tile_id = ? ORDER BY id DESC LIMIT ?', t.id, withHistory ? 100 : t.kind === 'number' ? 30 : 0);
  return {
    id: t.id,
    dashboard_id: t.dashboard_id,
    kind: t.kind,
    title: t.title,
    caption: t.caption,
    info: t.info ?? '',
    section_id: t.section_id ?? null,
    size: t.size ?? 'm',
    page_reason: t.page_reason ?? '',
    group: t.grp,
    position: t.position,
    pinned: t.pinned,
    expensive: !!t.expensive,
    deps: depsOf(t),
    recipe: recipeOf(t),
    data: parse<Row | null>(t.data, null),
    built: parse<Built | null>(t.built, null),
    stale: parse<Stale | null>(t.stale, null),
    error: parse<Row | null>(t.error, null),
    asked_at: t.asked_at,
    history_count: (get('SELECT COUNT(*) AS n FROM tile_history WHERE tile_id = ?', t.id)!.n as number) ?? 0,
    history: hist.map((h) => ({ id: h.id, data: parse<Row | null>(h.data, null), commit: h.commit_sha, task_id: h.task_id, agent_id: h.agent_id, at: h.created_at })).reverse(),
  };
}

export function dashboardView(d: Row) {
  const task = d.task_id ? get('SELECT id, title, state FROM tasks WHERE id = ?', d.task_id) : null;
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    state: d.state,
    task,
    position: d.position,
    created_at: d.created_at,
    ready_at: d.ready_at,
    sections: sectionsOf(d.id).map((s) => ({ id: s.id, title: s.title, parent_id: s.parent_id, position: s.position })),
    key: parse<Row[]>(d.series_key, []),
    tiles: tilesOf(d.id).map((t) => tileView(t)),
  };
}

export function dashboardsView(projectId: string) {
  return {
    on: dashboardsOn(projectId),
    dashboards: all('SELECT * FROM dashboards WHERE project_id = ? ORDER BY position, created_at', projectId).map(dashboardView),
  };
}

/** For the project state (Home): the pinned tiles, and a count per dashboard for the nav. */
export function dashboardSummary(projectId: string) {
  if (!dashboardsOn(projectId)) return { on: false, count: 0, stale: 0, pinned: [] };
  const n = (get('SELECT COUNT(*) AS n FROM dashboards WHERE project_id = ?', projectId)!.n as number) ?? 0;
  const stale = (get('SELECT COUNT(*) AS n FROM tiles WHERE project_id = ? AND stale IS NOT NULL', projectId)!.n as number) ?? 0;
  const pinned = all('SELECT * FROM tiles WHERE project_id = ? AND pinned > 0 ORDER BY pinned', projectId).map((t) => tileView(t));
  return { on: true, count: n, stale, pinned };
}

/** What a tile shows as of, in words for agents. */
function asOf(t: Row, tz: (ts: number) => string): string {
  const b = parse<Built | null>(t.built, null);
  if (!b) return 'no data yet';
  return `as of ${short(b.commit) ?? 'unknown commit'}, ${tz(b.at)}${b.agent ? ` by ${b.agent}` : ''}${b.task_id ? ` for [[${b.task_id}]]` : ''}`;
}

/** list_dashboards: every dashboard and tile with its state, dependencies and recipe. */
export function renderDashboards(projectId: string, tz: (ts: number) => string, only?: string, staleOnly = false): string {
  const ds = all('SELECT * FROM dashboards WHERE project_id = ? ORDER BY position, created_at', projectId).filter((d) => !only || d.id === only || d.title.toLowerCase() === only.toLowerCase());
  if (!ds.length) return only ? `No dashboard "${only}" on this project.` : 'This project has no dashboards yet.';
  const out: string[] = [];
  for (const d of ds) {
    out.push(`## ${d.title} [${d.id}] (${d.state === 'ready' ? 'ready' : 'being built'}${d.task_id ? `, task [[${d.task_id}]]` : ''})`);
    if (d.description) out.push(`Asked for: ${d.description.replace(/\s+/g, ' ').slice(0, 600)}`);
    const tiles = tilesOf(d.id).filter((t) => !staleOnly || parse<Stale | null>(t.stale, null));
    if (!tiles.length) out.push(staleOnly ? 'No Stale tiles.' : 'No tiles yet.');
    for (const t of tiles) {
      const deps = depsOf(t);
      const r = recipeOf(t);
      const stale = parse<Stale | null>(t.stale, null);
      const err = parse<Row | null>(t.error, null);
      const state = [stale ? `STALE: ${stale.reason}` : t.data ? 'current' : 'no data yet', err ? `last refresh FAILED: ${err.message.slice(0, 200)}` : ''].filter(Boolean).join('; ');
      out.push(
        [
          `- ${t.title} [${t.id}] ${t.kind}${t.section_id ? `, section "${sectionsOf(d.id).find((x) => x.id === t.section_id)?.title ?? '?'}"` : ', NO SECTION'}${t.grp ? `, group "${t.grp}"` : ''}${t.expensive ? ', EXPENSIVE (refresh only when the director asks)' : ''}${t.pinned ? ', pinned to Home' : ''}`,
          `  ${state}; ${asOf(t, tz)}`,
          `  depends on: ${[deps.paths.length ? deps.paths.join(', ') : '', deps.docs.length ? `Spec ${deps.docs.join(', ')}` : '', deps.tags.length ? `tags ${deps.tags.join(', ')}` : ''].filter(Boolean).join('; ') || 'nothing'}`,
          r ? `  recipe: in ${r.cwd}${r.host ? ` on ${r.host}` : ''}${r.duration ? `, takes ${r.duration}` : ''}: ${r.command.replace(/\n/g, ' ⏎ ')}${r.notes ? ` (${r.notes.replace(/\n/g, ' ')})` : ''}` : '  recipe: none',
        ].join('\n'),
      );
    }
    out.push('');
  }
  return out.join('\n').trim();
}
