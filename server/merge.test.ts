import { SCRATCH } from './testenv.ts';
// Merging tasks that are the same work, the queue review and Consolidate tasks (merge.ts), and reports on tasks.
// `node --test server/merge.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const agents = await import('./agents.ts');
const tasks = await import('./tasks.ts');
const mg = await import('./merge.ts');
const { setWaits } = await import('./waits.ts');
const { createRequest } = await import('./requests.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

agents.bindAgentOps('test', { send: async () => {}, close: async () => {}, interrupt: async () => {}, restartForProjects: () => {}, resolvePermission: () => {}, liveAgentIds: () => new Set() });

const by = { author: 'director' as const, name: 'Director' };
function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'mg', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = agents.rootAgent(project);
  const src = db.newId('rs');
  db.run("INSERT INTO report_sources (id, project_id, type, name, created_at, updated_at) VALUES (?,?,'folder','notes',?,?)", src, id, db.now(), db.now());
  const report = (title: string, taskId: string | null = null) => {
    const r = db.newId('rp');
    db.run("INSERT INTO reports (id, project_id, source_id, external_id, title, status, task_id, changed_at, created_at, updated_at) VALUES (?,?,?,?,?,'new',?,?,?,?)", r, id, src, r, title, taskId, db.now(), db.now(), db.now());
    return r;
  };
  return { project, director, report };
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

test('merge_tasks moves reports, Spec links, requests, waits and history, and closes the others as merged', async () => {
  const { project, director, report } = setup();
  const keep = tasks.createTask(project.id, { title: 'Fix the save dialog', description: 'Keep this.', state: 'waiting', origin: 'director' }, by);
  const dupe = tasks.createTask(project.id, { title: 'Save dialog loses text', description: 'The other description.', state: 'scheduled', origin: 'director' }, by);
  const other = tasks.createTask(project.id, { title: 'Something before', description: '', state: 'waiting', origin: 'director' }, by);
  const after = tasks.createTask(project.id, { title: 'Something after', description: '', state: 'waiting', origin: 'director' }, by);
  const doc = db.newId('doc');
  db.run("INSERT INTO docs (id, project_id, kind, title, created_at, updated_at) VALUES (?,?,'entry','Saving',?,?)", doc, project.id, db.now(), db.now());
  db.run("INSERT INTO doc_links (doc_id, task_id, relation, created_at) VALUES (?,?,'implements',?)", doc, dupe.id, db.now());
  const r1 = report('Text gone after save', dupe.id);
  assert.equal(setWaits(dupe.id, [other.id]), null);
  assert.equal(setWaits(after.id, [dupe.id]), null);
  const { id: req } = createRequest({ projectId: project.id, agentId: director.id, kind: 'question', title: 'Which dialog?', body: 'x', importance: 3, blocking: false, task: dupe });
  tasks.addTaskMessage(dupe, { author: 'user', name: 'You' }, 'It happens every time.');

  const res = await toolsFor(director)('merge_tasks', { into: keep.id, from: [dupe.id], why: 'The same bug in the save dialog', title: 'Save dialog bug' });
  assert.equal(res.error, false, res.text);
  const merged = tasks.getTask(dupe.id)!;
  assert.deepEqual([merged.state, merged.merged_into], ['dropped', keep.id]);
  const kept = tasks.getTask(keep.id)!;
  assert.match(kept.description, /## Merged from "Save dialog loses text"\n\nThe other description\./);
  assert.equal(db.get('SELECT task_id FROM reports WHERE id = ?', r1)!.task_id, keep.id);
  assert.ok(db.get("SELECT 1 AS x FROM doc_links WHERE task_id = ? AND doc_id = ?", keep.id, doc));
  assert.equal(db.get('SELECT task_id FROM inbox WHERE id = ?', req)!.task_id, keep.id);
  assert.ok(db.get('SELECT 1 AS x FROM task_waits WHERE task_id = ? AND waits_for = ?', keep.id, other.id), 'waits what it waited for');
  assert.ok(db.get('SELECT 1 AS x FROM task_waits WHERE task_id = ? AND waits_for = ?', after.id, keep.id), 'what waited for it waits for the kept task');
  // A link to the merged task opens the kept one, with the merged history folded in it.
  const detail = tasks.taskDetail(dupe.id)!;
  assert.equal(detail.task.id, keep.id);
  const origin = detail.origins.find((o: any) => o.id === dupe.id) as any;
  assert.ok(origin?.merged && origin.timeline.some((i: any) => i.body === 'It happens every time.'));
  assert.equal(tasks.taskView(kept).report_count, 1);
  assert.match(tasks.renderTasks(project.id, { all: true }), new RegExp(`merged into \\[\\[${keep.id}\\]\\]`));
});

test('a running task, a done one and one with an agent at work are refused; nothing changes', () => {
  const { project, director } = setup();
  const a = tasks.createTask(project.id, { title: 'A', description: '', state: 'waiting', origin: 'director' }, by);
  const run = tasks.createTask(project.id, { title: 'B', description: '', state: 'active', origin: 'director' }, by);
  const busy = tasks.createTask(project.id, { title: 'C', description: '', state: 'paused', origin: 'director' }, by);
  db.run("UPDATE agents SET task_id = ?, status = 'working' WHERE id = ?", busy.id, director.id);
  assert.match((mg.mergeTasks(project.id, a.id, [run.id], 'x', by) as any).error, /active/);
  assert.match((mg.mergeTasks(project.id, a.id, [busy.id], 'x', by) as any).error, /running/);
  assert.match((mg.mergeTasks(project.id, run.id, [a.id], 'x', by) as any).error, /active/);
  assert.equal(tasks.getTask(a.id)!.state, 'waiting');
});

test('the queue review raises a pair once, not again within a day or after keep_apart', () => {
  const { project } = setup();
  const a = tasks.createTask(project.id, { title: 'Tidy the chat sheet', description: 'Spacing in web/src/chat.tsx', state: 'waiting', origin: 'director' }, by);
  const b = tasks.createTask(project.id, { title: 'Chat draft line', description: 'A draft line in web/src/chat.tsx', state: 'scheduled', origin: 'director' }, by);
  tasks.createTask(project.id, { title: 'Unrelated', description: 'server/hosts.ts', state: 'active', origin: 'director' }, by);
  const t0 = db.now();
  const note = mg.queueReviewNote(project.id, t0);
  assert.ok(note && note.includes(a.id) && note.includes(b.id) && /web\/src\/chat\.tsx/.test(note), note ?? 'no note');
  assert.equal(mg.queueReviewNote(project.id, t0 + 3600_000), null, 'once');
  assert.equal(mg.queueReviewNote(project.id, t0 + 2 * mg.REVIEW_EVERY_MS), null, 'same pairs: not again');
  assert.equal(mg.keepApart(project.id, b.id, a.id, 'Different screens of the chat'), null);
  // A new pair appears later; the kept-apart one is not in it.
  const c = tasks.createTask(project.id, { title: 'Hosts page', description: 'server/hosts.ts', state: 'waiting', origin: 'director' }, by);
  const d = tasks.createTask(project.id, { title: 'Host notes', description: 'server/hosts.ts', state: 'waiting', origin: 'director' }, by);
  const next = mg.queueReviewNote(project.id, t0 + 3 * mg.REVIEW_EVERY_MS)!;
  assert.ok(next.includes(c.id) && next.includes(d.id));
  assert.ok(!next.includes(a.id), 'kept apart');
});

test('reports: a task for reports names them all, and its summary reaches them when done', async () => {
  const { project, director, report } = setup();
  const r1 = report('Crash on save');
  const r2 = report('Save crashes on big files');
  const tool = toolsFor(director);
  const none = await tool('create_task', { title: 'Fix the save crash', description: 'x', state: 'waiting', origin: 'report' });
  assert.equal(none.error, true);
  const made = await tool('create_task', { title: 'Fix the save crash', description: 'x', state: 'waiting', origin: 'report', reports: [r1, r2] });
  assert.equal(made.error, false, made.text);
  const t = db.get("SELECT * FROM tasks WHERE project_id = ? AND title = 'Fix the save crash'", project.id)!;
  assert.equal(tasks.taskView(t).report_count, 2);
  db.run("UPDATE tasks SET status_summary = 'Saving large files no longer crashes.' WHERE id = ?", t.id);
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', { author: 'user', name: 'You' });
  assert.deepEqual(db.all('SELECT status, fix_note FROM reports WHERE task_id = ? ORDER BY id', t.id).map((r) => [r.status, r.fix_note]), [['fixed', 'Saving large files no longer crashes.'], ['fixed', 'Saving large files no longer crashes.']]);
});

test('Consolidate tasks: proposals are cards; applying merges, orders or makes one wait; the discussion settles', async () => {
  const { project, director } = setup();
  const a = tasks.createTask(project.id, { title: 'A', description: '', state: 'scheduled', origin: 'director' }, by);
  const b = tasks.createTask(project.id, { title: 'B', description: '', state: 'scheduled', origin: 'director' }, by);
  const c = tasks.createTask(project.id, { title: 'C', description: '', state: 'scheduled', origin: 'director' }, by);
  const x = tasks.createTask(project.id, { title: 'X', description: '', state: 'waiting', origin: 'director' }, by);
  const { d } = mg.consolidationDiscussion(project.id);
  assert.equal(mg.consolidationDiscussion(project.id).created, false, 'one open discussion');
  const tool = toolsFor(director);
  assert.equal((await tool('propose_consolidation', { discussion: d.id, kind: 'merge', tasks: [a.id, b.id], gain: '' })).error, true, 'a gain is required');
  for (const [kind, ids] of [['adjacent', [a.id, c.id]], ['wait', [x.id, c.id]], ['merge', [a.id, b.id]]] as const) {
    const r = await tool('propose_consolidation', { discussion: d.id, kind, tasks: ids, gain: 'one pass over the same files' });
    assert.equal(r.error, false, r.text);
  }
  const cards = db.all('SELECT * FROM consolidations WHERE discussion_id = ? ORDER BY rowid', d.id);
  assert.equal(cards.length, 3);
  assert.ok(!('error' in mg.applyConsolidation(cards[0])));
  const order = tasks.listTasks(project.id).map((t) => t.id);
  assert.equal(order.indexOf(c.id), order.indexOf(a.id) + 1, 'back to back');
  assert.ok(!('error' in mg.applyConsolidation(cards[1])));
  assert.ok(db.get('SELECT 1 AS x FROM task_waits WHERE task_id = ? AND waits_for = ?', x.id, c.id));
  assert.equal(tasks.getTask(d.id)!.state, 'open', 'still a card open');
  assert.equal(mg.declineConsolidation(cards[2]), null);
  const settled = tasks.getTask(d.id)!;
  assert.equal(settled.state, 'settled');
  assert.match(settled.conclusion, /back to back[\s\S]*waits for/);
  assert.equal(tasks.getTask(b.id)!.merged_into, null, 'declined: not merged');
});
