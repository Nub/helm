import { useEffect, useRef, useState } from 'react';

/**
 * Drag to reorder, for mouse and touch alike. The grip starts a drag at once.
 * On touch, pressing and holding anywhere on the row also picks it up; moving
 * the finger before the hold completes is left to the page, so scrolling a
 * long list still works. While dragging, the page scrolls by itself when the
 * pointer is near the top or bottom of the screen, and the dragged row follows
 * the pointer (scrolling included).
 *
 * The list decides where a pointer position would drop (onMove gets the
 * pointer's viewport y, again after every auto-scroll step) and what dropping
 * does (onDrop). No vibration: the row lifts visibly instead.
 */

const HOLD_MS = 280;
const SLOP_PX = 10;
const EDGE_PX = 72;
const MAX_SPEED = 18;

export type DragState = { id: string; dy: number } | null;

/** What scrolls when the pointer nears an edge: the closest scrolling ancestor (a sheet), else the page. */
type Scroller = { pos: () => number; by: (v: number) => void; top: () => number; bottom: () => number; max: () => number };
function scrollerFor(el: Element | null): Scroller {
  for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) {
      const box = n;
      return { pos: () => box.scrollTop, by: (v) => box.scrollBy(0, v), top: () => box.getBoundingClientRect().top, bottom: () => box.getBoundingClientRect().bottom, max: () => box.scrollHeight - box.clientHeight };
    }
  }
  return { pos: () => window.scrollY, by: (v) => window.scrollBy(0, v), top: () => 0, bottom: () => window.innerHeight, max: () => document.documentElement.scrollHeight - window.innerHeight };
}

/**
 * holdFrom: a CSS selector; when given, a press and hold picks the row up only when it starts inside a matching
 * element (for rows that hold a whole card, so text in the card can still be selected and scrolled).
 */
export function useDragReorder({ onMove, onDrop, holdFrom }: { onMove: (id: string, y: number) => void; onDrop: (id: string) => void; holdFrom?: string }) {
  const [drag, setDrag] = useState<DragState>(null);
  const live = useRef<{ id: string; y0: number; scroll0: number; y: number; raf: number; cleanup: () => void; sc: Scroller; limit: number } | null>(null);
  const handlers = useRef({ onMove, onDrop });
  handlers.current = { onMove, onDrop };

  const update = () => {
    const l = live.current;
    if (!l) return;
    setDrag({ id: l.id, dy: l.y - l.y0 + (l.sc.pos() - l.scroll0) });
    handlers.current.onMove(l.id, l.y);
  };

  // Scroll while the pointer rests near an edge, faster the closer it is.
  const tick = () => {
    const l = live.current;
    if (!l) return;
    const top = l.sc.top();
    const bottom = l.sc.bottom();
    const v = l.y < top + EDGE_PX ? -Math.min(1, (top + EDGE_PX - l.y) / EDGE_PX) * MAX_SPEED : l.y > bottom - EDGE_PX ? Math.min(1, (l.y - (bottom - EDGE_PX)) / EDGE_PX) * MAX_SPEED : 0;
    // The dragged row's own offset makes the page longer; scroll only as far as the content went when the drag began.
    const room = v > 0 ? l.limit - l.sc.pos() : l.sc.pos();
    if (v && room > 0) {
      const before = l.sc.pos();
      l.sc.by(v > 0 ? Math.min(v, room) : Math.max(v, -room));
      if (l.sc.pos() !== before) update();
    }
    l.raf = requestAnimationFrame(tick);
  };

  const begin = (id: string, y: number, cleanup: () => void, el: Element | null) => {
    document.documentElement.classList.add('reordering');
    const sc = scrollerFor(el);
    live.current = { id, y0: y, scroll0: sc.pos(), y, raf: 0, cleanup, sc, limit: sc.max() };
    live.current.raf = requestAnimationFrame(tick);
    update();
  };

  const finish = (commit: boolean) => {
    const l = live.current;
    if (!l) return;
    cancelAnimationFrame(l.raf);
    l.cleanup();
    live.current = null;
    document.documentElement.classList.remove('reordering');
    setDrag(null);
    // A click that follows the drop must not open the row's link.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 400);
    if (commit) handlers.current.onDrop(l.id);
  };

  useEffect(() => () => finish(false), []);

  /** On the grip: mouse, pen or touch start a drag immediately (the grip has touch-action: none). */
  const gripProps = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || live.current) return;
      e.preventDefault();
      e.stopPropagation();
      const move = (ev: PointerEvent) => {
        if (!live.current) return;
        live.current.y = ev.clientY;
        update();
      };
      const up = () => finish(true);
      const cancel = () => finish(false);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      begin(
        id,
        e.clientY,
        () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);
        },
        e.currentTarget,
      );
    },
    // The grip's own touches belong to the pointer path above, not the row's long press.
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
  });

  /** On the whole row: on touch, press and hold to pick it up. */
  const rowProps = (id: string) => ({
    onTouchStart: (e: React.TouchEvent) => {
      if (live.current || e.touches.length !== 1) return;
      if (holdFrom && !(e.target as Element).closest?.(holdFrom)) return;
      const t0 = e.touches[0];
      const row = e.currentTarget;
      const x0 = t0.clientX;
      const y0 = t0.clientY;
      let y = y0;
      let started = false;
      const timer = window.setTimeout(() => {
        started = true;
        begin(id, y, detach, row);
      }, HOLD_MS);
      const move = (ev: TouchEvent) => {
        const t = ev.touches[0];
        if (!t) return;
        y = t.clientY;
        if (!started) {
          // Moving before the hold completes is a scroll or a swipe: let the page have it.
          if (Math.abs(t.clientX - x0) > SLOP_PX || Math.abs(t.clientY - y0) > SLOP_PX) detach();
          return;
        }
        ev.preventDefault();
        if (live.current) {
          live.current.y = y;
          update();
        }
      };
      const end = (ev: TouchEvent) => {
        if (started) {
          ev.preventDefault();
          finish(ev.type === 'touchend');
        } else detach();
      };
      function detach() {
        window.clearTimeout(timer);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', end);
        window.removeEventListener('touchcancel', end);
      }
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', end, { passive: false });
      window.addEventListener('touchcancel', end, { passive: false });
    },
    // Long-pressing a link on iOS would open its preview instead.
    onContextMenu: (e: React.MouseEvent) => {
      if (live.current) e.preventDefault();
    },
  });

  return { drag, gripProps, rowProps };
}
