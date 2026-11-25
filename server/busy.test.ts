import { SCRATCH } from './testenv.ts';
// An agent with work in hand never shows Idle (busy.ts): between turns, a background command, a host claim, an open
// subagent, a question it asked or an Active task it drives keep it Working, with the reason; with none it is idle.
// The agent views and the agent limit agree. `node --test server/busy.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
await import('./commands.ts'); // creates running_commands
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { busyReason } = await import('./busy.ts');
const { agentView, projectSummaries } = await import('./store.ts');
const { workingAgents } = await import('./subagents.ts');

const USER = { author: 'user' as const, name: 'You' };

test('between turns, work in hand keeps an agent Working with the reason; nothing in hand is idle', () => {
  const pid = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'busy', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', pid)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  db.run("UPDATE agents SET status = 'idle', status_line = 'Done for now' WHERE id = ?", builder.id);
  const row = () => db.get('SELECT * FROM agents WHERE id = ?', builder.id)!;

  assert.equal(busyReason(row()), null);
  assert.equal(agentView(row()).status, 'idle');
  const base = workingAgents(pid);

  // A background command still running.
  db.run("INSERT INTO running_commands (id, project_id, agent_id, session_agent_id, command, label, background, started_at) VALUES ('rc1', ?, ?, ?, 'npm run build', 'build', 1, ?)", pid, builder.id, builder.id, db.now());
  assert.equal(busyReason(row()), 'Waiting on build');
  const v = agentView(row());
  assert.deepEqual([v.status, v.status_line], ['working', 'Waiting on build']);
  assert.equal(workingAgents(pid), base + 1, 'the agent limit counts it');
  assert.equal(projectSummaries().find((p) => p.id === pid)!.working, 1, 'the project pill counts it');
  db.run('UPDATE running_commands SET ended_at = ? WHERE id = ?', db.now(), 'rc1');

  // A claim on a host: a job running there.
  const host = db.newId('host');
  db.run("INSERT INTO hosts (id, name, created_at, updated_at) VALUES (?, 'buildbox', ?, ?)", host, db.now(), db.now());
  db.run("INSERT INTO host_claims (id, host_id, agent_id, project_id, activity, created_at, updated_at) VALUES ('hc1', ?, ?, ?, 'release build', ?, ?)", host, builder.id, pid, db.now(), db.now());
  assert.equal(busyReason(row()), 'Waiting on release build on buildbox');
  db.run("DELETE FROM host_claims WHERE id = 'hc1'");

  // An open subagent.
  db.run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, status, created_at, updated_at) VALUES ('ag_sub1', ?, ?, 'subagent', 'sub', 'm', 'working', ?, ?)", pid, builder.id, db.now(), db.now());
  db.run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, status, created_at, updated_at) VALUES ('ag_sub2', ?, ?, 'subagent', 'sub', 'm', 'working', ?, ?)", pid, builder.id, db.now(), db.now());
  assert.equal(busyReason(row()), 'Waiting on 2 subagents');
  db.run("UPDATE agents SET status = 'done' WHERE id IN ('ag_sub1', 'ag_sub2')");

  // A review it asked for.
  db.run("INSERT INTO consults (id, project_id, asker_id, manager_id, kind, question, created_at) VALUES ('cs1', ?, ?, ?, 'review', 'Look', ?)", pid, builder.id, director.id, db.now());
  assert.equal(busyReason(row()), 'Waiting on a review');
  db.run("UPDATE consults SET status = 'answered' WHERE id = 'cs1'");

  // An Active task it drives.
  const t = tasks.createTask(pid, { title: 'Export JSON', state: 'active', origin: 'user', driver_agent_id: builder.id }, USER);
  assert.equal(busyReason(row()), 'On Export JSON');
  db.run("UPDATE tasks SET state = 'done' WHERE id = ?", t.id);

  // Nothing in hand: idle. Waiting on the user stays its own state.
  assert.equal(busyReason(row()), null);
  assert.equal(agentView(row()).status, 'idle');
  db.run("UPDATE agents SET status = 'waiting' WHERE id = ?", builder.id);
  assert.equal(agentView(row()).status, 'waiting');
});
