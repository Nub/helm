import { SCRATCH } from './testenv.ts';
// Related past work (related.ts): what is chosen, the cap, nothing weak, once per task, create_task and the switch.
// `node --test server/related.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { addJournal } = await import('./store.ts');
const rel = await import('./related.ts');
const { setSetting } = await import('./settings.ts');
const { requestSearchRebuild, buildSearchIndexNow } = await import('./searchindex.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
requestSearchRebuild();
buildSearchIndexNow();

function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'rel', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const mk = (title: string, description: string, state = 'done', kind: 'task' | 'discussion' = 'task') =>
    tasks.createTask(id, { title, description, state, origin: 'user', ...(kind === 'discussion' ? { kind } : {}) } as any, USER);
  return { project, director, mk };
}

test('earlier tasks, decisions and concluded discussions like the task; never itself, nothing weak, at most five', async () => {
  const { project, mk } = setup();
  const earlier = mk('Parquet exporter writes the schema twice', 'The parquet exporter in export/parquet.ts flushes the schema on every batch.');
  const settled = mk('Parquet or CSV for the weekly export', 'Which format the analysts get.', 'settled', 'discussion');
  db.run("UPDATE tasks SET conclusion = 'Parquet: the exporter writes the schema once per file; CSV kept as an option.' WHERE id = ?", settled.id);
  const open = mk('Parquet exporter compression', 'Should the parquet exporter compress?', 'open', 'discussion');
  addJournal(project.id, null, 'decision', 'Parquet exporter flushes once per file', 'Flushing per batch doubled the schema.', earlier.id);
  addJournal(project.id, null, 'milestone', 'Parquet exporter merged', 'Exporter is live.', earlier.id);
  mk('Login page colours', 'Make the sign in page darker.');
  const now = mk('Parquet exporter schema flush', 'The parquet exporter in export/parquet.ts flushes the schema on every batch: once per file is enough.', 'active');
  const lines = rel.relatedLines(now);
  const text = lines.join('\n');
  assert.ok(text.includes(`[[${earlier.id}]] task`), text);
  assert.ok(text.includes(`[[${settled.id}]] discussion`) && text.includes('CSV kept as an option'), text);
  assert.ok(/decision, .*"Parquet exporter flushes once per file"/.test(text), text);
  assert.ok(!text.includes(`[[${now.id}]]`), 'never its own task');
  assert.ok(!text.includes(open.id), 'a discussion without a conclusion is not past work');
  assert.ok(!text.includes('merged'), 'milestones are not decisions');
  assert.ok(!text.includes('Login page'), 'nothing unrelated');
  // At most five.
  for (let i = 0; i < 8; i++) mk(`Parquet exporter schema batch ${i}`, 'The parquet exporter flushes the schema per batch.');
  assert.equal(rel.relatedLines(now).length, rel.RELATED_MAX);
  // Nothing strong: nothing at all.
  const lone = mk('Rotate the TLS certificate', 'Renew before it expires.', 'active');
  assert.deepEqual(rel.relatedLines(lone), []);
  assert.equal(rel.relatedBlock(lone), '');
});

test('a standing agent gets it once per task with its next message; a spawned one has it in its brief; the switch', () => {
  const { project, director, mk } = setup();
  mk('Ledger rounding on invoices', 'Invoices round each ledger line.');
  const t1 = mk('Ledger rounding drift', 'Ledger totals drift from invoices after rounding.', 'active');
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const a = runtime.createAgent(project, director, role, 'Ledger engineer', 'Fix it.');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t1.id, a.id);
  rel.markRelatedGiven(a.id, t1.id);
  assert.equal(rel.relatedNote(a.id), '', 'given with its brief already');
  // Made the driver of its next task: told once, with its next message.
  const t2 = mk('Ledger export rounding', 'Rounding of ledger lines in the export, like the invoices.', 'active');
  tasks.followDriver((db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', a.id, t2.id), t2.id));
  const note = rel.relatedNote(a.id);
  assert.match(note, new RegExp(`^\\n<helm-note kind="related">You are now on \\[\\[${t2.id}\\]\\]\\. Related past work`));
  assert.ok(note.includes(t1.id));
  assert.equal(rel.relatedNote(a.id), '', 'once');
  // Off: nothing.
  setSetting(project.id, 'related_work', false);
  assert.equal(rel.relatedBlock(t2), '');
});

test('create_task shows the director the related work', async () => {
  const { project, director, mk } = setup();
  const prior = mk('Kestrel sync retries', 'Kestrel sync retries forever on a timeout.');
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(project.structure), director.role_id, null));
  const create = (description: string): Promise<any> => tools.find((x: any) => x.name === 'create_task')!.handler({ title: 'Kestrel sync timeout', description, state: 'planning' }, {});
  // A description that names no related work is refused with what Helm found (gates.ts relatedGate).
  const refused = await create('Kestrel sync gives up too late after a timeout; retries.');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, new RegExp(`\\[\\[${prior.id}\\]\\]`));
  const res = await create(`Kestrel sync gives up too late after a timeout; retries. Follows [[${prior.id}]].`);
  const text = res.content[0].text as string;
  assert.ok(!res.isError, text);
  assert.match(text, new RegExp(`Related past work \\(check for overlap\\):\\n- \\[\\[${prior.id}\\]\\] task`));
});
