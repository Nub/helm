// Keyboard control (web/src/keys.ts): ignored while typing, g sequences, the chat context for i, selection movement.
// `node --test web/test/keys.test.ts`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G_WINDOW_MS, KEYMAP, NO_STATE, chatContext, enterSends, switcherMove, switcherPick, gotoHash, keyAction, moveIndex, toggleChatView } from '../src/keys.ts';
import type { KeyEvent, KeyState } from '../src/keys.ts';

const ev = (key: string, over: Partial<KeyEvent> = {}): KeyEvent => ({ key, ctrl: false, meta: false, alt: false, shift: key.length === 1 && key !== key.toLowerCase(), typing: false, overlay: false, at: 1000, ...over });
const press = (keys: [string, Partial<KeyEvent>?][], st: KeyState = NO_STATE) => {
  const out: (ReturnType<typeof keyAction>['action'])[] = [];
  for (const [k, o] of keys) {
    const r = keyAction(ev(k, o), st);
    st = r.state;
    out.push(r.action);
  }
  return out;
};

test('keys do nothing while typing in a box, or with Ctrl, Cmd or Alt held', () => {
  for (const k of ['p', 'i', 'j', 'k', 'a', '1', 'Enter', 'x', 'o', '?', 'Escape']) assert.equal(keyAction(ev(k, { typing: true }), NO_STATE).action, null, k);
  for (const mod of ['ctrl', 'meta', 'alt'] as const) assert.equal(keyAction(ev('p', { [mod]: true }), NO_STATE).action, null, mod);
  // Typing also drops a pending g.
  assert.equal(keyAction(ev('h', { typing: true }), { g: 1000 }).state.g, null);
});

test('the plain keys', () => {
  const act = (k: string) => keyAction(ev(k), NO_STATE).action;
  assert.deepEqual(act('p'), { type: 'switcher' });
  assert.deepEqual(act('i'), { type: 'chat', general: false });
  assert.deepEqual(act('c'), { type: 'chat', general: false });
  assert.deepEqual(act('I'), { type: 'chat', general: true });
  assert.deepEqual(act('j'), { type: 'move', by: 1 });
  assert.deepEqual(act('k'), { type: 'move', by: -1 });
  assert.deepEqual(act('Enter'), { type: 'open' });
  assert.deepEqual(act('o'), { type: 'preview' });
  assert.deepEqual(act('x'), { type: 'fold' });
  assert.deepEqual(act('a'), { type: 'approve' });
  assert.deepEqual(act('?'), { type: 'help' });
  for (let n = 1; n <= 6; n++) assert.deepEqual(act(String(n)), { type: 'pick', n });
  for (const k of ['7', '0', 'z', '/', 'q']) assert.equal(act(k), null, k);
});

test('g then h, w, s, d or n goes to a page; any other second key cancels and acts as itself', () => {
  assert.deepEqual(press([['g'], ['h']]), [null, { type: 'goto', page: 'home' }]);
  for (const [k, page] of [['w', 'work'], ['s', 'spec'], ['d', 'dashboards'], ['n', 'needs'], ['a', 'all']] as const) assert.deepEqual(press([['g'], [k]])[1], { type: 'goto', page }, k);
  // g j: no page; j is a key of its own.
  assert.deepEqual(press([['g'], ['j']]), [null, { type: 'move', by: 1 }]);
  // Too slow: the second key is read alone (h does nothing).
  const slow = keyAction(ev('h', { at: 1000 + G_WINDOW_MS + 1 }), { g: 1000 });
  assert.equal(slow.action, null);
  // A goto does not repeat.
  assert.deepEqual(press([['g'], ['h'], ['h']]), [null, { type: 'goto', page: 'home' }, null]);
});

test('with a sheet or the viewer open only ? and nothing else acts; Esc is theirs', () => {
  assert.equal(keyAction(ev('j', { overlay: true }), NO_STATE).action, null);
  assert.deepEqual(keyAction(ev('?', { overlay: true }), NO_STATE).action, { type: 'help' });
  assert.equal(keyAction(ev('Escape', { overlay: true }), NO_STATE).action, null);
  assert.deepEqual(keyAction(ev('Escape'), NO_STATE).action, { type: 'escape' });
});

test('i opens the chat on the selected item, else the page (undefined); I is always General', () => {
  assert.deepEqual(chatContext('task:task_0123456789', false), { kind: 'task', id: 'task_0123456789' });
  assert.deepEqual(chatContext('discussion:disc_0123456789', false), { kind: 'discussion', id: 'disc_0123456789' });
  assert.deepEqual(chatContext('request:in_0123456789', false), { kind: 'request', id: 'in_0123456789' });
  assert.equal(chatContext(undefined, false), undefined, 'no selection: the page decides (its item, else General)');
  assert.equal(chatContext('garbage', false), undefined);
  assert.deepEqual(chatContext('task:task_0123456789', true), { kind: 'general' }, 'I: General even with a selection');
});

test('Ctrl+g in the chat switches between the item and General, only when there is an item', () => {
  assert.equal(toggleChatView('item', true), 'general');
  assert.equal(toggleChatView('general', true), 'item');
  assert.equal(toggleChatView('general', false), 'general');
});

test('j and k: the first press picks the first or last, then one step, stopping at the ends', () => {
  assert.equal(moveIndex(-1, 5, 1), 0);
  assert.equal(moveIndex(-1, 5, -1), 4);
  assert.equal(moveIndex(0, 5, 1), 1);
  assert.equal(moveIndex(4, 5, 1), 4);
  assert.equal(moveIndex(0, 5, -1), 0);
  assert.equal(moveIndex(2, 0, 1), -1);
});

test('g pages need a project except Needs you; the keymap lists every key the handler has', () => {
  assert.equal(gotoHash('home', 'pr_1'), '#/p/pr_1/overview');
  assert.equal(gotoHash('dashboards', 'pr_1'), '#/p/pr_1/dashboards');
  assert.equal(gotoHash('work', null), null);
  assert.equal(gotoHash('needs', null), '#/home/needs');
  assert.equal(gotoHash('all', null), '#/home', 'All projects needs no project');
  assert.equal(gotoHash('all', 'pr_1'), '#/home');
  const listed = KEYMAP.map((k) => k.keys).join(' ');
  for (const k of ['p', 'i', 'I', 'j', 'k', 'Enter', 'o', 'x', 'g h', 'g w', 'g s', 'g d', 'g n', 'g a', '1–6', 'a', '?', 'Esc', 'Ctrl+g', '/']) assert.ok(listed.includes(k), k);
});

test('Enter in a message box: sends; Shift+Enter, composing, empty or a touch-only keyboard add a line', () => {
  const k = { key: 'Enter', shift: false, composing: false, empty: false, touchOnly: false };
  assert.equal(enterSends(k), true);
  assert.equal(enterSends({ ...k, shift: true }), false);
  assert.equal(enterSends({ ...k, composing: true }), false);
  assert.equal(enterSends({ ...k, empty: true }), false);
  assert.equal(enterSends({ ...k, touchOnly: true }), false);
  assert.equal(enterSends({ ...k, key: 'a' }), false);
});

test('project switcher arrows: row 0 is All projects, then the list; Enter opens the highlight or the first match', () => {
  // Three projects listed: rows 0..3.
  let h = -1;
  h = switcherMove(h, 3, 1);
  assert.equal(h, 1);
  h = switcherMove(h, 3, 1);
  assert.equal(h, 2);
  assert.equal(switcherPick(h, 3), 1); // the second project
  assert.equal(switcherMove(3, 3, 1), 3); // stops at the end
  assert.equal(switcherMove(1, 3, -1), 0);
  assert.equal(switcherMove(0, 3, -1), 0); // stops at All projects
  assert.equal(switcherMove(-1, 3, -1), 0);
  assert.equal(switcherPick(0, 3), 'all');
  assert.equal(switcherPick(-1, 3), 0); // no highlight: first match
  assert.equal(switcherPick(-1, 0), null);
  assert.equal(switcherMove(-1, 0, 1), 0); // nothing listed: only All projects
  assert.equal(switcherMove(5, 2, 1), 1); // a stale highlight past a shrunk list restarts
});
