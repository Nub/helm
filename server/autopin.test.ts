import { SCRATCH } from './testenv.ts';
// The automatic "For review" pin (pins.ts autoPin): bursts, replacement, precedence over it, hand pins, unpinning
// and the migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const store = await import('./store.ts');
const tasks = await import('./tasks.ts');
const pins = await import('./pins.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'ap', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const a = runtime.createAgent(project, director, role, 'Engineer A', 'Build it.');
  const b = runtime.createAgent(project, director, role, 'Engineer B', 'Build it too.');
  const task = tasks.createTask(project.id, { title: 'Work', state: 'active', origin: 'director' }, USER);
  return { project, director, a, b, task };
}

/** Post a preview as `agent` on `task` (minutes ago, if given) and apply the rule, as post_preview does. */
function post(project: any, agent: any, task: any, title: string, minutesAgo = 0) {
  const res = store.addPreview(project, agent?.id ?? null, { title, content: `# ${title}`, task_id: task.id }) as { id: string };
  if (minutesAgo) db.run('UPDATE previews SET created_at = ? WHERE id = ?', db.now() - minutesAgo * 60_000, res.id);
  pins.autoPin(res.id);
  return res.id;
}
const nextTurn = (agent: any) => db.run('UPDATE agents SET turns = turns + 1 WHERE id = ?', agent.id);
const review = (taskId: string) => (pins.reviewView(taskId)?.items ?? []).map((i: any) => i.label);

test('a burst is the newest previews within the window, oldest first, capped at six', () => {
  const { project, a, task } = setup();
  for (let i = 1; i <= 3; i++) post(project, a, task, `P${i}`);
  assert.deepEqual(review(task.id), ['P1', 'P2', 'P3']);
  for (let i = 4; i <= 8; i++) post(project, a, task, `P${i}`);
  assert.deepEqual(review(task.id), ['P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
});

test('cause: several agents in one burst were split; now one set', () => {
  const { project, a, b, task } = setup();
  post(project, a, task, 'A1', 4);
  post(project, b, task, 'B1');
  assert.deepEqual(review(task.id), ['A1', 'B1']);
});

test('cause: one agent across turns within minutes was split; now one set', () => {
  const { project, a, task } = setup();
  post(project, a, task, 'Turn 1', 3);
  nextTurn(a);
  post(project, a, task, 'Turn 2');
  assert.deepEqual(review(task.id), ['Turn 1', 'Turn 2']);
});

test('a burst after a quiet gap replaces the set entirely', () => {
  const { project, a, b, task } = setup();
  post(project, a, task, 'Old 1', 60);
  post(project, a, task, 'Old 2', 58);
  assert.deepEqual(review(task.id), ['Old 1', 'Old 2']);
  post(project, b, task, 'New');
  assert.deepEqual(review(task.id), ['New']);
  const stale = db.all("SELECT unpinned_by FROM pins WHERE task_id = ? AND auto = 1 AND unpinned_at IS NOT NULL", task.id).map((r) => r.unpinned_by);
  assert.deepEqual(stale, ['helm', 'helm']);
});

test('cause: stale proposal rounds stayed pinned; an open question is the one exception, shown apart', () => {
  const { project, a, director, task } = setup();
  // A decided round and a round with no question, both from before the new burst: unpinned by it.
  const d1 = post(project, director, task, 'Decided option', 90);
  pins.pinItems(task, [{ id: d1, label: 'P1' }], { author: 'director', name: director.name, id: director.id }, 1);
  db.run('UPDATE pins SET pinned_at = ? WHERE preview_id = ?', db.now() - 90 * 60_000, d1);
  assert.equal(pins.choose(task, 1, d1, ''), null);
  const q = post(project, director, task, 'Waiting option', 80);
  pins.pinItems(task, [{ id: q, label: 'P2' }], { author: 'director', name: director.name, id: director.id }, 2);
  db.run('UPDATE pins SET pinned_at = ? WHERE preview_id = ?', db.now() - 80 * 60_000, q);
  pins.setQuestion(task, 2, 'Which one?');
  post(project, a, task, 'Fresh screenshot');
  const prop = pins.proposalView(task.id)!;
  assert.equal(prop.round, 2, 'the open question stays the proposal');
  assert.deepEqual(prop.items.map((i: any) => i.label), ['P2']);
  assert.deepEqual(prop.earlier, [], 'the decided round was unpinned');
  assert.deepEqual(review(task.id), ['Fresh screenshot'], 'For review is apart from the proposal');
  // Once decided, the next burst clears it too.
  assert.equal(pins.choose(task, 2, q, ''), null);
  post(project, a, task, 'Next screenshot');
  assert.equal(pins.proposalView(task.id)?.items.length ?? 0, 0);
});

test('a director pinning options and asking in the same burst keeps them', () => {
  const { project, director, task } = setup();
  const o = post(project, director, task, 'Option A');
  pins.pinItems(task, [{ id: o, label: 'A' }], { author: 'director', name: director.name, id: director.id });
  post(project, director, task, 'Option B');
  assert.deepEqual(pins.proposalView(task.id)!.items.map((i: any) => i.label), ['A']);
});

test('an item the user unpinned stays off until a newer burst', () => {
  const { project, a, task } = setup();
  post(project, a, task, 'One');
  post(project, a, task, 'Two');
  const two = pins.reviewView(task.id)!.items.find((i: any) => i.label === 'Two');
  assert.ok(!('error' in pins.unpin(task, [String(two.pin_id)], USER)));
  assert.deepEqual(review(task.id), ['One']);
  post(project, a, task, 'Three');
  assert.deepEqual(review(task.id), ['One', 'Three']);
  db.run('UPDATE previews SET created_at = created_at - ? WHERE task_id = ?', 60 * 60_000, task.id);
  post(project, a, task, 'Four');
  assert.deepEqual(review(task.id), ['Four']);
});

test('cause: previews with no agent (the API) and on Done tasks are pinned by the same rule', () => {
  const { project, task } = setup();
  const done = tasks.createTask(project.id, { title: 'Finished', state: 'done', origin: 'director' }, USER);
  post(project, null, task, 'From the API');
  post(project, null, done, 'After done');
  assert.deepEqual(review(task.id), ['From the API']);
  assert.deepEqual(review(done.id), ['After done']);
});

test('post_preview on a task: the Previews section shows it, so no For review line; the auto pin still feeds the row thumbnails', async () => {
  const { project, a, task } = setup();
  const tools = helmTools(a.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(project.structure), a.role_id, a.parent_id));
  const t = tools.find((x: any) => x.name === 'post_preview')!;
  const res: any = await t.handler({ title: 'Result', content: 'done', task: task.id }, {});
  assert.doesNotMatch(res.content[0].text, /For review/);
  assert.match(res.content[0].text, /^Preview posted: \[\[pv_/);
  assert.deepEqual(review(task.id), ['Result']);
});

test('cause: tasks never backfilled (closed, or before the rule): the repair sets every task once; nothing is left over', () => {
  const { project, a, b, task } = setup();
  const done = tasks.createTask(project.id, { title: 'Finished', state: 'done', origin: 'director' }, USER);
  const ins = (t: any, agent: any, title: string, at: number) =>
    db.run("INSERT INTO previews (id, project_id, agent_id, kind, title, created_at, task_id) VALUES (?,?,?,'markdown',?,?,?)", db.newId('pv'), project.id, agent.id, title, at, t.id);
  const t0 = db.now() - 60 * 60 * 1000;
  ins(task, b, 'Old', t0);
  ins(task, a, 'First', t0 + 30 * 60 * 1000);
  ins(task, b, 'Second', t0 + 31 * 60 * 1000);
  ins(done, a, 'Closed early', t0);
  ins(done, a, 'Closed last', t0 + 40 * 60 * 1000);
  assert.ok(pins.reviewMismatches(project.id).length >= 2);
  pins.repairReviewPins();
  assert.deepEqual(review(task.id), ['First', 'Second']);
  assert.deepEqual(review(done.id), ['Closed last']);
  assert.deepEqual(pins.reviewMismatches(project.id), []);
  const count = () => db.get('SELECT COUNT(*) AS n FROM pins WHERE auto = 1')!.n;
  const before = count();
  assert.equal(pins.repairReviewPins(), 0, 'once per project');
  assert.equal(count(), before);
});
