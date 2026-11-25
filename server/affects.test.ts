import { SCRATCH } from './testenv.ts';
// New work that may affect running tasks (affects.ts): each rule (Spec entry, files, similar), the cap, telling the
// agent or acknowledging, the one note more, and the switch. `node --test server/affects.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const aff = await import('./affects.ts');
const { setSetting } = await import('./settings.ts');
const { registerArtifact } = await import('./diskusage.ts');
const { requestSearchRebuild, buildSearchIndexNow } = await import('./searchindex.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
requestSearchRebuild();
buildSearchIndexNow();
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-C', dir, ...args], { encoding: 'utf8' }).trim();

let n = 0;
function setup(path = SCRATCH) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `af${++n}`, path, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const running = (title: string, description = '') => {
    const t = tasks.createTask(id, { title, description, state: 'active', origin: 'user' } as any, USER);
    const a = runtime.createAgent(project, director, role, `${title} engineer`, 'Build it.');
    db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, a.id);
    db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', a.id, t.id);
    return { task: tasks.getTask(t.id)!, agent: db.get('SELECT * FROM agents WHERE id = ?', a.id)! };
  };
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(structure, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  return { project, director, running, call };
}
const docId = (projectId: string) => {
  const d = db.newId('doc');
  db.run("INSERT INTO docs (id, project_id, kind, title, body, created_at, updated_at) VALUES (?, ?, 'goal', 'Exporter', '', ?, ?)", d, projectId, db.now(), db.now());
  return d;
};
const thread = (taskId: string) => db.all("SELECT body FROM task_messages WHERE task_id = ? AND author = 'system'", taskId).map((m) => m.body).join('\n');

test('paths a description names', () => {
  assert.deepEqual(aff.namedPaths('Change `server/tools.ts` and web/src/ plus styles.css, see https://x.org/a.'), ['server/tools.ts', 'web/src/', 'styles.css']);
});

test('the same Spec entry: listed with create_task, told by message_agent, one line in both threads', async () => {
  const { project, running, call } = setup();
  const doc = docId(project.id);
  const b = running('Exporter speed');
  db.run("INSERT INTO doc_links (doc_id, task_id, relation, created_at) VALUES (?, ?, 'implements', ?)", doc, b.task.id, db.now());
  running('Login colours');
  const res = await call('create_task', { title: 'Exporter format option', description: 'Add a format flag.', state: 'planning', doc });
  assert.match(res.text, new RegExp(`May affect running work:\\n- \\[\\[${b.task.id}\\]\\] \\(Exporter speed engineer, shares Spec entry \\[\\[${doc}\\]\\]\\)`));
  assert.ok(!res.text.includes('Login colours'));
  const t = db.get("SELECT id FROM tasks WHERE title = 'Exporter format option'")!.id;
  // A message that does not name the new task (answering its review, say) does not count.
  await call('message_agent', { agent: b.agent.id, message: 'Looks good, carry on.' });
  assert.equal(db.get('SELECT answered_at FROM affect_pairs WHERE task_id = ? AND affected_id = ?', t, b.task.id)!.answered_at, null);
  assert.match(res.text, new RegExp(`naming \\[\\[${t}\\]\\] in the message`));
  await call('message_agent', { agent: b.agent.id, message: `A format flag is coming (${t}); keep the writer generic.` });
  const pair = db.get('SELECT * FROM affect_pairs WHERE task_id = ? AND affected_id = ?', t, b.task.id)!;
  assert.equal(pair.how, 'told');
  for (const id of [t, b.task.id]) assert.match(thread(id), new RegExp(`Told Exporter speed engineer about \\[\\[${t}\\]\\]`));
  // Answered: not listed again when the task changes.
  const again = await call('update_task', { task: t, description: 'Add a format flag, parquet first.' });
  assert.ok(!again.text.includes('May affect running work'));
});

test('the same files: a path the new task names against what the running task changed in its worktree', async () => {
  const repo = join(SCRATCH, 'af-repo');
  mkdirSync(join(repo, 'server'), { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'server/tools.ts'), 'a\n');
  writeFileSync(join(repo, 'README.md'), 'r\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const { project, running, call } = setup(repo);
  const b = running('Quota warnings');
  const wt = join(SCRATCH, 'af-wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'quota');
  assert.ok(!('error' in (await registerArtifact(project, b.agent.id, { path: wt, kind: 'worktree', disposable: false, branch: 'quota' }))));
  db.run('UPDATE tasks SET started_at = ? WHERE id = ?', db.now() - 60_000, b.task.id);
  writeFileSync(join(wt, 'server/tools.ts'), 'changed\n');
  git(wt, 'commit', '-qam', 'quota');
  const res = await call('create_task', { title: 'Rename a tool', description: 'Rename list_hosts in `server/tools.ts`.', state: 'planning' });
  assert.match(res.text, new RegExp(`\\[\\[${b.task.id}\\]\\] \\(Quota warnings engineer, both touch server/tools.ts\\)`));
});

test('similar work by search; at most five; affects_ack; the note once more, never a third time; the switch', async () => {
  const { project, director, running, call } = setup();
  const many = Array.from({ length: 7 }, (_, i) => running(`Kestrel sync retry ${i}`, 'Kestrel sync retries after a timeout.'));
  const res = await call('create_task', { title: 'Kestrel sync timeout', description: 'Kestrel sync retries too long after a timeout. Related past work: the running retry tasks.', state: 'planning' });
  const listed = [...res.text.matchAll(/^- \[\[(task_[0-9a-f]+)\]\] \(.*, similar\)$/gm)].map((m) => m[1]);
  assert.equal(listed.length, aff.AFFECTS_MAX);
  const t = db.get("SELECT id FROM tasks WHERE title = 'Kestrel sync timeout'")!.id;
  // One acknowledged with a reason.
  const ack = await call('affects_ack', { task: t, affected: listed[0], reason: 'It only touches the docs.' });
  assert.ok(!ack.error, ack.text);
  assert.match(thread(listed[0]), /Not passed on to .* It only touches the docs\./);
  // The turn ends: the rest are put to the director once more, then never again.
  const note = aff.affectsNote(director)!;
  assert.match(note, /^<helm-note kind="affects">Not yet passed on:/);
  assert.match(note, /naming the new task/);
  assert.equal((note.match(/may affect/g) ?? []).length, aff.AFFECTS_MAX - 1);
  assert.ok(!note.includes(listed[0]));
  assert.equal(aff.affectsNote(director), null);
  void many;
  // Off: nothing listed.
  setSetting(project.id, 'affected_work', false);
  const off = await call('create_task', { title: 'Kestrel sync backoff', description: 'Kestrel sync retries with backoff after a timeout. Related past work: none found.', state: 'planning' });
  assert.ok(!off.text.includes('May affect running work'));
});
