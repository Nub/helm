/**
 * Checks for pinned proposals (pins.ts) through the agent tool handlers: pin on post, pin existing, rounds, relabel,
 * reorder, unpin, a linked request answered (choice recorded), inference in ask_user, and other projects' ids
 * refused. Run: npm run check:pins (uses a fresh temporary HELM_DATA).
 */
import { SCRATCH } from '../testenv.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { now, run, get, all } = await import('../db.ts');
const T = await import('../tasks.ts');
const P = await import('../pins.ts');
const { helmTools } = await import('../tools.ts');
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

// A 1x1 PNG, enough for previews of kind image and compare.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(SCRATCH, 'proj-'));
mkdirSync(join(dir, 'shots'));
for (const n of ['p1', 'p2', 'p3', 'r1', 'r2', 'before', 'after']) writeFileSync(join(dir, 'shots', `${n}.png`), PNG);

const pid = 'pr_pins';
for (const [id, name, path] of [[pid, 'Pins', dir], ['pr_other', 'Other', dir]]) {
  run('INSERT INTO projects (id, name, path, structure, created_at, updated_at, sessions_backfilled) VALUES (?,?,?,?,?,?,1)', id, name, path, JSON.stringify(defaultStructure()), now(), now());
}
run("INSERT INTO agents (id, project_id, role_id, name, model, status, created_at, updated_at) VALUES ('ag_dir', ?, 'director', 'Director', 'x', 'idle', ?, ?)", pid, now(), now());
run("INSERT INTO agents (id, project_id, role_id, name, model, status, created_at, updated_at) VALUES ('ag_oth', 'pr_other', 'director', 'Other director', 'x', 'idle', ?, ?)", now(), now());
const rt = { spawn: async () => 'x', send: async () => {}, close: async () => {}, markComplete: () => {} };
const tools = (agent: string) => {
  const list = helmTools(agent, rt, { manager: true, root: true, consult: false }) as any[];
  return (name: string, args: any) => list.find((t) => t.name === name)!.handler(args, {}) as Promise<{ content: { text: string }[]; isError?: boolean }>;
};
const call = tools('ag_dir');
const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');
const idOf = (r: { content: { text: string }[] }) => /(pv_[0-9a-f]+)/.exec(text(r))![1];

const disc = T.createTask(pid, { title: 'Redesign the Overview', state: 'open', origin: 'director', kind: 'discussion' }, { author: 'director', name: 'Director' });
const other = T.createTask('pr_other', { title: 'Elsewhere', state: 'open', origin: 'director', kind: 'discussion' }, { author: 'director', name: 'Other director' });

const ids: string[] = [];
await check('post_preview with pin pins to the top with its label, round 1', async () => {
  for (const [n, label] of [['p1', 'P1: two lists and one box'], ['p2', 'P2: one list'], ['p3', 'P3: cards']]) {
    const r = await call('post_preview', { title: `Flow ${n}`, path: `shots/${n}.png`, task: disc.id, pin: true, pin_label: label });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /Pinned to the top/);
    ids.push(idOf(r));
  }
  const v = P.proposalView(disc.id)!;
  assert.equal(v.round, 1);
  assert.deepEqual(v.items.map((i: any) => i.label), ['P1: two lists and one box', 'P2: one list', 'P3: cards']);
  assert.equal(v.request, null);
  assert.ok(get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE '%pinned \"P1: two lists and one box\" to the top%'", disc.id));
});

await check('post_preview with pin and no task is refused, nothing posted', async () => {
  const before = get('SELECT COUNT(*) AS n FROM previews')!.n;
  const r = await call('post_preview', { title: 'x', path: 'shots/p1.png', pin: true });
  assert.ok(r.isError);
  assert.equal(get('SELECT COUNT(*) AS n FROM previews')!.n, before);
});

let requestId = '';
await check('ask_user with options after pinning links itself (inferred) and its controls sit with the items', async () => {
  const r = await call('ask_user', { title: 'Which Overview?', question: 'Pick one.', options: [{ label: 'P1' }, { label: 'P2' }, { label: 'P3' }], task: disc.id });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /linked to the pinned proposal/);
  requestId = /request (in_[0-9a-f]+)/.exec(text(r))![1];
  const v = P.proposalView(disc.id)!;
  assert.equal(v.request.id, requestId);
  const sum = P.proposalSummary(disc.id)!;
  assert.equal(sum.count, 3);
  assert.equal(sum.waiting, true);
  assert.equal(sum.thumbs.length, 3);
  assert.ok(sum.thumbs.every((t: any) => t.url?.startsWith('/artifacts/')));
  // On the list views too.
  assert.equal(T.taskView(T.getTask(disc.id)!).proposal.waiting, true);
});

await check('ask_user without options or previews is not linked', async () => {
  const r = await call('ask_user', { title: 'Unrelated', question: 'Anything else?', task: disc.id });
  assert.doesNotMatch(text(r), /linked to the pinned/);
  assert.equal(P.proposalView(disc.id)!.request.id, requestId);
});

await check('relabel, reorder and unpin through the pin tool; unpinning keeps the preview', async () => {
  let r = await call('pin', { task: disc.id, relabel: [{ id: ids[1], label: 'P2: one long list' }], order: [ids[2], ids[0]] });
  assert.ok(!r.isError, text(r));
  assert.deepEqual(P.proposalView(disc.id)!.items.map((i: any) => i.label), ['P3: cards', 'P1: two lists and one box', 'P2: one long list']);
  r = await call('pin', { task: disc.id, order: [ids[0], ids[1], ids[2]] });
  r = await call('pin', { task: disc.id, unpin: [ids[2]] });
  assert.ok(!r.isError, text(r));
  assert.equal(P.proposalView(disc.id)!.items.length, 2);
  assert.ok(get('SELECT id FROM previews WHERE id = ?', ids[2]));
  // Pin it back (pin existing).
  r = await call('pin', { task: disc.id, add: [{ id: ids[2], label: 'P3: cards' }] });
  assert.ok(!r.isError, text(r));
  assert.equal(P.proposalView(disc.id)!.items.length, 3);
});

await check('a failing part changes nothing', async () => {
  const before = JSON.stringify(P.proposalView(disc.id));
  const r = await call('pin', { task: disc.id, relabel: [{ id: ids[0], label: 'Renamed' }], unpin: ['pv_nothere'] });
  assert.ok(r.isError);
  assert.match(text(r), /Nothing was changed/);
  assert.equal(JSON.stringify(P.proposalView(disc.id)), before);
});

await check("another project's previews and tasks are refused", async () => {
  const callOther = tools('ag_oth');
  const r = await callOther('post_preview', { title: 'Other', path: 'shots/p1.png', task: other.id });
  const otherPv = idOf(r);
  let x = await call('pin', { task: disc.id, add: [{ id: otherPv }] });
  assert.ok(x.isError);
  assert.match(text(x), /No preview or attachment/);
  x = await call('pin', { task: other.id, add: [{ id: ids[0] }] });
  assert.ok(x.isError);
  assert.equal(P.pinItems(T.getTask(disc.id)!, [{ id: otherPv }], T.USER).hasOwnProperty('error'), true);
});

await check('answering the linked request records the choice (by label key) and the round is decided', async () => {
  run("UPDATE inbox SET status = 'answered', answer = 'P1', answered_at = ? WHERE id = ?", now(), requestId);
  P.noteRequestAnswered(requestId);
  const v = P.proposalView(disc.id)!;
  assert.ok(v.choice);
  assert.equal(v.items.find((i: any) => i.pin_id === v.choice.pin_id).label, 'P1: two lists and one box');
  const sum = P.proposalSummary(disc.id)!;
  assert.equal(sum.waiting, false);
  assert.equal(sum.chosen, 'P1: two lists and one box');
  assert.ok(get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE '%chosen \"P1: two lists and one box\"%'", disc.id));
});

await check('a revision after the choice goes to round 2; round 1 collapses into earlier', async () => {
  const a = await call('post_preview', { title: 'Rev 1', path: 'shots/r1.png', task: disc.id, pin: true, pin_label: 'P1a: lists, tighter' });
  const b = await call('post_preview', { title: 'Rev 2', path: 'shots/r2.png', task: disc.id, pin: true, pin_label: 'P1b: lists, box on top' });
  assert.match(text(a), /round 2/);
  const v = P.proposalView(disc.id)!;
  assert.equal(v.round, 2);
  assert.equal(v.items.length, 2);
  assert.equal(v.choice, null);
  assert.equal(v.earlier.length, 1);
  assert.equal(v.earlier[0].round, 1);
  assert.ok(v.earlier[0].choice);
  // ask_user with the two previews and options links to round 2.
  const r = await call('ask_user', { title: 'Which revision?', question: 'Pick.', options: [{ label: 'P1a' }, { label: 'P1b' }], previews: [idOf(a), idOf(b)], task: disc.id });
  assert.match(text(r), /round 2/);
  // Answer by option position when labels do not match keys.
  const req = /request (in_[0-9a-f]+)/.exec(text(r))![1];
  run("UPDATE inbox SET status = 'answered', answer = 'P1b — but bigger', answered_at = ? WHERE id = ?", now(), req);
  P.noteRequestAnswered(req);
  const v2 = P.proposalView(disc.id)!;
  assert.equal(v2.items.find((i: any) => i.pin_id === v2.choice.pin_id).label, 'P1b: lists, box on top');
});

await check('options that do not map one to one onto previews are not linked unless proposal: true', async () => {
  const t = T.createTask(pid, { title: 'Mismatch', state: 'waiting', origin: 'director' }, { author: 'director', name: 'Director' });
  const a = idOf(await call('post_preview', { title: 'M1', path: 'shots/p1.png', task: t.id }));
  const b = idOf(await call('post_preview', { title: 'M2', path: 'shots/p2.png', task: t.id }));
  const r = await call('ask_user', { title: 'Q', question: 'Q', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }], previews: [a, b], task: t.id });
  assert.doesNotMatch(text(r), /linked/);
  assert.equal(P.proposalView(t.id), null);
  // A different question: asking the same one again is refused (the open one is replaced instead).
  const r2 = await call('ask_user', { title: 'Q2', question: 'Q, with the previews pinned as a proposal', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }], previews: [a, b], task: t.id, proposal: true });
  assert.match(text(r2), /linked to the pinned proposal/);
  assert.equal(P.proposalView(t.id)!.items.length, 2);
});

await check('ask_user with several unpinned previews and options pins them and links (proposal inferred)', async () => {
  const t = T.createTask(pid, { title: 'Pick an icon', state: 'planning', origin: 'director' }, { author: 'director', name: 'Director' });
  const a = idOf(await call('post_preview', { title: 'Icon A', before: { path: 'shots/before.png' }, after: { path: 'shots/after.png' }, task: t.id }));
  const b = idOf(await call('post_preview', { title: 'Icon B', path: 'shots/p2.png', task: t.id }));
  assert.equal(P.proposalView(t.id), null);
  const r = await call('ask_user', { title: 'Which icon?', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }], previews: [a, b], task: t.id });
  assert.match(text(r), /linked to the pinned proposal/);
  const v = P.proposalView(t.id)!;
  assert.deepEqual(v.items.map((i: any) => i.item_id), [a, b]);
  assert.equal(v.items[0].preview.kind, 'compare');
  // proposal: false stops it.
  const t2 = T.createTask(pid, { title: 'No pins', state: 'waiting', origin: 'director' }, { author: 'director', name: 'Director' });
  const r2 = await call('ask_user', { title: 'Q', question: 'Q', options: [{ label: 'A' }, { label: 'B' }], previews: [a, b], task: t2.id, proposal: false });
  assert.doesNotMatch(text(r2), /linked/);
  assert.equal(P.proposalView(t2.id), null);
});

await check('the pin tool sets the question, links the latest open question, records a choice by hand and clears it', async () => {
  const t = T.createTask(pid, { title: 'Backfill case', state: 'open', origin: 'director', kind: 'discussion' }, { author: 'director', name: 'Director' });
  const ps = [];
  for (const n of ['p1', 'p2', 'p3']) ps.push(idOf(await call('post_preview', { title: `Old ${n}`, path: `shots/${n}.png`, task: t.id })));
  await call('ask_user', { title: 'Old question', question: 'Which?', options: [{ label: 'P1' }, { label: 'P2' }], task: t.id, proposal: false });
  const r = await call('pin', { task: t.id, add: ps.map((id, i) => ({ id, label: `P${i + 1}` })), question: 'Which flow should the Overview use?', request: 'latest' });
  assert.ok(!r.isError, text(r));
  const v = P.proposalView(t.id)!;
  assert.equal(v.question, 'Which flow should the Overview use?');
  assert.equal(v.request.title, 'Old question');
  let x = await call('pin', { task: t.id, chosen: ps[1] });
  assert.ok(!x.isError, text(x));
  assert.equal(P.proposalView(t.id)!.choice.pin_id, P.proposalView(t.id)!.items[1].pin_id);
  x = await call('pin', { task: t.id, chosen: 'none' });
  assert.equal(P.proposalView(t.id)!.choice, null);
  // The rendered state is in list_tasks / list_discussions for the director.
  assert.match(P.renderProposal(t.id), /Pinned proposal, round 1: Which flow/);
});

await check('the user pins an attachment and a preview; unpin by pin id', async () => {
  const t = T.createTask(pid, { title: 'User pins', state: 'open', origin: 'user', kind: 'discussion' }, T.USER);
  run("INSERT INTO attachments (id, project_id, owner_kind, owner_id, name, mime, kind, size, file, created_at) VALUES ('at_x', ?, 'task', ?, 'mock.png', 'image/png', 'image', 10, 'mock.png', ?)", pid, t.id, now());
  const res = P.pinItems(t, [{ id: 'at_x' }], T.USER);
  assert.ok(!('error' in res));
  const v = P.proposalView(t.id)!;
  assert.equal(v.items[0].attachment.name, 'mock.png');
  assert.equal(v.items[0].label, 'mock.png');
  assert.ok(get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body = 'You pinned \"mock.png\" to the top.'", t.id));
  const u = P.unpin(t, [String(v.items[0].pin_id)], T.USER);
  assert.ok(!('error' in u));
  assert.equal(P.proposalView(t.id), null);
  assert.ok(get("SELECT id FROM attachments WHERE id = 'at_x'"));
});

await check('the tool descriptions say what pin does', async () => {
  const list = helmTools('ag_dir', rt, { manager: true, root: true, consult: false }) as any[];
  assert.ok(list.some((t) => t.name === 'pin'));
  const worker = helmTools('ag_dir', rt, { manager: false, root: false, consult: true }) as any[];
  assert.ok(!worker.some((t) => t.name === 'pin'));
  assert.ok(worker.find((t) => t.name === 'post_preview').inputSchema?.pin ?? true);
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}. Data: ${process.env.HELM_DATA}`);
void all;
