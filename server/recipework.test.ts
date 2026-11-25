import { SCRATCH } from './testenv.ts';
// The release recipe on the Releases page (recipework.ts, releaseapi.ts): the user's form with the tool's checks, the
// director's recipe as a card the user applies, changes or declines, and test builds only the user starts.
// `node --test server/recipework.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

void SCRATCH;
const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const agents = await import('./agents.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const rel = await import('./releases.ts');
const rw = await import('./recipework.ts');
const { registerReleaseApi } = await import('./releaseapi.ts');
const { ARTIFACT_DIR } = await import('./config.ts');
const PROJECTS = mkdtempSync(join(tmpdir(), `helm-test-recipe-${process.pid}-`));
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
  const repo = join(PROJECTS, `repo${++n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `recipe${n}`, repo, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = agents.rootAgent(project);
  return { project, repo, director, tools: toolsFor(director) };
}
function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const tools = helmTools(agent.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown> = {}) => {
    const t = tools.find((x: any) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const res: any = await t.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
}
async function api() {
  const app = Fastify();
  registerReleaseApi(app);
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as any });
  return { app, call };
}
const CLI = { name: 'CLI', command: 'make cli', cwd: '.', files: ['dist/cli'], duration: '2 min' };

test("the user's form: the tool's checks, and it takes effect for the next release", async () => {
  const { project } = setup();
  const { app, call } = await api();
  const url = `/api/projects/${project.id}/release-recipe`;
  const noFiles = await call('PUT', url, { artifacts: [{ name: 'CLI', command: 'make', cwd: '.' }] });
  assert.equal(noFiles.statusCode, 400);
  assert.match(noFiles.json().error, /files/);
  const secret = await call('PUT', url, { publish: 'gh release create with token=abcdef123456' });
  assert.match(secret.json().error, /credential/);
  const host = await call('PUT', url, { artifacts: [{ ...CLI, host: 'nowhere' }] });
  assert.match(host.json().error, /No host "nowhere"/);
  const twice = await call('PUT', url, { artifacts: [CLI, CLI] });
  assert.match(twice.json().error, /Two artifacts/);
  assert.equal(rel.getRecipe(project.id).artifacts.length, 0, 'nothing saved by a refused form');
  const ok = await call('PUT', url, { artifacts: [CLI], scheme: 'date' });
  assert.equal(ok.statusCode, 200, ok.body);
  const r = rel.getRecipe(project.id);
  assert.deepEqual([r.artifacts[0].name, r.scheme, r.updated_by], ['CLI', 'date', 'the user']);
  await app.close();
});

test("the director's recipe is a card the user applies, changes or declines; just_do_it only when the user asked", async () => {
  const { project, director, tools } = setup();
  sent.length = 0;
  const proposed = await tools('set_release_recipe', { artifacts: [CLI], rationale: 'One CLI binary per release' });
  assert.equal(proposed.error, false, proposed.text);
  assert.match(proposed.text, /Proposed/);
  assert.equal(rel.getRecipe(project.id).artifacts.length, 0, 'not saved by proposing');
  const p = rw.openProposal(project.id)!;
  assert.equal(p.recipe.artifacts[0].name, 'CLI');
  const d = rw.recipeDiscussion(project.id);
  assert.equal(p.discussion_id, d.id, 'the card is in the Release recipe discussion');
  assert.ok(db.get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND kind = 'recipe'", d.id));
  // A refused recipe is not proposed.
  assert.equal((await tools('set_release_recipe', { publish: 'token=abcdef123456' })).error, true);
  // Applied with the user's change.
  const { app, call } = await api();
  const applied = await call('POST', `/api/recipe-proposals/${p.id}/apply`, { recipe: { artifacts: [{ ...CLI, duration: '3 min' }] } });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(rel.getRecipe(project.id).artifacts[0].duration, '3 min');
  assert.equal(rel.getRecipe(project.id).updated_by, 'the user');
  assert.match(sent.at(-1)!.text, /applied your proposed release recipe with changes/);
  assert.equal((await call('POST', `/api/recipe-proposals/${p.id}/apply`, {})).statusCode, 409, 'once');
  // A newer proposal supersedes; declining leaves the recipe.
  await tools('set_release_recipe', { scheme: 'semver' });
  await tools('set_release_recipe', { scheme: 'date' });
  const latest = rw.openProposal(project.id)!;
  assert.equal(db.all("SELECT 1 FROM recipe_proposals WHERE project_id = ? AND status = 'superseded'", project.id).length, 1);
  assert.equal((await call('POST', `/api/recipe-proposals/${latest.id}/decline`, { note: 'keep semver' })).statusCode, 200);
  assert.equal(rel.getRecipe(project.id).scheme, 'semver');
  assert.match(sent.at(-1)!.text, /declined.*keep semver/);
  // just_do_it: refused without the user's message this turn, saved with it.
  const refused = await tools('set_release_recipe', { scheme: 'date', just_do_it: true });
  assert.equal(refused.error, true);
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)", project.id, director.id, db.now(), 'inbound', JSON.stringify({ from: { kind: 'user', name: 'You' }, text: 'Just set it to date versions.' }));
  const done = await tools('set_release_recipe', { scheme: 'date', just_do_it: true });
  assert.equal(done.error, false, done.text);
  assert.equal(rel.getRecipe(project.id).scheme, 'date');
  await app.close();
});

test('test build: only the user starts one; the report closes it with the file or the error', async () => {
  const { project, repo, tools } = setup();
  rel.saveRecipe(project.id, { artifacts: [CLI] }, 'the user');
  // No agent can report a test build the user did not start, and none can start one.
  assert.equal((await tools('report_test_build', { test: 'rt_nope', path: 'a.txt' })).error, true);
  assert.equal(helmTools(agents.rootAgent(project).id, {} as any, toolAccess(JSON.parse(project.structure), agents.rootAgent(project).role_id, null)).some((t: any) => /test_build/.test(t.name) && !['report_test_build', 'make_test_build'].includes(t.name)), false);
  const { app, call } = await api();
  const url = `/api/projects/${project.id}/release-recipe/test`;
  assert.equal((await call('POST', url, { artifact: 'Nope' })).statusCode, 400);
  sent.length = 0;
  const started = await call('POST', url, { artifact: 'CLI' });
  assert.equal(started.statusCode, 200, started.body);
  const id = started.json().id;
  // No note asks the director to build it: Helm made a Scheduled task for a builder (buildtask.ts).
  assert.ok(!sent.some((m) => /test build/.test(m.text)), 'the director is not asked to build');
  const made = db.get("SELECT * FROM tasks WHERE project_id = ? AND title = 'Test build: CLI'", project.id)!;
  assert.match(made.description, new RegExp(`test build \\[${id}\\].*report_test_build`, 's'));
  assert.equal((await call('POST', url, { artifact: 'CLI' })).json().existing, true, 'one at a time per artifact');
  // The file is checked as a release's is: outside the project is refused.
  const outside = join(PROJECTS, 'outside.bin');
  writeFileSync(outside, 'x');
  assert.match((await tools('report_test_build', { test: id, path: outside })).text, /outside the project/);
  mkdirSync(join(repo, 'dist'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'cli'), 'binary');
  const ok = await tools('report_test_build', { test: id, path: join(repo, 'dist', 'cli') });
  assert.equal(ok.error, false, ok.text);
  const view = rw.testsView(project.id).CLI;
  assert.equal(view.status, 'done');
  assert.equal(view.bytes, 6);
  assert.ok(existsSync(join(ARTIFACT_DIR, view.url.replace('/artifacts/', ''))));
  assert.equal((await tools('report_test_build', { test: id, path: join(repo, 'dist', 'cli') })).error, true, 'closed once reported');
  // A failure closes the next one with its error; the earlier file is kept until a newer one replaces it.
  const again = (await call('POST', url, { artifact: 'CLI' })).json().id;
  await tools('report_test_build', { test: again, error: 'make: *** No rule to make target cli' });
  assert.equal(rw.testsView(project.id).CLI.status, 'failed');
  assert.match(rw.testsView(project.id).CLI.error, /No rule/);
  await app.close();
});

test("the user's Test build tap makes a Scheduled task with its recipe, touches and check, and Helm starts Builder A on it", async () => {
  const { project } = setup();
  rel.saveRecipe(project.id, { artifacts: [CLI] }, 'the user');
  const { app, call } = await api();
  const started = await call('POST', `/api/projects/${project.id}/release-recipe/test`, { artifact: 'CLI' });
  assert.equal(started.statusCode, 200, started.body);
  const id = started.json().id;
  const t = db.get("SELECT * FROM tasks WHERE project_id = ? AND title = 'Test build: CLI'", project.id)!;
  assert.equal(t.state, 'scheduled');
  assert.equal(t.tier, 'skilled');
  assert.deepEqual(JSON.parse(t.touches), CLI.files);
  assert.match(t.check_how, new RegExp(`report_test_build with test "${id}"`));
  assert.match(t.description, /git worktree add --detach/);
  const { dispatchProject } = await import('./dispatch.ts');
  sent.length = 0;
  const [b] = await dispatchProject(project.id);
  assert.equal(b?.name, 'Builder A');
  assert.equal(b.task_id, t.id);
  assert.equal(db.get('SELECT state, driver_agent_id FROM tasks WHERE id = ?', t.id)!.state, 'active');
  assert.ok(sent.some((m) => m.to === b.id && m.text.includes(`report_test_build with test "${id}"`)), 'its brief carries the recipe and the report');
  await app.close();
});
