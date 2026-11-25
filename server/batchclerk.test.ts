import { SCRATCH } from './testenv.ts';
// The batch clerk (batchclerk.ts): a finished builder batch starts the full checks; a pass with "Move branch release"
// moves the branch and (Helm's own project) files one Update Helm request, replaced by the next batch's; a failure
// wakes the director and moves nothing; Stopped does nothing. `node --test server/batchclerk.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const pc = await import('./projectchecks.ts');
const b = await import('./builder.ts');
const { getChoice, setSetting } = await import('./settings.ts');

const USER = { author: 'user' as const, name: 'You' };
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;
function setup() {
  const repo = join(SCRATCH, `bc${++n}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'master');
  commit(repo, 'one');
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'bc', repo, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  assert.equal(pc.setChecks(id, { quick: [], full: [{ name: 'tests', command: 'tests' }], minutes: 1 }), null);
  return { project, repo, director: runtime.rootAgent(project) };
}
function commit(repo: string, msg: string) {
  writeFileSync(join(repo, 'a.txt'), `${msg}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', msg);
  return git(repo, 'rev-parse', 'HEAD');
}
/** A builder batch of `count` finished tasks waiting for its record. */
function finish(projectId: string, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const t = tasks.createTask(projectId, { title: `T${n}-${i}`, state: 'done', origin: 'director', description: 'x' } as any, USER);
    db.run('INSERT INTO builder_batch (project_id, task_id, finished_at, commits, result, noted, subagents) VALUES (?,?,?,?,?,0,0)', projectId, t.id, db.now() + i, '[]', 'Done.');
    return t.id as string;
  });
}
let failing = false;
const ran: string[] = [];
pc.setRunCommand(async (command) => {
  ran.push(command);
  return failing ? { code: 1, output: 'Error: 2 tests failed' } : { code: 0, output: 'ok' };
});
// The checks and the step after them run in the background: wait until nothing has changed for a while.
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (!db.get("SELECT 1 AS x FROM check_runs WHERE status = 'running'")) break;
  }
  await new Promise((r) => setTimeout(r, 100));
};
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));
const updateRequests = (projectId: string) => db.all("SELECT * FROM inbox WHERE project_id = ? AND title = 'Update Helm' ORDER BY created_at, id", projectId);
const branchAt = (repo: string, name: string) => {
  try {
    return git(repo, 'rev-parse', name);
  } catch {
    return null;
  }
};

test('a finished batch starts the checks; on a pass with Nothing, nothing moves and no one is woken', async () => {
  const { project, repo, director } = setup();
  assert.equal(getChoice(project.id, 'after_checks'), 'nothing');
  const before = inbound(director.id).length;
  finish(project.id, 2);
  ran.length = 0;
  assert.equal(await b.batchNote(project), true);
  await settle();
  assert.deepEqual(ran, ['tests']);
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.equal(pc.latestRun(project.id, head)?.status, 'passed');
  assert.equal(branchAt(repo, 'release'), null);
  assert.equal(inbound(director.id).length, before, 'a pass wakes no one');
  const rec = db.get("SELECT body FROM journal WHERE project_id = ? AND title LIKE 'Batch:%'", project.id)!;
  assert.match(rec.body, /Started the full checks \(tests\)/);
});

test("Helm's own project: release by default; a pass moves it and files one Update request; the next batch replaces it", async () => {
  const { project, repo, director } = setup();
  process.env.HELM_LIVE_UPDATE_REPO = repo;
  try {
    assert.equal(getChoice(project.id, 'after_checks'), 'release', "Helm's own project moves release by default");
    const before = inbound(director.id).length;
    const first = finish(project.id, 2);
    await b.batchNote(project);
    await settle();
    const c1 = git(repo, 'rev-parse', 'HEAD');
    assert.equal(branchAt(repo, 'release'), c1);
    assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'master', 'the checked-out branch stays');
    let reqs = updateRequests(project.id);
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].status, 'open');
    assert.equal(JSON.parse(reqs[0].payload).act.kind, 'update_helm');
    for (const id of first) assert.ok(reqs[0].body.includes(`[[${id}]]`));
    // A second batch on a new commit: release follows; one open request lists both batches' tasks.
    const c2 = commit(repo, 'two');
    const second = finish(project.id, 1);
    await b.batchNote(project);
    await settle();
    assert.equal(branchAt(repo, 'release'), c2);
    reqs = updateRequests(project.id);
    assert.deepEqual(reqs.map((r) => r.status), ['withdrawn', 'open']);
    for (const id of [...first, ...second]) assert.ok(reqs[1].body.includes(`[[${id}]]`));
    assert.equal(inbound(director.id).length, before, 'passes wake no one');
    // The user may still choose Nothing for it.
    assert.equal(setSetting(project.id, 'after_checks', 'nothing'), null);
    assert.equal(getChoice(project.id, 'after_checks'), 'nothing');
  } finally {
    delete process.env.HELM_LIVE_UPDATE_REPO;
  }
});

test('a failure wakes the director with the failure and moves nothing', async () => {
  const { project, repo, director } = setup();
  setSetting(project.id, 'after_checks', 'release');
  finish(project.id, 1);
  failing = true;
  try {
    await b.batchNote(project);
    await settle();
  } finally {
    failing = false;
  }
  assert.equal(branchAt(repo, 'release'), null);
  const note = inbound(director.id).find((t) => t.includes('kind="checks"'));
  assert.ok(note);
  assert.match(note!, /Checks failed on [0-9a-f]{7} at "tests"/);
  assert.equal(updateRequests(project.id).length, 0);
});

test('a project that is Stopped: no checks, nothing moved', async () => {
  const { project, repo } = setup();
  setSetting(project.id, 'after_checks', 'release');
  db.run("UPDATE projects SET mode = 'stopped' WHERE id = ?", project.id);
  finish(project.id, 1);
  ran.length = 0;
  await b.batchNote(project);
  await settle();
  assert.deepEqual(ran, []);
  assert.equal(pc.latestRun(project.id), undefined);
  assert.equal(branchAt(repo, 'release'), null);
});

test('the branch checked out is never moved', async () => {
  const { project, repo, director } = setup();
  git(repo, 'checkout', '-qb', 'release');
  const at = git(repo, 'rev-parse', 'HEAD');
  setSetting(project.id, 'after_checks', 'release');
  finish(project.id, 1);
  await b.batchNote(project);
  await settle();
  assert.equal(branchAt(repo, 'release'), at);
  assert.ok(inbound(director.id).some((t) => /could not move branch release: release is the branch checked out/.test(t)));
});
