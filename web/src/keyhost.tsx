import { useEffect, useState } from 'react';
import { openChat } from './chat';
import { G_WINDOW_MS, KEYMAP, NO_STATE, chatContext, gotoHash, keyAction, moveIndex } from './keys';
import type { KeyState } from './keys';
import { openSwitcher, lastProject } from './switcher';
import { Sheet, href, openPreview, useRoute } from './ui';

/**
 * Keyboard control: vim-like keys on a desktop or iPad keyboard (keys.ts has the pure handler and the keymap). The host
 * is mounted once by the shell; "/" is the search's own (search.tsx). Items a key can select carry data-kctx
 * ("task:<id>", "discussion:<id>", "request:<id>"); the selection outline shows only once a key was used.
 */

const SELECTABLE = '[data-kctx]';
const OVERLAY = '.sheet-backdrop, .viewer';
const typingIn = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
const visible = (el: Element) => el instanceof HTMLElement && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
const items = () => [...document.querySelectorAll<HTMLElement>(SELECTABLE)].filter(visible);
const selected = () => document.querySelector<HTMLElement>('[data-ksel]');

function setSelected(el: HTMLElement | null) {
  document.querySelectorAll('[data-ksel]').forEach((x) => x.removeAttribute('data-ksel'));
  if (el) {
    el.setAttribute('data-ksel', '1');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
const keysOn = (on: boolean) => document.body.classList.toggle('keys-on', on);

/** The request card the key is about: the selected one, else the first request card in view. */
function requestCard(): HTMLElement | null {
  const sel = selected();
  if (sel?.classList.contains('inbox-card')) return sel;
  return [...document.querySelectorAll<HTMLElement>('.inbox-card')].filter(visible).find((c) => c.getBoundingClientRect().bottom > 60) ?? null;
}

/** Click the first of `sel` inside `root` that is there and enabled; whether one was. */
function press(root: ParentNode, sel: string): boolean {
  const el = [...root.querySelectorAll<HTMLElement>(sel)].find((x) => !(x as HTMLButtonElement).disabled);
  el?.click();
  return !!el;
}

/** The section (fold) the selection is in, else the one in the middle of the screen. */
function focusedFold(): HTMLElement | null {
  const sel = selected()?.closest<HTMLElement>('.fold');
  if (sel) return sel;
  const mid = window.innerHeight / 2;
  const folds = [...document.querySelectorAll<HTMLElement>('.card.fold')].filter(visible);
  return folds.find((f) => f.getBoundingClientRect().top <= mid && f.getBoundingClientRect().bottom >= mid) ?? folds.find((f) => f.getBoundingClientRect().bottom > 80) ?? null;
}

export function KeyboardKeys() {
  const route = useRoute();
  const [help, setHelp] = useState(false);
  useEffect(() => {
    let state: KeyState = NO_STATE;
    const project = () => (route[0] === 'p' ? decodeURIComponent(route[1] ?? '') : lastProject());
    const onKey = (e: KeyboardEvent) => {
      const res = keyAction({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey, typing: typingIn(e.target), overlay: !!document.querySelector(OVERLAY), at: Date.now() }, state);
      state = res.state;
      const a = res.action;
      // Enter on a focused link or button is that control's own; it opens the selection only from the page itself.
      if (a?.type === 'open' && (!selected() || (e.target instanceof HTMLElement && e.target.closest('a, button, summary, [role="button"]')))) return;
      if (!a) {
        if (e.key === 'g') keysOn(true);
        return;
      }
      if (a.type === 'escape') {
        if (selected()) {
          setSelected(null);
          keysOn(false);
        } else if (route[0] === 'p' && route[3]) location.hash = href('p', route[1], route[2]);
        else if (route[0] && route[0] !== 'p') location.hash = href();
        else return;
        e.preventDefault();
        return;
      }
      e.preventDefault();
      keysOn(true);
      const sel = selected();
      switch (a.type) {
        case 'switcher':
          openSwitcher();
          break;
        case 'help':
          setHelp(true);
          break;
        case 'chat':
          openChat(chatContext(sel?.dataset.kctx, a.general));
          break;
        case 'move': {
          const list = items();
          const at = moveIndex(sel ? list.indexOf(sel) : -1, list.length, a.by);
          if (at >= 0) setSelected(list[at]);
          break;
        }
        case 'open': {
          const link = sel?.querySelector<HTMLElement>('a.card-open, a.task-link, a.disc-row-link, a.head-title-link, h3 a');
          if (link) link.click();
          break;
        }
        case 'preview': {
          const pv = sel?.dataset.kpreview;
          if (pv) {
            const [pid, id] = pv.split('/');
            openPreview(pid, id);
          } else press(sel ?? document, 'button.task-head-shot, button.ts-shot, button.tri3-shot, .tile-wrap button.tile');
          break;
        }
        case 'fold': {
          const f = focusedFold();
          if (f) press(f, '.fold-head .fold-toggle');
          break;
        }
        case 'goto': {
          const to = gotoHash(a.page, project());
          if (to) location.hash = to;
          break;
        }
        case 'pick': {
          const card = requestCard();
          if (card) card.querySelectorAll<HTMLElement>('.options .option')[a.n - 1]?.click();
          break;
        }
        case 'approve': {
          const card = requestCard();
          if (card) press(card, '.answer-actions .btn.primary');
          break;
        }
      }
    };
    // A pointer press hands the screen back to the mouse: the selection outline goes.
    const onPointer = () => {
      keysOn(false);
      setSelected(null);
    };
    const reset = window.setInterval(() => {
      if (state.g !== null && Date.now() - state.g > G_WINDOW_MS) state = NO_STATE;
    }, 500);
    addEventListener('keydown', onKey);
    addEventListener('pointerdown', onPointer, true);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('pointerdown', onPointer, true);
      clearInterval(reset);
    };
  }, [route.join('/')]);
  return help ? <KeysSheet onClose={() => setHelp(false)} /> : null;
}

/** The "?" sheet: every key, from the same keymap the handler is tested against. */
function KeysSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Keyboard" onClose={onClose} className="keys-sheet">
      <dl className="keys-list">
        {KEYMAP.map((k) => (
          <div key={k.keys} className="keys-row">
            <dt>
              {k.keys.split('  ').map((g, i) => (
                <span key={i}>
                  {g.split(' ').map((c, j) => (
                    <kbd key={j}>{c}</kbd>
                  ))}
                </span>
              ))}
            </dt>
            <dd>{k.does}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
