import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Icon } from './ui';

/**
 * Collapsible cards on the task and discussion pages. Tapping a card's header opens or closes it; the state is
 * remembered per kind of card on this device (one setting for every task, not per task), so the page opens the way
 * the user left it.
 */
const key = (kind: string) => `helm-fold:${kind}`;
const OPENED = 'helm-fold-open';

/** Opens a card from elsewhere (a jump link): remembered like the user's own tap, and shown at once. */
export function openFold(kind: string) {
  localStorage.setItem(key(kind), '1');
  dispatchEvent(new CustomEvent(OPENED, { detail: kind }));
}

/**
 * Scrolls to the first element matching `selector`, opening the card `fold` first if it is collapsed. `end`: its bottom
 * edge in view (the newest entry and the message box of a history).
 */
export function jumpTo(selector: string, opts: { fold?: string; end?: boolean } = {}) {
  if (opts.fold) openFold(opts.fold);
  // Two frames: the opened card has to be drawn before it is scrolled to.
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: opts.end ? 'end' : 'start' })));
}

export function useFold(kind: string, openByDefault: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(key(kind));
    return v === null ? openByDefault : v === '1';
  });
  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<string>).detail === kind && setOpen(true);
    addEventListener(OPENED, on);
    return () => removeEventListener(OPENED, on);
  }, [kind]);
  const toggle = () =>
    setOpen((o) => {
      localStorage.setItem(key(kind), o ? '0' : '1');
      return !o;
    });
  return [open, toggle];
}

/** A card's header as the toggle: chevron, title, and anything else on the row (kept outside the button). */
export function FoldHead({ open, onToggle, title, note, children }: { open: boolean; onToggle: () => void; title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`fold-head ${open ? 'open' : ''}`}>
      <button type="button" className="fold-toggle" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevron" size={16} />
        <h2 className="now-label">{title}</h2>
        {/* What the card holds, one muted line, while it is collapsed. */}
        {!open && note && <span className="fold-note muted small one-line">{note}</span>}
      </button>
      {open && children}
    </div>
  );
}

/** A collapsible card: header, then its body while open. */
export function Fold({ kind, title, note, openByDefault = true, className = '', label, head, children }: { kind: string; title: ReactNode; note?: ReactNode; openByDefault?: boolean; className?: string; label?: string; head?: ReactNode; children: ReactNode }) {
  const [open, toggle] = useFold(kind, openByDefault);
  return (
    <section className={`card fold ${open ? 'open' : 'closed'} ${className}`} aria-label={label}>
      <FoldHead open={open} onToggle={toggle} title={title} note={note}>
        {head}
      </FoldHead>
      {open && children}
    </section>
  );
}

/**
 * The title card stays in view: once it has scrolled up under the top bar, a compact strip with the same state,
 * title, status and buttons is shown fixed below the bar. Returns the ref for the card and whether it is out of view.
 */
export function useOutOfView<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [out, setOut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The top bar's height (--chrome-top includes the safe area, so measure it rather than parse it).
    const m = document.createElement('div');
    m.style.cssText = 'position:absolute;visibility:hidden;height:var(--chrome-top)';
    document.body.appendChild(m);
    const top = m.offsetHeight || 61;
    m.remove();
    // Out of view once all of it is under the top bar (above, not below the screen).
    const io = new IntersectionObserver(([e]) => setOut(!e.isIntersecting && e.boundingClientRect.top < top), { rootMargin: `-${Math.round(top)}px 0px 0px 0px`, threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, out];
}

/** The title card of a task or discussion page, and its compact strip fixed under the top bar once it scrolls away. */
export function StickyHead({ className, children, strip }: { className: string; children: ReactNode; strip: ReactNode }) {
  const [ref, out] = useOutOfView<HTMLElement>();
  return (
    <>
      <header ref={ref} className={className}>
        {children}
      </header>
      {/* A zero-height sticky anchor in the page's column: the strip lines up with the cards and moves nothing. */}
      <div className="title-strip-anchor">
        {out && (
          <div className="title-strip" role="region" aria-label="Title">
            {strip}
          </div>
        )}
      </div>
    </>
  );
}
