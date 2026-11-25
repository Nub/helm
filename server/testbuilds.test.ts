import { SCRATCH } from './testenv.ts';
// Test builds (testbuilds.ts): made only from a committed clean checkout of a commit the repository has; carried by
// the test request with Download and Get link; a newer one supersedes; files go only after feedback plus the quiet
// days and only while the commit exists; never while the request is open. `node --test server/testbuilds.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

void SCRATCH;
const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const agents = await import('./agents.ts');
const tasks = await import('./tasks.ts');
const rel = await import('./releases.ts');
const tb = await import('./testbuilds.ts');
const dl = await import('./dllinks.ts');
const { answerInbox } = await import('./answers.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { ARTIFACT_DIR } = await import('./config.ts');
const PROJECTS = mkdtempSync(join(tmpdir(), `helm-test-tb-${process.pid}-`));
process.on('exit', () => rmSync(PROJECTS, { recursive: true, force: true }));
agents.bindAgentOps('test', { send: async () => {}, close: async () => {}, interrupt: async () => {}, restartForProjects: () => {}, resolvePermission: () => {}, liveAgentIds: () => new Set() });

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const DAY = 24 * 3600_000;
let n = 0;
function setup() {
  const repo = join(PROJECTS, `repo${++n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `tb${n}`, repo, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = agents.rootAgent(project);
  rel.saveRecipe(id, { artifacts: [{ name: 'Bundle', command: 'tar czf dist/b.tgz a.txt', cwd: '.', files: ['dist/b.tgz'] }] }, 'the user');
  const task = tasks.createTask(id, { title: 'Try the parry', state: 'waiting', origin: 'director' }, tasks.USER);
  return { project, repo, director, task, tools: toolsFor(director) };
}
function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const ts = helmTools(agent.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown>) => {
    const t = ts.find((x: any) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const res: any = await t.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
}
/** A clean checkout of HEAD with the bundle built in it, as the recipe says. */
function checkout(repo: string, name: string) {
  const wt = join(PROJECTS, `${name}-wt`);
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  mkdirSync(join(wt, 'dist'), { recursive: true });
  writeFileSync(join(wt, 'dist', 'b.tgz'), `bundle of ${name}`);
  return wt;
}
const idOf = (text: string) => /\[(tb_[0-9a-f]+)\]/.exec(text)?.[1] ?? '';

test('an uncommitted tree is refused; a clean checkout of a commit the repository has makes the build', async () => {
  const { repo, task, tools } = setup();
  const wt = checkout(repo, 'dirty');
  writeFileSync(join(wt, 'a.txt'), 'changed but not committed\n');
  const dirty = await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(wt, 'dist', 'b.tgz') }] });
  assert.equal(dirty.error, true);
  assert.match(dirty.text, /uncommitted changes/);
  git(wt, 'checkout', '--', 'a.txt');
  assert.equal((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Nope', path: join(wt, 'dist', 'b.tgz') }] })).error, true, 'only the recipe\'s artifacts');
  const ok = await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(wt, 'dist', 'b.tgz') }] });
  assert.equal(ok.error, false, ok.text);
  const b = tb.getBuild(idOf(ok.text))!;
  assert.equal(b.commit_sha, git(repo, 'rev-parse', 'HEAD'));
  const v = tb.buildView(b);
  assert.equal(v.label, 'Test build 1 of Try the parry');
  assert.ok(v.files[0].url && existsSync(join(ARTIFACT_DIR, v.files[0].url.replace('/artifacts/', ''))));
  assert.equal(db.all('SELECT 1 FROM releases WHERE project_id = ?', b.project_id).length, 0, 'not a release');
});

test('a commit the project repository does not have is refused', async () => {
  const { repo, task, tools } = setup();
  // A separate clone inside the project folder, with a commit only it has.
  const clone = join(repo, 'elsewhere');
  execFileSync('git', ['clone', '-q', repo, clone]);
  writeFileSync(join(clone, 'a.txt'), 'only here\n');
  git(clone, 'commit', '-qam', 'not in the project');
  mkdirSync(join(clone, 'dist'));
  writeFileSync(join(clone, 'dist', 'b.tgz'), 'x');
  const r = await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(clone, 'dist', 'b.tgz') }] });
  assert.equal(r.error, true);
  assert.match(r.text, /not in the project's repository/);
});

test('the request carries the build; a newer build supersedes the older and withdraws its request; links serve the file', async () => {
  const { repo, task, tools } = setup();
  const one = idOf((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(checkout(repo, 'one'), 'dist', 'b.tgz') }] })).text);
  const ask1 = await tools('ask_user', { kind: 'action', title: 'Try build 1', question: 'Play a round.', steps: '1. Download it\n2. Play', task: task.id, test_build: one });
  assert.equal(ask1.error, false, ask1.text);
  const b1 = tb.getBuild(one)!;
  assert.equal(b1.state, 'waiting');
  assert.equal(JSON.parse(db.get('SELECT payload FROM inbox WHERE id = ?', b1.request_id)!.payload).test_build, one);
  // A download link to its file works without signing in, until the files go.
  const f = tb.buildView(b1).files[0];
  const link = dl.createTestLink(one, f.id, '1h');
  assert.ok(!('error' in link));
  const got = dl.resolveToken((link as any).token);
  assert.equal(got?.files[0].bytes, 'bundle of one'.length);
  // Build 2 replaces it.
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'two');
  const two = idOf((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(checkout(repo, 'two'), 'dist', 'b.tgz') }] })).text);
  await tools('ask_user', { kind: 'action', title: 'Try build 2', question: 'Again.', steps: '1. Download\n2. Play', task: task.id, test_build: two });
  assert.equal(tb.getBuild(one)!.state, 'superseded');
  assert.equal(db.get('SELECT status FROM inbox WHERE id = ?', b1.request_id)!.status, 'withdrawn');
  assert.equal(tb.buildView(tb.getBuild(two)!).n, 2);
  // Superseded: kept for a day, then its files go and the link stops.
  assert.equal(await tb.sweepTestBuilds(db.now() + 3600_000), 0);
  assert.equal(await tb.sweepTestBuilds(db.now() + DAY + 60_000), 1);
  assert.equal(tb.getBuild(one)!.state, 'removed');
  assert.equal(dl.resolveToken((link as any).token), null);
});

test('files go only after feedback plus the quiet days, only while the commit exists; never while the request is open', async () => {
  const { repo, task, tools } = setup();
  const id = idOf((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(checkout(repo, 'q'), 'dist', 'b.tgz') }] })).text);
  await tools('ask_user', { kind: 'action', title: 'Try it', question: 'Play.', steps: '1. Download\n2. Play', task: task.id, test_build: id });
  const later = db.now() + 30 * DAY;
  assert.equal(await tb.sweepTestBuilds(later), 0, 'the request is open');
  assert.equal(await tb.keepReason(tb.getBuild(id)!, later), 'its test request is open');
  assert.equal(await answerInbox(tb.getBuild(id)!.request_id, { choice: 'Done', text: 'Parry feels right.' }), null);
  assert.equal(tb.getBuild(id)!.state, 'feedback');
  assert.equal(await tb.sweepTestBuilds(db.now() + 2 * DAY), 0, 'not quiet long enough (3 days)');
  // Its commit gone: flagged and kept.
  const sha = tb.getBuild(id)!.commit_sha;
  db.run('UPDATE test_builds SET commit_sha = ? WHERE id = ?', 'f'.repeat(40), id);
  assert.equal(await tb.sweepTestBuilds(db.now() + 4 * DAY), 0);
  assert.match(tb.getBuild(id)!.flag, /not in the repository/);
  db.run("UPDATE test_builds SET commit_sha = ?, flag = '' WHERE id = ?", sha, id);
  assert.equal(await tb.sweepTestBuilds(db.now() + 4 * DAY), 1);
  const gone = tb.buildView(tb.getBuild(id)!);
  assert.equal(gone.state, 'removed');
  assert.equal(gone.files[0].url, null, 'the record stays without its file');
});

test('the newest build of an Active task stays; Delete removes the files at once', async () => {
  const { repo, task, tools } = setup();
  const id = idOf((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: join(checkout(repo, 'act'), 'dist', 'b.tgz') }] })).text);
  await tools('ask_user', { kind: 'action', title: 'Try it', question: 'Play.', steps: '1. Download\n2. Play', task: task.id, test_build: id });
  await answerInbox(tb.getBuild(id)!.request_id, { choice: 'Done' });
  db.run("UPDATE tasks SET state = 'active' WHERE id = ?", task.id);
  assert.equal(await tb.keepReason(tb.getBuild(id)!, db.now() + 10 * DAY), 'the newest build of an Active task');
  assert.equal(tb.removeBuildFiles(tb.getBuild(id)!, 'deleted by you'), 1);
  assert.equal(tb.getBuild(id)!.removed_why, 'deleted by you');
});

test('a file a host job copied back is accepted with the commit of its workspace; anything else outside a checkout is refused', async () => {
  const { project, repo, task, tools } = setup();
  const { resultsDir } = await import('./hostwork.ts');
  const head = git(repo, 'rev-parse', 'HEAD');
  const ws = (state: string) => {
    const id = db.newId('hws');
    db.run("INSERT INTO host_workspaces (id, host_id, project_id, task_id, name, path, commit_sha, state, created_at) VALUES (?, 'host_win', ?, ?, 'job-1', 'C:/helm/game/job-1', ?, ?, ?)", id, project.id, task.id, head, state, db.now());
    const w = db.get('SELECT * FROM host_workspaces WHERE id = ?', id)!;
    mkdirSync(join(resultsDir(w), 'out'), { recursive: true });
    const file = join(resultsDir(w), 'out', 'game-win.zip');
    writeFileSync(file, 'windows zip');
    return file;
  };
  const failed = await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: ws('failed') }] });
  assert.equal(failed.error, true);
  assert.match(failed.text, /did not end well/);
  const ok = await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: ws('done') }] });
  assert.equal(ok.error, false, ok.text);
  assert.equal(tb.getBuild(idOf(ok.text))!.commit_sha, head, 'the commit comes from the workspace record');
  // In host-results but no workspace record: refused. Elsewhere outside any checkout: refused as before.
  const stray = join(ARTIFACT_DIR, 'host-results', project.id, 'hws_nope', 'x.zip');
  mkdirSync(join(stray, '..'), { recursive: true });
  writeFileSync(stray, 'x');
  assert.match((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: stray }] })).text, /not the result of a workspace/);
  const loose = join(PROJECTS, 'loose.zip');
  writeFileSync(loose, 'x');
  assert.equal((await tools('make_test_build', { task: task.id, artifacts: [{ name: 'Bundle', path: loose }] })).error, true);
});
