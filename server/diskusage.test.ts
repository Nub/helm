import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * Disk tracking (server/diskusage.ts): which paths clean_artifacts may remove, against real scratch repositories with
 * worktrees. A table of hostile and harmless paths, then the reviewer's reproductions: a sweep with no paths must not
 * delete the release branch, another project's checkout, or a worktree an agent is still using.
 */

// The temporary folder the removal rules allow is a folder of its own here, so the rest of SCRATCH counts as "outside".
const TMP = join(SCRATCH, 'tmp');
mkdirSync(TMP);
process.env.TMPDIR = TMP;
// Helm's data in a folder of its own too: removal refuses anything inside it.
process.env.HELM_DATA = join(SCRATCH, 'data');
mkdirSync(process.env.HELM_DATA);

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const usage = await import('./diskusage.ts');
const runtime = await import('./runtime.ts');
usage.measurer.du = async (p) => (p.includes('big') ? 5e9 : 1e6);
// Everything here was made a moment ago; the one-hour rule is tested on its own below.
usage.limits.recentMs = 0;

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv });
const file = (p: string, text = 'x') => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

const SRC = join(SCRATCH, 'src');
const PROJ = join(SRC, 'proj');
const WT = join(SRC, 'proj-wt');
const OUT = join(SCRATCH, 'outside');
const PLAIN = join(SRC, 'plain');
mkdirSync(PROJ, { recursive: true });
git(PROJ, 'init', '-q', '-b', 'master');
file(join(PROJ, '.gitignore'), 'build/\nnode_modules/\nout/\nmydir/\nmine/\n');
file(join(PROJ, 'src', 'a.ts'), 'export {}');
git(PROJ, 'add', '.');
git(PROJ, 'commit', '-qm', 'init');
git(PROJ, 'branch', 'release');
file(join(PROJ, 'build', 'big', 'out.o'));
file(join(PROJ, 'build', 'data', 'rows.db'));
file(join(PROJ, 'node_modules', 'x', 'index.js'));
file(join(PROJ, 'out', '.env'), 'SECRET=1');
file(join(PROJ, 'mydir', 'x.o'));
file(join(PROJ, 'newstuff', 'notes.md'));
const wt = (name: string, branch: string, create = true) => git(PROJ, 'worktree', 'add', '-q', join(WT, name), ...(create ? ['-b', branch] : [branch]));
wt('merged', 'merged');
wt('rel', 'release', false);
wt('dirty', 'dirty');
file(join(WT, 'dirty', 'src', 'a.ts'), 'changed');
wt('unmerged', 'unmerged');
file(join(WT, 'unmerged', 'b.ts'));
git(join(WT, 'unmerged'), 'add', '.');
git(join(WT, 'unmerged'), 'commit', '-qm', 'more');
wt('untracked', 'untracked');
file(join(WT, 'untracked', 'scratch.txt'));
wt('withbuild', 'withbuild');
file(join(WT, 'withbuild', 'build', 'out.o'));
wt('upstream', 'up');
git(PROJ, 'config', 'branch.up.remote', '.');
git(PROJ, 'config', 'branch.up.merge', 'refs/heads/master');
wt('other', 'other');
wt('live', 'live');
mkdirSync(join(WT, 'stray'));
file(join(OUT, 'precious.txt'));
symlinkSync(OUT, join(WT, 'link'));
symlinkSync(OUT, join(PROJ, 'build', 'escape'));
file(join(TMP, 'scratch-1', 'data.bin'));
file(join(TMP, 'clone', '.git', 'HEAD'), 'ref: refs/heads/master');
file(join(TMP, 'holder', 'a', 'b', 'c', 'd', 'e', 'repo', '.git', 'HEAD'), 'x');
file(join(TMP, 'bare', 'HEAD'), 'ref: refs/heads/master');
mkdirSync(join(TMP, 'bare', 'objects'));
mkdirSync(join(TMP, 'bare', 'refs'));
file(join(TMP, 'tmux-1001', 'x'));
file(join(TMP, 'loose.log'));
file(join(TMP, 'busy', 'x'));
file(join(TMP, 'live-scratch', 'x'));
file(join(TMP, 'shared', 'x'));
file(join(TMP, 'recent', 'x'));
file(join(PLAIN, 'build', 'x.o'));
mkdirSync(join(TMP, 'sock'));
const sock = createServer().listen(join(TMP, 'sock', 's.sock'));
const busy = spawn('sleep', ['60'], { cwd: join(TMP, 'busy'), stdio: 'ignore' });

function makeProject(name: string, path: string) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, path, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  return db.get('SELECT * FROM projects WHERE id = ?', id)!;
}
const project = makeProject('Proj', PROJ);
makeProject('Other', join(WT, 'other'));
const plain = makeProject('Plain', PLAIN);
const director = runtime.rootAgent(project);
const role = defaultStructure().roles.find((r) => r.id !== defaultStructure().root)!;
const finished = runtime.createAgent(project, director, role, 'Finished', 'Done.');
db.run("UPDATE agents SET status = 'done' WHERE id = ?", finished.id);
const live = runtime.createAgent(project, director, role, 'Live', 'Working.');

/** A registered artifact row (in the database, as register_artifacts leaves it). */
function reg(path: string, kind: string, agentId: string | null, extra: Record<string, unknown> = {}) {
  const id = db.newId('art');
  const st = statSync(path);
  db.run(
    'INSERT INTO artifacts (id, project_id, agent_id, path, kind, disposable, note, created_at, users, branch, birth, fresh) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, (extra.project as string) ?? project.id, agentId, path, kind, 1, '', db.now(), JSON.stringify(extra.users ?? []), (extra.branch as string) ?? null, (extra.birth as number) ?? st.birthtimeMs, extra.fresh ? 1 : 0,
  );
  return db.get('SELECT * FROM artifacts WHERE id = ?', id)!;
}

test('checkRemovable: hostile and harmless paths', async () => {
  const F = finished.id;
  // Registered by an agent that finished.
  const build = reg(join(PROJ, 'build', 'big'), 'build', F);
  const nm = reg(join(PROJ, 'node_modules'), 'build', F);
  const merged = reg(join(WT, 'merged'), 'worktree', F, { branch: 'merged' });
  const rel = reg(join(WT, 'rel'), 'worktree', F, { branch: 'release' });
  const withbuild = reg(join(WT, 'withbuild'), 'worktree', F);
  const up = reg(join(WT, 'upstream'), 'worktree', F, { branch: 'up' });
  const scratch = reg(join(TMP, 'scratch-1'), 'scratch', F);
  const mydir = reg(join(PROJ, 'mydir'), 'build', F);
  const data = reg(join(PROJ, 'build', 'data'), 'build', F);
  const env = reg(join(PROJ, 'out'), 'build', F);
  const tmux = reg(join(TMP, 'tmux-1001'), 'scratch', F);
  const busyArt = reg(join(TMP, 'busy'), 'scratch', F);
  const plainBuild = reg(join(PLAIN, 'build'), 'build', F, { project: plain.id });
  reg(join(TMP, 'live-scratch'), 'scratch', live.id);
  reg(join(WT, 'live'), 'worktree', live.id, { branch: 'live' });
  const shared = reg(join(TMP, 'shared'), 'scratch', F, { users: [live.id] });
  const otherArt = reg(join(TMP, 'clone'), 'scratch', F);
  const mine = { kind: 'build', agent_id: F, fresh: 1, birth: 0 } as const;
  const none = null;

  type Case = [string, unknown, boolean, boolean, RegExp?, Record<string, unknown>?];
  const cases: Case[] = [
    // Allowed.
    [join(PROJ, 'build', 'big'), build, false, true],
    [join(PROJ, 'build', 'big') + '/', build, false, true],
    [join(PROJ, 'node_modules'), nm, false, true],
    [join(WT, 'merged'), merged, false, true, undefined, { deleteBranch: 'merged' }],
    [join(WT, 'merged'), none, true, true, undefined, { deleteBranch: null }],
    [join(WT, 'rel'), rel, false, true, undefined, { deleteBranch: null }],
    [join(WT, 'upstream'), up, false, true, undefined, { deleteBranch: null }],
    [join(WT, 'withbuild'), withbuild, false, true],
    [join(TMP, 'scratch-1'), scratch, false, true],
    // Not a path, or not a plain one.
    ['', none, false, false, /no path/],
    ['build', none, false, false, /absolute/],
    [`${PROJ}/../proj/build`, none, false, false, /\.\./],
    [`${TMP}/../outside`, none, false, false, /\.\./],
    [join(PROJ, 'nothing-here'), none, false, false, /does not exist/],
    [join(TMP, 'loose.log'), scratch, false, false, /not a folder/],
    // Outside the allowed places, or the places themselves.
    ['/', none, false, false, /outside/],
    ['/etc', none, false, false, /outside/],
    [OUT, none, false, false, /outside/],
    [SRC, none, false, false, /outside/],
    [PROJ, none, false, false, /outside|main checkout|holds the project/],
    [WT, none, false, false, /outside/],
    [TMP, none, false, false, /outside/],
    [SCRATCH, none, false, false, /outside/],
    // Another project's folder: a worktree of this project's repository that is a project of its own.
    [join(WT, 'other'), none, true, false, /another project/],
    // Symlinks: the link itself, and paths that go through one.
    [join(WT, 'link'), none, true, false, /symlink/],
    [join(PROJ, 'build', 'escape'), build, false, false, /symlink/],
    [join(PROJ, 'build', 'escape', 'precious.txt'), none, false, false, /through a symlink/],
    // Work git would lose.
    [join(PROJ, '.git'), none, false, false, /\.git/],
    [join(PROJ, '.git', 'objects'), none, false, false, /\.git/],
    [join(PROJ, 'src'), { kind: 'build', agent_id: F }, false, false, /tracks files/],
    [join(PROJ, 'newstuff'), { kind: 'scratch', agent_id: F }, false, false, /untracked|does not ignore/],
    [join(WT, 'dirty'), none, true, false, /uncommitted/],
    [join(WT, 'untracked'), none, true, false, /uncommitted|untracked/],
    [join(WT, 'unmerged'), none, true, false, /not merged/],
    // Only registered folders, and only worktrees named or registered.
    [join(WT, 'merged'), none, false, false, /nobody registered/],
    [join(PROJ, 'build', 'big'), none, false, false, /registered as build or scratch/],
    [join(TMP, 'scratch-1'), none, false, false, /registered as build or scratch/],
    [join(WT, 'stray'), none, true, false, /registered as build or scratch/],
    // Build output must look like build output, or be made by the agent.
    [join(PROJ, 'mydir'), mydir, false, false, /usual build-output/],
    [join(PROJ, 'mydir'), { ...mine, birth: statSync(join(PROJ, 'mydir')).birthtimeMs }, false, true],
    [join(PLAIN, 'build'), plainBuild, false, false, /not a git checkout/, { project: plain }],
    // Data, secrets, repositories, programs' folders.
    [join(PROJ, 'build', 'data'), data, false, false, /data folder/],
    [join(PROJ, 'out'), env, false, false, /secrets/],
    [join(TMP, 'clone'), otherArt, false, false, /repository/],
    [join(TMP, 'holder'), { kind: 'scratch', agent_id: F }, false, false, /git repository/],
    [join(TMP, 'bare'), { kind: 'scratch', agent_id: F }, false, false, /bare git repository/],
    [join(TMP, 'sock'), { kind: 'scratch', agent_id: F }, false, false, /socket/],
    [join(TMP, 'tmux-1001'), tmux, false, false, /running program's session/],
    // In use.
    [join(TMP, 'busy'), busyArt, false, false, /running program \(pid/],
    [join(TMP, 'live-scratch'), { kind: 'scratch', agent_id: live.id }, false, false, /in use by Live/],
    [join(WT, 'live'), none, true, false, /in use by Live/],
    [join(TMP, 'shared'), shared, false, false, /in use by Live/],
  ];
  for (const [path, artifact, explicit, ok, why, extra] of cases) {
    const r = await usage.checkRemovable(path, (extra?.project as typeof project) ?? project, { artifact: artifact as never, explicit });
    assert.equal(r.ok, ok, `${path}: ${r.ok ? 'allowed' : (r as { reason: string }).reason}`);
    if (!r.ok && why) assert.match(r.reason, why, path);
    if (r.ok && extra && 'deleteBranch' in extra) assert.equal(r.deleteBranch, extra.deleteBranch, `${path}: branch`);
  }
  db.run('DELETE FROM artifacts');
});

test('the one-hour rule: a folder changed lately whose owner is not finished stays', async () => {
  const a = reg(join(TMP, 'recent'), 'scratch', null);
  usage.limits.recentMs = 60 * 60 * 1000;
  try {
    const r = await usage.checkRemovable(join(TMP, 'recent'), project, { artifact: a });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /last hour/);
    // Its owner finished and was last active after the last change: no need to wait.
    db.run('UPDATE agents SET active_at = ? WHERE id = ?', Date.now() + 1000, finished.id);
    const b = { ...a, agent_id: finished.id };
    assert.equal((await usage.checkRemovable(join(TMP, 'recent'), project, { artifact: b })).ok, true);
  } finally {
    usage.limits.recentMs = 0;
    db.run('DELETE FROM artifacts');
  }
});

test('registering: branches are recorded only when new, checked out there and deletable; the first owner stays', async () => {
  const err = async (p: string) => ((await usage.registerArtifact(project, null, { path: p, kind: 'build', disposable: true })) as { error: string }).error;
  assert.match(await err('rel'), /absolute/);
  assert.match(await err(join(TMP, 'nope')), /does not exist/);
  assert.match(await err(PROJ), /not something/);
  assert.match(await err(join(TMP, 'loose.log')), /not a folder/);

  const rel = await usage.registerArtifact(project, finished.id, { path: join(WT, 'rel'), kind: 'worktree', disposable: true, branch: 'release' });
  assert.ok('id' in rel && /not recorded as yours: release is a protected name/.test(rel.text), JSON.stringify(rel));
  const up = await usage.registerArtifact(project, finished.id, { path: join(WT, 'upstream'), kind: 'worktree', disposable: true, branch: 'up' });
  assert.ok('id' in up && /has an upstream/.test(up.text));
  const wrong = await usage.registerArtifact(project, finished.id, { path: join(WT, 'withbuild'), kind: 'worktree', disposable: true, branch: 'merged' });
  assert.ok('id' in wrong && /has withbuild checked out/.test(wrong.text));
  const ok = await usage.registerArtifact(project, finished.id, { path: join(WT, 'merged'), kind: 'worktree', disposable: true, branch: 'merged' });
  assert.ok('id' in ok && /branch merged recorded as yours/.test(ok.text));
  assert.equal(db.get('SELECT branch FROM artifacts WHERE path = ?', join(WT, 'merged'))!.branch, 'merged');
  assert.equal(db.get('SELECT branch FROM artifacts WHERE path = ?', join(WT, 'rel'))!.branch, null);

  // Someone else registers the same folder: ownership does not move.
  const again = await usage.registerArtifact(project, live.id, { path: join(WT, 'merged'), kind: 'worktree', disposable: true });
  assert.ok('id' in again && /stays its owner/.test(again.text));
  const row = db.get('SELECT agent_id, users FROM artifacts WHERE path = ?', join(WT, 'merged'))!;
  assert.equal(row.agent_id, finished.id);
  assert.deepEqual(JSON.parse(row.users), [live.id]);
  db.run('DELETE FROM artifacts');
});

test('reproduction: a sweep with no paths keeps release, other projects, and worktrees in use', async () => {
  const other = db.get("SELECT * FROM projects WHERE name = 'Other'")!;
  // An agent of the other project registered its own checkout; this project's live agent its worktree.
  await usage.registerArtifact(other, null, { path: join(WT, 'other'), kind: 'worktree', disposable: true });
  await usage.registerArtifact(project, finished.id, { path: join(WT, 'rel'), kind: 'worktree', disposable: true, branch: 'release' });
  await usage.registerArtifact(project, live.id, { path: join(WT, 'live'), kind: 'worktree', disposable: true, branch: 'live' });
  await usage.registerArtifact(project, finished.id, { path: join(WT, 'merged'), kind: 'worktree', disposable: true, branch: 'merged' });

  const res = await usage.cleanArtifacts(project.id, { by: 'Director (clean_artifacts)' });
  const removed = res.removed.map((r) => r.path).sort();
  assert.deepEqual(removed, [join(WT, 'merged'), join(WT, 'rel')].sort(), JSON.stringify(res, null, 1));
  assert.ok(git(PROJ, 'branch', '--list', 'release').trim(), 'release survives');
  assert.ok(!git(PROJ, 'branch', '--list', 'merged').trim(), 'the branch the agent created is deleted');
  assert.ok(existsSync(join(WT, 'other')), "the other project's checkout survives");
  assert.ok(existsSync(join(WT, 'live')), 'the live worktree survives');
  assert.ok(existsSync(join(WT, 'unmerged')) && existsSync(join(WT, 'dirty')) && existsSync(join(WT, 'withbuild')), 'unregistered worktrees are not swept');
  assert.match(res.refused.find((r) => r.path === join(WT, 'live'))!.reason, /in use by Live/);
  const j = db.get('SELECT title, body FROM journal WHERE project_id = ? ORDER BY id DESC LIMIT 1', project.id)!;
  assert.match(j.title, /Removed 2 folders/);
  assert.match(j.body, /branch release \(.*\) kept/);

  // From the other project, this project's worktrees are out of reach.
  const fromOther = await usage.cleanArtifacts(other.id, { by: 'x', paths: [join(WT, 'withbuild')] });
  assert.deepEqual(fromOther.removed, []);
  db.run('DELETE FROM artifacts');
});

test('clean: build and scratch output that is safe goes, the rest is explained; a dry run removes nothing', async () => {
  reg(join(PROJ, 'build', 'big'), 'build', finished.id);
  reg(join(TMP, 'scratch-1'), 'scratch', finished.id);
  reg(join(PROJ, 'newstuff'), 'scratch', finished.id);
  reg(OUT, 'scratch', finished.id);
  const dry = await usage.cleanArtifacts(project.id, { by: 'test', dryRun: true });
  assert.deepEqual(dry.removed.map((r) => r.path).sort(), [join(PROJ, 'build', 'big'), join(TMP, 'scratch-1')].sort());
  assert.ok(existsSync(join(PROJ, 'build', 'big')), 'a dry run removes nothing');
  const res = await usage.cleanArtifacts(project.id, { by: 'test' });
  assert.equal(res.removed.length, 2);
  const refused = Object.fromEntries(res.refused.map((r) => [r.path, r.reason]));
  assert.match(refused[OUT], /outside/);
  assert.match(refused[join(PROJ, 'newstuff')], /untracked|does not ignore/);
  assert.ok(existsSync(join(OUT, 'precious.txt')) && existsSync(join(PROJ, 'src', 'a.ts')));
  const odd = await usage.cleanArtifacts(project.id, { by: 'test', paths: ['/etc'] });
  assert.match(odd.refused[0].reason, /not a disposable folder/);
  db.run('DELETE FROM artifacts');
});

test('closing an agent removes its scratch only when no other unfinished agent uses it', async () => {
  const worker = runtime.createAgent(project, director, role, 'Builder', 'Build.');
  const helper = runtime.createAgent(project, director, role, 'Helper', 'Help.');
  for (const n of ['w-scratch', 'w-kept', 'w-shared']) file(join(TMP, n, 'x.bin'));
  await usage.registerArtifact(project, worker.id, { path: join(TMP, 'w-scratch'), kind: 'scratch', disposable: true });
  await usage.registerArtifact(project, worker.id, { path: join(TMP, 'w-kept'), kind: 'scratch', disposable: false });
  await usage.registerArtifact(project, worker.id, { path: join(TMP, 'w-shared'), kind: 'scratch', disposable: true });
  await usage.registerArtifact(project, helper.id, { path: join(TMP, 'w-shared'), kind: 'scratch', disposable: true });
  await runtime.closeAgent(worker.id, 'done');
  for (let i = 0; i < 60 && existsSync(join(TMP, 'w-scratch')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(join(TMP, 'w-scratch')));
  assert.ok(existsSync(join(TMP, 'w-kept')), 'kept folders stay');
  assert.ok(existsSync(join(TMP, 'w-shared')), 'the helper still uses it');
  // The last user finishes: now it goes.
  await runtime.closeAgent(helper.id, 'closed');
  for (let i = 0; i < 60 && existsSync(join(TMP, 'w-shared')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!existsSync(join(TMP, 'w-shared')));
});

test('usage lists the project folder, worktrees (stray ones too) and registered folders, without other projects in list_disk', async () => {
  reg(OUT, 'scratch', finished.id);
  const u = await usage.projectUsage(project);
  const kinds = u.entries.map((e) => `${e.kind}:${e.label}`);
  assert.ok(kinds.includes('project:Project folder'));
  assert.ok(kinds.includes('worktree:dirty') && kinds.includes('worktree:unmerged') && kinds.includes('worktree:stray'));
  assert.equal(u.entries.find((e) => e.label === 'dirty')!.clean, false);
  assert.equal(u.entries.find((e) => e.label === 'unmerged')!.merged, false);
  assert.ok(u.entries.some((e) => e.kind === 'artifact' && e.path === OUT));
  const text = await usage.renderDisk(project, [{ holds: [{ label: 'Proj' }, { label: 'Other' }, { label: 'Nix store' }], size: 1e12, free: 5e11, level: 'ok' }]);
  assert.ok(!text.includes('Other'), text);
  assert.match(text, /this project, 1 other project, Nix store/);
  sock.close();
  busy.kill();
});

// ---------- third review: the probes that still got through ----------

test('a finished owner waives the hour only for folders untouched since it finished', async () => {
  file(join(TMP, 'lbuild', 'a.o'));
  usage.limits.recentMs = 60 * 60 * 1000;
  try {
    // F finished ten seconds ago; then L (live, unregistered) writes into F's folder.
    db.run('UPDATE agents SET active_at = ? WHERE id = ?', Date.now() - 10_000, finished.id);
    await usage.registerArtifact(project, finished.id, { path: join(TMP, 'lbuild'), kind: 'scratch', disposable: true });
    file(join(TMP, 'lbuild', 'sub', 'l-output.o'));
    const res = await usage.cleanArtifacts(project.id, { by: 'probe', paths: [join(TMP, 'lbuild')] });
    assert.deepEqual(res.removed, []);
    assert.match(res.refused[0].reason, /changed after its owner last worked/);
    assert.ok(existsSync(join(TMP, 'lbuild', 'sub', 'l-output.o')));
    // Nothing touched since F finished: it may go at once.
    db.run('UPDATE agents SET active_at = ? WHERE id = ?', Date.now() + 5_000, finished.id);
    const ok = await usage.cleanArtifacts(project.id, { by: 'probe', paths: [join(TMP, 'lbuild')] });
    assert.equal(ok.removed.length, 1);
  } finally {
    usage.limits.recentMs = 0;
    db.run('UPDATE agents SET active_at = NULL WHERE id = ?', finished.id);
    db.run('DELETE FROM artifacts');
  }
});

test('a worktree made again at a registered path is not the registered one', async () => {
  // F registered its worktree; it was removed by hand; L made a new one at the same path.
  wt('reuse', 'f-reuse');
  await usage.registerArtifact(project, finished.id, { path: join(WT, 'reuse'), kind: 'worktree', disposable: true, branch: 'f-reuse' });
  git(PROJ, 'worktree', 'remove', join(WT, 'reuse'));
  await new Promise((r) => setTimeout(r, 5));
  wt('reuse', 'l-work');
  const res = await usage.cleanArtifacts(project.id, { by: 'probe' });
  assert.ok(existsSync(join(WT, 'reuse')), "L's new worktree survives");
  assert.ok(git(PROJ, 'branch', '--list', 'l-work').trim());
  assert.match(res.refused.find((r) => r.path === join(WT, 'reuse'))!.reason, /not the (folder|worktree) that was registered/);
  assert.equal(db.get('SELECT removed_by FROM artifacts WHERE path = ?', join(WT, 'reuse'))!.removed_by, 'replaced', 'the stale registration is dropped');
  // Same birth time but another branch checked out: refused too.
  const st = statSync(join(WT, 'reuse'));
  const row = reg(join(WT, 'reuse'), 'worktree', finished.id, { birth: st.birthtimeMs });
  db.run("UPDATE artifacts SET wt_branch = 'f-reuse' WHERE id = ?", row.id);
  const r2 = await usage.checkRemovable(join(WT, 'reuse'), project, { artifact: db.get('SELECT * FROM artifacts WHERE id = ?', row.id) });
  assert.equal(r2.ok, false);
  assert.match((r2 as { reason: string }).reason, /has l-work checked out, not f-reuse/);
  db.run('DELETE FROM artifacts');
});

test('an existing branch checked out in a new worktree is not recorded as the agent\'s', async () => {
  const twoHoursAgo = `${Math.floor(Date.now() / 1000) - 7200} +0000`;
  execFileSync('git', ['-C', PROJ, 'branch', 'userfeature'], { env: { ...gitEnv, GIT_COMMITTER_DATE: twoHoursAgo } });
  wt('claim', 'userfeature', false);
  const r = await usage.registerArtifact(project, finished.id, { path: join(WT, 'claim'), kind: 'worktree', disposable: true, branch: 'userfeature' });
  assert.ok('id' in r && /existed before the worktree was made/.test(r.text), JSON.stringify(r));
  assert.equal(db.get('SELECT branch FROM artifacts WHERE path = ?', join(WT, 'claim'))!.branch, null);
  // A branch with no reflog at all is not provably new either.
  wt('noreflog', 'noreflog');
  execFileSync('rm', ['-f', join(PROJ, '.git', 'logs', 'refs', 'heads', 'noreflog')]);
  const r2 = await usage.registerArtifact(project, finished.id, { path: join(WT, 'noreflog'), kind: 'worktree', disposable: true, branch: 'noreflog' });
  assert.ok('id' in r2 && /no history of being created/.test(r2.text), JSON.stringify(r2));
  const res = await usage.cleanArtifacts(project.id, { by: 'probe' });
  assert.ok(res.removed.some((x) => x.path === join(WT, 'claim')), 'the worktree goes');
  assert.ok(git(PROJ, 'branch', '--list', 'userfeature').trim(), 'the branch stays');
  assert.ok(git(PROJ, 'branch', '--list', 'noreflog').trim());
  db.run('DELETE FROM artifacts');
});

test('a parent swapped for a symlink between check and delete is not followed', async () => {
  const S = join(TMP, 'S');
  const OUT2 = join(SCRATCH, 'outside2');
  file(join(OUT2, 'b', 'precious.txt'));
  mkdirSync(join(S, 'a', 'b'), { recursive: true });
  // Swap S/a for a symlink to OUT2 and back, as fast as the shell can.
  const swapper = spawn('bash', ['-c', `cd ${S}; while :; do mv a a.r 2>/dev/null; ln -s ${OUT2} a 2>/dev/null; rm -f a 2>/dev/null; mv a.r a 2>/dev/null; done`], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 300; i++) {
      try {
        mkdirSync(join(S, 'a', 'b'));
      } catch {}
      await usage.removePinned(join(S, 'a', 'b')).catch(() => {});
    }
  } finally {
    swapper.kill('SIGKILL');
  }
  assert.ok(existsSync(join(OUT2, 'b', 'precious.txt')), 'nothing outside was deleted');
});

test('another project inside this one: its folders are out of reach; from inside, its own build output is not', async () => {
  const NESTED = join(PROJ, 'nested');
  file(join(NESTED, 'build', 'x.o'));
  const nested = makeProject('Nested', NESTED);
  const fromOuter = await usage.checkRemovable(join(NESTED, 'build'), project, { artifact: { kind: 'build', agent_id: finished.id } as never });
  assert.equal(fromOuter.ok, false);
  assert.match((fromOuter as { reason: string }).reason, /another project/);
  const fromInner = await usage.checkRemovable(join(NESTED, 'build'), nested, { artifact: { kind: 'build', agent_id: finished.id } as never });
  assert.equal(fromInner.ok, true, JSON.stringify(fromInner));
  db.run('DELETE FROM projects WHERE id = ?', nested.id);
});

test('a newline in a worktree path cannot fake an entry', async () => {
  const evil = join(WT, 'evil\nworktree /etc');
  git(PROJ, 'worktree', 'add', '-q', evil, '-b', 'evil');
  const { known } = await usage.worktreesOf(PROJ);
  assert.ok(known.some((w) => w.path === evil));
  assert.ok(!known.some((w) => w.path === '/etc'));
});

test('close and sweep at the same time journal each removal once', async () => {
  const worker = runtime.createAgent(project, director, role, 'Racer', 'Race.');
  file(join(TMP, 'race', 'x'));
  await usage.registerArtifact(project, worker.id, { path: join(TMP, 'race'), kind: 'scratch', disposable: true });
  db.run("UPDATE agents SET status = 'done', active_at = ? WHERE id = ?", Date.now() + 1000, worker.id);
  const before = db.get('SELECT COUNT(*) AS n FROM journal WHERE body LIKE ?', `%${join(TMP, 'race')}%`)!.n;
  await Promise.all([usage.cleanArtifacts(project.id, { by: 'close', agentId: worker.id }), usage.cleanArtifacts(project.id, { by: 'sweep' })]);
  assert.ok(!existsSync(join(TMP, 'race')));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM journal WHERE body LIKE ?', `%${join(TMP, 'race')}%`)!.n - before, 1);
  db.run('DELETE FROM artifacts');
});

// ---------- fourth review ----------

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a file rewritten in place, deep inside, counts as a change', async () => {
  file(join(TMP, 'inplace', 'deep', 'sub', 'obj.o'), 'v1');
  const art = await usage.registerArtifact(project, finished.id, { path: join(TMP, 'inplace'), kind: 'scratch', disposable: true });
  assert.ok('id' in art);
  usage.limits.recentMs = 60 * 60 * 1000;
  try {
    await pause(30);
    db.run('UPDATE agents SET active_at = ? WHERE id = ?', Date.now(), finished.id);
    const row = db.get('SELECT * FROM artifacts WHERE id = ?', art.id);
    assert.equal((await usage.checkRemovable(join(TMP, 'inplace'), project, { artifact: row })).ok, true, 'untouched since F last worked');
    await pause(30);
    // L overwrites the file in place: no folder's times change.
    writeFileSync(join(TMP, 'inplace', 'deep', 'sub', 'obj.o'), 'v2 from L');
    const res = await usage.cleanArtifacts(project.id, { by: 'probe', paths: [join(TMP, 'inplace')] });
    assert.deepEqual(res.removed, []);
    assert.match(res.refused[0].reason, /changed after its owner last worked/);
  } finally {
    usage.limits.recentMs = 0;
    db.run('UPDATE agents SET active_at = NULL WHERE id = ?', finished.id);
    db.run('DELETE FROM artifacts');
  }
});

test('use while the owner sat idle before being closed keeps the folder', async () => {
  const owner = runtime.createAgent(project, director, role, 'Idler', 'Idle.');
  file(join(TMP, 'idle', 'x.o'));
  await usage.registerArtifact(project, owner.id, { path: join(TMP, 'idle'), kind: 'scratch', disposable: true });
  usage.limits.recentMs = 60 * 60 * 1000;
  try {
    await pause(30);
    db.run('UPDATE agents SET active_at = ? WHERE id = ?', Date.now(), owner.id); // the owner's last turn ends
    await pause(30);
    file(join(TMP, 'idle', 'from-l.o')); // L uses it, unregistered
    await pause(30);
    db.run("UPDATE agents SET status = 'closed', finished_at = ? WHERE id = ?", Date.now(), owner.id); // closed later
    const res = await usage.cleanArtifacts(project.id, { by: 'probe', agentId: owner.id });
    assert.deepEqual(res.removed, []);
    assert.ok(existsSync(join(TMP, 'idle', 'from-l.o')));
  } finally {
    usage.limits.recentMs = 0;
    db.run('DELETE FROM artifacts');
  }
});

test('an owner started again while its close cleanup runs keeps its folders', async () => {
  const owner = runtime.createAgent(project, director, role, 'Reopened', 'Again.');
  file(join(TMP, 'reopen', 'x.o'));
  await usage.registerArtifact(project, owner.id, { path: join(TMP, 'reopen'), kind: 'scratch', disposable: true });
  // Closed, cleanup queued, and the agent is working again before it runs.
  db.run("UPDATE agents SET status = 'working', finished_at = NULL WHERE id = ?", owner.id);
  const res = await usage.cleanArtifacts(project.id, { by: 'close', agentId: owner.id });
  assert.deepEqual(res.removed, []);
  assert.ok(existsSync(join(TMP, 'reopen')));
  db.run('DELETE FROM artifacts');
});

test('the agent\'s own activity is recorded; what it is sent is not', async () => {
  const { addEvent } = await import('./store.ts');
  const ag = runtime.createAgent(project, director, role, 'Recorder', 'Rec.');
  addEvent(ag, 'inbound', { text: 'hi' });
  assert.equal(db.get('SELECT active_at FROM agents WHERE id = ?', ag.id)!.active_at, null);
  addEvent(ag, 'tool', { name: 'Bash' });
  assert.ok(db.get('SELECT active_at FROM agents WHERE id = ?', ag.id)!.active_at > 0);
});

test('System › Disk Clean up: the plan is clean_artifacts\' dry run, confirming removes exactly it, held work is skipped with why', async () => {
  const { cleanupPlan, runCleanup } = await import('./diskclean.ts');
  wt('done2', 'done2');
  wt('dirty2', 'dirty2');
  file(join(WT, 'dirty2', 'src', 'a.ts'), 'uncommitted');
  file(join(TMP, 'scratch-2', 'data.bin'));
  reg(join(WT, 'done2'), 'worktree', finished.id, { branch: 'done2' });
  reg(join(WT, 'dirty2'), 'worktree', finished.id, { branch: 'dirty2' });
  reg(join(TMP, 'scratch-2'), 'scratch', finished.id);

  const dry = await usage.cleanArtifacts(project.id, { by: 'test', dryRun: true });
  const plan = await cleanupPlan(project.id);
  const folders = plan.remove.filter((i) => i.kind === 'folder');
  assert.deepEqual(folders.map((i) => i.path).sort(), dry.removed.map((r) => r.path).sort(), 'the plan lists what clean_artifacts would remove');
  assert.deepEqual(folders.map((i) => i.path).sort(), [join(WT, 'done2'), join(TMP, 'scratch-2')].sort());
  assert.equal(plan.total, folders.reduce((n, i) => n + (i.bytes ?? 0), 0));
  const why = plan.skipped.find((s) => s.path === join(WT, 'dirty2'));
  assert.ok(why, 'the worktree with uncommitted work is listed as skipped');
  assert.match(why!.reason, /uncommitted|changes|modified/);
  assert.ok(existsSync(join(WT, 'done2')), 'the plan removes nothing');

  const res = await runCleanup(project.id, { paths: folders.map((i) => i.path), builds: [] });
  assert.deepEqual(res.remove.map((i) => i.path).sort(), folders.map((i) => i.path).sort(), 'exactly what the plan listed');
  assert.ok(!existsSync(join(WT, 'done2')) && !existsSync(join(TMP, 'scratch-2')));
  assert.ok(existsSync(join(WT, 'dirty2', 'src', 'a.ts')), 'held work stays');
  assert.ok(db.get("SELECT 1 AS x FROM journal WHERE project_id = ? AND title LIKE 'Removed 2 folders%'", project.id), 'journaled');
  db.run('DELETE FROM artifacts');
});
