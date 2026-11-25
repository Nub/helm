import { SCRATCH } from './testenv.ts';
// Dashboard rules (dashrules.ts, dashtools.ts): the tools' refusals, compare and scores tiles, sections, the key, lint,
// the safe conversion of one view's image tiles into one compare tile, and the one note to the director.
// `node --test server/dashrules.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const dash = await import('./dashboards.ts');
const rules = await import('./dashrules.ts');
const { ARTIFACT_DIR } = await import('./config.ts');

const sent: { to: string; text: string }[] = [];
const rt = { spawn: async () => 'no', send: async (to: string, text: string) => void sent.push({ to, text }), close: async () => {}, markComplete: () => {} };
const recipe = { command: 'render.sh', cwd: '.' };

/** A PNG with a size; animated adds an acTL chunk before IDAT (an APNG). */
function png(dir: string, name: string, w = 320, h = 200, animated = false): string {
  mkdirSync(dir, { recursive: true });
  const b = Buffer.alloc(96);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  if (animated) b.write('acTL', 37, 'latin1');
  b.write('IDAT', 60, 'latin1');
  const p = join(dir, name);
  writeFileSync(p, b);
  return p;
}

let n = 0;
async function setup() {
  const dir = join(SCRATCH, `dr${++n}`);
  mkdirSync(dir, { recursive: true });
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `dr${n}`, dir, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const tools = helmTools(director.id, rt as any, toolAccess(JSON.parse(project.structure), director.role_id, director.parent_id));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const made = await call('set_dashboard', { title: 'GI comparison', description: 'Each scene in every backend, scored.' });
  assert.ok(!made.error, made.text);
  const d = db.get('SELECT * FROM dashboards WHERE project_id = ?', id)!;
  return { project, director, d, dir, call };
}
const tileId = (text: string) => /\[(tile_[0-9a-f]+)\]/.exec(text)![1];

test('set_tile refuses what breaks the rules, with what to do instead', async () => {
  const { d, call } = await setup();
  const base = { dashboard: d.id, depends_on: { paths: [] }, recipe };
  assert.match((await call('set_tile', { ...base, kind: 'number', title: 'Frames' })).text, /Every tile belongs to a section: pass section/);
  assert.match((await call('set_tile', { ...base, section: 'Cornell', kind: 'number', title: 'Average frame rate at 4K in the heavy interior' })).text, /title is 1 to 40 characters/);
  assert.match((await call('set_tile', { ...base, section: 'Cornell', kind: 'number', title: 'Frames', caption: 'one\ntwo' })).text, /caption is one line/);
  assert.match((await call('set_tile', { ...base, section: 'Cornell', kind: 'page', title: 'Viewer' })).text, /needs page_reason/);
  assert.match((await call('set_tile', { ...base, section: 'Cornell', kind: 'number', title: 'Frames', size: 'xl' })).text, /size is one of/);
  // A new section by title; at most 8 tiles in it, then a sub-section is asked for.
  for (let i = 1; i <= 8; i++) assert.ok(!(await call('set_tile', { ...base, section: 'Cornell', kind: 'number', title: `N${i}` })).error);
  assert.match((await call('set_tile', { ...base, section: 'Cornell', kind: 'number', title: 'N9' })).text, /already holds 8 tiles: add a sub-section/);
  assert.ok(!(await call('set_dashboard', { dashboard: d.id, sections: [{ title: 'Cornell details', parent: 'Cornell' }] })).error);
  assert.ok(!(await call('set_tile', { ...base, section: 'Cornell details', kind: 'number', title: 'N9' })).error);
  // A page with a reason is allowed and shown as such.
  const page = await call('set_tile', { ...base, section: 'Cornell details', kind: 'page', title: 'Custom', page_reason: 'An interactive 3D model, no widget fits' });
  assert.ok(!page.error, page.text);
  // The key: names once, palette colours, no repeats.
  assert.match((await call('set_dashboard', { dashboard: d.id, key: [{ name: 'Cascades', color: 1 }, { name: 'Solari', color: 1 }] })).text, /colour 1 is already used/);
  assert.ok(!(await call('set_dashboard', { dashboard: d.id, key: [{ name: 'Cascades', color: 1 }, { name: 'Solari', color: 3 }] })).error);
  assert.deepEqual(dash.dashboardView(db.get('SELECT * FROM dashboards WHERE id = ?', d.id)!).key, [{ name: 'Cascades', color: 1 }, { name: 'Solari', color: 3 }]);
});

test('a compare tile takes 2 to 8 labelled images and a reference; animated images are refused everywhere', async () => {
  const { d, dir, call } = await setup();
  const made = await call('set_tile', { dashboard: d.id, section: 'Cornell', kind: 'compare', title: 'Cornell box', depends_on: { paths: ['scenes/cornell/**'] }, recipe });
  assert.ok(!made.error, made.text);
  const tile = tileId(made.text);
  const labels = ['No GI', 'Cascades', 'GI-1.2', 'Solari', 'Reference'];
  const images = labels.map((label, i) => ({ label, path: png(dir, `c${i}.png`) }));
  assert.match((await call('update_tile', { tile, images: images.slice(0, 1) })).text, /2 to 8 images/);
  assert.match((await call('update_tile', { tile, images, reference: 'Truth' })).text, /reference "Truth" is not one of the image labels/);
  assert.match((await call('update_tile', { tile, images: [...images.slice(0, 4), { label: 'Flip', path: png(dir, 'flip.png', 320, 200, true) }] })).text, /is animated/);
  const ok = await call('update_tile', { tile, images, reference: 'Reference' });
  assert.ok(!ok.error, ok.text);
  const data = JSON.parse(db.get('SELECT data FROM tiles WHERE id = ?', tile)!.data);
  assert.deepEqual(data.images.map((i: any) => i.label), labels);
  assert.equal(data.reference, 'Reference');
  assert.ok(data.images.every((i: any) => existsSync(join(ARTIFACT_DIR, i.file)) && i.width === 320));
  // An animated image on an image tile: refused, pointing to a compare tile.
  const im = await call('set_tile', { dashboard: d.id, section: 'Cornell', kind: 'image', title: 'Flip', depends_on: { paths: [] }, recipe });
  assert.match((await call('update_tile', { tile: tileId(im.text), path: png(dir, 'anim.png', 320, 200, true) })).text, /the image is animated\. Give its frames as a compare tile/);
  // Scores: typed columns, row labels like the compare's.
  const sc = await call('set_tile', { dashboard: d.id, section: 'Cornell', kind: 'scores', title: 'Cornell scores', depends_on: { paths: [] }, recipe });
  assert.match((await call('update_tile', { tile: tileId(sc.text), data: { columns: [{ name: 'Error', unit: '%', better: 'down' }], rows: [{ label: 'Cascades', values: [3] }] } })).text, /better must be "higher" or "lower"/);
  assert.ok(!(await call('update_tile', { tile: tileId(sc.text), data: { columns: [{ name: 'Error', unit: '%', better: 'lower' }, { name: 'Frame', unit: 'ms', better: 'lower' }], rows: labels.map((label, i) => ({ label, values: [i, 2 + i] })) } })).error);
  // Removing the compare tile removes every image file.
  const files = data.images.map((i: any) => join(ARTIFACT_DIR, i.file));
  assert.ok(!(await call('set_tile', { dashboard: d.id, tile, remove: true })).error);
  assert.ok(files.every((f: string) => !existsSync(f)));
});

test('image tiles of one view become one compare tile in their own section; a gallery of different views stays', async () => {
  const { project, d, dir } = await setup();
  const insert = (title: string, grp: string, pos: number, file: string, w = 512, h = 512) => {
    const id = db.newId('tile');
    const rel = `dashboards/${project.id}/${id}.png`;
    mkdirSync(join(ARTIFACT_DIR, 'dashboards', project.id), { recursive: true });
    writeFileSync(join(ARTIFACT_DIR, rel), 'x');
    db.run(
      'INSERT INTO tiles (id, dashboard_id, project_id, kind, title, caption, grp, position, deps, recipe, data, built, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, d.id, project.id, 'image', title, `${title} caption`, grp, pos, JSON.stringify({ paths: [`scenes/${grp}/**`], docs: [], tags: [] }), JSON.stringify({ command: `render ${title}`, cwd: '.' }),
      JSON.stringify({ file: rel, bytes: 1, width: w, height: h }), JSON.stringify({ commit: 'abc1234', at: db.now(), agent_id: null, agent: 'Rig', task_id: null }), db.now(), db.now(),
    );
    void file;
    return id;
  };
  const cornell = ['No GI', 'Our GI (cascades)', 'AMD GI-1.2', 'Solari (DLSS RR)', 'Path-traced reference'].map((l, i) => insert(`Cornell: ${l}`, 'cornell', i + 1, dir));
  const gallery = ['Station in the sun', 'Asteroid field', 'All three grids'].map((t, i) => insert(t, 'Scenic', 10 + i, dir, 3840, 2160));
  // Lint before: one view as five image tiles, and nothing in a section.
  const before = rules.lintDashboard(d);
  assert.ok(before.some((x) => /5 image tiles of one view/.test(x.problem)));
  assert.ok(before.some((x) => x.problem === 'has no section'));
  const done = rules.convertDashboard(d);
  assert.match(done[0], /5 image tiles of "cornell" became one compare tile "Cornell"/);
  const tiles = dash.tilesOf(d.id);
  assert.ok(cornell.every((id) => !tiles.some((t) => t.id === id)), 'the image tiles are gone');
  assert.deepEqual(tiles.filter((t) => t.kind === 'image').map((t) => t.id).sort(), [...gallery].sort(), 'the gallery stays');
  const cmp = tiles.find((t) => t.kind === 'compare')!;
  const data = JSON.parse(cmp.data);
  assert.deepEqual(data.images.map((i: any) => i.label), ['No GI', 'Our GI (cascades)', 'AMD GI-1.2', 'Solari (DLSS RR)', 'Path-traced reference']);
  assert.equal(data.reference, 'Path-traced reference');
  assert.ok(data.images.every((i: any) => existsSync(join(ARTIFACT_DIR, i.file))));
  assert.equal(rules.sectionsOf(d.id).find((s) => s.id === cmp.section_id)!.title, 'Cornell');
  assert.match(JSON.parse(cmp.recipe).command, /# No GI\nrender Cornell: No GI/);
  assert.deepEqual(JSON.parse(cmp.deps).paths, ['scenes/cornell/**']);
  // Four tiles left (compare + 3 gallery), no section on the gallery yet: lint lists them for the director.
  assert.ok(rules.lintDashboard(d).every((x) => x.problem === 'has no section'));
});

test('a small dashboard with no sections gets one; each director is told once, with the list', async () => {
  const { project, director, d, call } = await setup();
  db.run("INSERT INTO tiles (id, dashboard_id, project_id, kind, title, caption, position, deps, recipe, data, created_at, updated_at) VALUES (?,?,?,'number','A rather long title for a number tile on this dashboard','',1,'{}','{}','{\"value\":1}',?,?)", db.newId('tile'), d.id, project.id, db.now(), db.now());
  sent.length = 0;
  const told = await rules.bringDashboardsInLine(async (to, text) => void sent.push({ to, text }));
  assert.ok(told >= 1);
  const mine = sent.filter((s) => s.to === director.id);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /its 1 tiles went into one section, "Overview"/);
  assert.match(mine[0].text, /title is 55 characters/);
  // Once.
  sent.length = 0;
  await rules.bringDashboardsInLine(async (to, text) => void sent.push({ to, text }));
  assert.equal(sent.filter((s) => s.to === director.id).length, 0);
  // Ready is refused while it breaks a rule.
  assert.match((await call('set_dashboard', { dashboard: d.id, state: 'ready' })).text, /breaks the dashboard rules/);
});
