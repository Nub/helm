import { SCRATCH } from './testenv.ts';
// Spec adherence (specadherence.ts, Setup › Planning): Strict refuses scheduling or starting a task without a linked
// Spec entry and the builder skips one; Loose lets the director add a one-line entry and schedule; None checks nothing;
// quick_fix exempts only in Loose. `node --test server/specadherence.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const b = await import('./builder.ts');
const { setSetting, getChoice } = await import('./settings.ts');
const { recordOwnerActivity } = await import('./sessions.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { SKIPPED_NOTE, QUICK_FIX_NOTE } = await import('./specadherence.ts');

const USER = { author: 'user' as const, name: 'You' };

function setup(mode?: 'strict' | 'loose' | 'none') {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'sa', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  if (mode) assert.equal(setSetting(id, 'spec_adherence', mode), null);
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  recordOwnerActivity(id);
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const entry = async (title: string) => {
    const r = await call('set_doc', { title, summary: `${title} works.`, because: 'none' });
    assert.ok(!r.error, r.text);
    return /\[\[(doc_[0-9a-f]+)\]\]/.exec(r.text)![1];
  };
  const byTitle = (title: string) => db.get('SELECT * FROM tasks WHERE project_id = ? AND title = ?', id, title);
  return { project, director, call, entry, byTitle };
}

test('Loose is the default', () => {
  const { project } = setup();
  assert.equal(getChoice(project.id, 'spec_adherence'), 'loose');
});

test('Strict: scheduling or starting without a linked entry is refused, with what to do; with a link it goes', async () => {
  const { call, entry, byTitle } = setup('strict');
  const r = await call('create_task', { title: 'Add exports', description: 'x', state: 'scheduled', touches: ['src/a.ts'], check: 'npm test' });
  assert.equal(r.error, true);
  assert.match(r.text, /Strict/);
  assert.match(r.text, /propose_doc_edit/);
  assert.match(r.text, /change the Spec or redesign the task/);
  assert.equal(byTitle('Add exports'), undefined);
  // Waiting needs no link; scheduling it later does.
  const w = await call('create_task', { title: 'Add imports', description: 'x', state: 'waiting' });
  assert.ok(!w.error, w.text);
  const t = byTitle('Add imports')!;
  const up = await call('update_task', { task: t.id, state: 'scheduled', touches: ['src/a.ts'] });
  assert.equal(up.error, true);
  assert.match(up.text, /Strict/);
  assert.equal(tasks.getTask(t.id)!.state, 'waiting');
  // quick_fix does not exempt in Strict.
  const q = await call('create_task', { title: 'Fix a typo', description: 'x', state: 'scheduled', touches: ['src/a.ts'], quick_fix: true });
  assert.equal(q.error, true);
  assert.match(q.text, /quick_fix is not allowed/);
  // Linking the entry in the same call schedules it.
  const doc = await entry('Imports');
  const ok = await call('update_task', { task: t.id, state: 'scheduled', touches: ['src/a.ts'], doc });
  assert.ok(!ok.error, ok.text);
  // Scheduled, or already Active: Helm starts a fresh builder on scheduled work at once (dispatch.ts).
  assert.ok(['scheduled', 'active'].includes(tasks.getTask(t.id)!.state));
  const made = await call('create_task', { title: 'Add exports', description: 'x', state: 'scheduled', touches: ['src/a.ts'], docs: [doc] });
  assert.ok(!made.error, made.text);
});

test('Strict: the builder hand-off skips a Scheduled task with no link, with one thread line', async () => {
  const { project } = setup('strict');
  const unlinked = tasks.createTask(project.id, { title: 'Unlinked', state: 'scheduled', origin: 'user', description: 'x' } as any, USER);
  const doc = db.newId('doc');
  db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, created_at, updated_at) VALUES (?, ?, 'goal', 'E', 's', '', ?, ?)", doc, project.id, db.now(), db.now());
  const linked = tasks.createTask(project.id, { title: 'Linked', state: 'scheduled', origin: 'user', description: 'x', doc_id: doc } as any, USER);
  assert.equal(b.nextScheduled(project.id)?.id, linked.id);
  b.noteSkipped(project.id);
  b.noteSkipped(project.id);
  const lines = tasks.taskTimeline(unlinked.id).filter((i: any) => i.body === SKIPPED_NOTE);
  assert.equal(lines.length, 1);
  // In Loose the queue order holds.
  setSetting(project.id, 'spec_adherence', 'loose');
  assert.equal(b.nextScheduled(project.id)?.id, unlinked.id);
});

test('Loose: refused without a link; a one-line entry by the director in the same step, then scheduling, goes', async () => {
  const { call, entry, byTitle } = setup('loose');
  const r = await call('create_task', { title: 'Dark mode', description: 'x', state: 'scheduled', touches: ['src/a.ts'] });
  assert.equal(r.error, true);
  assert.match(r.text, /Loose/);
  assert.match(r.text, /one-line entry with set_doc/);
  const doc = await entry('Dark mode');
  const ok = await call('create_task', { title: 'Dark mode', description: 'x', state: 'scheduled', touches: ['src/a.ts'], doc });
  assert.ok(!ok.error, ok.text);
  assert.ok(['scheduled', 'active'].includes(byTitle('Dark mode')!.state));
});

test('quick_fix exempts only in Loose, and is remembered on the task', async () => {
  const { call, byTitle } = setup('loose');
  const q = await call('create_task', { title: 'Fix a typo', description: 'x', state: 'waiting', quick_fix: true });
  assert.ok(!q.error, q.text);
  const t = byTitle('Fix a typo')!;
  assert.ok(tasks.taskTimeline(t.id).some((i: any) => i.body === QUICK_FIX_NOTE));
  const up = await call('update_task', { task: t.id, state: 'scheduled', touches: ['src/a.ts'] });
  assert.ok(!up.error, up.text);
  // On update_task too, for a task the director did not create.
  const w = await call('create_task', { title: 'Tidy the footer', description: 'x', state: 'waiting' });
  assert.ok(!w.error);
  const f = byTitle('Tidy the footer')!;
  assert.equal((await call('update_task', { task: f.id, state: 'scheduled', touches: ['src/a.ts'] })).error, true);
  assert.ok(!(await call('update_task', { task: f.id, state: 'scheduled', touches: ['src/a.ts'], quick_fix: true })).error);
  // Strict refuses it (above); None needs nothing.
  const none = setup('none');
  const n = await none.call('create_task', { title: 'Anything', description: 'x', state: 'scheduled', touches: ['src/a.ts'] });
  assert.ok(!n.error, n.text);
  assert.ok(!tasks.taskTimeline(none.byTitle('Anything')!.id).some((i: any) => i.body === QUICK_FIX_NOTE));
});

test('None: no checks on create_task or update_task', async () => {
  const { call, byTitle } = setup('none');
  const w = await call('create_task', { title: 'Later', description: 'x', state: 'waiting' });
  assert.ok(!w.error);
  const up = await call('update_task', { task: byTitle('Later')!.id, state: 'scheduled', touches: ['src/a.ts'] });
  assert.ok(!up.error, up.text);
});

test('the director\'s planning line follows the mode', () => {
  assert.match(structure.specFirstLine('strict'), /Strict.*stops/);
  assert.match(structure.specFirstLine('loose'), /one-line entry with set_doc/);
  assert.match(structure.specFirstLine('loose'), /Spec first/);
  assert.match(structure.specFirstLine('none'), /purpose/);
  assert.doesNotMatch(structure.specFirstLine('none'), /Spec first/);
});
