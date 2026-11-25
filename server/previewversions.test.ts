import { SCRATCH } from './testenv.ts';
// Versioned previews (store.ts addPreview, db.ts groupPreviewVersions): the same key, or the same title without a key, on
// one task adds a version under the same id; a pinned proposal option stays apart; old ids resolve to the latest.
// `node --test server/previewversions.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const tasks = await import('./tasks.ts');
const store = await import('./store.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'pv', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', pid)!;
  const t = tasks.createTask(pid, { title: 'Menu', state: 'active', origin: 'user' }, USER);
  const post = (input: Record<string, unknown>) => {
    const r = store.addPreview(project, null, { content: 'x', task_id: t.id, ...input } as any);
    assert.ok(!('error' in r), JSON.stringify(r));
    return r as { id: string; version?: number };
  };
  return { project, t, post };
}

test('the same key adds a version under the same id, whatever the title', () => {
  const { post, t } = setup();
  const a = post({ title: 'Menu v1', key: 'menu-screen', content: 'one' });
  const b = post({ title: 'Menu, larger font', key: 'menu-screen', content: 'two' });
  const c = post({ title: 'Menu, final', key: 'menu-screen', content: 'three' });
  assert.equal(b.id, a.id);
  assert.equal(c.id, a.id);
  assert.equal(c.version, 3);
  assert.equal(db.all('SELECT id FROM previews WHERE task_id = ?', t.id).length, 1);
  const v = store.previewVersions(a.id)!;
  assert.deepEqual(v.map((x) => [x.version, x.content, x.title]), [[1, 'one', 'Menu v1'], [2, 'two', 'Menu, larger font'], [3, 'three', 'Menu, final']]);
  // Another key is another preview.
  assert.notEqual(post({ title: 'Settings', key: 'settings' }).id, a.id);
});

test('without a key, the same title on the same task is the same preview; another task or a pinned option is not', () => {
  const { post, t, project } = setup();
  const a = post({ title: 'Load time', content: '1' });
  const b = post({ title: ' load time ', content: '2' });
  assert.equal(b.id, a.id);
  assert.equal(b.version, 2);
  const other = tasks.createTask(project.id, { title: 'Other', state: 'active', origin: 'user' }, USER);
  assert.notEqual(post({ title: 'Load time', task_id: other.id }).id, a.id);
  assert.notEqual(post({ title: 'Load time', fresh: true }).id, a.id, 'a proposal option posted with pin is its own');
  void t;
});

test('older same-title previews are grouped into the newest; an old id resolves to it, over the API too', async () => {
  const { project, t } = setup();
  const ins = (id: string, at: number) =>
    db.run("INSERT INTO previews (id, project_id, kind, title, caption, content, source, created_at, task_id) VALUES (?, ?, 'markdown', 'Chart', '', ?, '', ?, ?)", id, project.id, `v-${id}`, at, t.id);
  ins('pv_0ld0000001', 1000);
  ins('pv_0ld0000002', 2000);
  ins('pv_0ld0000003', 3000);
  assert.ok(db.groupPreviewVersions() >= 2);
  assert.equal(db.all('SELECT id FROM previews WHERE task_id = ?', t.id).length, 1);
  assert.equal(db.groupPreviewVersions(), 0, 'idempotent');
  assert.equal(store.resolvePreviewId('pv_0ld0000001'), 'pv_0ld0000003');
  assert.equal(store.resolvePreviewId('pv_0ld0000003'), 'pv_0ld0000003');
  const r = await app.inject({ method: 'GET', url: '/api/previews/pv_0ld0000001/versions', headers: { cookie } });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.id, 'pv_0ld0000003');
  assert.deepEqual(body.versions.map((v: any) => v.content), ['v-pv_0ld0000001', 'v-pv_0ld0000002', 'v-pv_0ld0000003']);
  assert.equal(store.previewAliases(project.id).pv_0ld0000002, 'pv_0ld0000003');
  // A further post with that title continues the versions.
  const next = store.addPreview(project, null, { title: 'Chart', content: 'v4', task_id: t.id }) as { id: string; version: number };
  assert.deepEqual([next.id, next.version], ['pv_0ld0000003', 4]);
});
