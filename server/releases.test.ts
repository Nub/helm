import { SCRATCH } from './testenv.ts';
// Releases (releases.ts, releasetools.ts): the recipe, the user-only start, the change-log material, attaching files
// with checksums, the fail path, the local tag, publishing only after the user's confirmation, removing old files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const agents = await import('./agents.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const tasks = await import('./tasks.ts');
const rel = await import('./releases.ts');
const { answerInbox } = await import('./answers.ts');
const { projectUsage } = await import('./diskusage.ts');
const { ARTIFACT_DIR, DATA_DIR } = await import('./config.ts');
// Project folders live outside Helm's data folder (SCRATCH is HELM_DATA here), as they do for real.
const PROJECTS = mkdtempSync(join(tmpdir(), `helm-test-rel-${process.pid}-`));
process.on('exit', () => rmSync(PROJECTS, { recursive: true, force: true }));

const sent: { to: string; text: string }[] = [];
agents.bindAgentOps('test', {
  send: async (to, text) => void sent.push({ to, text }),
  close: async () => {},
  interrupt: async () => {},
  restartForProjects: () => {},
  resolvePermission: () => {},
  liveAgentIds: () => new Set(),
});

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
let n = 0;
function setup() {
  const repo = join(PROJECTS, `relrepo${++n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `rel${n}`, repo, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = agents.rootAgent(project);
  built = repo;
  return { project, repo, director, tools: toolsFor(director) };
}
function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const tools = helmTools(agent.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown> = {}) => {
    const t = tools.find((x: any) => x.name === name);
    if (!t) return { missing: true, text: '', error: true };
    const res: any = await t.handler(input, {});
    return { missing: false, text: res.content[0].text as string, error: !!res.isError };
  };
}
const doneTask = (projectId: string, title: string, summary: string, at: number) => {
  const t = tasks.createTask(projectId, { title, state: 'done', origin: 'director', status_summary: summary }, tasks.USER);
  db.run('UPDATE tasks SET finished_at = ?, updated_at = ? WHERE id = ?', at, at, t.id);
  return t;
};
let built = PROJECTS;
/** A built file, in the latest project's folder unless a folder is given. */
const file = (name: string, text: string, dir = built) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test('recipe: validated, credentials refused, versions proposed by scheme', () => {
  const { project } = setup();
  const bad = rel.saveRecipe(project.id, { artifacts: [{ name: 'CLI', command: 'make', cwd: '.' }] }, 'Director');
  assert.ok('error' in bad && /files/.test(bad.error));
  const secret = rel.saveRecipe(project.id, { publish: 'Run `gh release create` with token=abcdef123456' }, 'Director');
  assert.ok('error' in secret && /credential/.test(secret.error));
  const okr = rel.saveRecipe(project.id, { artifacts: [{ name: 'CLI', command: 'make cli', cwd: '.', files: ['dist/cli'] }] }, 'Director');
  assert.ok('recipe' in okr && okr.recipe.artifacts.length === 1);
  assert.equal(rel.nextVersion(project.id, 'semver'), '0.1.0');
  assert.equal(rel.nextVersion(project.id, 'date', new Date(2026, 10, 19)), '2026.11.19');
  assert.match(rel.checkVersion(project.id, 'semver', 'one') ?? '', /MAJOR/);
});

test('only the user starts a release: the page, or the cut_release action on a request the director files', async () => {
  const { project, director, tools } = setup();
  // No agent tool starts one, whatever was said.
  assert.ok((await tools('start_release')).missing);
  const structure = defaultStructure();
  const role = structure.roles.find((x) => x.id !== structure.root && !x.canSpawn.length)!;
  const w = agents.createAgent(project, director, role, 'Builder', 'build');
  const workerAsk = await toolsFor(w)('ask_user', { title: 'Cut it?', question: 'Shall we?', action: { kind: 'cut_release' } });
  assert.ok(workerAsk.error && /Only the director/.test(workerAsk.text), workerAsk.text);
  // The director proposes one: filing the request starts nothing.
  const filed = await tools('ask_user', { title: 'Cut release 0.1.0?', question: 'Three tasks are done since the start.', options: [{ label: 'Not now' }], action: { kind: 'cut_release' } });
  assert.ok(!filed.error, filed.text);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM releases WHERE project_id = ?', project.id)!.n, 0);
  const req = db.get("SELECT * FROM inbox WHERE project_id = ? AND title = 'Cut release 0.1.0?'", project.id)!;
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", req.id);
  // Not now: nothing either.
  assert.equal(await answerInbox(req.id, { choice: 'Not now' }), null);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM releases WHERE project_id = ?', project.id)!.n, 0);
  // The user's tap on Cut release starts it, through the same start as the page's button.
  const again = await tools('ask_user', { title: 'Cut release now?', question: 'Ready when you are.', action: { kind: 'cut_release' } });
  assert.ok(!again.error, again.text);
  const req2 = db.get("SELECT * FROM inbox WHERE project_id = ? AND title = 'Cut release now?'", project.id)!;
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", req2.id);
  assert.equal(await answerInbox(req2.id, { perform: true }), null);
  const row = db.get('SELECT * FROM releases WHERE project_id = ?', project.id)!;
  assert.equal(row.version, '0.1.0');
  assert.equal(row.commit_sha, execFileSync('git', ['-C', project.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  assert.equal(tasks.getTask(row.task_id)!.state, 'active');
});

test('one release at a time: a second start, even at the same moment, returns the open one', async () => {
  const { project } = setup();
  const [a, b] = await Promise.all([rel.startRelease(project.id, {}), rel.startRelease(project.id, {})]);
  assert.ok('release' in a && 'release' in b);
  assert.equal(a.release.id, b.release.id);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM releases WHERE project_id = ?', project.id)!.n, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND title LIKE 'Release %'", project.id)!.n, 1);
  const c = await rel.startRelease(project.id, { version: '9.9.9' });
  assert.ok('release' in c && c.existing && c.release.id === a.release.id);
});

test('artifact paths: only regular files from the project or its worktrees, never Helm data, symlinks or secrets', async () => {
  const { project, repo, tools } = setup();
  const res = await rel.startRelease(project.id, {});
  assert.ok('release' in res);
  const add = (name: string, path: string) => tools('add_release_artifact', { release: res.release.id, name, path });
  writeFileSync(join(DATA_DIR, 'secret.db'), 'data');
  let r = await add('db', join(DATA_DIR, 'secret.db'));
  assert.ok(r.error && /data folder/.test(r.text), r.text);
  const outside = join(PROJECTS, 'outside.bin');
  writeFileSync(outside, 'x');
  r = await add('out', outside);
  assert.ok(r.error && /outside the project/.test(r.text), r.text);
  writeFileSync(join(PROJECTS, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
  symlinkSync(join(PROJECTS, 'id_ed25519'), join(repo, 'build.bin'));
  r = await add('key', 'build.bin');
  assert.ok(r.error && /symlink/.test(r.text), r.text);
  symlinkSync(join(DATA_DIR), join(repo, 'data'));
  r = await add('db2', join(repo, 'data', 'secret.db'));
  assert.ok(r.error && /symlink/.test(r.text), 'a symlinked folder in the path too');
  r = await add('key2', file('server.pem', 'x'));
  assert.ok(r.error && /credentials/.test(r.text), r.text);
  r = await add('key3', file('notes.txt', 'here: -----BEGIN RSA PRIVATE KEY-----\nMII'));
  assert.ok(r.error && /private key/.test(r.text), r.text);
  mkdirSync(join(repo, 'dir'));
  r = await add('dir', join(repo, 'dir'));
  assert.ok(r.error && /regular file/.test(r.text), r.text);
  // A clean checkout of the commit is a worktree of the project: allowed.
  const wt = join(PROJECTS, `wt${n}`);
  git(repo, 'worktree', 'add', '-q', '--detach', wt, res.release.commit_sha);
  r = await add('CLI', file('cli', 'built', wt));
  assert.ok(!r.error, r.text);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM release_artifacts WHERE release_id = ?', res.release.id)!.n, 1);
});

test('artifact size and space: at most MAX_ARTIFACT_BYTES, and never past the disk guard\'s critical level', async () => {
  const { project, tools } = setup();
  const res = await rel.startRelease(project.id, {});
  assert.ok('release' in res);
  const big = file('big.bin', '');
  truncateSync(big, rel.MAX_ARTIFACT_BYTES + 1);
  const r = await tools('add_release_artifact', { release: res.release.id, name: 'big', path: big });
  assert.ok(r.error && /at most 2 GB/.test(r.text), r.text);
  rmSync(big);
  // 100 GB disk, 12 GB free: the critical level is 5 GB (5%); 8 GB more would leave 4.
  const GB = 1073741824;
  const disk = () => ({ bavail: 12 * GB / 4096, bsize: 4096, blocks: 100 * GB / 4096 });
  assert.match(rel.spaceRefusal(8 * GB, disk) ?? '', /critical level/);
  assert.equal(rel.spaceRefusal(6 * GB, disk), null);
});

test('change log material: tasks finished since the previous release, with fixed reports; the director is briefed', async () => {
  const { project, director } = setup();
  const t0 = db.now() - 100_000;
  const old = doneTask(project.id, 'Old work', 'Done long ago.', t0);
  db.run("INSERT INTO releases (id, project_id, version, commit_sha, state, created_at, updated_at) VALUES (?,?,?,?,'ready',?,?)", db.newId('rel'), project.id, '1.2.0', 'abc', t0 + 10, t0 + 10);
  const a = doneTask(project.id, 'Dark mode', 'Every page has a dark theme.', t0 + 20);
  const b = doneTask(project.id, 'Crash on save', 'Saving no longer crashes.', t0 + 30);
  const src = db.newId('rs');
  db.run("INSERT INTO report_sources (id, project_id, type, name, created_at, updated_at) VALUES (?,?,'folder','notes',?,?)", src, project.id, t0, t0);
  db.run("INSERT INTO reports (id, project_id, source_id, external_id, title, status, task_id, changed_at, created_at, updated_at) VALUES (?,?,?,?,?,'fixed',?,?,?,?)", db.newId('rp'), project.id, src, 'x1', 'App crashes when saving', b.id, t0, t0, t0);
  tasks.createTask(project.id, { title: 'Still open', state: 'active', origin: 'director' }, tasks.USER);
  assert.deepEqual(rel.tasksSince(project.id).map((t) => t.id), [a.id, b.id]);
  assert.ok(!rel.tasksSince(project.id).some((t) => t.id === old.id));
  sent.length = 0;
  const res = await rel.startRelease(project.id, {});
  assert.ok('release' in res);
  assert.equal(res.release.version, '1.3.0');
  const brief = sent.find((s) => s.to === director.id)!.text;
  assert.match(brief, /set_release_notes/);
  assert.match(brief, /Dark mode: Every page has a dark theme/);
  assert.match(brief, /Fixed reports: "App crashes when saving"/);
  assert.ok(!brief.includes('Old work') && !brief.includes('Still open'));
});

test('artifacts: copied with size and checksum, replaced by name; finish needs the log and every artifact, then tags locally', async () => {
  const { project, repo, tools } = setup();
  rel.saveRecipe(project.id, { artifacts: [{ name: 'CLI', command: 'make cli', cwd: '.', files: ['dist/cli'] }, { name: 'Docs', command: 'make docs', cwd: '.', files: ['dist/docs.zip'] }] }, 'Director');
  const res = await rel.startRelease(project.id, { version: '2.0.0' });
  assert.ok('release' in res);
  const id = res.release.id;
  let r = await tools('add_release_artifact', { release: '2.0.0', name: 'CLI', path: file('cli-a', 'first build') });
  assert.ok(!r.error, r.text);
  const first = db.get('SELECT * FROM release_artifacts WHERE release_id = ?', id)!;
  r = await tools('add_release_artifact', { release: id, name: 'CLI', path: file('cli-b', 'second build!') });
  assert.match(r.text, /Still to attach: Docs/);
  assert.ok(!existsSync(join(ARTIFACT_DIR, first.file)), 'the replaced file is gone');
  const a = db.get('SELECT * FROM release_artifacts WHERE release_id = ?', id)!;
  assert.equal(a.bytes, 13);
  assert.equal(a.sha256, createHash('sha256').update('second build!').digest('hex'));
  assert.equal(readFileSync(join(ARTIFACT_DIR, a.file), 'utf8'), 'second build!');
  r = await tools('finish_release', { release: id });
  assert.match(r.text, /change log/);
  assert.ok(!(await tools('set_release_notes', { release: id, notes: '## New\n- Dark mode.' })).error);
  r = await tools('finish_release', { release: id });
  assert.ok(r.error && /Docs/.test(r.text), 'every artifact in the recipe first');
  await tools('add_release_artifact', { release: id, name: 'Docs', path: file('docs.zip', 'zip') });
  r = await tools('finish_release', { release: id });
  assert.ok(!r.error, r.text);
  assert.equal(git(repo, 'rev-parse', 'v2.0.0^{commit}'), res.release.commit_sha);
  assert.equal(rel.getRelease(id)!.state, 'ready');
  // A tag of that name on another commit is never moved.
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git(repo, 'commit', '-qam', 'two');
  git(repo, 'tag', 'v2.1.0');
  rel.saveRecipe(project.id, { artifacts: [] }, 'Director');
  const next = await rel.startRelease(project.id, { version: '2.1.0', commit: res.release.commit_sha });
  assert.ok('release' in next);
  rel.setNotes(next.release, 'x');
  const clash = await rel.finishRelease(rel.getRelease(next.release.id)!);
  assert.ok('error' in clash && /already exists/.test(clash.error));
});

test('fail path: a failed build removes its files and is never listed as ready', async () => {
  const { project, tools } = setup();
  rel.saveRecipe(project.id, { artifacts: [{ name: 'CLI', command: 'make', cwd: '.', files: ['cli'] }] }, 'Director');
  const res = await rel.startRelease(project.id, {});
  assert.ok('release' in res);
  await tools('add_release_artifact', { release: res.release.id, name: 'CLI', path: file('half', 'half') });
  const f = db.get('SELECT file FROM release_artifacts WHERE release_id = ?', res.release.id)!.file;
  const r = await tools('fail_release', { release: res.release.id, error: 'make: *** [cli] Error 1' });
  assert.ok(!r.error, r.text);
  assert.ok(!existsSync(join(ARTIFACT_DIR, f)));
  assert.equal(db.get('SELECT COUNT(*) AS n FROM release_artifacts WHERE release_id = ?', res.release.id)!.n, 0);
  assert.equal(rel.getRelease(res.release.id)!.state, 'failed');
  assert.ok((await tools('finish_release', { release: res.release.id })).error);
  // The version is free again.
  assert.equal(rel.nextVersion(project.id, 'semver'), '0.1.0');
});

test('publishing: only after the user confirms, each time; the director then gets the instructions', async () => {
  const { project, director, tools } = setup();
  const res = await rel.startRelease(project.id, {});
  assert.ok('release' in res);
  const id = res.release.id;
  rel.setNotes(rel.getRelease(id)!, '## Fixed\n- Saving works.');
  await rel.finishRelease(rel.getRelease(id)!);
  assert.ok('error' in rel.requestPublish(rel.getRelease(id)!), 'no instructions: releases stay in Helm');
  rel.saveRecipe(project.id, { publish: '1. Run `gh release create v$VERSION dist/*` (gh is logged in on this machine).' }, 'Director');
  assert.ok((await tools('mark_published', { release: id, how: 'GitHub' })).error, 'not without confirmation');
  const req = rel.requestPublish(rel.getRelease(id)!);
  assert.ok('request' in req);
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", req.request);
  assert.deepEqual(rel.requestPublish(rel.getRelease(id)!), req, 'one open confirmation at a time');
  sent.length = 0;
  assert.equal(await answerInbox(req.request, { choice: 'Not now' }), null);
  assert.equal(rel.getRelease(id)!.publish_confirmed_at, null);
  assert.ok(!sent.some((s) => s.text.includes('gh release create')));
  const again = rel.requestPublish(rel.getRelease(id)!);
  assert.ok('request' in again && again.request !== req.request);
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", again.request);
  sent.length = 0;
  assert.equal(await answerInbox(again.request, { perform: true }), null);
  const msg = sent.find((s) => s.to === director.id)!.text;
  assert.match(msg, /confirmed publishing release 0\.1\.0/);
  assert.match(msg, /gh release create/);
  const r = await tools('mark_published', { release: id, how: 'GitHub release v0.1.0' });
  assert.ok(!r.error, r.text);
  const done = rel.getRelease(id)!;
  assert.equal(done.state, 'published');
  assert.equal(done.publish_confirmed_at, null);
  assert.ok((await tools('mark_published', { release: id, how: 'again' })).error, 'a confirmation is used once');
});

test('old release files: listed on the Disk page and removable, the record kept', async () => {
  const { project, tools } = setup();
  rel.saveRecipe(project.id, { artifacts: [{ name: 'CLI', command: 'make', cwd: '.', files: ['cli'] }] }, 'Director');
  const res = await rel.startRelease(project.id, {});
  assert.ok('release' in res);
  await tools('add_release_artifact', { release: res.release.id, name: 'CLI', path: file('cli-z', 'bytes!') });
  rel.setNotes(rel.getRelease(res.release.id)!, 'Notes');
  await rel.finishRelease(rel.getRelease(res.release.id)!);
  const entry = (await projectUsage(project)).entries.find((e) => e.kind === 'release');
  assert.equal(entry?.releaseId, res.release.id);
  assert.equal(entry?.bytes, 6);
  assert.equal(rel.removeFiles(rel.getRelease(res.release.id)!), 1);
  assert.ok(!(await projectUsage(project)).entries.some((e) => e.kind === 'release'));
  const view = rel.releaseView(rel.getRelease(res.release.id)!);
  assert.equal(view.notes, 'Notes');
  assert.ok(view.artifacts[0].removed && view.artifacts[0].url === null && view.artifacts[0].sha256);
});

test('the setting: off refuses the tools and the start', async () => {
  const { project, tools } = setup();
  const { setSetting } = await import('./settings.ts');
  setSetting(project.id, 'releases', false);
  assert.match((await tools('list_releases')).text, /off/);
  assert.match((await tools('ask_user', { title: 'Cut?', question: 'Cut a release?', action: { kind: 'cut_release' } })).text, /off/);
  const res = await rel.startRelease(project.id, {});
  assert.ok('error' in res && /off/.test(res.error));
});
