import DOMPurify from 'dompurify';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AttachButton, AttachTray, dropTarget, pasteInto, useAttachDraft } from './attachments';
import { renderMarkdown } from './markdown';
import { lookupRef, useRefs } from './refcache';
import { plainRefs, refIds } from './refs';
import type { ChipEnv } from './refs';

// ---------- routing (hash based, so it works from any static host path) ----------

export function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const f = () => {
      setParts(read());
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

// ---------- formatting ----------

export function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export const clock = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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

// ---------- icons ----------

const PATHS: Record<string, string> = {
  overview: 'M4 5h16M4 12h16M4 19h10',
  spec: 'M6 3.5h8.5L19 8v12.5H6zM14.5 3.5V8H19M9 12h7M9 15.5h7M9 19h4',
  agents: 'M12 4v5m0 0H6v5m6-5h6v5M4 14h4v5H4zm6 0h4v5h-4zm6 0h4v5h-4z',
  inbox: 'M4 13l2.5-8h11L20 13v6H4v-6zm0 0h5l1 2.5h4l1-2.5h5',
  previews: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 3-3L20 16M9 9.2a.6.6 0 100 .01',
  history: 'M12 7v5l3.5 2M4.5 12a7.5 7.5 0 107.5-7.5A7.6 7.6 0 005.6 8M4 4.5V8h3.5',
  setup: 'M5 7h9m4 0h1M5 17h3m4 0h7M14 5v4M8 15v4',
  back: 'M14.5 5.5L8 12l6.5 6.5',
  plus: 'M12 5v14M5 12h14',
  clip: 'M16.5 8.5l-6.8 6.8a1.6 1.6 0 002.3 2.3l7-7a3.4 3.4 0 00-4.8-4.8l-7.1 7.1a5.2 5.2 0 007.4 7.4l5.3-5.3',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  download: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14',
  send: 'M5 12l14-7-5 14-2.5-5.5L5 12z',
  stop: 'M7 7h10v10H7z',
  play: 'M8 5.5v13l10.5-6.5L8 5.5z',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 6l6 6-6 6',
  folder: 'M3.5 7h6l2 2.5h9V19h-17z',
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
  hosts: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01M11 8h5.5M11 16h5.5',
  toolbox: 'M4 9h16v10H4zM9 9V6.5h6V9M4 13h16M11 12v2.5h2V12',
  reports: 'M6 3.5h8.5L18 7v13.5H6zM14 3.5V7.5h4M9 12h6M9 15.5h6M9 8.5h2.5',
  github: 'M9 19c-4 1.3-4-2-6-2.5m12 4.5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  terminal: 'M4 5h16v14H4zM7.5 9.5l3 2.5-3 2.5M12.5 15h4',
  bell: 'M6 16v-5a6 6 0 0112 0v5l1.5 2h-15zM10 20.5a2 2 0 004 0',
  alert: 'M12 4L21 19.5H3zM12 10v4.5M12 17h.01',
  disk: 'M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5v11c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5zM4 6.5c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
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

/** Long markdown clipped to a few lines with a "Show more" toggle. */
export function Clamp({ text, lines = 6, initiallyOpen = false }: { text: string; lines?: number; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const long = text.length > lines * 90 || text.split('\n').length > lines;
  return (
    <div className="clamp-box">
      <div className={!open && long ? 'clamp' : ''} style={{ ['--lines' as any]: lines }}>
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
    <span className={`importance imp-${value}`} title={`Importance: ${IMPORTANCE[value]}`}>
      <span className="pips" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((n) => (
          <i key={n} className={n <= value ? 'on' : ''} />
        ))}
      </span>
      {IMPORTANCE[value]}
    </span>
  );
}
export const importanceName = (n: number) => IMPORTANCE[n];

export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone}`}>{children}</span>;
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
export function Sheet({ title, onClose, children, wide = false, className = '', head }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; head?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  useScrollLock();
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'sheet-wide' : ''} ${className}`} role="dialog" aria-label={title}>
        {head ?? (
          <header className="sheet-head">
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
}: {
  placeholder: string;
  onSend: (text: string, attachments: string[]) => Promise<unknown>;
  cta?: string;
  attachTo?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useAttachDraft(attachTo);
  const canSend = (!!text.trim() || draft.ready.length > 0) && !busy && !draft.uploading;
  const send = async () => {
    const t = text.trim();
    if (!canSend) return;
    const files = draft.ready;
    setBusy(true);
    setError('');
    // Clear at once so the message reads as sent; put it back if sending fails.
    setText('');
    if (ref.current) ref.current.style.height = '';
    try {
      await onSend(t, files.map((a) => a.id));
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
      className={`composer ${attachTo ? 'with-attach' : ''} ${over ? 'drop-over' : ''}`}
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
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <button className="btn primary composer-send" aria-label={cta} disabled={!canSend} onClick={send}>
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

export type ChartSpec = { type?: 'line' | 'bar'; labels?: (string | number)[]; series: { name?: string; values: number[] }[]; unit?: string; title?: string };

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
 * Line or grouped-bar chart for agent-posted results. Series colours come from
 * a fixed validated order (see styles.css --series-N); more than six series
 * are not drawn, the table below the chart carries them.
 */
export function Chart({ spec, compact = false }: { spec: ChartSpec; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = spec.series.slice(0, 6);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const labels = Array.from({ length: n }, (_, i) => String(spec.labels?.[i] ?? i + 1));
  const type = spec.type === 'bar' ? 'bar' : 'line';
  const W = 640;
  const H = compact ? 480 : 320;
  const pad = { l: compact ? 40 : 46, r: compact ? 40 : type === 'line' && series.length <= 4 ? 84 : 14, t: compact ? 60 : 12, b: compact ? 60 : 30 };
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!all.length || !n) return <Empty title="Chart has no data" />;
  const lo = type === 'bar' ? Math.min(0, ...all) : Math.min(...all);
  const hi = Math.max(...all);
  const ticks = niceTicks(type === 'bar' ? lo : lo - (hi - lo) * 0.08, hi);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const band = iw / n;
  const x = (i: number) => (type === 'bar' ? pad.l + band * (i + 0.5) : n === 1 ? pad.l + iw / 2 : pad.l + (iw * i) / (n - 1));
  const labelEvery = Math.ceil(n / (iw / 70));
  const unit = spec.unit ? ` ${spec.unit}` : '';

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = type === 'bar' ? Math.floor((px - pad.l) / band) : Math.round(((px - pad.l) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };

  const barW = Math.max(2, Math.min(compact ? 90 : 34, (band * 0.72) / series.length - 2));

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
          {hover !== null && type === 'line' && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="crosshair" />}
          {hover !== null && type === 'bar' && <rect x={pad.l + band * hover} y={pad.t} width={band} height={ih} className="hover-band" />}
          {type === 'line'
            ? series.map((s, k) => {
                const pts = s.values.map((v, i) => (Number.isFinite(v) ? `${x(i)},${y(v)}` : null)).filter(Boolean);
                const last = s.values.length - 1;
                return (
                  <g key={k}>
                    <polyline points={pts.join(' ')} fill="none" stroke={`var(--series-${k + 1})`} strokeWidth={compact ? 5 : 2} strokeLinejoin="round" strokeLinecap="round" />
                    {n <= 24 && !compact && s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} fill={`var(--series-${k + 1})`} stroke="var(--chart-surface)" strokeWidth="2" />)}
                    {!compact && series.length <= 4 && (
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
                  const cx = x(i) + (k - (series.length - 1) / 2) * (barW + 2);
                  const top = Math.min(y(v), y(0));
                  const h = Math.max(1, Math.abs(y(v) - y(0)));
                  const r = Math.min(4, barW / 2, h);
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
      {!compact && (
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
