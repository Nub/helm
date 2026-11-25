import DOMPurify from 'dompurify';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, ReactNode } from 'react';
import { AttachButton, AttachTray, dropTarget, pasteInto, useAttachDraft } from './attachments';
import { useStoredText } from './drafts';
import { enterSends, isComposing, isTouchOnly } from './keys';
import { renderMarkdown } from './markdown';
import { lookupRef, useRefs } from './refcache';
import { pageHref, plainRefs, refIds, splitRefs } from './refs';
import type { Page } from './refs';
import type { ChipEnv } from './refs';
import { dateOnly, dateTime } from './time';

// ---------- routing (hash based, so it works from any static host path) ----------

/** The hash without an overlay's suffix ("?preview=..."): the page under it. */
export const routePath = () => location.hash.replace(/\?.*$/, '');
const readRoute = () => (routePath().replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);

export function useRoute(): string[] {
  const [parts, setParts] = useState(readRoute);
  const last = useRef(routePath());
  useEffect(() => {
    const f = () => {
      // Only an overlay's suffix came or went (a preview opened or closed over the page): the page stays as it is.
      if (routePath() === last.current) return;
      last.current = routePath();
      setParts(readRoute());
      window.scrollTo(0, 0);
    };
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return parts;
}
export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`;
export const go = (...parts: string[]) => {
  location.hash = href(...parts);
};

/**
 * A preview open over the current page: "?preview=<id>" after the page's hash (and "&project=<id>" when the page is
 * not that project's). Opening pushes a history entry, so Back closes it and the page stays where it was.
 */
export const PREVIEW_EVENT = 'helm-preview';
const hashProject = (h: string) => {
  const m = /^#\/p\/([^/?]+)/.exec(h)?.[1];
  return m ? decodeURIComponent(m) : null;
};
export function previewInHash(): { pid: string; id: string } | null {
  const q = /\?(.*)$/.exec(location.hash)?.[1];
  if (!q) return null;
  const sp = new URLSearchParams(q);
  const id = sp.get('preview');
  const pid = sp.get('project') ?? hashProject(location.hash);
  return id && pid ? { pid, id } : null;
}
export function previewHash(base: string, pid: string, id: string) {
  const sp = new URLSearchParams({ preview: id });
  if (hashProject(base) !== pid) sp.set('project', pid);
  return `${base || '#/'}?${sp}`;
}
/** Every Open on a preview: the viewer over the current page (PreviewHost in more.tsx). */
export function openPreview(pid: string, id: string) {
  const cur = previewInHash();
  if (cur?.pid === pid && cur.id === id) return;
  const url = previewHash(routePath(), pid, id);
  if (cur) history.replaceState(history.state, '', url);
  else history.pushState({ helmPreview: true }, '', url);
  dispatchEvent(new Event(PREVIEW_EVENT));
}
export function closePreview() {
  if (!previewInHash()) return;
  // Opened here: step back off its entry, as the Back button does. Opened from a link: drop the suffix in place.
  if (history.state?.helmPreview) history.back();
  else {
    history.replaceState(null, '', routePath() || '#/');
    dispatchEvent(new Event(PREVIEW_EVENT));
  }
}

// ---------- formatting ----------

export function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return dateOnly(ts, true);
}
/** "Nov 18, 12:52 pm" (time.ts has the other forms). */
export const clock = dateTime;

/** Re-render periodically so "5 min ago" labels stay honest. */
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export const modelLabel = (id: string) =>
  ({ 'claude-fable-5-2': 'Fable 5.2', 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' })[id] ?? id;

/**
 * "Skilled · Opus 5.5", or "Light · Haiku 5.5 · low effort": the tier an agent runs at now, with its model, and its
 * effort only when it is not the model's default (so the status beside it has room at 390 px).
 */
export function runLabel(a: { run_tier_name?: string; run_model?: string; run_effort?: string }): string {
  if (!a.run_tier_name || !a.run_model) return '';
  return `${a.run_tier_name} · ${modelLabel(a.run_model)}${a.run_effort ? ` · ${a.run_effort} effort` : ''}`;
}

// ---------- icons ----------

const PATHS: Record<string, string> = {
  overview: 'M4 5h16M4 12h16M4 19h10',
  spec: 'M6 3.5h8.5L19 8v12.5H6zM14.5 3.5V8H19M9 12h7M9 15.5h7M9 19h4',
  agents: 'M12 4v5m0 0H6v5m6-5h6v5M4 14h4v5H4zm6 0h4v5h-4zm6 0h4v5h-4z',
  inbox: 'M4 13l2.5-8h11L20 13v6H4v-6zm0 0h5l1 2.5h4l1-2.5h5',
  previews: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 3-3L20 16M9 9.2a.6.6 0 100 .01',
  gallery: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 3-3L20 16M9 9.2a.6.6 0 100 .01',
  // A sticky note with a folded corner: the Ideas board.
  ideas: 'M5 4h14v10l-6 6H5zM13 20v-6h6M8.5 8.5h7M8.5 12h4',
  history: 'M12 7v5l3.5 2M4.5 12a7.5 7.5 0 107.5-7.5A7.6 7.6 0 005.6 8M4 4.5V8h3.5',
  setup: 'M5 7h9m4 0h1M5 17h3m4 0h7M14 5v4M8 15v4',
  back: 'M14.5 5.5L8 12l6.5 6.5',
  plus: 'M12 5v14M5 12h14',
  clip: 'M16.5 8.5l-6.8 6.8a1.6 1.6 0 002.3 2.3l7-7a3.4 3.4 0 00-4.8-4.8l-7.1 7.1a5.2 5.2 0 007.4 7.4l5.3-5.3',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14',
  send: 'M5 12l14-7-5 14-2.5-5.5L5 12z',
  stop: 'M7 7h10v10H7z',
  pause: 'M9 5.5v13M15 5.5v13',
  play: 'M8 5.5v13l10.5-6.5L8 5.5z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 6l6 6-6 6',
  folder: 'M3.5 7h6l2 2.5h9V19h-17z',
  share: 'M12 15V4M8 8l4-4 4 4M5 12v7.5h14V12',
  external: 'M14 5h5v5M19 5l-8 8M11 7H5v12h12v-6',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12',
  discuss: 'M4.5 5h15v10.5H10L5.5 19.5v-4H4.5z',
  tasks: 'M10.5 6.5H20M10.5 12H20M10.5 17.5H20M4 6.5l1.5 1.5L8 5.5M4 12l1.5 1.5L8 11M4 17.5L5.5 19 8 16.5',
  edit: 'M5 19l1-4L16.5 4.5l3 3L9 18l-4 1z',
  home: 'M4 11.5L12 5l8 6.5V19h-5.5v-5h-5v5H4z',
  skip: 'M5.5 6l7 6-7 6zM16.5 6v12',
  more: 'M5 12a1.4 1.4 0 102.8 0 1.4 1.4 0 10-2.8 0M10.6 12a1.4 1.4 0 102.8 0 1.4 1.4 0 10-2.8 0M16.2 12a1.4 1.4 0 102.8 0 1.4 1.4 0 10-2.8 0',
  pin: 'M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7',
  top: 'M6 5h12M12 9v10M7.5 13.5L12 9l4.5 4.5',
  telemetry: 'M4 19.5h16M5 15l4-4.5 3.5 3L19 6',
  watches: 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 9.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z',
  hosts: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01M11 8h5.5M11 16h5.5',
  toolbox: 'M4 9h16v10H4zM9 9V6.5h6V9M4 13h16M11 12v2.5h2V12',
  reports: 'M6 3.5h8.5L18 7v13.5H6zM14 3.5V7.5h4M9 12h6M9 15.5h6M9 8.5h2.5',
  github: 'M9 19c-4 1.3-4-2-6-2.5m12 4.5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  bell: 'M6 16v-5a6 6 0 0112 0v5l1.5 2h-15zM10 20.5a2 2 0 004 0',
  clock: 'M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zM12 7.5V12l3 2',
  alert: 'M12 4L21 19.5H3zM12 10v4.5M12 17h.01',
  search: 'M10.5 4a6.5 6.5 0 110 13 6.5 6.5 0 010-13zM15.3 15.3L20 20',
  knowledge: 'M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0012 3z',
  dashboards: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  refresh: 'M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5v4h-4',
  releases: 'M3.5 12.5V3.5h9l8 8-9 9zM8 8h.01',
  ship: 'M4 8.5L12 4l8 4.5V19H4zM12 16.5V10m-3 3l3-3 3 3',
  // A circle with a minus: take a task out of the queue.
  unschedule: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12h8',
  disk: 'M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5v11c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5zM4 6.5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
};

/** Icons come in two sizes (Quieter system): 20 in buttons and navigation (the default), 16 beside text. */
export function Icon({ name, size = 20 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

// ---------- small pieces ----------

const iconHtml = (name: string) =>
  `<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name] ?? PATHS.file}"/></svg>`;
/** The project the page is in, for [[page:...]] links. */
const routeProject = () => /^#\/p\/([^/]+)/.exec(location.hash)?.[1] ?? null;

/**
 * Agent or user text as markdown. References to Helm items ([[id]], [[id|label]], [[page:name]], bare ids) show as
 * chips with the item's current title and state that open it in the app (web/src/refs.ts, refcache.ts).
 */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const ids = useMemo(() => refIds(text ?? ''), [text]);
  const v = useRefs(ids);
  const html = useMemo(() => {
    const env: ChipEnv = { resolve: lookupRef, projectId: routeProject() && decodeURIComponent(routeProject()!), icon: iconHtml };
    return DOMPurify.sanitize(renderMarkdown(text ?? '', env));
  }, [text, v]);
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** One line of agent text with references as their titles, for rows and summaries shown as plain text. */
export function usePlainRefs(text: string): string {
  const ids = useMemo(() => refIds(text ?? ''), [text]);
  useRefs(ids);
  return plainRefs(text ?? '', lookupRef);
}
/** Component form of usePlainRefs, for use inside lists. */
export function PlainRefs({ text, strip = false }: { text: string; strip?: boolean }) {
  const t = usePlainRefs(text);
  return <>{strip ? t.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim() : t}</>;
}

/** Plain text whose references are links showing the item's title (no chip, no state): table cells, chart items. */
export function RefLinks({ text }: { text: string }) {
  const ids = useMemo(() => refIds(text ?? ''), [text]);
  useRefs(ids);
  if (!ids.length && !text.includes('[[page:')) return <>{text}</>;
  const project = routeProject() && decodeURIComponent(routeProject()!);
  return (
    <>
      {splitRefs(text).map((p, i) => {
        if (typeof p === 'string') return p;
        const words = plainRefs(`[[${p.id}${p.label ? `|${p.label}` : ''}]]`, lookupRef);
        const to = p.id.startsWith('page:') ? pageHref(p.id.slice(5) as Page, project) : lookupRef(p.id)?.href;
        return to ? (
          <a key={i} className="ref-link" href={to}>
            {words}
          </a>
        ) : (
          words
        );
      })}
    </>
  );
}

/** Long markdown clipped to a few lines with a "Show more" toggle. */
/**
 * The last text a clamped box shows: its last text node whose last line is inside the box (clamped-off lines are
 * laid out beyond its bottom edge). Null when nothing shows.
 */
function lastShown(box: HTMLElement): Text | null {
  const bottom = box.getBoundingClientRect().bottom + 2;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  const range = document.createRange();
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.nodeValue?.trim()) continue;
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (rects.length && rects[0].bottom <= bottom) last = n;
  }
  return last;
}

/**
 * A clamp that never cuts right after a reference chip: when the last words shown are a chip (or a chip and the
 * punctuation after it), that chip is left out, so the excerpt ends in words and the clamp's ellipsis.
 */
function useChipSafeClamp(box: React.RefObject<HTMLDivElement | null>, active: boolean, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !active) return;
    const fix = () => {
      el.querySelectorAll<HTMLElement>('[data-clamp-hid]').forEach((n) => {
        n.style.display = '';
        n.removeAttribute('data-clamp-hid');
      });
      for (let i = 0; i < 6; i++) {
        const chip = lastShown(el)?.parentElement?.closest<HTMLElement>('.ref-wrap, a.ref');
        if (!chip || !el.contains(chip)) return;
        chip.style.display = 'none';
        chip.setAttribute('data-clamp-hid', '1');
        // Nothing but chips before it: leave it as it was.
        if (!lastShown(el)) {
          chip.style.display = '';
          chip.removeAttribute('data-clamp-hid');
          return;
        }
      }
    };
    fix();
    const ro = new ResizeObserver(fix);
    ro.observe(el);
    return () => ro.disconnect();
  }, [active, ...deps]);
}

export function Clamp({ text, lines = 6, initiallyOpen = false }: { text: string; lines?: number; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const long = text.length > lines * 90 || text.split('\n').length > lines;
  const box = useRef<HTMLDivElement>(null);
  useChipSafeClamp(box, !open && long, [text, lines]);
  return (
    <div className="clamp-box">
      <div ref={box} className={!open && long ? 'clamp' : ''} style={{ ['--lines' as any]: lines }}>
        <Markdown text={text} />
      </div>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * Any content cut to a few lines, with Show more when it is longer: History's entries can hold an agent's whole
 * brief, and unclamped they made the page tens of thousands of pixels tall on a phone.
 */
export function ClampBox({ lines = 4, children, className = '', open: startOpen = false }: { lines?: number; children: ReactNode; className?: string; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, children]);
  return (
    <div className={`clamp-box ${className}`}>
      <div ref={box} className={open ? '' : 'clamp-lines'} style={{ ['--lines' as any]: lines }}>
        {children}
      </div>
      {(long || open) && (
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export function Progress({ value, tone = '' }: { value: number | null; tone?: string }) {
  return (
    <div className={`progress ${tone}`} role="progressbar" aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${value ?? 0}%` }} />
    </div>
  );
}

/**
 * A worklist's progress as a thin line along the bottom edge of its card or row, like the project's line under the
 * top bar. The parent must be position: relative; the line follows its rounded corners. Nothing without a worklist.
 */
export function EdgeProgress({ value, live = false }: { value: number | null | undefined; live?: boolean }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="edge-progress" role="progressbar" aria-label="Worklist progress" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className={live ? 'live' : ''} style={{ width: `${value}%` }} />
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  working: 'Working',
  waiting: 'Waiting on you',
  idle: 'Idle',
  done: 'Done',
  closed: 'Closed',
  error: 'Error',
  interrupted: 'Stopped',
};
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

const IMPORTANCE = ['', 'Minor', 'Low', 'Medium', 'High', 'Critical'];
export function Importance({ value }: { value: number }) {
  return (
    // The shared importance chip (styles.css shared block): plain muted text, High in the accent, Critical filled.
    <span className={`tag imp imp-l${value}`} title={`Importance: ${IMPORTANCE[value]}`}>
      {IMPORTANCE[value]}
    </span>
  );
}
export const importanceName = (n: number) => IMPORTANCE[n];

export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

/**
 * The page header (Quieter system): the page's title on the left and its actions, small secondary buttons, on the
 * right. Every page uses it; a page never makes its own heading row.
 */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-head page-head">
      <h1 className="page-title">{title}</h1>
      {children && <span className="page-head-actions">{children}</span>}
    </div>
  );
}

/**
 * The row (Quieter system): a title, one muted line under it, and what it leads to on the right; at least 44 px tall.
 * Rows sit in one card, separated by lines. href makes the whole row a link.
 */
export function Row({ title, line, end, href: to, onClick }: { title: ReactNode; line?: ReactNode; end?: ReactNode; href?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="row-item-text">
        <span className="row-item-title">{title}</span>
        {line && <span className="row-item-line">{line}</span>}
      </span>
      {end ?? (to || onClick ? <Icon name="chevron" size={16} /> : null)}
    </>
  );
  if (to) return <a className="row-item" href={to}>{body}</a>;
  if (onClick) return <button type="button" className="row-item" onClick={onClick}>{body}</button>;
  return <div className="row-item">{body}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Chips<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; count?: number }[] }) {
  return (
    <div className="chips" role="tablist">
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'chip on' : 'chip'} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count !== undefined && <span className="chip-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

let locks = 0;
let lockedAt = 0;
/**
 * Keeps the page still while an overlay (sheet, lightbox, annotation editor) is open. overflow: hidden on the body
 * does not stop iOS Safari scrolling the page behind a fixed overlay (and html's overflow-x: clip keeps it from
 * reaching the viewport anyway), so the body is pinned with position: fixed at its scroll offset and put back where
 * it was on close. Counted, so overlays can stack.
 */
export function useScrollLock(on = true) {
  useEffect(() => {
    if (!on) return;
    const body = document.body.style;
    if (locks++ === 0) {
      lockedAt = window.scrollY;
      document.body.classList.add('no-scroll');
      body.top = `-${lockedAt}px`;
    }
    return () => {
      if (--locks > 0) return;
      document.body.classList.remove('no-scroll');
      body.top = '';
      window.scrollTo({ top: lockedAt, behavior: 'instant' });
    };
  }, [on]);
}

/** `head`: a header of the caller's own in place of the title and close button (the chat's thread switcher). */
export function Sheet({ title, onClose, children, wide = false, className = '', head, swipeDown = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; head?: ReactNode; swipeDown?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  useScrollLock();
  // swipeDown: a finger dragging the header down pulls the sheet with it and closes it past 90 px.
  const [pull, setPull] = useState(0);
  const start = useRef<{ id: number; y: number } | null>(null);
  const drag = swipeDown
    ? {
        style: { touchAction: 'none' as const },
        onPointerDown: (e: RPointerEvent) => {
          if (e.pointerType !== 'touch' || (e.target as Element).closest('button, a')) return;
          start.current = { id: e.pointerId, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        },
        onPointerMove: (e: RPointerEvent) => {
          if (start.current?.id === e.pointerId) setPull(Math.max(0, e.clientY - start.current.y));
        },
        onPointerUp: (e: RPointerEvent) => {
          if (start.current?.id !== e.pointerId) return;
          const close = e.type === 'pointerup' && e.clientY - start.current.y > 90;
          start.current = null;
          setPull(0);
          if (close) onClose();
        },
        onPointerCancel: () => {
          start.current = null;
          setPull(0);
        },
      }
    : {};
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'sheet-wide' : ''} ${className}`} role="dialog" aria-label={title} style={pull ? { transform: `translateY(${pull}px)` } : undefined}>
        {head ?? (
          <header className="sheet-head" {...drag}>
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" />
            </button>
          </header>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * The message box under a thread. With `attachTo` (a project id) it also takes files: the paperclip opens the
 * picker, an image pasted into the box or files dropped on it are added, each uploads at once with its progress,
 * and the message is sent with the ids of those that finished.
 */
export function Composer({
  placeholder,
  onSend,
  cta = 'Send',
  attachTo,
  second,
  draftKey,
}: {
  placeholder: string;
  /** Where the typed text is kept until it is sent (drafts.ts): per task, per agent, per project. */
  draftKey?: string;
  onSend: (text: string, attachments: string[]) => Promise<unknown>;
  cta?: string;
  attachTo?: string;
  /** A second way to send the same text (a running task's Interject), beside the main one. */
  second?: { label: string; onSend: (text: string, attachments: string[]) => Promise<unknown>; empty?: boolean };
}) {
  const [text, setText] = useStoredText(draftKey ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useAttachDraft(attachTo, null, draftKey ?? null);
  const canSend = (!!text.trim() || draft.ready.length > 0) && !busy && !draft.uploading;
  // A kept draft comes back at its full height.
  useEffect(() => {
    const el = ref.current;
    if (el && text) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, []);
  const send = async (how = onSend, empty = false) => {
    const t = text.trim();
    if (!canSend && !(empty && !busy && !draft.uploading)) return;
    const files = draft.ready;
    setBusy(true);
    setError('');
    // Clear at once so the message reads as sent; put it back if sending fails.
    setText('');
    if (ref.current) ref.current.style.height = '';
    try {
      await how(t, files.map((a) => a.id));
      draft.clear();
    } catch (err: any) {
      setText(t);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`composer ${attachTo ? 'with-attach' : ''} ${second ? 'two' : ''} ${over ? 'drop-over' : ''}`}
      {...(attachTo ? dropTarget(draft, setOver) : {})}
    >
      {attachTo && <AttachTray items={draft.items} onRemove={draft.drop} />}
      {attachTo && <AttachButton draft={draft} className="icon-btn composer-attach" label="Attach photos or files" />}
      <textarea
        ref={ref}
        value={text}
        placeholder={placeholder}
        rows={1}
        onChange={(e) => {
          setText(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
        }}
        onPaste={attachTo ? pasteInto(draft) : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (enterSends({ key: e.key, shift: e.shiftKey, composing: isComposing(e), empty: !text.trim() && draft.ready.length === 0, touchOnly: isTouchOnly() })) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {second && (
        <button className="btn composer-second" disabled={!canSend && !(second.empty && !busy)} onClick={() => send(second.onSend, !!second.empty)}>
          {second.label}
        </button>
      )}
      <button className="btn primary composer-send" aria-label={cta} disabled={!canSend} onClick={() => send()}>
        <Icon name="send" size={16} />
        <span>{busy ? 'Sending' : draft.uploading ? 'Uploading' : cta}</span>
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** Runs an async action from a button, showing failure inline. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// ---------- chart ----------

export type ChartSpec = { type?: 'line' | 'bar' | 'stacked' | 'area'; labels?: (string | number)[]; series: { name?: string; values: number[] }[]; unit?: string; title?: string };

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.999; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/**
 * Line, grouped-bar, stacked-bar or stacked-area chart (area: each series piles on the ones before it, as a cumulative
 * flow does). Series colours come from
 * a fixed validated order (see styles.css --series-N); more than six series
 * are not drawn, the table below the chart carries them (table: false leaves the table to the caller).
 */
export function Chart({ spec, compact = false, width = 640, height, table = true }: { spec: ChartSpec; compact?: boolean; width?: number; height?: number; table?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = spec.series.slice(0, 6);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const labels = Array.from({ length: n }, (_, i) => String(spec.labels?.[i] ?? i + 1));
  const type = spec.type === 'bar' ? 'bar' : spec.type === 'stacked' ? 'stacked' : spec.type === 'area' ? 'area' : 'line';
  const piled = type === 'stacked' || type === 'area';
  // Stacked: each label's values pile up (positive values only make sense stacked; negatives start from 0 downwards).
  const stack = (sign: 1 | -1) => Array.from({ length: n }, (_, i) => series.reduce((t, s) => t + (Number.isFinite(s.values[i]) && Math.sign(s.values[i]) === sign ? s.values[i] : 0), 0));
  // A narrower drawing (a dashboard tile on a phone) keeps its text readable when scaled to the box.
  const W = width;
  const H = height ?? (compact ? 480 : width < 640 ? 260 : 320);
  const pad = { l: compact ? 40 : 46, r: compact ? 40 : type === 'line' && series.length <= 4 ? 84 : 14, t: compact ? 60 : 12, b: compact ? 60 : 30 };
  const all = (piled ? [...stack(1), ...stack(-1)] : series.flatMap((s) => s.values)).filter((v) => Number.isFinite(v));
  if (!all.length || !n) return <Empty title="Chart has no data" />;
  const bars = type === 'bar' || type === 'stacked';
  const fromZero = bars || type === 'area';
  const lo = fromZero ? Math.min(0, ...all) : Math.min(...all);
  const hi = Math.max(...all);
  const ticks = niceTicks(fromZero ? lo : lo - (hi - lo) * 0.08, hi);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const band = iw / n;
  const x = (i: number) => (bars ? pad.l + band * (i + 0.5) : n === 1 ? pad.l + iw / 2 : pad.l + (iw * i) / (n - 1));
  const labelEvery = Math.ceil(n / (iw / 70));
  const unit = spec.unit ? ` ${spec.unit}` : '';

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = bars ? Math.floor((px - pad.l) / band) : Math.round(((px - pad.l) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  const barW = type === 'stacked' ? Math.max(2, Math.min(compact ? 90 : 48, band * 0.6)) : Math.max(2, Math.min(compact ? 90 : 34, (band * 0.72) / series.length - 2));
  // Stacked bars: where each segment starts, per label and sign.
  const base = { up: Array(n).fill(0) as number[], down: Array(n).fill(0) as number[] };

  return (
    <figure className={`chart ${compact ? 'chart-compact' : ''}`}>
      {!compact && series.length > 1 && (
        <figcaption className="chart-legend">
          {series.map((s, k) => (
            <span key={k}>
              <i style={{ background: `var(--series-${k + 1})` }} />
              {s.name ?? `Series ${k + 1}`}
            </span>
          ))}
        </figcaption>
      )}
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={spec.title ?? 'Chart'}>
          {!compact &&
            ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
                <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" className="tick">
                  {fmt(t)}
                </text>
              </g>
            ))}
          {!compact && labels.map((l, i) => (i % labelEvery === 0 ? <text key={i} x={x(i)} y={H - 9} textAnchor="middle" className="tick">{l.length > 12 ? `${l.slice(0, 11)}…` : l}</text> : null))}
          {hover !== null && !bars && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="crosshair" />}
          {hover !== null && bars && <rect x={pad.l + band * hover} y={pad.t} width={band} height={ih} className="hover-band" />}
          {type === 'area'
            ? (() => {
                // Each series is the band between the total of those before it and the total with it.
                const below = Array(n).fill(0) as number[];
                return series.map((s, k) => {
                  const lower = below.slice();
                  const upper = lower.map((b, i) => b + (Number.isFinite(s.values[i]) ? Math.max(0, s.values[i]) : 0));
                  upper.forEach((v, i) => (below[i] = v));
                  const top = upper.map((v, i) => `${x(i)},${y(v)}`);
                  const bottom = lower.map((v, i) => `${x(i)},${y(v)}`).reverse();
                  return (
                    <g key={k}>
                      <polygon points={[...top, ...bottom].join(' ')} fill={`var(--series-${k + 1})`} opacity={0.8} />
                      <polyline points={top.join(' ')} fill="none" stroke={`var(--series-${k + 1})`} strokeWidth={compact ? 4 : 1.5} strokeLinejoin="round" />
                    </g>
                  );
                });
              })()
            : type === 'line'
            ? series.map((s, k) => {
                const pts = s.values.map((v, i) => (Number.isFinite(v) ? `${x(i)},${y(v)}` : null)).filter(Boolean);
                const last = s.values.length - 1;
                return (
                  <g key={k}>
                    <polyline points={pts.join(' ')} fill="none" stroke={`var(--series-${k + 1})`} strokeWidth={compact ? 5 : 2} strokeLinejoin="round" strokeLinecap="round" />
                    {n <= 24 && !compact && s.values.map((v, i) => (Number.isFinite(v) ? <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} fill={`var(--series-${k + 1})`} stroke="var(--chart-surface)" strokeWidth="2" /> : null))}
                    {!compact && series.length <= 4 && Number.isFinite(s.values[last]) && (
                      <text x={x(last) + 9} y={y(s.values[last]) + 4} className="end-label">
                        {series.length > 1 ? `${(s.name ?? '').slice(0, 9)} ` : ''}
                        {fmt(s.values[last])}
                      </text>
                    )}
                  </g>
                );
              })
            : series.map((s, k) =>
                s.values.map((v, i) => {
                  if (!Number.isFinite(v)) return null;
                  let from = 0;
                  if (type === 'stacked') {
                    const side = v >= 0 ? 'up' : 'down';
                    from = base[side][i];
                    base[side][i] += v;
                  }
                  const cx = type === 'stacked' ? x(i) : x(i) + (k - (series.length - 1) / 2) * (barW + 2);
                  const top = Math.min(y(from + v), y(from));
                  const h = Math.max(1, Math.abs(y(from + v) - y(from)));
                  const r = type === 'stacked' ? Math.min(1.5, h) : Math.min(4, barW / 2, h);
                  const up = v >= 0;
                  const d = up
                    ? `M${cx - barW / 2},${top + h} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${top + h} Z`
                    : `M${cx - barW / 2},${top} V${top + h - r} Q${cx - barW / 2},${top + h} ${cx - barW / 2 + r},${top + h} H${cx + barW / 2 - r} Q${cx + barW / 2},${top + h} ${cx + barW / 2},${top + h - r} V${top} Z`;
                  return <path key={`${k}-${i}`} d={d} fill={`var(--series-${k + 1})`} opacity={hover === null || hover === i ? 1 : 0.55} />;
                }),
              )}
        </svg>
        {hover !== null && !compact && (
          <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }} data-side={x(hover) > W * 0.6 ? 'left' : 'right'}>
            <strong>{labels[hover]}</strong>
            {series.map((s, k) => (
              <span key={k}>
                <i style={{ background: `var(--series-${k + 1})` }} />
                {series.length > 1 ? `${s.name ?? `Series ${k + 1}`}: ` : ''}
                {Number.isFinite(s.values[hover]) ? `${fmt(s.values[hover])}${unit}` : '—'}
              </span>
            ))}
          </div>
        )}
      </div>
      {!compact && table && (
        <details className="chart-table">
          <summary>Data table{spec.series.length > 6 ? ` (all ${spec.series.length} series; the chart shows the first 6)` : ''}</summary>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th />
                  {spec.series.map((s, k) => (
                    <th key={k}>{s.name ?? `Series ${k + 1}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {labels.map((l, i) => (
                  <tr key={i}>
                    <th>{l}</th>
                    {spec.series.map((s, k) => (
                      <td key={k}>{Number.isFinite(s.values[i]) ? `${fmt(s.values[i])}${unit}` : '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

export function parseChart(content: string | null): ChartSpec | null {
  try {
    const spec = JSON.parse(content ?? '');
    return Array.isArray(spec?.series) ? spec : null;
  } catch {
    return null;
  }
}
