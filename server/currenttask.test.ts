import { SCRATCH } from './testenv.ts';
// A standing agent taking task after task (tasks.ts followDriver), and the dashboard scope of a reused, rebased branch
// (tilescope.ts reflogBase). `node --test server/currenttask.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const scope = await import('./tilescope.ts');
const { registerArtifact } = await import('./diskusage.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
const rt = { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} };

function setup(path = SCRATCH) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'ct', path, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  // An agent of a retired area (not a builder: a builder has one task, dispatch.ts).
  const role = { id: 'engineer', name: 'Engineer', model: 'claude-opus-5-5', effort: '' as const, description: '', prompt: '', canSpawn: [] };
  const first = tasks.createTask(id, { title: 'First', state: 'active', origin: 'user' }, USER);
  const worker = runtime.createAgent(project, director, role, 'Standing engineer', 'Build it.');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', first.id, worker.id);
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', worker.id, first.id);
  const call = (agent: any) => {
    const tools = helmTools(agent.id, rt as any, toolAccess(structure, agent.role_id, agent.parent_id));
    return async (name: string, input: Record<string, unknown>) => {
      const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
      return { text: res.content[0].text as string, error: !!res.isError };
    };
  };
  return { project, director, worker, first, call };
}
const taskOf = (agentId: string) => db.get('SELECT task_id FROM agents WHERE id = ?', agentId)!.task_id;

test('made the driver of an Active task, a standing agent files its work under that task', async () => {
  const { project, director, worker, first, call } = setup();
  const second = tasks.createTask(project.id, { title: 'Second', state: 'active', origin: 'director' }, USER);
  // The director hands it the next task (the bug: everything stayed filed under the first).
  const res = await call(director)('update_task', { task: second.id, driver: worker.id });
  assert.ok(!res.error, res.text);
  assert.equal(taskOf(worker.id), second.id);
  const pv = await call(worker)('post_preview', { title: 'Shot', content: '# x' });
  assert.ok(!pv.error, pv.text);
  assert.equal(db.get('SELECT task_id FROM previews WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1', worker.id)!.task_id, second.id);
  // A scheduled task it drives follows it once it becomes Active, not before.
  const third = tasks.createTask(project.id, { title: 'Third', state: 'scheduled', origin: 'director' }, USER);
  await call(director)('update_task', { task: third.id, driver: worker.id });
  assert.equal(taskOf(worker.id), second.id);
  tasks.setTaskState(tasks.getTask(third.id)!, 'active', USER);
  assert.equal(taskOf(worker.id), third.id);
  // The director itself never takes a task this way.
  await call(director)('update_task', { task: first.id, driver: 'me' });
  assert.equal(taskOf(director.id), null);
});

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

test('scope: only the task\'s own commits, not what a rebase brought in or an earlier task on the same branch made', async () => {
  const repo = join(SCRATCH, 'ct-repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) write(repo, f, `${f}\n`);
  git(repo, 'add', '.');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, 'commit', '-qm', 'init'], { env: { ...process.env, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' } });
  const { project, worker, first } = setup(repo);
  const wt = join(SCRATCH, 'ct-wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'standing');
  assert.ok(!('error' in (await registerArtifact(project, worker.id, { path: wt, kind: 'worktree', disposable: false, branch: 'standing' }))));
  // First task: its commit, merged.
  write(wt, 'a.txt', 'first\n');
  git(wt, 'commit', '-qam', 'first task');
  assert.deepEqual((await scope.changedFiles(first)).files, ['a.txt']);
  git(repo, 'merge', '-q', '--ff-only', 'standing');
  // Second task on the same branch, later: an older commit would count for it without the start time.
  const second = tasks.createTask(project.id, { title: 'Second', state: 'active', origin: 'user' }, USER);
  db.run('UPDATE tasks SET driver_agent_id = ?, started_at = ? WHERE id = ?', worker.id, Date.now() + 120_000, second.id);
  // Meanwhile master moves on (another agent's work), and the branch is rebased on it.
  write(repo, 'c.txt', 'other agent\n');
  git(repo, 'commit', '-qam', 'other work');
  db.run('UPDATE tasks SET started_at = ? WHERE id = ?', Date.now() - 1000, second.id);
  write(wt, 'b.txt', 'second\n');
  git(wt, 'commit', '-qam', 'second task');
  git(wt, 'rebase', '-q', 'main');
  const c = await scope.changedFiles(tasks.getTask(second.id)!);
  assert.deepEqual(c.files, ['b.txt'], 'not c.txt (came in by rebase) nor a.txt (the first task)');
  // The reflog names the rebase target as the branch's base.
  assert.equal(await scope.reflogBase(wt, 'standing', git(wt, 'rev-parse', 'HEAD')), git(repo, 'rev-parse', 'main'));
});
