import { SCRATCH } from './testenv.ts';
// A task's Status shows only what belongs to it (task_aeff7900b5): a builder with two tasks in hand keeps a worklist
// per task (worklist_set/update take the task), and each task's view carries only its own worklist, status line,
// current tool and subagents. `node --test server/worklisttask.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const sub = await import('./subagents.ts');
const { addEvent } = await import('./store.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };

/** A task the standing Builder held alongside its own before fresh builders (take_task is gone; dispatch.ts sends it back to the queue). */
function takeAlongside(builderId: string, taskId: string) {
  db.run("UPDATE tasks SET state = 'active', driver_agent_id = ?, started_at = ? WHERE id = ?", builderId, db.now(), taskId);
}

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'wl', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const tools = helmTools(builder.id, { send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, 'builder', director.role_id));
  const call = async (n: string, input: Record<string, unknown>) => {
    const r: any = await tools.find((x: any) => x.name === n)!.handler(input, {});
    return { text: r.content[0].text as string, error: !!r.isError };
  };
  return { id, builder, call };
}

test('two tasks in a builder\'s hand: each shows only its own worklist, status line and activity', async () => {
  const { id, builder, call } = setup();
  const own = tasks.createTask(id, { title: 'Own work', state: 'active', origin: 'director', description: 'Edit src/own.ts.', driver_agent_id: builder.id } as any, USER);
  const other = tasks.createTask(id, { title: 'Alongside', state: 'scheduled', origin: 'director', description: 'Edit src/other.ts.' } as any, USER);
  takeAlongside(builder.id, other.id);
  db.run("UPDATE agents SET status = 'working', status_line = 'Editing src/own.ts' WHERE id = ?", builder.id);

  // The default is the task in hand; the other is named.
  assert.equal((await call('worklist_set', { items: [{ text: 'Own step one', state: 'doing' }, { text: 'Own step two' }] })).error, false);
  const set2 = await call('worklist_set', { task: other.id, items: [{ text: 'Merge the subagent branch' }] });
  assert.equal(set2.error, false, set2.text);
  assert.match(set2.text, /Merge the subagent branch/);
  assert.doesNotMatch(set2.text, /Own step/);
  assert.equal((await call('worklist_update', { task: other.id, updates: [{ item: 1, state: 'done' }] })).error, false);
  // Updating one leaves the other alone.
  assert.equal((await call('worklist_update', { updates: [{ item: 2, state: 'doing' }] })).error, false);

  // A subagent on the other task, mid-command.
  sub.agentCallCheck(db.get('SELECT * FROM agents WHERE id = ?', builder.id)!, 'tw9', { subagent_type: 'skilled', description: `${other.id}: build it`, prompt: 'p', isolation: 'worktree' });
  const subRow = sub.subagentFor('tw9')!;
  // A subagent is booked to its builder's own task now; one of the standing Builder's, on a task held alongside, stays there.
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', other.id, subRow.id);
  sub.subagentEvent('tw9', 'tool', { id: 'toolu_x', name: 'Bash', summary: 'npm test' });
  // The builder itself is mid-command on its own task.
  addEvent(db.get('SELECT * FROM agents WHERE id = ?', builder.id)!, 'tool', { id: 'toolu_own', name: 'Bash', summary: 'npm run typecheck' });

  const ownView = tasks.taskDetail(own.id)!;
  const b1 = ownView.agents.find((a: any) => a.id === builder.id)!;
  assert.deepEqual(b1.checklist.map((i: any) => i.text), ['Own step one', 'Own step two']);
  // Its line is derived from its current command (busy.ts toolLine), as no report_status came after it started.
  assert.match(b1.status_line, /^Check the code \(typecheck\) · /);
  assert.equal(b1.current_tool?.summary, 'npm run typecheck');
  assert.ok(!ownView.agents.some((a: any) => a.id === subRow.id), 'the other task\'s subagent is not on this one');

  const otherView = tasks.taskDetail(other.id)!;
  const b2 = otherView.agents.find((a: any) => a.id === builder.id)!;
  assert.deepEqual(b2.checklist.map((i: any) => [i.text, i.state]), [['Merge the subagent branch', 'done']]);
  assert.match(b2.status_line, /^Waiting on subagent: /, "its subagent on that task, not its own task's line");
  assert.equal(b2.current_tool, null);
  assert.equal(b2.progress, 100);
  const s2 = otherView.agents.find((a: any) => a.id === subRow.id)!;
  assert.equal(s2.current_tool?.summary, 'npm test');

  // The rows on Work: each task's driver carries that task's worklist.
  assert.deepEqual(tasks.taskView(tasks.getTask(other.id)!).driver.checklist.map((i: any) => i.text), ['Merge the subagent branch']);
  assert.deepEqual(tasks.taskView(tasks.getTask(own.id)!).driver.checklist.map((i: any) => i.text), ['Own step one', 'Own step two']);

  // A task the builder does not drive is refused.
  const stranger = tasks.createTask(id, { title: 'Not mine', state: 'waiting', origin: 'director' } as any, USER);
  assert.match((await call('worklist_set', { task: stranger.id, items: [{ text: 'x' }] })).text, /You do not drive/);
});
