import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentLists, filterPast, pastTasks } from '../src/agentlists.ts';

// The Agents page (web/src/team.tsx): the agents running now, past ones apart, builder subagents in neither.
const ag = (id: string, role_id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, role_id, status, name: id, task: '', last_result: '', created_at: 1, updated_at: 1, task_id: null, ...extra }) as any;

test('open agents only; closed and done apart, newest first; subagents never listed', () => {
  const agents = [
    ag('Director', 'director', 'idle'),
    ag('Builder', 'builder', 'working'),
    ag('Web engineer', 'engineer', 'closed', { updated_at: 5 }),
    ag('Docs engineer', 'engineer', 'done', { updated_at: 9 }),
    ag('Sub live', 'subagent', 'working'),
    ag('Sub done', 'subagent', 'closed'),
  ];
  const { open, past } = agentLists(agents);
  assert.deepEqual(open.map((a) => a.id), ['Director', 'Builder']);
  assert.deepEqual(past.map((a) => a.id), ['Docs engineer', 'Web engineer']);
});

test('past agents: search by words and filter by task', () => {
  const past = [ag('Web engineer', 'engineer', 'closed', { task_id: 't1', last_result: 'Fixed the chart' }), ag('Docs engineer', 'engineer', 'closed', { task_id: 't2' }), ag('Helper', 'helper', 'closed', { task_id: 't1' })];
  assert.deepEqual(filterPast(past, 'web chart', '').map((a) => a.id), ['Web engineer']);
  assert.deepEqual(filterPast(past, '', 't1').map((a) => a.id), ['Web engineer', 'Helper']);
  assert.deepEqual(filterPast(past, 'docs', 't1'), []);
  assert.deepEqual(pastTasks(past), [{ id: 't1', count: 2 }, { id: 't2', count: 1 }]);
});
