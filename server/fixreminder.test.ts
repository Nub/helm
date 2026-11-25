import { SCRATCH } from './testenv.ts';
// Fewer repeated errors: budgets stated up front (brevity.ts), knowledge for a builder's subagents (knowledge.ts) and
// the reminder to record a fix (fixreminder.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure, buildSystemPrompt } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const store = await import('./store.ts');
const kn = await import('./knowledge.ts');
const br = await import('./brevity.ts');
const fx = await import('./fixreminder.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { createTask } = await import('./tasks.ts');

function makeProject() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'fx', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const worker = runtime.createAgent(project, director, role, 'Engineer', 'Build it.');
  return { project, director, worker, structure, role };
}
const agentRow = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;

test('budgets are stated in tool descriptions, the prompt and after a send', async () => {
  const { project, director, worker } = makeProject();
  const sent: string[] = [];
  const rt = { spawn: async () => 'no', send: async (_to: string, text: string) => void sent.push(text), close: async () => {}, markComplete: () => {} };
  const st = JSON.parse(project.structure);
  const wTools = helmTools(worker.id, rt as any, toolAccess(st, worker.role_id, worker.parent_id));
  const dTools = helmTools(director.id, rt as any, toolAccess(st, director.role_id, director.parent_id));
  const desc = (tools: any[], name: string) => String(tools.find((t) => t.name === name)?.description ?? '');
  const report = `${br.BUDGETS.report.chars} characters and ${br.BUDGETS.report.lines} lines`;
  const reply = `${br.BUDGETS.reply.chars} characters and ${br.BUDGETS.reply.lines} lines`;
  for (const n of ['request_review', 'ask_manager', 'ask_user']) assert.ok(desc(wTools, n).includes(report), n);
  assert.ok(desc(dTools, 'task_post').includes(reply));
  const prompt = buildSystemPrompt(project, defaultStructure(), defaultStructure().roles.find((r) => r.id === worker.role_id)!, agentRow(worker.id), agentRow(director.id));
  assert.ok(prompt.includes(br.COUNT_RULE));
  const res: any = await wTools.find((t: any) => t.name === 'ask_manager').handler({ question: 'Which of the two?' }, {});
  assert.ok(!res.isError);
  assert.match(res.content[0].text, /Next one: under 600 characters and 8 lines\./);
  const t = createTask(project.id, { title: 'Thread', description: '', state: 'active', origin: 'user' }, { author: 'user', name: 'You' } as any);
  const post: any = await dTools.find((x: any) => x.name === 'task_post').handler({ task: t.id, message: 'Short.' }, {});
  assert.match(post.content[0].text, /Next one: under 500 characters/);
});

test('over-budget refusals are counted per day', async () => {
  const { worker } = makeProject();
  const before = br.refusalsByDay(worker.project_id);
  assert.equal(before.length, 0);
  store.addEvent(worker, 'tool_result', { id: 'x', error: true, text: 'Not sent: your question is 900 characters and 3 lines; the budget is 600 characters and 8 lines. Cut it.' });
  store.addEvent(worker, 'tool_result', { id: 'y', error: true, text: 'Some other error' });
  store.addEvent(worker, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: `${br.NOTE_TAG}Your report was not delivered</helm-note>` });
  const days = br.refusalsByDay(worker.project_id);
  assert.equal(days.length, 1);
  assert.equal(days[0].n, 2);
  assert.match(days[0].day, /^\d{4}-\d\d-\d\d$/);
});

test("a builder's subagent prompts carry the relevant knowledge notes, within the budget", () => {
  const { project, worker } = makeProject();
  kn.writeNote(project.id, kn.USER, { topic: 'Environment', title: 'No python3 on the host', text: 'python3 is not installed: use node for scripts.', paths: [] }, { agent: false });
  kn.writeNote(project.id, kn.USER, { topic: 'Build & run', title: 'Widget renderer build', text: 'The widget renderer builds with npm run build:widgets.', paths: ['web/widgets'] }, { agent: false });
  for (let i = 0; i < 40; i++) kn.writeNote(project.id, kn.USER, { topic: 'Pitfalls', title: `Unrelated pitfall ${i}`, text: `Some long unrelated fact number ${i} about the deploy pipeline and its queues.`, paths: [] }, { agent: false });
  const t = createTask(project.id, { title: 'Fix the widget renderer', description: 'The widget renderer build fails.', state: 'active', origin: 'user' }, { author: 'user', name: 'You' } as any);
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, worker.id);
  const defs = kn.withSubagentKnowledge({ light: { prompt: 'Brief.', model: 'x' }, skilled: { prompt: 'Brief.', model: 'y' } }, project.id, agentRow(worker.id));
  for (const d of Object.values(defs)) {
    assert.ok(d.prompt.startsWith('Brief.'));
    assert.ok(d.prompt.includes('Widget renderer build'), 'the note relevant to the task');
    assert.ok(d.prompt.length < 'Brief.'.length + kn.SUBAGENT_BUDGET + 200, 'within the budget');
  }
  assert.deepEqual(kn.withSubagentKnowledge({}, project.id, agentRow(worker.id)), {});
});

test('the fixed-error reminder: once per new error that was got past, never for Helm refusals, at most two per task', () => {
  const { worker } = makeProject();
  const w = agentRow(worker.id);
  const call = (id: string, name: string, error: boolean, text: string) => {
    store.addEvent(w, 'tool', { id, name, input: {} });
    store.addEvent(w, 'tool_result', { id, error, text });
  };
  // Helm's own refusal, then the same tool succeeds: no reminder.
  call('h1', 'mcp__helm__ask_manager', true, 'Not sent: your question is 900 characters and 3 lines; the budget is 600 characters and 8 lines.');
  call('h2', 'mcp__helm__ask_manager', false, 'Sent.');
  call('b0', 'Bash', true, 'PreToolUse:Bash hook error: Blocked: run it in the background');
  call('b0b', 'Bash', false, 'ok');
  assert.equal(fx.noteFixedErrors(worker.id), 0);
  // A new error not yet got past: nothing yet.
  call('b1', 'Bash', true, 'Exit code 127\nbash: python3: command not found');
  assert.equal(fx.noteFixedErrors(worker.id), 0);
  assert.equal(fx.takeFixReminder(worker.id), '');
  // Got past it: one reminder, on the next message only.
  call('b2', 'Bash', false, 'done');
  assert.equal(fx.noteFixedErrors(worker.id), 1);
  const note = fx.takeFixReminder(worker.id);
  assert.ok(note.includes(fx.FIX_TEXT) && note.includes('python3: command not found'), note);
  assert.equal(fx.takeFixReminder(worker.id), '');
  // The same error again and past again: not reminded twice.
  call('b3', 'Bash', true, 'bash: python3: command not found');
  call('b4', 'Bash', false, 'done');
  assert.equal(fx.noteFixedErrors(worker.id), 0);
  // Two more new errors got past: only one more (two per task).
  call('b5', 'Bash', true, 'error: cannot find module left-pad in the project');
  call('b6', 'Bash', true, 'fatal: unable to access the remote repository mirror');
  call('b7', 'Bash', false, 'done');
  assert.equal(fx.noteFixedErrors(worker.id), 1);
  assert.equal(fx.noteFixedErrors(worker.id), 0);
  assert.equal(Number(db.get('SELECT COUNT(*) AS n FROM fix_reminders WHERE agent_id = ?', worker.id)!.n), 2);
});
