import { SCRATCH } from './testenv.ts';
// Checks run once (projectchecks.ts): the declaration, a full run stored against the commit (not run twice), a failure
// naming the first failing check and the tasks since the last good run, and the prompt lines.
// `node --test server/projectchecks.test.ts`.
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

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
let n = 0;
function setup() {
  const repo = join(SCRATCH, `pc${++n}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'pc', repo, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  return { project, repo, director: runtime.rootAgent(project) };
}
const ran: string[] = [];
let failing = '';
/** While set, runs wait for it: a run in progress. */
let gate: Promise<void> | null = null;
/** The real runner, kept before the stand-in replaces it. */
const realRun = pc.runCommand;
pc.setRunCommand(async (command) => {
  ran.push(command);
  if (gate) await gate;
  if (command === 'missing-tool') return { code: 127, output: 'bash: line 1: missing-tool: command not found\n' };
  return command === failing ? { code: 1, output: 'Error: 2 tests failed' } : { code: 0, output: 'ok' };
});
const finished = () => new Promise<any>((resolve) => setTimeout(resolve, 0)).then(() => new Promise((r) => setTimeout(r, 20)));

test('the declaration, and a full run kept against the commit: a checked commit is not run again', async () => {
  const { project, repo } = setup();
  assert.match((await pc.startChecks(project.id, () => {})).text, /no checks declared/);
  assert.match(pc.setChecks(project.id, { quick: [], full: [] , minutes: null })!, /at least one full check/);
  assert.equal(pc.setChecks(project.id, { quick: [{ name: 'typecheck', command: 'npm run typecheck' }], full: [{ name: 'typecheck', command: 'npm run typecheck' }, { name: 'tests', command: 'npm test' }, { name: 'split', command: 'npm run check:split' }], minutes: 12 }), null);
  ran.length = 0;
  let told: any = null;
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  const first = await pc.startChecks(project.id, (r) => (told = r));
  assert.ok(first.started);
  assert.match(first.text, /Started the full checks \(typecheck, tests, split\) on [0-9a-f]{7} in the background, about 12 min/);
  assert.match((await pc.startChecks(project.id, () => {})).text, /Checks are running on/, 'a run in progress is not started twice');
  gate = null;
  open();
  await finished();
  assert.equal(told.status, 'passed');
  assert.deepEqual(ran, ['npm run typecheck', 'npm test', 'npm run check:split']);
  const again = await pc.startChecks(project.id, () => {});
  assert.ok(!again.started);
  assert.match(again.text, /^Checks passed on [0-9a-f]{7} .* This commit was already checked; nothing was run\./);
  assert.equal(ran.length, 3);
  // A new commit is checked again.
  writeFileSync(join(repo, 'a.txt'), 'b\n');
  git(repo, 'commit', '-qam', 'two');
  assert.ok((await pc.startChecks(project.id, () => {})).started);
  await finished();
});

test('a failure names the first failing check (later ones not run) and the tasks finished since the last good run', async () => {
  const { project, repo } = setup();
  pc.setChecks(project.id, { quick: [], full: [{ name: 'typecheck', command: 'tc' }, { name: 'tests', command: 'tests' }, { name: 'split', command: 'split' }], minutes: null });
  await pc.startChecks(project.id, () => {});
  await finished();
  const t1 = tasks.createTask(project.id, { title: 'Since one', state: 'active', origin: 'user' }, tasks.USER);
  tasks.setTaskState(t1, 'done', tasks.USER);
  writeFileSync(join(repo, 'a.txt'), 'c\n');
  git(repo, 'commit', '-qam', 'three');
  failing = 'tests';
  ran.length = 0;
  let told: any = null;
  await pc.startChecks(project.id, (r) => (told = r));
  await finished();
  failing = '';
  assert.deepEqual(ran, ['tc', 'tests'], 'stops at the first failure');
  assert.equal(told.failed_check, 'tests');
  const line = pc.runLine(told);
  assert.match(line, /^Checks failed on [0-9a-f]{7} at "tests"/);
  assert.ok(line.includes(`[[${t1.id}]]`));
  assert.match(line, /2 tests failed/);
});

test('agents are told to run only their check and the quick ones; the director to run the full set once', () => {
  const { project, director } = setup();
  pc.setChecks(project.id, { quick: [{ name: 'typecheck', command: 'npm run typecheck' }], full: [{ name: 'tests', command: 'npm test' }], minutes: 5 });
  const s = JSON.parse(project.structure);
  const eng = runtime.createAgent(project, director, s.roles.find((r: any) => r.id === 'builder'), 'Engineer', 'x');
  const worker = structure.buildSystemPrompt(project, s, s.roles.find((r: any) => r.id === 'builder'), eng, director);
  assert.match(worker, /run only your task's named check and the quick checks \(`npm run typecheck`\)\. Never the full suite, and not again after a rebase unless it conflicted/);
  const boss = structure.buildSystemPrompt(project, s, s.roles[0], director, undefined);
  assert.match(boss, /once per merged batch with run_checks/);
});

test('the failure note names at most the 10 newest tasks since the last good run; with none ever, none', async () => {
  const { project, repo } = setup();
  pc.setChecks(project.id, { quick: [], full: [{ name: 'tests', command: 'tests' }], minutes: null });
  failing = 'tests';
  let told: any = null;
  await pc.startChecks(project.id, (r) => (told = r));
  await finished();
  assert.equal(told.status, 'failed');
  assert.match(pc.runLine(told), /No earlier run passed, so no tasks are named\./);
  assert.doesNotMatch(pc.runLine(told), /\[\[task_/);
  // A good run, then twelve tasks, then a failure.
  failing = '';
  writeFileSync(join(repo, 'a.txt'), 'p\n');
  git(repo, 'commit', '-qam', 'good');
  await pc.startChecks(project.id, () => {});
  await finished();
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) {
    const t = tasks.createTask(project.id, { title: `Since ${i}`, state: 'active', origin: 'user' }, tasks.USER);
    db.advanceClock(1000);
    tasks.setTaskState(t, 'done', tasks.USER);
    ids.push(t.id);
  }
  writeFileSync(join(repo, 'a.txt'), 'q\n');
  git(repo, 'commit', '-qam', 'bad');
  failing = 'tests';
  await pc.startChecks(project.id, (r) => (told = r));
  await finished();
  failing = '';
  const line = pc.runLine(told);
  assert.equal((line.match(/\[\[task_/g) ?? []).length, 10);
  assert.ok(line.includes(`[[${ids[11]}]], [[${ids[10]}]]`), 'newest first');
  assert.ok(!line.includes(ids[0]) && !line.includes(ids[1]));
  assert.match(line, /, and 2 earlier\./);
});

test('a command that cannot start is reported as "could not start", not as a failed check, and blames no task', async () => {
  const { project } = setup();
  pc.setChecks(project.id, { quick: [], full: [{ name: 'typecheck', command: 'missing-tool' }, { name: 'tests', command: 'tests' }], minutes: null });
  ran.length = 0;
  let told: any = null;
  await pc.startChecks(project.id, (r) => (told = r));
  await finished();
  assert.equal(told.status, 'unstartable');
  assert.deepEqual(ran, ['missing-tool']);
  const line = pc.runLine(told);
  assert.match(line, /^Checks could not start on [0-9a-f]{7}: "typecheck" did not run/);
  assert.doesNotMatch(line, /failed|\[\[task_/);
  assert.equal(pc.couldNotStart({ code: 127, output: '' }), true);
  assert.equal(pc.couldNotStart({ code: 1, output: 'Error: 2 tests failed' }), false);
});

test('checks run with the PATH agents get (not a login shell), without Helm\'s variables', async () => {
  const { repo } = setup();
  process.env.HELM_SECRET_PROBE = 'x';
  const r = await realRun('command -v node >/dev/null && echo "node ok"; echo "helm=${HELM_SECRET_PROBE:-none}"; pwd', repo);
  delete process.env.HELM_SECRET_PROBE;
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /node ok/);
  assert.match(r.output, /helm=none/);
  assert.ok(r.output.includes(repo));
  assert.equal((await realRun('no-such-command-xyz', repo)).code, 127);
});
