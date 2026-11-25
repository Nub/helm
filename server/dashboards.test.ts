import { SCRATCH } from './testenv.ts';
// Dashboards (dashboards.ts, tilescope.ts, dashtools.ts): globs, what a task changed, the complete_task ask combined with
// the knowledge ask, the director's scope check, data validation, history trimming with file cleanup, the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const { defaultStructure, buildSystemPrompt } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const kn = await import('./knowledge.ts');
const { setSetting } = await import('./settings.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const tasks = await import('./tasks.ts');
const dash = await import('./dashboards.ts');
const scope = await import('./tilescope.ts');
const { registerArtifact } = await import('./diskusage.ts');
const { ARTIFACT_DIR } = await import('./config.ts');

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE ?? '' } }).trim();
const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

let n = 0;
/** A scratch repository with a chart input and three gallery inputs, committed long ago. */
function makeRepo(): string {
  const dir = join(SCRATCH, `repo${++n}`);
  mkdirSync(dir);
  git(dir, 'init', '-q');
  for (const f of ['chart/data.json', 'levels/forest/scene.txt', 'levels/cave/scene.txt', 'levels/desert/scene.txt', 'README.md', 'profile/settings.txt']) write(dir, f, `${f}\n`);
  git(dir, 'add', '.');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, 'commit', '-qm', 'init'], { env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' } });
  return dir;
}

const sent: { to: string; text: string }[] = [];
const rt = { spawn: async () => 'no', send: async (to: string, text: string) => void sent.push({ to, text }), close: async () => {}, markComplete: () => {} };
function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const tools = helmTools(agent.id, rt as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown>) => {
    const t = tools.find((x: any) => x.name === name);
    if (!t) return { missing: true, text: '', error: true };
    const res: any = await t.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
}

function img(dir: string, name: string): string {
  const p = join(dir, name);
  // A PNG header with a size, enough for imageSize.
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(320, 16);
  b.writeUInt32BE(200, 20);
  writeFileSync(p, b);
  return p;
}

/** A project on a scratch repo, a director, a dashboard with a bar chart, a three-picture gallery and an expensive number. */
async function setup() {
  const repo = makeRepo();
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `p${n}`, repo, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const dt = toolsFor(director);
  const made = await dt('set_dashboard', { title: 'Game', description: 'A bar chart of draw calls and a gallery of every level.' });
  assert.ok(!made.error, made.text);
  const d = db.get('SELECT * FROM dashboards WHERE project_id = ?', id)!;
  const tile = async (input: Record<string, unknown>) => {
    const r = await dt('set_tile', { dashboard: d.id, section: 'Main', ...input });
    assert.ok(!r.error, r.text);
    return db.get('SELECT * FROM tiles WHERE dashboard_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', d.id)!;
  };
  const recipe = { command: 'node scripts/chart.js', cwd: '.' };
  const chart = await tile({ kind: 'chart', title: 'Draw calls', depends_on: { paths: ['chart/**'] }, recipe });
  const pics: Record<string, any> = {};
  for (const lv of ['forest', 'cave', 'desert']) pics[lv] = await tile({ kind: 'image', title: lv, group: 'Levels', depends_on: { paths: [`levels/${lv}/**`] }, recipe: { command: `node scripts/shot.js ${lv}`, cwd: '.' } });
  const cost = await tile({ kind: 'number', title: 'Frame cost', depends_on: { paths: ['profile/**'] }, recipe: { command: 'profile.sh', cwd: '.', duration: '20 min' }, expensive: true });
  // First data, built by the director's task (not asked about its own tiles).
  assert.ok(!(await dt('update_tile', { tile: chart.id, data: { type: 'bar', labels: ['a', 'b'], series: [{ name: 'calls', values: [1, 2] }] } })).error);
  for (const lv of Object.keys(pics)) assert.ok(!(await dt('update_tile', { tile: pics[lv].id, path: img(SCRATCH, `${lv}${n}.png`) })).error);
  assert.ok(!(await dt('update_tile', { tile: cost.id, data: { value: 16, unit: 'ms' } })).error);
  const worker = (title: string) => {
    const t = tasks.createTask(id, { title, state: 'active', origin: 'director' }, { author: 'director', name: 'Director' });
    db.run('UPDATE tasks SET started_at = ? WHERE id = ?', db.now() - 5000, t.id);
    const a = runtime.createAgent(project, director, role, `Engineer ${title}`, title);
    db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, a.id);
    return { task: tasks.getTask(t.id)!, agent: db.get('SELECT * FROM agents WHERE id = ?', a.id)! };
  };
  return { project, repo, director, d, chart, pics, cost, worker, dt };
}
const built = (t: any) => db.get('SELECT built FROM tiles WHERE id = ?', t.id)!.built;
const done = (r: { text: string }) => /^Marked complete/.test(r.text);

test('globs: segments, any depth, alternatives, folders', () => {
  const m = scope.globMatch;
  assert.ok(m('levels/forest/**', 'levels/forest/a/b.txt'));
  assert.ok(m('levels/forest', 'levels/forest/scene.txt'), 'a folder covers what is under it');
  assert.ok(!m('levels/forest', 'levels/forestry/x'));
  assert.ok(m('src/*.ts', 'src/a.ts'));
  assert.ok(!m('src/*.ts', 'src/x/a.ts'), '* stays within a folder');
  assert.ok(m('**/*.glsl', 'a/b/c.glsl'));
  assert.ok(m('**/*.glsl', 'c.glsl'));
  assert.ok(m('src/render/{settings,shaders}/**', 'src/render/shaders/x.frag'));
  assert.ok(!m('src/render/{settings,shaders}/**', 'src/render/mesh/x'));
  assert.ok(m('./a?.txt', 'ab.txt'));
  assert.ok(!m('a.txt', 'aXtxt'), 'dots are literal');
});

test('data validation: shapes, clear errors, caps', () => {
  const v = dash.validateData;
  assert.ok('data' in v('number', { value: 3, unit: 'ms', target: 4 }));
  assert.match((v('number', { value: 'x' }) as any).error, /"value" must be a finite number.*Expected/);
  assert.match((v('number', { value: 1, colour: 'red' }) as any).error, /Unknown field colour/);
  assert.ok('data' in v('chart', { type: 'stacked', labels: ['a', 'b'], series: [{ values: [1, null] }] }));
  assert.match((v('chart', { series: [] }) as any).error, /non-empty/);
  assert.match((v('chart', { type: 'pie', series: [{ values: [1] }] }) as any).error, /"type" must be one of/);
  assert.match((v('chart', { labels: ['a'], series: [{ values: [1, 2] }] }) as any).error, /"labels" has 1 entries/);
  assert.match((v('chart', { series: [{ values: [1, 'x'] }] }) as any).error, /values\[1\] is not a number/);
  assert.ok('data' in v('table', { columns: ['a', 'b'], rows: [[1, 'x'], [null, true]] }));
  assert.match((v('table', { columns: ['a', 'b'], rows: [[1]] }) as any).error, /rows\[0\] must be an array of 2 cells/);
  assert.match((v('chart', { series: Array.from({ length: 12 }, () => ({ values: Array(500).fill(123456.789) })) }) as any).error, /at most 64 KB/);
  assert.match((v('image', {}) as any).error, /takes no data object/);
});

test('data validation: Helm references count as the words they show, not their ids', () => {
  const v = dash.validateData;
  const ref = '[[task_0123456789|' + 'x'.repeat(40) + ']]';
  assert.equal(dash.shownLength(ref), 40);
  assert.equal(dash.shownLength('[[task_0123456789|' + 'x'.repeat(100) + ']]'), 48, 'a long title counts as much as a row shows');
  assert.equal(dash.shownLength('[[page:spec]] and more'), 'spec and more'.length);
  assert.ok('data' in v('number', { value: 1, label: `${ref}${ref}` }), 'two 40-word references fit an 80-character label');
  assert.match((v('number', { value: 1, label: `${ref} ${ref} ${ref}` }) as any).error, /"label" must be text of at most 80/);
  assert.ok('data' in v('table', { columns: ['Task', 'Time'], rows: [['[[task_0123456789]]', '3 min']] }));
  assert.ok('data' in v('chart', { labels: ['[[task_0123456789]]'], series: [{ values: [3] }] }));
});

test('changed files: worktree (committed, uncommitted, untracked), its branch once removed, and no worktree', async () => {
  const { project, repo, worker } = await setup();
  const { task, agent } = worker('wt');
  const wt = join(SCRATCH, `wt${n}`);
  git(repo, 'worktree', 'add', '-q', wt, '-b', `b${n}`);
  const reg = await registerArtifact(project, agent.id, { path: wt, kind: 'worktree', disposable: false, branch: `b${n}` });
  assert.ok(!('error' in reg));
  assert.ok(db.get('SELECT base_commit FROM artifacts WHERE path = ?', wt)!.base_commit, 'the fork point is recorded');
  write(wt, 'levels/cave/scene.txt', 'changed\n');
  git(wt, 'commit', '-qam', 'cave');
  write(wt, 'README.md', 'edited, not committed\n');
  write(wt, 'notes/new.txt', 'untracked\n');
  let c = await scope.changedFiles(task);
  assert.deepEqual(c.files, ['README.md', 'levels/cave/scene.txt', 'notes/new.txt']);
  // Merged by fast-forward: the recorded fork point still gives the task's own change.
  git(wt, 'checkout', '-q', '--', 'README.md');
  execFileSync('rm', ['-r', join(wt, 'notes')]);
  git(repo, 'merge', '-q', '--ff-only', `b${n}`);
  c = await scope.changedFiles(task);
  assert.deepEqual(c.files, ['levels/cave/scene.txt']);
  // The worktree removed (the branch kept): read from the branch.
  git(repo, 'worktree', 'remove', wt);
  db.run('UPDATE artifacts SET removed_at = ? WHERE path = ?', db.now(), wt);
  c = await scope.changedFiles(task);
  assert.deepEqual(c.files, ['levels/cave/scene.txt']);
  assert.match(c.how.join(), /its worktree is gone/);
  // No worktree at all: commits on the main checkout's branch since the task started.
  const other = worker('main');
  write(repo, 'levels/desert/scene.txt', 'desert\n');
  git(repo, 'commit', '-qam', 'desert');
  c = await scope.changedFiles(other.task);
  assert.ok(c.files.includes('levels/desert/scene.txt'));
  assert.match(c.how.join(), /since the task started/);
});

test('complete_task names exactly the affected tile, with the knowledge ask in the same result; refreshing completes it', async () => {
  const { repo, pics, chart, cost, worker, director } = await setup();
  const { task, agent } = worker('forest');
  write(repo, 'levels/forest/scene.txt', 'new trees\n');
  git(repo, 'commit', '-qam', 'forest');
  for (let i = 0; i < kn.NUDGE_TOOL_CALLS; i++) db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,'tool',?)", agent.project_id, agent.id, db.now(), JSON.stringify({ name: 'Bash' }));
  const before = { chart: built(chart), cave: built(pics.cave), desert: built(pics.desert), cost: built(cost) };
  const at = toolsFor(agent);
  const first = await at('complete_task', { summary: 'done' });
  assert.match(first.text, /^Not completed yet\. Two things before you finish:/);
  assert.match(first.text, /"forest" \[tile_/);
  assert.match(first.text, /levels\/forest\/scene\.txt/);
  assert.match(first.text, /node scripts\/shot\.js forest/, 'the recipe is in the ask');
  assert.match(first.text, /2\. Knowledge: record what cost you time/);
  for (const other of ['"cave"', '"desert"', '"Draw calls"', '"Frame cost"']) assert.ok(!first.text.includes(other), `${other} is not asked`);
  assert.ok(db.get('SELECT stale FROM tiles WHERE id = ?', pics.forest.id)!.stale, 'the affected tile shows Stale');
  // Still unanswered: asked again, but the knowledge ask is not repeated.
  const second = await at('complete_task', { summary: 'done' });
  assert.match(second.text, /^Not completed yet\. Dashboard tiles/);
  assert.ok(!/Knowledge/.test(second.text));
  // Refreshing a tile the task did not affect is recorded as unasked.
  const extra = await at('update_tile', { tile: pics.cave.id, path: img(SCRATCH, 'cave-again.png') });
  assert.match(extra.text, /recorded as unasked/);
  const r = await at('update_tile', { tile: pics.forest.id, path: img(SCRATCH, 'forest2.png') });
  assert.ok(!r.error, r.text);
  assert.ok(!db.get('SELECT stale FROM tiles WHERE id = ?', pics.forest.id)!.stale);
  assert.ok(done(await at('complete_task', { summary: 'done' })));
  const b = JSON.parse(built(pics.forest));
  assert.equal(b.task_id, task.id);
  assert.equal(b.commit, git(repo, 'rev-parse', 'HEAD'));
  assert.deepEqual({ chart: built(chart), desert: built(pics.desert), cost: built(cost) }, { chart: before.chart, desert: before.desert, cost: before.cost }, 'the other tiles keep their "as of"');
  const thread = db.all('SELECT body FROM task_messages WHERE task_id = ?', task.id).map((m) => m.body).join('\n');
  assert.match(thread, /"forest" .*: refreshed/);
  assert.match(thread, /"cave" .*: refreshed although the task did not affect it/);
  // The director's check: send back, correct a dependency, then accept.
  const dt = toolsFor(director);
  sent.length = 0;
  const back = await dt('review_dashboard_scope', { task: task.id, decision: 'send_back', send_back: [{ tile: pics.desert.id, why: 'the forest change moved the shared sky' }] });
  assert.ok(!back.error, back.text);
  assert.ok(sent.some((s) => s.to === agent.id && /desert/.test(s.text)), 'the agent is told');
  assert.match((await at('complete_task', { summary: 'done' })).text, /"desert"/, 'the sent-back tile is asked for');
  const fix = await dt('review_dashboard_scope', { task: task.id, decision: 'accept', dependencies: [{ tile: pics.desert.id, paths: ['levels/desert/**', 'levels/shared/sky/**'] }], note: 'sky is shared' });
  assert.ok(!fix.error, fix.text);
  assert.deepEqual(dash.depsOf(db.get('SELECT * FROM tiles WHERE id = ?', pics.desert.id)!).paths, ['levels/desert/**', 'levels/shared/sky/**']);
  const view = scope.taskScope(task.id)!;
  assert.deepEqual(view.reviews.map((r: any) => r.decision), ['send_back', 'accept']);
  assert.match(db.all('SELECT body FROM task_messages WHERE task_id = ?', task.id).map((m) => m.body).join('\n'), /checked the scope: accepted/);
});

test('a task that touches nothing relevant is asked nothing', async () => {
  const { repo, worker } = await setup();
  const { agent } = worker('readme');
  write(repo, 'README.md', 'docs only\n');
  git(repo, 'commit', '-qam', 'readme');
  assert.ok(done(await toolsFor(agent)('complete_task', { summary: 'done', nothing_to_record: true })));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tile_checks WHERE task_id = ?', agent.task_id)!.n, 0);
});

test('an expensive tile goes Stale and to the director, not to the worker', async () => {
  const { repo, cost, worker, director } = await setup();
  const { agent, task } = worker('profile');
  write(repo, 'profile/settings.txt', 'ultra\n');
  git(repo, 'commit', '-qam', 'profile');
  sent.length = 0;
  assert.ok(done(await toolsFor(agent)('complete_task', { summary: 'done', nothing_to_record: true })));
  assert.match(JSON.parse(db.get('SELECT stale FROM tiles WHERE id = ?', cost.id)!.stale).reason, /profile\/settings\.txt/);
  assert.ok(sent.some((s) => s.to === director.id && /expensive/.test(s.text) && /Frame cost/.test(s.text)));
  assert.equal(scope.taskScope(task.id)!.rows[0].status, 'expensive');
});

test('closing with tiles unanswered warns the manager (soft) and leaves them stale', async () => {
  const { repo, chart, worker, director } = await setup();
  const { agent, task } = worker('chart');
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', agent.id, task.id);
  write(repo, 'chart/data.json', '[3,4]\n');
  git(repo, 'commit', '-qam', 'chart');
  const res = await toolsFor(director)('close_agent', { agent: agent.id, task_state: 'done', status_summary: 'Done.' });
  assert.ok(!res.error, res.text);
  assert.match(res.text, /^Closed .* to Done\./);
  assert.match(res.text, /1 affected tile was not refreshed or declared unaffected and stays Stale/);
  assert.match(res.text, /Scope not checked yet: review_dashboard_scope/);
  assert.equal(tasks.getTask(task.id)!.state, 'done');
  assert.equal(scope.taskScope(task.id)!.rows[0].status, 'stale');
  assert.ok(db.get('SELECT stale FROM tiles WHERE id = ?', chart.id)!.stale);
});

test('history is trimmed with its files; removing a tile or dashboard removes its files; the Disk page counts them', async () => {
  const { project, pics, d, dt } = await setup();
  const tile = pics.forest;
  for (let i = 0; i < dash.HISTORY_KEEP.image + 5; i++) assert.ok(!(await dt('update_tile', { tile: tile.id, path: img(SCRATCH, `h${i}.png`) })).error);
  const rows = db.all('SELECT file FROM tile_history WHERE tile_id = ?', tile.id);
  assert.equal(rows.length, dash.HISTORY_KEEP.image);
  const dir = dash.fileDir(project.id);
  const mine = () => readdirSync(dir).filter((f) => f.startsWith(tile.id));
  assert.equal(mine().length, dash.HISTORY_KEEP.image, 'files of trimmed entries are removed');
  const { projectUsage } = await import('./diskusage.ts');
  const u = await projectUsage(project);
  assert.ok(u.entries.some((e) => e.kind === 'dashboards' && e.bytes === dash.dashboardBytes(project.id) && (e.bytes ?? 0) > 0));
  assert.ok(!(await dt('set_tile', { dashboard: d.id, tile: tile.id, remove: true })).error);
  assert.equal(mine().length, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tile_history WHERE tile_id = ?', tile.id)!.n, 0);
  assert.ok(!(await dt('set_dashboard', { dashboard: d.id, remove: true })).error);
  assert.equal(readdirSync(dir).length, 0);
  assert.ok(existsSync(ARTIFACT_DIR));
});

test('tools refuse bad input clearly and check who may edit tiles', async () => {
  const { d, chart, worker, dt } = await setup();
  assert.match((await dt('update_tile', { tile: chart.id, data: { series: [] } })).text, /Not updated\. "series" must be a non-empty array/);
  assert.match((await dt('update_tile', { tile: chart.id, path: '/nope.png' })).text, /chart tile takes data/);
  // A relative path: the agent's worktree when it still exists, else the project folder.
  const { project } = await (async () => ({ project: db.get('SELECT * FROM projects WHERE id = ?', d.project_id)! }))();
  img(project.path, 'rel.png');
  const pic = db.get("SELECT * FROM tiles WHERE dashboard_id = ? AND kind = 'image' LIMIT 1", d.id)!;
  assert.ok(!(await dt('update_tile', { tile: pic.id, path: 'rel.png' })).error);
  assert.match((await dt('update_tile', { tile: pic.id, path: 'missing.png' })).text, /File not found: .*missing\.png\. Give an absolute path/);
  assert.match((await dt('update_tile', { tile: chart.id, data: { series: [{ values: [1] }] }, unaffected: 'x' })).text, /exactly one of/);
  assert.match((await dt('set_tile', { dashboard: d.id, section: 'Main', kind: 'image', title: 'x', depends_on: { paths: [] } })).text, /needs a recipe/);
  assert.match((await dt('set_tile', { dashboard: d.id, section: 'Main', kind: 'image', title: 'x', depends_on: { paths: ['../up'] }, recipe: { command: 'x', cwd: '.' } })).text, /without "\.\."/);
  assert.match((await dt('set_tile', { dashboard: d.id, section: 'Main', kind: 'image', title: 'x', depends_on: { paths: [] }, recipe: { command: 'x', cwd: '.', host: 'mars' } })).text, /No host "mars"/);
  const { agent, task } = worker('builder');
  const at = toolsFor(agent);
  assert.match((await at('set_tile', { dashboard: d.id, section: 'Main', kind: 'text', title: 'Notes', depends_on: { paths: [] }, recipe: { command: 'write it', cwd: '.' } })).text, /may not edit the tiles/);
  assert.ok(!(await dt('set_dashboard', { dashboard: d.id, allow_tasks: [task.id] })).error);
  assert.ok(!(await at('set_tile', { dashboard: d.id, section: 'Main', kind: 'text', title: 'Notes', depends_on: { paths: [] }, recipe: { command: 'write it', cwd: '.' } })).error);
  assert.match((await dt('set_dashboard', { dashboard: d.id, state: 'ready' })).text, /no data yet.*Notes/);
});

test('the setting off: no tools, no ask, no prompt section', async () => {
  const { project, repo, worker, director } = await setup();
  const { agent } = worker('off');
  write(repo, 'levels/forest/scene.txt', 'off\n');
  git(repo, 'commit', '-qam', 'off');
  setSetting(project.id, 'dashboards', false);
  const at = toolsFor(agent);
  assert.match((await at('list_dashboards', {})).text, /Dashboards are off/);
  assert.ok(done(await at('complete_task', { summary: 'done', nothing_to_record: true })));
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id === agent.role_id)!;
  assert.ok(!buildSystemPrompt(project, structure, role, agent, director).includes('update_tile'));
  setSetting(project.id, 'dashboards', true);
  assert.ok(buildSystemPrompt(project, structure, role, agent, director).includes('update_tile'));
});
