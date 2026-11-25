import './testenv.ts';
// The project search (search.ts) and its endpoint (searchapi.ts): `node --test server/search.test.ts` (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import * as db from './db.ts';
import { defaultStructure } from './structure.ts';
import { createTask } from './tasks.ts';
import { addJournal } from './store.ts';
import { findInProject, matchLine, rankHits, renderFind, searchItems } from './search.ts';
import { registerApi } from './api.ts';
import { config } from './config.ts';

const project = (id: string, name: string, archived = 0) =>
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', id, name, tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), archived, db.now(), db.now());
const by = { author: 'user', name: 'You' } as const;
const touch = (id: string, ts: number) => db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', ts, id);

project('p_a', 'Alpha');
project('p_b', 'Beta');
project('p_old', 'Old', 1);
const T = 1_800_000_000_000;
// In project A: an old task with both words in its title, a newer one with one word in the title, the newest with
// the words only in its description, one with the words only in its thread, and a discussion.
const both = createTask('p_a', { title: 'Search bar on Home', state: 'waiting', origin: 'user' }, by);
const some = createTask('p_a', { title: 'Home layout on phones', description: 'room for a search field', state: 'waiting', origin: 'user' }, by);
const body = createTask('p_a', { title: 'Make it findable', description: 'A search box on the home page.', state: 'active', origin: 'user' }, by);
const thread = createTask('p_a', { title: 'Unrelated title', state: 'done', origin: 'user' }, by);
db.run('INSERT INTO task_messages (task_id, author, author_name, body, created_at) VALUES (?,?,?,?,?)', thread.id, 'user', 'You', 'Could the home have a search too?', T);
const disc = createTask('p_a', { title: 'Search everywhere on home?', state: 'planning', origin: 'user', kind: 'discussion' }, by);
touch(both.id, T - 4000);
touch(some.id, T - 3000);
touch(body.id, T - 1000);
touch(thread.id, T - 2000);
touch(disc.id, T);
db.run('INSERT INTO agents (id, project_id, role_id, name, model, status, status_line, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', 'ag_1', 'p_a', 'engineer', 'Home search engineer', 'opus', 'working', 'Wiring the search box', T, T);
addJournal('p_a', null, 'milestone', 'Search shipped on home', 'It works.');
// In project B and an archived project: the same words.
createTask('p_b', { title: 'Search on home for Beta', state: 'waiting', origin: 'user' }, by);
createTask('p_old', { title: 'Search on home in an archived project', state: 'waiting', origin: 'user' }, by);

test('ranking: every word in the title, then some of them, then body only; newest first within each', () => {
  const tasks = searchItems('p_a', 'search home', { kind: 'task' }).map((h) => h.id);
  assert.deepEqual(tasks, [both.id, some.id, body.id, thread.id]);
  const hits = rankHits([
    { inTitle: 0, ts: 9 },
    { inTitle: 2, ts: 1 },
    { inTitle: 1, ts: 5 },
    { inTitle: 2, ts: 3 },
  ]);
  assert.deepEqual(hits.map((h) => `${h.inTitle}:${h.ts}`), ['2:3', '2:1', '1:5', '0:9']);
});

test('every kind is searched, agents by name, role and status line; the find tool ranks the same way', () => {
  const kinds = new Set(searchItems('p_a', 'search home').map((h) => h.kind));
  assert.deepEqual([...kinds].sort(), ['agent', 'discussion', 'journal', 'task']);
  assert.equal(searchItems('p_a', 'wiring box')[0]?.id, 'ag_1');
  assert.equal(searchItems('p_a', 'engineer')[0]?.kind, 'agent');
  const found = findInProject('p_a', 'search home', undefined, 50);
  assert.ok(found.findIndex((h) => h.id === both.id) < found.findIndex((h) => h.id === body.id));
  assert.match(renderFind('p_a', 'wiring', 'agent'), /\[\[ag_1\]\] agent · working/);
});

test('the matching line comes from the thread or body, not the title', () => {
  const t = searchItems('p_a', 'search home', { kind: 'task' }).find((h) => h.id === thread.id)!;
  assert.equal(matchLine(t.text, t.title, ['search', 'home']), 'Could the home have a search too?');
  assert.equal(matchLine('Title\nnothing\n**the** search line', 'Title', ['search']), 'the search line');
});

test('one project only, or every project not archived', () => {
  assert.ok(searchItems('p_a', 'search home').every((h) => h.project_id === 'p_a'));
  const everywhere = new Set(searchItems(null, 'search home').map((h) => h.project_id));
  assert.deepEqual([...everywhere].sort(), ['p_a', 'p_b']);
});

test('the endpoint: signed in only, scoped to the project, grouped in order, project names across projects', async () => {
  const app = Fastify();
  registerApi(app);
  await app.ready();
  const out = await app.inject({ method: 'GET', url: '/api/search?q=search+home&project=p_a' });
  assert.equal(out.statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });

  const a = await get('/api/search?q=search+home&project=p_a');
  assert.equal(a.statusCode, 200);
  const view = a.json();
  assert.deepEqual(view.groups.map((g: any) => g.kind), ['task', 'discussion', 'agent', 'journal']);
  assert.deepEqual(view.groups[0].items.map((i: any) => i.id), [both.id, some.id, body.id, thread.id]);
  assert.ok(view.groups.every((g: any) => g.items.every((i: any) => i.project_id === 'p_a' && !('project' in i))));
  assert.equal(typeof view.ms, 'number');

  const b = (await get('/api/search?q=search+home&project=p_b')).json();
  assert.deepEqual(b.groups.flatMap((g: any) => g.items.map((i: any) => i.project_id)), ['p_b']);

  const every = (await get('/api/search?q=search+home&all=1')).json();
  const names = new Set(every.groups.flatMap((g: any) => g.items.map((i: any) => i.project)));
  assert.deepEqual([...names].sort(), ['Alpha', 'Beta']);

  assert.equal((await get('/api/search?q=search&project=nope')).statusCode, 404);
  assert.deepEqual((await get('/api/search?q=a&project=p_a')).json().groups, []);
  await app.close();
});
