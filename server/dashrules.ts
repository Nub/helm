import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { ARTIFACT_DIR } from './config.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import type { Built } from './dashboards.ts';
import { imageSize } from './store.ts';
import { copyFileAtomic } from './safefs.ts';
import {
  CAPTION_MAX,
  COMPARE_MAX,
  COMPARE_MIN,
  MAX_IMAGE_BYTES,
  SECTION_MAX,
  TITLE_MAX,
  depsOf,
  fileDir,
  recipeOf,
  recordData,
  removeTile,
  tilesOf,
} from './dashboards.ts';

/**
 * The rules every dashboard follows, so dashboards look and read alike (the user's ask: shared widgets, consistent):
 *
 * - A dashboard is a few titled sections in a stated order (one per scene, per area); every tile belongs to one, and a
 *   section holds at most SECTION_MAX tiles before a sub-section is asked for.
 * - A tile's title is at most TITLE_MAX characters and its caption one line of at most CAPTION_MAX; more goes in info,
 *   behind an info tap.
 * - Images of one viewpoint are one compare tile (2 to 8 labelled images, an optional reference), never separate image
 *   tiles, an animated "flip" image or a hand-made viewer page. Animated images are refused.
 * - A page tile (free HTML) states why nothing else fits (page_reason) and shows as such.
 * - A dashboard may name its series once (its key: label and colour from the validated palette).
 *
 * set_tile, update_tile and set_dashboard enforce them (dashtools.ts); lintDashboard lists what an existing dashboard
 * breaks; convertDashboard does what is safe by itself (sameview image groups to one compare tile; a small dashboard
 * with no sections gets one).
 */

export const SERIES_COLORS = 8;

const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ---------- sections ----------

export const sectionsOf = (dashboardId: string) => all('SELECT * FROM dashboard_sections WHERE dashboard_id = ? ORDER BY position, created_at', dashboardId);

/** A section of the dashboard by id or title (case-insensitive). */
export function findSection(d: Row, ref: string): Row | undefined {
  return get('SELECT * FROM dashboard_sections WHERE dashboard_id = ? AND (id = ? OR lower(title) = lower(?)) ORDER BY position LIMIT 1', d.id, ref, ref.trim());
}

/** A new section at the end (or under `parent`). */
export function addSection(d: Row, title: string, parent: Row | null = null): Row {
  const id = newId('sec');
  const pos = ((get('SELECT MAX(position) AS m FROM dashboard_sections WHERE dashboard_id = ?', d.id)?.m as number) ?? 0) + 1;
  run('INSERT INTO dashboard_sections (id, dashboard_id, project_id, title, parent_id, position, created_at) VALUES (?,?,?,?,?,?,?)', id, d.id, d.project_id, title.trim().slice(0, 60), parent?.id ?? null, pos, now());
  return get('SELECT * FROM dashboard_sections WHERE id = ?', id)!;
}

export type SectionInput = { section?: string; title?: string; parent?: string; remove?: boolean };

/**
 * set_dashboard's sections: create (title, optional parent), rename (section + title), move under another (parent) or
 * remove (only an empty one); the array's order is the sections' order.
 */
export function applySections(d: Row, input: SectionInput[]): string | null {
  // First every entry is checked against what exists and what earlier entries create, so a refused call changes nothing.
  const titles = new Map(sectionsOf(d.id).map((s) => [s.title.toLowerCase(), s]));
  const newTitles = new Set<string>();
  for (const [i, s] of input.entries()) {
    const sec = s.section ? findSection(d, s.section) : undefined;
    if (s.section && !sec) return `sections[${i}]: no section "${s.section}" on this dashboard.`;
    if (s.parent) {
      const p = titles.get(s.parent.trim().toLowerCase()) ?? findSection(d, s.parent);
      if (!p && !newTitles.has(s.parent.trim().toLowerCase())) return `sections[${i}]: no section "${s.parent}" to put it under (create it earlier in the array).`;
      if (p?.parent_id) return `sections[${i}]: "${p.title}" is itself a sub-section; sections nest one level.`;
    }
    if (s.remove) {
      if (!sec) return `sections[${i}]: remove needs section.`;
      const n = Number(get('SELECT COUNT(*) AS n FROM tiles WHERE section_id = ?', sec.id)?.n ?? 0) + Number(get('SELECT COUNT(*) AS n FROM dashboard_sections WHERE parent_id = ?', sec.id)?.n ?? 0);
      if (n) return `sections[${i}]: "${sec.title}" still holds tiles or sub-sections; move them first.`;
      continue;
    }
    const title = s.title?.trim();
    if (title !== undefined && (!title || title.length > 60)) return `sections[${i}]: a section title is 1 to 60 characters.`;
    if (!sec && !title) return `sections[${i}]: a new section needs a title.`;
    if (!sec) newTitles.add(title!.toLowerCase());
  }
  tx(() => {
    const order: string[] = [];
    const byTitle = (t: string) => findSection(d, t);
    for (const s of input) {
      const sec = s.section ? findSection(d, s.section) : undefined;
      if (s.remove) {
        run('DELETE FROM dashboard_sections WHERE id = ?', sec!.id);
        continue;
      }
      const parent = s.parent ? byTitle(s.parent) ?? null : undefined;
      if (sec) {
        run('UPDATE dashboard_sections SET title = ?, parent_id = ? WHERE id = ?', s.title?.trim() ?? sec.title, parent === undefined ? sec.parent_id : parent?.id ?? null, sec.id);
        order.push(sec.id);
      } else order.push(addSection(d, s.title!, parent ?? null).id);
    }
    const rest = sectionsOf(d.id).map((s) => s.id).filter((id) => !order.includes(id));
    [...order, ...rest].forEach((id, k) => run('UPDATE dashboard_sections SET position = ? WHERE id = ?', k + 1, id));
  });
  return null;
}

/** Tiles in a section now, besides `except`. */
export const sectionCount = (sectionId: string, except = '') => Number(get('SELECT COUNT(*) AS n FROM tiles WHERE section_id = ? AND id != ?', sectionId, except)?.n ?? 0);

// ---------- the series key ----------

export type KeyEntry = { name: string; color: number };
/** A dashboard's key: each series named once with a colour from the validated palette (1 to SERIES_COLORS). */
export function validateKey(input: unknown): { key: KeyEntry[] } | { error: string } {
  if (!Array.isArray(input) || input.length > SERIES_COLORS) return { error: `key is up to ${SERIES_COLORS} entries: [{"name": "Cascades", "color": 1}, …].` };
  const key: KeyEntry[] = [];
  for (const [i, e] of input.entries()) {
    if (!e || typeof e.name !== 'string' || !e.name.trim() || e.name.length > 40) return { error: `key[${i}] needs "name" (at most 40 characters).` };
    const color = e.color ?? i + 1;
    if (!Number.isInteger(color) || color < 1 || color > SERIES_COLORS) return { error: `key[${i}].color is 1 to ${SERIES_COLORS}: the palette's validated order.` };
    if (key.some((k) => k.name.toLowerCase() === e.name.trim().toLowerCase())) return { error: `key[${i}]: "${e.name}" is named twice.` };
    if (key.some((k) => k.color === color)) return { error: `key[${i}]: colour ${color} is already used.` };
    key.push({ name: e.name.trim(), color });
  }
  return { key };
}

// ---------- images ----------

/**
 * Whether an image file is animated: a GIF with more than one frame, a PNG with an animation chunk (APNG), or a WebP
 * with an ANIM chunk. Reads the file's bytes, never decodes it.
 */
export function isAnimated(abs: string): boolean {
  const ext = extname(abs).toLowerCase();
  let buf: Buffer;
  try {
    const fd = openSync(abs, 'r');
    const size = Math.min(statSync(abs).size, 8 * 1024 * 1024);
    buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    closeSync(fd);
  } catch {
    return false;
  }
  if (ext === '.png' || buf.subarray(1, 4).toString('latin1') === 'PNG') {
    // acTL comes before the first IDAT in an APNG.
    const idat = buf.indexOf('IDAT', 8, 'latin1');
    const actl = buf.indexOf('acTL', 8, 'latin1');
    return actl >= 0 && (idat < 0 || actl < idat);
  }
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') {
    // Image descriptors (0x2C) after graphic control extensions: count the GCE blocks (0x21 0xF9).
    let frames = 0;
    for (let i = 13; i + 1 < buf.length && frames < 2; i++) if (buf[i] === 0x21 && buf[i + 1] === 0xf9) frames++;
    return frames > 1;
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return buf.indexOf('ANIM', 12, 'latin1') >= 0;
  return false;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.avif', '.gif'];

/** A compare tile's images, given as files: checked (2 to 8, same viewpoint, not animated), copied into the artifact folder. */
export function storeCompare(project: Row, tile: Row, images: { label?: string; path?: string; caption?: string }[], reference: string | undefined, bases: string[] = []): { value: Row; bytes: number } | { error: string } {
  if (!Array.isArray(images) || images.length < COMPARE_MIN || images.length > COMPARE_MAX) return { error: `A compare tile takes ${COMPARE_MIN} to ${COMPARE_MAX} images.` };
  const seen = new Set<string>();
  const found: { label: string; abs: string; caption?: string }[] = [];
  for (const [i, im] of images.entries()) {
    const label = String(im?.label ?? '').trim();
    if (!label || label.length > 40) return { error: `images[${i}] needs a label of at most 40 characters (the name it is shown and flipped by).` };
    if (seen.has(label.toLowerCase())) return { error: `images[${i}]: the label "${label}" is used twice.` };
    seen.add(label.toLowerCase());
    if (!im.path) return { error: `images[${i}] needs path: the image file.` };
    const tries = isAbsolute(im.path) ? [im.path] : [...bases, project.path].filter((b) => existsSync(b)).map((b) => resolve(b, im.path!));
    const abs = tries.find((t) => existsSync(t));
    if (!abs || !statSync(abs).isFile()) return { error: `images[${i}]: file not found: ${tries.join(' or ') || im.path}.` };
    if (!IMAGE_EXTS.includes(extname(abs).toLowerCase())) return { error: `images[${i}] is not an image (${IMAGE_EXTS.join(' ')}): ${abs}` };
    if (statSync(abs).size > MAX_IMAGE_BYTES) return { error: `images[${i}] is over ${MAX_IMAGE_BYTES / 1048576} MB.` };
    if (isAnimated(abs)) return { error: `images[${i}] is animated: give each frame as its own labelled image instead (the compare tile flips between them).` };
    if ((im.caption ?? '').length > CAPTION_MAX) return { error: `images[${i}].caption is one line of at most ${CAPTION_MAX} characters.` };
    found.push({ label, abs, caption: im.caption?.trim() || undefined });
  }
  if (reference !== undefined && !found.some((f) => f.label.toLowerCase() === reference.trim().toLowerCase())) return { error: `reference "${reference}" is not one of the image labels (${found.map((f) => f.label).join(', ')}).` };
  mkdirSync(fileDir(project.id), { recursive: true });
  let bytes = 0;
  const stored = found.map((f) => {
    const name = `${tile.id}-${newId('v').slice(2)}${extname(f.abs).toLowerCase()}`;
    copyFileAtomic(f.abs, join(fileDir(project.id), name));
    const size = imageSize(f.abs);
    bytes += statSync(f.abs).size;
    return { label: f.label, file: `dashboards/${project.id}/${name}`, width: size?.width ?? null, height: size?.height ?? null, ...(f.caption ? { caption: f.caption } : {}) };
  });
  const ref = reference ? found.find((f) => f.label.toLowerCase() === reference.trim().toLowerCase())!.label : undefined;
  return { value: { images: stored, ...(ref ? { reference: ref } : {}) }, bytes };
}

// ---------- lint ----------

export type LintIssue = { tile?: string; title: string; problem: string };

/** What a dashboard breaks of the rules, tile by tile. */
export function lintDashboard(d: Row): LintIssue[] {
  const out: LintIssue[] = [];
  const tiles = tilesOf(d.id);
  const sections = sectionsOf(d.id);
  for (const t of tiles) {
    const at = { tile: t.id, title: t.title };
    if (!t.section_id || !sections.some((s) => s.id === t.section_id)) out.push({ ...at, problem: 'has no section' });
    if (t.title.length > TITLE_MAX) out.push({ ...at, problem: `title is ${t.title.length} characters (at most ${TITLE_MAX})` });
    if (t.caption.length > CAPTION_MAX || t.caption.includes('\n')) out.push({ ...at, problem: `caption is more than one line of ${CAPTION_MAX} characters (move the rest to info)` });
    if (t.kind === 'page' && !t.page_reason) out.push({ ...at, problem: 'is a page (free HTML) with no stated reason' });
    if (t.kind === 'image') {
      const file = parse<Row | null>(t.data, null)?.file;
      if (file && isAnimated(join(ARTIFACT_DIR, file))) out.push({ ...at, problem: 'is an animated image (use a compare tile)' });
    }
  }
  for (const [grp, list] of groupsOf(tiles)) if (sameView(list)) out.push({ title: grp, problem: `${list.length} image tiles of one view (group "${grp}"): one compare tile` });
  for (const s of sections) {
    const n = tiles.filter((t) => t.section_id === s.id).length;
    if (n > SECTION_MAX) out.push({ title: s.title, problem: `section holds ${n} tiles (at most ${SECTION_MAX}; add a sub-section)` });
  }
  return out;
}

export function lintText(d: Row, issues = lintDashboard(d)): string {
  if (!issues.length) return `"${d.title}" follows the rules.`;
  return [`"${d.title}" [${d.id}]: ${issues.length} to fix`, ...issues.map((i) => `- ${i.tile ? `"${i.title}" [${i.tile}]` : `"${i.title}"`}: ${i.problem}`)].join('\n');
}

// ---------- conversion ----------

const animatedTile = (t: Row) => {
  const file = parse<Row | null>(t.data, null)?.file;
  return !!file && isAnimated(join(ARTIFACT_DIR, file));
};
const groupsOf = (tiles: Row[]) => {
  const m = new Map<string, Row[]>();
  // An animated image (a flip) is never one of the views: it is what the compare tile replaces.
  for (const t of tiles) if (t.kind === 'image' && t.grp && !animatedTile(t)) (m.get(t.grp) ?? m.set(t.grp, []).get(t.grp)!).push(t);
  return [...m].filter(([, l]) => l.length >= 2);
};
/** "Cornell: No GI" → ["Cornell", "No GI"]. */
const split = (title: string) => {
  const m = /^(.{1,60}?):\s+(.+)$/.exec(title);
  return m ? [m[1].trim(), m[2].trim()] : null;
};
/**
 * Whether image tiles show one viewpoint (and so are one comparison, not a gallery): every title is "<scene>: <label>"
 * with the same scene, and every image has the same size.
 */
export function sameView(list: Row[]): boolean {
  if (list.length < COMPARE_MIN || list.length > COMPARE_MAX) return false;
  const scenes = list.map((t) => split(t.title)?.[0]?.toLowerCase());
  if (scenes.some((s) => !s) || new Set(scenes).size !== 1) return false;
  const sizes = list.map((t) => parse<Row | null>(t.data, null)).map((d) => (d?.file && d.width && d.height ? `${d.width}x${d.height}` : null));
  return sizes.every((s) => s) && new Set(sizes).size === 1;
}

/** Image tiles of one view become one compare tile in a section named for them, in their order; the old tiles go. */
function groupToCompare(d: Row, grp: string, list: Row[]): Row {
  const scene = split(list[0].title)![0];
  const section = findSection(d, scene) ?? findSection(d, grp) ?? addSection(d, scene);
  const id = newId('tile');
  const ordered = [...list].sort((a, b) => a.position - b.position || a.created_at - b.created_at);
  const deps = { paths: [...new Set(ordered.flatMap((t) => depsOf(t).paths))], docs: [...new Set(ordered.flatMap((t) => depsOf(t).docs))], tags: [...new Set(ordered.flatMap((t) => depsOf(t).tags))] };
  const recipes = ordered.map((t) => ({ label: split(t.title)![1], r: recipeOf(t) })).filter((x) => x.r);
  const first = recipes[0]?.r;
  const recipe = first
    ? { command: recipes.map((x) => `# ${x.label}\n${x.r!.command}`).join('\n\n').slice(0, 4000), cwd: first.cwd, host: first.host, duration: first.duration, notes: `One image per label, then update_tile images: [{label, path}…]${recipes.some((x) => x.r!.cwd !== first.cwd) ? ' (each label\'s command runs in its own folder; see the original tiles\' recipes)' : ''}.` }
    : { command: 'Render each image as before, then update_tile images.', cwd: '.' };
  const images: Row[] = [];
  let bytes = 0;
  for (const t of ordered) {
    const data = parse<Row | null>(t.data, null)!;
    const src = join(ARTIFACT_DIR, data.file);
    const name = `${id}-${newId('v').slice(2)}${extname(data.file)}`;
    if (existsSync(src)) {
      mkdirSync(fileDir(d.project_id), { recursive: true });
      copyFileAtomic(src, join(fileDir(d.project_id), name));
      bytes += Number(data.bytes ?? 0);
    }
    images.push({ label: split(t.title)![1].slice(0, 40), file: `dashboards/${d.project_id}/${name}`, width: data.width ?? null, height: data.height ?? null, ...(t.caption || data.caption ? { caption: String(data.caption || t.caption).split('\n')[0].slice(0, CAPTION_MAX) } : {}) });
  }
  const ref = images.find((i) => /reference|ground truth|path.?traced/i.test(i.label));
  const latest = ordered.map((t) => parse<Row | null>(t.built, null)).filter(Boolean).sort((a, b) => b!.at - a!.at)[0];
  const title = scene.slice(0, 40);
  run(
    'INSERT INTO tiles (id, dashboard_id, project_id, kind, title, caption, info, grp, position, deps, recipe, expensive, section_id, size, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, d.id, d.project_id, 'compare', title, `${images.length} images${ref ? `, against ${ref.label}` : ''}`.slice(0, CAPTION_MAX), '', '', ordered[0].position, JSON.stringify(deps), JSON.stringify(recipe), ordered.some((t) => t.expensive) ? 1 : 0, section.id, 'l', now(), now(),
  );
  const tile = get('SELECT * FROM tiles WHERE id = ?', id)!;
  recordData(tile, { images, ...(ref ? { reference: ref.label } : {}) }, (latest as Built | undefined) ?? { commit: null, at: now(), agent_id: null, agent: 'Helm', task_id: null }, { file: null as unknown as string, bytes });
  for (const t of ordered) removeTile(t);
  return get('SELECT * FROM tiles WHERE id = ?', id)!;
}

/**
 * What Helm does by itself to bring a dashboard in line: image tiles of one view become one compare tile (in a
 * section named for the view); a dashboard with no sections and at most SECTION_MAX tiles gets one, "Overview", holding
 * them all. Returns what it did, in lines.
 */
export function convertDashboard(d: Row): string[] {
  const done: string[] = [];
  for (const [grp, list] of groupsOf(tilesOf(d.id))) {
    if (!sameView(list)) continue;
    const t = groupToCompare(d, grp, list);
    done.push(`${list.length} image tiles of "${grp}" became one compare tile "${t.title}" [${t.id}]`);
  }
  const tiles = tilesOf(d.id);
  if (!sectionsOf(d.id).length && tiles.length && tiles.length <= SECTION_MAX) {
    const s = addSection(d, 'Overview');
    run('UPDATE tiles SET section_id = ? WHERE dashboard_id = ?', s.id, d.id);
    done.push(`its ${tiles.length} tiles went into one section, "Overview"`);
  }
  return done;
}

/** A tile with no section: its section's id; else the dashboard's single section, if it has just one. */
export function defaultSection(d: Row): Row | undefined {
  const s = sectionsOf(d.id);
  return s.length === 1 ? s[0] : undefined;
}

/**
 * Once per dashboard (dashboards.lint_noted): Helm converts what it safely can (convertDashboard), then tells the
 * project's director what still breaks the rules, with the list, one note per project. Runner side, at start and daily.
 */
export async function bringDashboardsInLine(send: (agentId: string, text: string) => Promise<unknown>): Promise<number> {
  let told = 0;
  for (const p of all("SELECT id FROM projects WHERE archived = 0 AND EXISTS (SELECT 1 FROM dashboards d WHERE d.project_id = projects.id AND d.lint_noted IS NULL)")) {
    const { dashboardsOn } = await import('./dashboards.ts');
    if (!dashboardsOn(p.id)) continue;
    const parts: string[] = [];
    for (const d of all('SELECT * FROM dashboards WHERE project_id = ? AND lint_noted IS NULL ORDER BY position', p.id)) {
      const done = convertDashboard(d);
      const issues = lintDashboard(d);
      run('UPDATE dashboards SET lint_noted = ? WHERE id = ?', now(), d.id);
      if (done.length || issues.length) parts.push([`## ${d.title} [${d.id}]`, ...done.map((x) => `Helm did: ${x}.`), issues.length ? lintText(d, issues) : 'It now follows the rules.'].join('\n'));
    }
    const root = get("SELECT id FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", p.id);
    if (!parts.length || !root) continue;
    const { touchProject } = await import('./store.ts');
    touchProject(p.id);
    await send(
      root.id,
      `<helm-note kind="dashboards">Dashboards now follow shared rules (sections, short titles, one caption line, compare tiles for images of one view, scores tiles, page tiles only with a reason). Helm converted what it safely could; bring the rest in line (set_dashboard sections, set_tile section/title/caption/info, a compare tile with update_tile images in place of flip images and viewer pages, then remove the replaced tiles). dashboard_lint checks again.\n\n${parts.join('\n\n')}</helm-note>`,
    ).catch(() => {});
    told++;
  }
  return told;
}
