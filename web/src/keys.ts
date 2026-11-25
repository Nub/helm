// Keyboard control (keyhost.tsx hosts it): the pure parts, so keys.test.ts runs them under plain Node. One keymap: the
// handler, the "?" sheet and the tests all read KEYMAP.

import type { ChatCtx } from './chat';

/** What a key press asks for; keys.tsx does it. */
export type KeyAction =
  | { type: 'switcher' }
  | { type: 'chat'; general: boolean }
  | { type: 'move'; by: 1 | -1 }
  | { type: 'open' }
  | { type: 'preview' }
  | { type: 'fold' }
  | { type: 'goto'; page: 'home' | 'work' | 'spec' | 'dashboards' | 'needs' | 'all' }
  | { type: 'pick'; n: number }
  | { type: 'approve' }
  | { type: 'help' }
  | { type: 'escape' };

/** One press, with what the handler needs to know about the moment. */
export type KeyEvent = { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; typing: boolean; overlay: boolean; at: number };
/** `g` waits for its second key for this long. */
export const G_WINDOW_MS = 1000;
export type KeyState = { g: number | null };
export const NO_STATE: KeyState = { g: null };

const GOTO: Record<string, Extract<KeyAction, { type: 'goto' }>['page']> = { h: 'home', w: 'work', s: 'spec', d: 'dashboards', n: 'needs', a: 'all' };

/**
 * Keys never act while typing in a box (input, textarea, select, contenteditable), with Ctrl, Cmd or Alt held, or while
 * a sheet or the viewer is open (those take their own keys; Esc is theirs). `g` then h, w, s, d, n or a goes to a page (a: All projects, the global Home).
 * "/" is not here: the search owns it (search.tsx SearchShortcut).
 */
export function keyAction(e: KeyEvent, st: KeyState): { action: KeyAction | null; state: KeyState } {
  if (e.typing || e.ctrl || e.meta || e.alt) return { action: null, state: NO_STATE };
  if (e.key === 'Escape') return { action: e.overlay ? null : { type: 'escape' }, state: NO_STATE };
  if (e.overlay) return { action: e.key === '?' ? { type: 'help' } : null, state: NO_STATE };
  const pendingG = st.g !== null && e.at - st.g <= G_WINDOW_MS;
  if (pendingG) {
    const page = GOTO[e.key];
    if (page) return { action: { type: 'goto', page }, state: NO_STATE };
    // Anything else cancels the sequence and is read as a key of its own.
  }
  const k = e.key;
  if (k === 'g') return { action: null, state: { g: e.at } };
  const act = (action: KeyAction | null): { action: KeyAction | null; state: KeyState } => ({ action, state: NO_STATE });
  if (k === 'p') return act({ type: 'switcher' });
  if (k === 'i' || k === 'c') return act({ type: 'chat', general: false });
  if (k === 'I') return act({ type: 'chat', general: true });
  if (k === 'j') return act({ type: 'move', by: 1 });
  if (k === 'k') return act({ type: 'move', by: -1 });
  if (k === 'Enter') return act({ type: 'open' });
  if (k === 'o') return act({ type: 'preview' });
  if (k === 'x') return act({ type: 'fold' });
  if (k === 'a') return act({ type: 'approve' });
  if (k === '?') return act({ type: 'help' });
  if (/^[1-6]$/.test(k) && !e.shift) return act({ type: 'pick', n: Number(k) });
  return act(null);
}

/** The listing the "?" sheet shows: every key and what it does. */
export const KEYMAP: { keys: string; does: string }[] = [
  { keys: '/', does: 'Search the project' },
  { keys: 'p', does: 'Switch project' },
  { keys: 'Esc', does: 'Close, or back one level (drafts are kept)' },
  { keys: 'i  c', does: 'Chat with the director about what is on screen' },
  { keys: 'I', does: 'Chat with the director in general' },
  { keys: 'Ctrl+g', does: 'In the chat: this item or General' },
  { keys: 'j  k', does: 'Move the selection down or up' },
  { keys: 'Enter', does: 'Open the selected item' },
  { keys: 'o', does: "Open the selected item's preview" },
  { keys: 'x', does: 'Collapse or expand the section' },
  { keys: 'g h', does: 'Go to Home' },
  { keys: 'g w', does: 'Go to Work' },
  { keys: 'g s', does: 'Go to Spec' },
  { keys: 'g d', does: 'Go to Dashboards' },
  { keys: 'g n', does: 'Go to Needs you' },
  { keys: 'g a', does: 'Go to All projects' },
  { keys: '1–6', does: "Pick a request's option" },
  { keys: 'a', does: 'Approve or Done on the request' },
  { keys: '?', does: 'This list' },
];

/** The chat context for `i`: the selected item (data-kctx "task:<id>", "discussion:<id>", "request:<id>"), else undefined: the page's own (General on a list). */
export function chatContext(selected: string | null | undefined, general: boolean): ChatCtx | undefined {
  if (general) return { kind: 'general' };
  const m = /^(task|discussion|request):([\w-]+)$/.exec(selected ?? '');
  return m ? ({ kind: m[1] as 'task' | 'discussion' | 'request', id: m[2] } as ChatCtx) : undefined;
}

/** Ctrl+g in the chat: between the item and General (only when there is an item). */
export const toggleChatView = (view: 'item' | 'general', hasItem: boolean): 'item' | 'general' => (view === 'item' || !hasItem ? 'general' : 'item');

/** j/k: the first press selects the first (or last) item; then one step, stopping at the ends. */
export function moveIndex(current: number, count: number, by: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return by === 1 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + by));
}

/** The page a `g` key goes to, as a hash route given the project (null: not available without one). */
export function gotoHash(page: Extract<KeyAction, { type: 'goto' }>['page'], projectId: string | null): string | null {
  if (page === 'needs') return '#/home/needs';
  if (page === 'all') return '#/home';
  if (!projectId) return null;
  const tab = { home: 'overview', work: 'work', spec: 'spec', dashboards: 'dashboards' }[page];
  return `#/p/${projectId}/${tab}`;
}

/**
 * Enter in the chat and thread message boxes: Enter sends, Shift+Enter adds a line (as in the Claude CLI). Not while an
 * IME is composing, not when the box is empty, and not on a phone's on-screen keyboard (touch only): there Return adds a
 * line and the Send button sends. Request note boxes keep Enter as a newline and do not use this.
 */
export function enterSends(e: { key: string; shift: boolean; composing: boolean; empty: boolean; touchOnly: boolean }): boolean {
  return e.key === 'Enter' && !e.shift && !e.composing && !e.empty && !e.touchOnly;
}

/** No hardware keyboard to speak of: a coarse pointer and no fine one anywhere. */
export function isTouchOnly(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
}

/** Whether a textarea key press is an IME composition step (keyCode 229 covers Safari). */
export const isComposing = (e: { nativeEvent: { isComposing?: boolean }; keyCode?: number }): boolean => !!e.nativeEvent.isComposing || e.keyCode === 229;

/**
 * Arrow keys in the project switcher's find field. Rows: 0 is All projects, 1..count the listed projects; -1 is no
 * highlight. From none, Down goes to the first project and Up to All projects; then one step, stopping at the ends.
 */
export function switcherMove(current: number, count: number, by: 1 | -1): number {
  if (current < 0 || current > count) return by === 1 ? Math.min(1, count) : 0;
  return moveIndex(current, count + 1, by);
}

/** What Enter in the switcher opens: 'all', a project's index in the list, or null. With no highlight, the first match. */
export function switcherPick(current: number, count: number): 'all' | number | null {
  if (current === 0) return 'all';
  if (current > 0 && current <= count) return current - 1;
  return count > 0 ? 0 : null;
}
