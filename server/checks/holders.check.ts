/**
 * Checks for request holders (requests.ts): an agent's standing "Requests from …" holder and the old Inbox archive are
 * not discussions, holders settle when nothing is pending and reopen with the next request. (spawn_agent is gone: Helm starts
 * builders on their task, dispatch.ts.) Run: npm run check:holders.
 */
import '../testenv.ts';
import assert from 'node:assert/strict';

const { now, run, get } = await import('../db.ts');
const T = await import('../tasks.ts');
const R = await import('../requests.ts');
const Dz = await import('../discussions.ts');
const { findInProject } = await import('../search.ts');
const { touchProject } = await import('../store.ts');
const { defaultStructure } = await import('../structure.ts');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err: any) {
    console.log(`FAIL ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}

const pid = 'pr_hold';
run('INSERT INTO projects (id, name, path, structure, created_at, updated_at, sessions_backfilled) VALUES (?,?,?,?,?,?,1)', pid, 'Hold', '/tmp', JSON.stringify(defaultStructure()), now(), now());
const agent = (id: string, name: string, role = 'director', parent: string | null = null, task: string | null = null) =>
  run('INSERT INTO agents (id, project_id, parent_id, role_id, name, model, status, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, pid, parent, role, name, 'x', 'idle', task, now(), now());
agent('ag_dir', 'Director');
// A builder (dispatch.ts).
const workerRole = defaultStructure().roles.find((r: any) => r.id === 'builder')!;
agent('ag_w', 'Top bar engineer', workerRole.id, 'ag_dir');

const listed = () => Dz.listDiscussions(pid).map((d) => d.title);
let holderId = '';

await check('a permission from an agent with no task lands in its holder, which is not listed among discussions', () => {
  const { home } = R.createRequest({ projectId: pid, agentId: 'ag_w', kind: 'permission', title: 'Bash', body: '', importance: 3, blocking: true });
  holderId = home.id;
  assert.equal(home.requests_agent_id, 'ag_w');
  assert.ok(!listed().includes('Requests from Top bar engineer'));
  assert.deepEqual(Dz.listDiscussions(pid, { q: 'Requests' }).map((d) => d.id), []);
  assert.ok(!findInProject(pid, 'Requests from', 'discussion').length);
  // It is under Needs you, with the agent's name and what it does.
  const holders = Dz.requestHolders(pid);
  assert.equal(holders.length, 1);
  assert.equal(holders[0].holder.agent_name, 'Top bar engineer');
  assert.match(holders[0].holder.context, /no task$/);
  assert.equal(R.needingResponse((t) => Dz.discussionView(t), pid).count, 1);
});

await check('answering its last request settles the holder; the next request reopens the same one', () => {
  const req = get("SELECT id FROM inbox WHERE task_id = ? AND status = 'open'", holderId)!;
  run("UPDATE inbox SET status = 'answered', answer = 'Allow', answered_at = ? WHERE id = ?", now(), req.id);
  touchProject(pid);
  assert.equal(T.getTask(holderId)!.state, 'settled');
  assert.equal(Dz.requestHolders(pid).length, 0);
  const { home } = R.createRequest({ projectId: pid, agentId: 'ag_w', kind: 'permission', title: 'Edit', body: '', importance: 3, blocking: true });
  assert.equal(home.id, holderId);
  assert.equal(T.getTask(holderId)!.state, 'open');
  // A request waiting on the director (Director first) keeps it open too.
  run("UPDATE inbox SET status = 'director' WHERE task_id = ? AND status = 'open'", holderId);
  touchProject(pid);
  assert.equal(T.getTask(holderId)!.state, 'open');
  run("UPDATE inbox SET status = 'answered' WHERE task_id = ?", holderId);
});

await check('the startup step settles idle holders and is idempotent', () => {
  run("UPDATE tasks SET state = 'open' WHERE id = ?", holderId);
  assert.equal(R.settleIdleHolders(), 1);
  assert.equal(R.settleIdleHolders(), 0);
  assert.equal(T.getTask(holderId)!.state, 'settled');
});

await check('the old Inbox archive is not listed among discussions', () => {
  const d = T.createTask(pid, { title: 'Earlier requests (from the Inbox)', state: 'settled', origin: 'director', kind: 'discussion' }, { author: 'system', name: 'Helm' });
  run('UPDATE tasks SET inbox_archive = 1 WHERE id = ?', d.id);
  assert.ok(!listed().includes('Earlier requests (from the Inbox)'));
});

await check("a task-less question from the director still starts a real discussion", () => {
  const { home } = R.createRequest({ projectId: pid, agentId: 'ag_dir', kind: 'question', title: 'Should Helm support Gemini?', body: '', importance: 3, blocking: false });
  assert.equal(home.kind, 'discussion');
  assert.equal(home.requests_agent_id, null);
  assert.ok(listed().includes('Should Helm support Gemini?'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}.`);
