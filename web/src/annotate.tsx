import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api';
import type { Attachment } from './api';
import { uploadFiles } from './attachments';
import { Icon, clock, go, useScrollLock } from './ui';
import { openViewer } from './viewer';
import { clampView as clampTo, pinchStart, pinchView, zoomAround } from './zoom';
import type { PinchStart, View } from './zoom';

/**
 * Feedback drawn on images (server/annotations.ts). The user opens an image (a preview, one side of a comparison, a
 * guide step's screenshot, an attached image) in a full-screen editor, draws marks and drops numbered notes, and
 * sends it to a task's thread or to the director. Marks are vector data in image coordinates (0-1); the same path
 * strings draw the SVG overlay on screen and the PNG with the marks burned in (canvas Path2D), so both match.
 * One host (AnnotatorHost, mounted once in main.tsx) shows the editor or the viewer of sent feedback over anything.
 */

export type MarkType = 'pen' | 'arrow' | 'rect' | 'ellipse';
export type Mark = { id: string; type: MarkType; color: string; points: [number, number][] };
export type Note = { id: string; x: number; y: number; text: string; mark: string | null };
export type AnnSource = { kind: 'preview' | 'attachment'; id: string; side?: string };
type ThreadRef = { id: string; title: string; kind: 'task' | 'discussion'; state: string };
export type Annotation = {
  id: string;
  project_id: string;
  source: { kind: 'preview' | 'attachment'; id: string; side: string };
  title: string;
  width: number;
  height: number;
  marks: Mark[];
  notes: Note[];
  comment: string;
  original: Attachment | null;
  flat: Attachment | null;
  task: ThreadRef | null;
  parent_id: string | null;
  created_at: number;
};
type Doc = { marks: Mark[]; notes: Note[] };

/** Few, high-contrast colours; each stroke also gets a dark outline so it reads on light and dark images. */
export const COLORS = [
  { id: '#ff375f', name: 'Red' },
  { id: '#ffd60a', name: 'Yellow' },
  { id: '#40c8e0', name: 'Cyan' },
  { id: '#ffffff', name: 'White' },
];
const DEFAULT_COLOR = COLORS[0].id;
const HALO = 'rgba(0,0,0,0.72)';
/** The long side of the marked-up PNG at most; larger images are scaled down to it. */
const MAX_FLAT = 2560;

// ---------- the host ----------

/** `to`: where Send defaults to (a task or discussion id, or 'director'), as when opened from the chat; `onSent` after sending. */
type EditOpts = { projectId: string; source: AnnSource; url: string; title: string; parent?: Annotation; to?: string; onSent?: (a: Annotation) => void };
type Open = ({ mode: 'edit' } & EditOpts) | { mode: 'view'; id: string };
let setOpenGlobal: ((o: Open | null) => void) | null = null;

/** Open the editor over an image. `url` is the image as shown; `parent` continues earlier feedback. */
export const openAnnotator = (o: EditOpts) => setOpenGlobal?.({ mode: 'edit', ...o });
/** Show sent feedback: the original with the marks over it, toggleable. */
export const openFeedback = (id: string) => setOpenGlobal?.({ mode: 'view', id });

export function AnnotatorHost() {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => {
    setOpenGlobal = setOpen;
    return () => {
      setOpenGlobal = null;
    };
  }, []);
  const isOpen = !!open;
  useScrollLock(isOpen);
  useEffect(() => {
    if (!isOpen) return;
    // No page scroll, rubber-banding or Safari page zoom under the editor.
    const root = document.documentElement;
    root.classList.add('ann-open');
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    return () => {
      root.classList.remove('ann-open');
      document.removeEventListener('gesturestart', stop);
    };
  }, [isOpen]);
  if (!open) return null;
  const close = () => setOpen(null);
  return createPortal(
    open.mode === 'edit' ? (
      <Editor key={`${open.source.kind}:${open.source.id}:${open.source.side ?? ''}:${open.parent?.id ?? ''}`} {...open} onClose={close} />
    ) : (
      <Viewer
        key={open.id}
        id={open.id}
        onClose={close}
        onContinue={(a) => setOpen({ mode: 'edit', projectId: a.project_id, source: { kind: a.source.kind, id: a.source.id, side: a.source.side }, url: a.original!.url, title: a.title, parent: a })}
      />
    ),
    document.body,
  );
}

// ---------- geometry, shared by the screen and the PNG ----------

export function markStyle(W: number, H: number) {
  const base = Math.max(W, H);
  const sw = Math.max(2, base * 0.0055);
  return { sw, halo: sw + Math.max(2.5, sw * 0.9), pin: Math.max(12, base * 0.021) };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** An SVG path for a mark in image pixels. Path2D takes the same string, so the PNG matches the screen. */
export function markPath(m: Mark, W: number, H: number, sw: number): string {
  const P = m.points.map(([x, y]) => [r1(x * W), r1(y * H)] as const);
  if (m.type === 'pen') {
    if (P.length === 1) return `M${P[0][0]} ${P[0][1]}l0.01 0`;
    let d = `M${P[0][0]} ${P[0][1]}`;
    for (let i = 1; i < P.length - 1; i++) d += `Q${P[i][0]} ${P[i][1]} ${r1((P[i][0] + P[i + 1][0]) / 2)} ${r1((P[i][1] + P[i + 1][1]) / 2)}`;
    const last = P[P.length - 1];
    return `${d}L${last[0]} ${last[1]}`;
  }
  const [[x0, y0], [x1, y1]] = P;
  if (m.type === 'rect') return `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
  if (m.type === 'ellipse') {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.max(0.5, Math.abs(x1 - x0) / 2);
    const ry = Math.max(0.5, Math.abs(y1 - y0) / 2);
    return `M${r1(cx - rx)} ${r1(cy)}a${r1(rx)} ${r1(ry)} 0 1 0 ${r1(2 * rx)} 0a${r1(rx)} ${r1(ry)} 0 1 0 ${r1(-2 * rx)} 0Z`;
  }
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const head = Math.min(Math.hypot(x1 - x0, y1 - y0) * 0.45, sw * 5);
  const wing = (a: number) => `${r1(x1 + head * Math.cos(a))} ${r1(y1 + head * Math.sin(a))}`;
  return `M${x0} ${y0}L${x1} ${y1}M${wing(ang + Math.PI * 0.8)}L${x1} ${y1}L${wing(ang - Math.PI * 0.8)}`;
}

/** Where a note attached to a mark sits: a corner of a box, the upper right of an ellipse, an arrow's tail. */
export function anchorOf(m: Mark): [number, number] {
  const xs = m.points.map((p) => p[0]);
  const ys = m.points.map((p) => p[1]);
  if (m.type === 'rect') return [Math.max(...xs), Math.min(...ys)];
  if (m.type === 'ellipse') {
    const cx = (xs[0] + xs[1]) / 2;
    const cy = (ys[0] + ys[1]) / 2;
    return [cx + (Math.abs(xs[1] - xs[0]) / 2) * 0.707, cy - (Math.abs(ys[1] - ys[0]) / 2) * 0.707];
  }
  return m.points[0];
}

const pinColor = (n: Note, marks: Mark[]) => marks.find((m) => m.id === n.mark)?.color ?? DEFAULT_COLOR;
const inkOn = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
};
const PIN_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

/** Draw marks and numbered pins onto a canvas context whose units are image pixels. */
function drawMarks(ctx: CanvasRenderingContext2D, W: number, H: number, marks: Mark[], notes: Note[]) {
  const st = markStyle(W, H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const m of marks) {
    const p = new Path2D(markPath(m, W, H, st.sw));
    ctx.strokeStyle = HALO;
    ctx.lineWidth = st.halo;
    ctx.stroke(p);
    ctx.strokeStyle = m.color;
    ctx.lineWidth = st.sw;
    ctx.stroke(p);
  }
  notes.forEach((n, i) => {
    const x = n.x * W;
    const y = n.y * H;
    const c = pinColor(n, marks);
    ctx.beginPath();
    ctx.arc(x, y, st.pin + st.sw * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = HALO;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, st.pin, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, st.sw * 0.35);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = inkOn(c);
    ctx.font = `700 ${Math.round(st.pin * (i >= 9 ? 1 : 1.2))}px ${PIN_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + st.pin * 0.06);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image.'));
    img.src = url;
  });
}

/** The image at its natural size (capped at MAX_FLAT on the long side) with the marks and pins drawn in, as PNG. */
export async function renderFlat(url: string, W: number, H: number, doc: Doc): Promise<Blob> {
  const img = await loadImage(url);
  const scale = Math.min(1, MAX_FLAT / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale);
  c.height = Math.round(H * scale);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  ctx.scale(scale, scale);
  drawMarks(ctx, W, H, doc.marks, doc.notes);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not draw the marked-up image.');
  return blob;
}

/** The marks over an image, as SVG in image pixels. */
function MarksLayer({
  W,
  H,
  doc,
  draft,
  selected,
  active,
  className = '',
  onPin,
}: {
  W: number;
  H: number;
  doc: Doc;
  draft?: Mark | null;
  selected?: string | null;
  active?: string | null;
  className?: string;
  onPin?: (id: string) => void;
}) {
  const st = markStyle(W, H);
  const list = draft ? [...doc.marks, draft] : doc.marks;
  return (
    <svg className={`ann-svg ${className}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden={!onPin}>
      {list.map((m) => {
        const d = markPath(m, W, H, st.sw);
        const sel = m.id === selected;
        return (
          <g key={m.id} className={sel ? 'sel' : ''}>
            {sel && <path d={d} fill="none" stroke="#ffffff" strokeOpacity={0.55} strokeWidth={st.halo + st.sw * 2.2} strokeLinecap="round" strokeLinejoin="round" />}
            <path d={d} fill="none" stroke={HALO} strokeWidth={st.halo} strokeLinecap="round" strokeLinejoin="round" />
            <path d={d} fill="none" stroke={m.color} strokeWidth={st.sw} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
      {doc.notes.map((n, i) => {
        const c = pinColor(n, doc.marks);
        const x = n.x * W;
        const y = n.y * H;
        return (
          <g key={n.id} className={`ann-pin ${n.id === active ? 'active' : ''}`} onClick={onPin ? () => onPin(n.id) : undefined}>
            {n.id === active && <circle cx={x} cy={y} r={st.pin * 1.75} fill="none" stroke="#ffffff" strokeWidth={st.sw * 0.7} className="ann-ring" />}
            <circle cx={x} cy={y} r={st.pin + st.sw * 0.6} fill={HALO} />
            <circle cx={x} cy={y} r={st.pin} fill={c} stroke="#ffffff" strokeWidth={Math.max(1.5, st.sw * 0.35)} />
            <text x={x} y={y + st.pin * 0.06} textAnchor="middle" dominantBaseline="central" fontSize={st.pin * (i >= 9 ? 1 : 1.2)} fontWeight={700} fontFamily={PIN_FONT} fill={inkOn(c)}>
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- hit testing (image pixels) ----------

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitMark(m: Mark, x: number, y: number, W: number, H: number, tol: number): boolean {
  const P = m.points.map(([a, b]) => [a * W, b * H]);
  if (m.type === 'pen' || m.type === 'arrow') {
    if (P.length === 1) return Math.hypot(x - P[0][0], y - P[0][1]) < tol;
    for (let i = 1; i < P.length; i++) if (distToSeg(x, y, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]) < tol) return true;
    return false;
  }
  const [[x0, y0], [x1, y1]] = P;
  const l = Math.min(x0, x1);
  const r = Math.max(x0, x1);
  const t = Math.min(y0, y1);
  const b = Math.max(y0, y1);
  if (m.type === 'rect') {
    const inside = x > l - tol && x < r + tol && y > t - tol && y < b + tol;
    const deep = x > l + tol && x < r - tol && y > t + tol && y < b - tol;
    return inside && !deep;
  }
  const rx = (r - l) / 2 || 1;
  const ry = (b - t) / 2 || 1;
  const v = Math.hypot((x - (l + r) / 2) / (rx + tol), (y - (t + b) / 2) / (ry + tol));
  const inner = Math.hypot((x - (l + r) / 2) / Math.max(1, rx - tol), (y - (t + b) / 2) / Math.max(1, ry - tol));
  return v <= 1 && inner >= 1;
}

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

/** Drop points closer than `min` (normalised) to the last kept one: a long stroke stays small. */
function thin(points: [number, number][], min: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push([Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
  }
  const end = points[points.length - 1];
  if (out.length > 1 && end && out[out.length - 1] !== end) out[out.length - 1] = end;
  return out;
}

// ---------- the editor ----------

type Tool = 'select' | MarkType | 'note';
const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select and move', key: 'v' },
  { id: 'pen', label: 'Pen', key: 'p' },
  { id: 'arrow', label: 'Arrow', key: 'a' },
  { id: 'rect', label: 'Box', key: 'r' },
  { id: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'note', label: 'Numbered note', key: 'n' },
];

function ToolIcon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    select: <path d="M6 4l12 7-5.5 1.5L10 18z" />,
    pen: <path d="M4 20c3-1 4.5-4 7-7l5-5a2.1 2.1 0 013 3l-5 5c-3 2.5-6 4-10 4zM14 7l3 3" />,
    arrow: <path d="M5 19L19 5M10 5h9v9" />,
    rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
    ellipse: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
    note: (
      <>
        <circle cx="12" cy="10" r="6" />
        <path d="M12 16v5M10.5 8.2L12 7v6" />
      </>
    ),
    undo: <path d="M9 7L4.5 11.5 9 16M5 11.5h9a5 5 0 010 10h-2" />,
    redo: <path d="M15 7l4.5 4.5L15 16M19 11.5h-9a5 5 0 000 10h2" />,
    annotate: <path d="M4 20l1-4L15.5 5.5l3 3L8 19l-4 1zM14 20h6" />,
  };
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

type Context = { title: string; url: string; target: ThreadRef | null; threads: ThreadRef[]; director: string; earlier: { id: string; created_at: number }[] };
type Gesture =
  | { kind: 'draw' }
  | { kind: 'pan'; id: number; sx: number; sy: number; px: number; py: number }
  | ({ kind: 'pinch'; a: number; b: number } & PinchStart)
  | { kind: 'movepin'; id: string; dx: number; dy: number }
  | { kind: 'tapnote'; sx: number; sy: number; x: number; y: number }
  | null;

const draftKey = (o: EditOpts) => `helm-annotation:${o.projectId}:${o.source.kind}:${o.source.id}:${o.source.side ?? ''}:${o.parent?.id ?? ''}`;

function readDraft(key: string): (Doc & { comment: string }) | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? 'null');
    return d && Array.isArray(d.marks) && Array.isArray(d.notes) ? d : null;
  } catch {
    return null;
  }
}

function useVisualViewport() {
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    const update = () => setVv({ h: v.height, top: v.offsetTop });
    update();
    v.addEventListener('resize', update);
    v.addEventListener('scroll', update);
    return () => {
      v.removeEventListener('resize', update);
      v.removeEventListener('scroll', update);
    };
  }, []);
  return vv;
}

function useWide(min: number) {
  const [wide, setWide] = useState(() => window.matchMedia(`(min-width: ${min}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${min}px)`);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [min]);
  return wide;
}

function Editor({ projectId, source, url, title, parent, to, onSent, onClose }: EditOpts & { onClose: () => void }) {
  const key = draftKey({ projectId, source, url, title, parent });
  const [initial] = useState(() => {
    const d = readDraft(key);
    return { doc: d ? { marks: d.marks, notes: d.notes } : parent ? { marks: parent.marks, notes: parent.notes } : { marks: [], notes: [] }, comment: d?.comment ?? '', restored: !!d };
  });
  const [doc, setDoc] = useState<Doc>(initial.doc);
  const [hist, setHist] = useState<{ past: Doc[]; future: Doc[] }>({ past: [], future: [] });
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [size, setSize] = useState<{ W: number; H: number } | null>(parent ? { W: parent.width, H: parent.height } : null);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [sending, setSending] = useState(false);
  const [comment, setComment] = useState(initial.comment || parent?.comment || '');
  const [notesOpen, setNotesOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(initial.restored ? 'Restored your unsent marks.' : '');
  const wide = useWide(900);
  const vv = useVisualViewport();

  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const viewRef = useRef(view);
  viewRef.current = view;
  const ptrs = useRef(new Map<number, { x: number; y: number; type: string }>());
  const gesture = useRef<Gesture>(null);
  const draftRef = useRef<Mark | null>(null);
  const pencil = useRef(false);
  const userZoomed = useRef(false);

  const dirty = doc.marks.length > 0 || doc.notes.length > 0;
  const W = size?.W ?? 1;
  const H = size?.H ?? 1;

  useEffect(() => {
    const q = new URLSearchParams({ kind: source.kind, id: source.id, side: source.side ?? '', ...(parent ? { parent: parent.id } : {}) });
    api<Context>(`/api/projects/${projectId}/annotate?${q}`)
      .then(setCtx)
      .catch((err) => setLoadError(err.message));
  }, []);

  // The draft is kept on this device until sent, so closing by accident loses nothing.
  useEffect(() => {
    if (doc.marks.length || doc.notes.length || comment) localStorage.setItem(key, JSON.stringify({ ...doc, comment }));
    else localStorage.removeItem(key);
  }, [doc, comment]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // ----- fitting -----
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fitK = size && stage ? Math.min((stage.w - 16) / W, (stage.h - 16) / H) : 1;
  const fitView = (): View | null => (size && stage ? { k: fitK, px: (stage.w - W * fitK) / 2, py: (stage.h - H * fitK) / 2 } : null);
  useEffect(() => {
    if (!size || !stage) return;
    if (!userZoomed.current || !viewRef.current) setView(fitView());
  }, [size?.W, size?.H, stage?.w, stage?.h]);

  // An edge of the image may come to the middle of the screen, no further.
  const clampView = (v: View): View => (stage ? clampTo(v, W, H, stage, fitK, fitK * 12, { w: stage.w / 2, h: stage.h / 2 }) : v);
  const zoomAt = (factor: number, sx: number, sy: number) => {
    const v = viewRef.current;
    if (!v) return;
    const k = Math.min(fitK * 12, Math.max(fitK, v.k * factor));
    userZoomed.current = k > fitK * 1.001;
    setView(clampView(zoomAround(v, k, sx, sy)));
  };

  // Wheel: pinch on a trackpad (ctrl) or ctrl+wheel zooms; otherwise it pans. Needs a non-passive listener.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top); // a wheel notch is ~1.5×; trackpad pinches send small deltas
      else {
        const v = viewRef.current;
        if (v && v.k > fitK * 1.001) setView(clampView({ ...v, px: v.px - e.deltaX, py: v.py - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  // ----- history -----
  const commit = (next: Doc) => {
    const prev = docRef.current; // read now: the updater below runs later, after docRef has moved on
    setHist((h) => ({ past: [...h.past, prev].slice(-200), future: [] }));
    docRef.current = next;
    setDoc(next);
  };
  const undo = () => {
    if (!hist.past.length) return;
    setHist({ past: hist.past.slice(0, -1), future: [docRef.current, ...hist.future] });
    docRef.current = hist.past[hist.past.length - 1];
    setDoc(docRef.current);
    setSelected(null);
    setActive(null);
  };
  const redo = () => {
    if (!hist.future.length) return;
    setHist({ past: [...hist.past, docRef.current], future: hist.future.slice(1) });
    docRef.current = hist.future[0];
    setDoc(docRef.current);
    setSelected(null);
    setActive(null);
  };

  // ----- notes -----
  const addNote = (x: number, y: number, mark: string | null) => {
    const n: Note = { id: uid(), x, y, text: '', mark };
    commit({ ...docRef.current, notes: [...docRef.current.notes, n] });
    setActive(n.id);
    // Focus inside the gesture that made the note, or iOS will not raise the keyboard.
    inputRef.current?.focus({ preventScroll: true });
  };
  const setNoteText = (id: string, text: string) => {
    const next = { ...docRef.current, notes: docRef.current.notes.map((n) => (n.id === id ? { ...n, text } : n)) };
    docRef.current = next;
    setDoc(next);
  };
  const deleteNote = (id: string) => {
    commit({ ...docRef.current, notes: docRef.current.notes.filter((n) => n.id !== id) });
    if (active === id) setActive(null);
  };
  const deleteMark = (id: string) => {
    // Its notes stay where they are, no longer tied to it.
    commit({ marks: docRef.current.marks.filter((m) => m.id !== id), notes: docRef.current.notes.map((n) => (n.mark === id ? { ...n, mark: null } : n)) });
    setSelected(null);
  };
  const noteForSelected = () => {
    const m = doc.marks.find((x) => x.id === selected);
    if (!m) return;
    const existing = doc.notes.find((n) => n.mark === m.id);
    if (existing) {
      setActive(existing.id);
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    const [x, y] = anchorOf(m);
    addNote(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), m.id);
  };
  const recolor = (c: string) => {
    setColor(c);
    if (selected) commit({ ...docRef.current, marks: docRef.current.marks.map((m) => (m.id === selected ? { ...m, color: c } : m)) });
  };
  const clearAll = () => {
    if (!dirty || !confirm('Clear every mark and note?')) return;
    commit({ marks: [], notes: [] });
    setSelected(null);
    setActive(null);
  };

  // ----- pointers -----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toImage = (sx: number, sy: number): [number, number] => {
    const v = viewRef.current!;
    return [Math.min(1, Math.max(0, (sx - v.px) / v.k / W)), Math.min(1, Math.max(0, (sy - v.py) / v.k / H))];
  };
  const pinAt = (sx: number, sy: number) => {
    const v = viewRef.current!;
    const st = markStyle(W, H);
    const reach = Math.max(st.pin * v.k, 18);
    const notes = docRef.current.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (Math.hypot(n.x * W * v.k + v.px - sx, n.y * H * v.k + v.py - sy) <= reach) return n;
    }
    return null;
  };
  const markAt = (sx: number, sy: number) => {
    const v = viewRef.current!;
    const x = (sx - v.px) / v.k;
    const y = (sy - v.py) / v.k;
    const tol = 14 / v.k + markStyle(W, H).sw;
    const marks = docRef.current.marks;
    for (let i = marks.length - 1; i >= 0; i--) if (hitMark(marks[i], x, y, W, H, tol)) return marks[i];
    return null;
  };
  const setDraftBoth = (m: Mark | null) => {
    draftRef.current = m;
    setDraft(m);
  };

  const startPinch = () => {
    const [a, b] = [...ptrs.current.entries()];
    const v = viewRef.current!;
    gesture.current = { kind: 'pinch', a: a[0], b: b[0], ...pinchStart(v, a[1], b[1]) };
  };
  const startPan = (id: number, sx: number, sy: number) => {
    const v = viewRef.current!;
    gesture.current = { kind: 'pan', id, sx, sy, px: v.px, py: v.py };
  };

  const onDown = (e: RPointerEvent) => {
    if (!viewRef.current || !size) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    if (e.pointerType !== 'touch') stageRef.current!.setPointerCapture(e.pointerId); // touch is captured by its target already
    const p = local(e);
    ptrs.current.set(e.pointerId, { ...p, type: e.pointerType });
    if (e.pointerType === 'pen') pencil.current = true;
    if (ptrs.current.size >= 2) {
      // A second finger: this is a pinch or a pan, never a stroke.
      setDraftBoth(null);
      startPinch();
      return;
    }
    // With an Apple Pencil in use, a finger only moves the image.
    if (e.button === 1 || (pencil.current && e.pointerType === 'touch')) return startPan(e.pointerId, p.x, p.y);
    const [x, y] = toImage(p.x, p.y);
    if (tool === 'select' || tool === 'note') {
      const pin = pinAt(p.x, p.y);
      if (pin) {
        setActive(pin.id);
        setSelected(null);
        commit(docRef.current); // the move can be undone
        gesture.current = { kind: 'movepin', id: pin.id, dx: pin.x - x, dy: pin.y - y };
        return;
      }
      if (tool === 'note') {
        gesture.current = { kind: 'tapnote', sx: p.x, sy: p.y, x, y };
        return;
      }
      const m = markAt(p.x, p.y);
      setSelected(m?.id ?? null);
      setActive(null);
      if (!m) startPan(e.pointerId, p.x, p.y);
      else gesture.current = null;
      return;
    }
    setSelected(null);
    setActive(null);
    inputRef.current?.blur();
    gesture.current = { kind: 'draw' };
    setDraftBoth({ id: uid(), type: tool, color, points: tool === 'pen' ? [[x, y]] : [[x, y], [x, y]] });
  };

  const onMove = (e: RPointerEvent) => {
    const known = ptrs.current.get(e.pointerId);
    if (!known) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, { ...p, type: known.type });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const a = ptrs.current.get(g.a);
      const b = ptrs.current.get(g.b);
      if (!a || !b) return;
      const next = pinchView(g, a, b, fitK, fitK * 12);
      userZoomed.current = next.k > fitK * 1.001;
      setView(clampView(next));
      return;
    }
    if (g.kind === 'pan') {
      if (e.pointerId !== g.id) return;
      setView(clampView({ k: viewRef.current!.k, px: g.px + p.x - g.sx, py: g.py + p.y - g.sy }));
      return;
    }
    if (g.kind === 'tapnote') {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > 10) startPan(e.pointerId, g.sx, g.sy);
      return;
    }
    const [x, y] = toImage(p.x, p.y);
    if (g.kind === 'movepin') {
      const next = { ...docRef.current, notes: docRef.current.notes.map((n) => (n.id === g.id ? { ...n, x: Math.min(1, Math.max(0, x + g.dx)), y: Math.min(1, Math.max(0, y + g.dy)) } : n)) };
      docRef.current = next;
      setDoc(next);
      return;
    }
    const d = draftRef.current;
    if (!d) return;
    // Coalesced events give a smoother pen line where the browser has them.
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
    if (d.type === 'pen') {
      const pts = (events.length ? events.map((ev) => toImage(local(ev).x, local(ev).y)) : [[x, y] as [number, number]]);
      setDraftBoth({ ...d, points: [...d.points, ...pts] });
    } else setDraftBoth({ ...d, points: [d.points[0], [x, y]] });
  };

  const onUp = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // One finger left: it moves the image until it is lifted too.
      const rest = [...ptrs.current.entries()][0];
      if (rest) startPan(rest[0], rest[1].x, rest[1].y);
      else gesture.current = null;
      return;
    }
    if (ptrs.current.size) return;
    gesture.current = null;
    if (g?.kind === 'tapnote' && e.type === 'pointerup') return addNote(g.x, g.y, null);
    if (g?.kind !== 'draw') return;
    const d = draftRef.current;
    setDraftBoth(null);
    if (!d || e.type !== 'pointerup') return;
    const v = viewRef.current!;
    const minPx = 6 / v.k;
    let done: Mark;
    if (d.type === 'pen') {
      done = { ...d, points: thin(d.points, 1.2 / v.k / Math.max(W, H)) };
    } else {
      const [[x0, y0], [x1, y1]] = d.points;
      if (Math.hypot((x1 - x0) * W, (y1 - y0) * H) < minPx) return; // a tap with a shape tool draws nothing
      done = d;
    }
    commit({ ...docRef.current, marks: [...docRef.current.marks, done] });
    if (d.type !== 'pen') setSelected(done.id); // ready for "Add note"
  };

  // ----- keys -----
  const tryClose = () => {
    if (sending) return;
    if (dirty && !confirm('Close without sending? Your marks stay on this device as a draft and come back when you annotate this image again.')) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (typing) (e.target as HTMLElement).blur();
        else if (active) setActive(null);
        else if (sending) setSending(false);
        else tryClose();
        return;
      }
      if (typing) return;
      e.stopPropagation();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && (selected || active)) {
        e.preventDefault();
        if (selected) deleteMark(selected);
        else if (active) deleteNote(active);
      } else if (!mod && !e.altKey) {
        const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t) setTool(t.id);
        if (e.key === '+' || e.key === '=') zoomAt(1.25, (stage?.w ?? 0) / 2, (stage?.h ?? 0) / 2);
        if (e.key === '-') zoomAt(0.8, (stage?.w ?? 0) / 2, (stage?.h ?? 0) / 2);
        if (e.key === '0') {
          userZoomed.current = false;
          setView(fitView());
        }
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });

  const activeNote = doc.notes.find((n) => n.id === active);
  const activeIndex = activeNote ? doc.notes.indexOf(activeNote) : -1;
  const zoomed = !!view && view.k > fitK * 1.01;
  const counts = `${doc.notes.length} ${doc.notes.length === 1 ? 'note' : 'notes'} · ${doc.marks.length} ${doc.marks.length === 1 ? 'mark' : 'marks'}`;

  const notesList = (
    <ol className="ann-notes">
      {doc.notes.map((n, i) => (
        <li key={n.id} className={n.id === active ? 'active' : ''}>
          <button type="button" className="ann-num" style={{ background: pinColor(n, doc.marks), color: inkOn(pinColor(n, doc.marks)) }} onClick={() => setActive(n.id)} aria-label={`Note ${i + 1}: show its pin`}>
            {i + 1}
          </button>
          <textarea rows={1} value={n.text} placeholder="What should change here?" onFocus={() => setActive(n.id)} onChange={(e) => setNoteText(n.id, e.target.value)} aria-label={`Note ${i + 1}`} />
          <button type="button" className="icon-btn" onClick={() => deleteNote(n.id)} aria-label={`Delete note ${i + 1}`}>
            <Icon name="trash" size={16} />
          </button>
        </li>
      ))}
    </ol>
  );

  return (
    <div
      className={`ann-editor ${wide ? 'wide' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Annotate ${title}`}
      style={vv ? { height: vv.h, top: vv.top } : undefined}
    >
      <header className="ann-top">
        <button className="icon-btn" onClick={tryClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <div className="ann-title">
          <strong className="one-line">{title}</strong>
          <span className="muted small">{parent ? `Continuing feedback from ${clock(parent.created_at)}` : dirty ? counts : 'Draw on the image, tap with the note tool to add a numbered note'}</span>
        </div>
        <button className="icon-btn" onClick={undo} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl+Z)">
          <ToolIcon name="undo" />
        </button>
        <button className="icon-btn" onClick={redo} disabled={!hist.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
          <ToolIcon name="redo" />
        </button>
        <button className="btn primary ann-send" disabled={!dirty || !size} onClick={() => setSending(true)}>
          <Icon name="send" size={16} /> Send
        </button>
      </header>

      <div className="ann-main">
        <div
          className={`ann-stage tool-${tool}`}
          ref={stageRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          {view && (
            <div className="ann-canvas" style={{ width: W, height: H, transform: `translate(${view.px}px, ${view.py}px) scale(${view.k})` }}>
              <img src={url} alt={title} draggable={false} />
              <MarksLayer W={W} H={H} doc={doc} draft={draft} selected={selected} active={active} />
            </div>
          )}
          <img
            className="ann-probe"
            src={url}
            alt=""
            onLoad={(e) => !size && setSize({ W: e.currentTarget.naturalWidth || 1200, H: e.currentTarget.naturalHeight || 800 })}
            onError={() => setLoadError('The image could not be loaded.')}
          />
          {!view && !loadError && <div className="ann-loading">Loading the image…</div>}
          {loadError && <div className="ann-loading error-text">{loadError}</div>}
          {notice && <div className="ann-notice" role="status">{notice}</div>}
          <div className="ann-zoom" onPointerDown={(e) => e.stopPropagation()}>
            <button className="icon-btn" onClick={() => zoomAt(0.8, (stage?.w ?? 0) / 2, (stage?.h ?? 0) / 2)} disabled={!zoomed} aria-label="Zoom out">
              −
            </button>
            <button
              className="ann-zoom-level"
              onClick={() => {
                userZoomed.current = false;
                setView(fitView());
              }}
              disabled={!zoomed}
              title="Fit to the screen"
            >
              {zoomed && view ? `${Math.round((view.k / fitK) * 100)}%` : 'Fit'}
            </button>
            <button className="icon-btn" onClick={() => zoomAt(1.25, (stage?.w ?? 0) / 2, (stage?.h ?? 0) / 2)} aria-label="Zoom in">
              +
            </button>
          </div>
        </div>
        {wide && (
          <aside className="ann-side">
            <div className="ann-side-head">
              <span className="label">Notes</span>
              <span className="muted small">{counts}</span>
            </div>
            {doc.notes.length ? notesList : <p className="muted small">Pick the note tool and tap the image to drop a numbered note, or draw a shape and press Add note.</p>}
          </aside>
        )}
      </div>

      <div className="ann-tools" role="toolbar" aria-label="Annotation tools">
        <div className="ann-toolset">
          {TOOLS.map((t) => (
            <button key={t.id} className={`ann-tool ${tool === t.id ? 'on' : ''}`} onClick={() => setTool(t.id)} aria-pressed={tool === t.id} aria-label={t.label} title={`${t.label} (${t.key.toUpperCase()})`}>
              <ToolIcon name={t.id} />
            </button>
          ))}
        </div>
        <div className="ann-colors" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button key={c.id} role="radio" aria-checked={color === c.id} aria-label={c.name} className={`ann-color ${color === c.id ? 'on' : ''}`} style={{ background: c.id }} onClick={() => recolor(c.id)} />
          ))}
        </div>
        <div className="ann-actions">
          {selected ? (
            <>
              <button className="btn small" onClick={noteForSelected}>
                <ToolIcon name="note" size={16} /> {doc.notes.some((n) => n.mark === selected) ? 'Edit note' : 'Add note'}
              </button>
              <button className="btn small quiet danger" onClick={() => deleteMark(selected)}>
                <Icon name="trash" size={15} /> Delete
              </button>
            </>
          ) : (
            <button className="btn small quiet" onClick={clearAll} disabled={!dirty}>
              Clear all
            </button>
          )}
        </div>
      </div>

      {!wide && doc.notes.length > 0 && !activeNote && (
        <div className={`ann-drawer ${notesOpen ? 'open' : ''}`}>
          <button className="ann-drawer-head" onClick={() => setNotesOpen(!notesOpen)} aria-expanded={notesOpen}>
            <span className="label">Notes · {doc.notes.length}</span>
            <span className="one-line muted small">{doc.notes.map((n, i) => `${i + 1}. ${n.text || '…'}`).join('  ')}</span>
            <Icon name="chevron" size={16} />
          </button>
          {notesOpen && notesList}
        </div>
      )}

      {/* Always mounted, so a tap that drops a note can focus it at once and raise the iOS keyboard. */}
      <div className={`ann-dock ${activeNote ? 'open' : ''}`} aria-hidden={!activeNote}>
        <span className="ann-num" style={activeNote ? { background: pinColor(activeNote, doc.marks), color: inkOn(pinColor(activeNote, doc.marks)) } : undefined}>
          {activeIndex + 1}
        </span>
        <input
          ref={inputRef}
          value={activeNote?.text ?? ''}
          placeholder="What should change here?"
          aria-label={`Note ${activeIndex + 1}`}
          tabIndex={activeNote ? 0 : -1}
          enterKeyHint="done"
          onChange={(e) => activeNote && setNoteText(activeNote.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setActive(null);
              e.currentTarget.blur();
            }
          }}
        />
        <button className="icon-btn" tabIndex={activeNote ? 0 : -1} onClick={() => activeNote && deleteNote(activeNote.id)} aria-label="Delete this note">
          <Icon name="trash" size={17} />
        </button>
        <button
          className="btn small primary"
          tabIndex={activeNote ? 0 : -1}
          onClick={() => {
            setActive(null);
            inputRef.current?.blur();
          }}
        >
          Done
        </button>
      </div>

      {sending && size && (
        <SendPanel
          projectId={projectId}
          ctx={ctx}
          source={source}
          url={url}
          W={W}
          H={H}
          doc={doc}
          parent={parent}
          initialTo={to}
          comment={comment}
          setComment={setComment}
          counts={counts}
          onCancel={() => setSending(false)}
          onSent={(a) => {
            localStorage.removeItem(key);
            onClose();
            // From the chat: it stays open, and the feedback arrives in the thread it shows.
            if (onSent) return onSent(a);
            go('p', projectId, ...(a.task ? [a.task.kind === 'discussion' ? 'discussions' : 'tasks', a.task.id] : []));
          }}
        />
      )}
    </div>
  );
}

function SendPanel({
  projectId,
  ctx,
  source,
  url,
  W,
  H,
  doc,
  parent,
  initialTo,
  comment,
  setComment,
  counts,
  onCancel,
  onSent,
}: {
  projectId: string;
  ctx: Context | null;
  source: AnnSource;
  url: string;
  W: number;
  H: number;
  doc: Doc;
  parent?: Annotation;
  initialTo?: string;
  comment: string;
  setComment: (s: string) => void;
  counts: string;
  onCancel: () => void;
  onSent: (a: Annotation) => void;
}) {
  const [to, setTo] = useState<string>(() => initialTo ?? (ctx?.target ? ctx.target.id : 'director'));
  useEffect(() => {
    if (ctx?.target && !initialTo) setTo(ctx.target.id);
  }, [ctx?.target?.id]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const threads = ctx ? [...(ctx.target && !ctx.threads.some((t) => t.id === ctx.target!.id) ? [ctx.target] : []), ...ctx.threads] : [];
  const empty = doc.notes.filter((n) => !n.text.trim()).length;

  const send = async () => {
    setError('');
    try {
      setBusy('Drawing the marked-up image…');
      const blob = await renderFlat(url, W, H, doc);
      setBusy('Uploading…');
      const base = (ctx?.title ?? 'image').replace(/\.[a-z0-9]+$/i, '').slice(0, 80);
      const [att] = await uploadFiles(projectId, [new File([blob], `${base} (marked up).png`, { type: 'image/png' })], null);
      setBusy('Sending…');
      const r = await api<{ annotation: Annotation }>(`/api/projects/${projectId}/annotations`, {
        body: { source: { kind: source.kind, id: source.id, side: source.side ?? '' }, width: W, height: H, marks: doc.marks, notes: doc.notes, comment, flat: att.id, to: to === 'director' ? { director: true } : { task: to }, parent: parent?.id },
      });
      onSent(r.annotation);
    } catch (err: any) {
      setError(err.message);
      setBusy('');
    }
  };

  return (
    <div className="ann-send-sheet" role="dialog" aria-label="Send feedback">
      <div className="ann-send-card">
        <div className="row">
          <h2>Send feedback</h2>
          <span className="spacer" />
          <button className="icon-btn" onClick={onCancel} aria-label="Back to the image" disabled={!!busy}>
            <Icon name="close" />
          </button>
        </div>
        <p className="muted small">
          {counts}
          {empty > 0 && ` · ${empty} ${empty === 1 ? 'note has' : 'notes have'} no text`}. The agent gets your notes with where each one is, the original image and a copy with your marks drawn in.
        </p>
        <label className="ann-field">
          <span className="label">Overall comment (optional)</span>
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything that applies to the whole image" />
        </label>
        <label className="ann-field">
          <span className="label">Send to</span>
          <select value={to} onChange={(e) => setTo(e.target.value)} disabled={!ctx}>
            {threads.map((t) => (
              <option key={t.id} value={t.id}>
                {t.kind === 'discussion' ? 'Discussion' : 'Task'}: {t.title}
              </option>
            ))}
            <option value="director">Conversation with {ctx?.director ?? 'the director'}</option>
          </select>
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <span className="muted small">{busy}</span>
          <span className="spacer" />
          <button className="btn quiet" onClick={onCancel} disabled={!!busy}>
            Keep editing
          </button>
          <button className="btn primary" onClick={send} disabled={!!busy || !ctx}>
            <Icon name="send" size={16} /> Send feedback
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- sent feedback ----------

const cache = new Map<string, Promise<Annotation>>();
export function useAnnotation(id: string | undefined) {
  const [a, setA] = useState<Annotation | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    let live = true;
    let p = cache.get(id);
    if (!p) {
      p = api<{ annotation: Annotation }>(`/api/annotations/${id}`).then((r) => r.annotation);
      cache.set(id, p);
      p.catch(() => cache.delete(id));
    }
    p.then((x) => live && setA(x)).catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [id]);
  return { a, error };
}

/** The original image with the marks over it: marks can be hidden, and a note tapped in the list rings its pin. */
function Viewer({ id, onClose, onContinue }: { id: string; onClose: () => void; onContinue: (a: Annotation) => void }) {
  const { a, error } = useAnnotation(id);
  const [marks, setMarks] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'm' && !(e.target instanceof HTMLInputElement)) setMarks((m) => !m);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  const img = a?.original ?? a?.flat;
  return (
    <div className="ann-viewer" role="dialog" aria-modal="true" aria-label="Feedback">
      <header className="ann-top">
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <div className="ann-title">
          <strong className="one-line">Feedback on {a?.title ?? '…'}</strong>
          {a && (
            <span className="muted small">
              {clock(a.created_at)} · sent to {a.task ? <a href={`#/p/${a.project_id}/${a.task.kind === 'discussion' ? 'discussions' : 'tasks'}/${a.task.id}`} onClick={onClose}>{a.task.title}</a> : 'the director'}
            </span>
          )}
        </div>
      </header>
      {error && <p className="error-text">{error}</p>}
      {a && img && (
        <div className="ann-view-body">
          <div className="ann-view-stage">
            <div className="ann-view-frame" style={{ aspectRatio: `${a.width} / ${a.height}`, ['--ar' as any]: a.width / a.height }}>
              <img src={a.original ? a.original.url : img.url} alt={a.title} />
              {a.original && marks && <MarksLayer W={a.width} H={a.height} doc={a} active={active} onPin={(n) => setActive(n === active ? null : n)} />}
              <button
                type="button"
                className="ann-view-zoom"
                aria-label="Full screen, zoomable"
                title="Full screen, zoomable"
                onClick={() =>
                  openViewer([
                    {
                      node: (
                        <div className="ann-view-frame zv-ann">
                          <img src={a.original ? a.original.url : img.url} alt={a.title} />
                          {a.original && marks && <MarksLayer W={a.width} H={a.height} doc={a} active={active} onPin={() => {}} />}
                        </div>
                      ),
                      width: a.width,
                      height: a.height,
                      label: `Feedback on ${a.title}`,
                    },
                  ])
                }
              >
                <Icon name="external" size={18} />
              </button>
            </div>
          </div>
          <div className="ann-view-side">
            <div className="row wrap">
              {a.original && (
                <label className="check">
                  <input type="checkbox" checked={marks} onChange={(e) => setMarks(e.target.checked)} /> Show marks
                </label>
              )}
              <span className="spacer" />
              {a.flat && (
                <a className="btn small quiet" href={a.flat.url} target="_blank" rel="noopener">
                  <Icon name="external" size={15} /> Marked-up PNG
                </a>
              )}
              {a.original && (
                <button className="btn small" onClick={() => onContinue(a)}>
                  <ToolIcon name="annotate" size={16} /> Continue
                </button>
              )}
            </div>
            {a.comment && <p className="ann-comment">{a.comment}</p>}
            {a.notes.length > 0 && (
              <ol className="ann-notes read">
                {a.notes.map((n, i) => (
                  <li key={n.id} className={n.id === active ? 'active' : ''}>
                    <button
                      type="button"
                      className="ann-note-row"
                      onClick={() => {
                        setMarks(true);
                        setActive(n.id === active ? null : n.id);
                      }}
                    >
                      <span className="ann-num" style={{ background: pinColor(n, a.marks), color: inkOn(pinColor(n, a.marks)) }}>
                        {i + 1}
                      </span>
                      <span>{n.text || <i className="muted">no text</i>}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A feedback message's marked-up image in a thread: thumbnail, comment and notes; tap to open the viewer. */
export function FeedbackCard({ att, compact = false }: { att: Attachment; compact?: boolean }) {
  const { a } = useAnnotation(att.annotation?.id);
  return (
    <div className={`ann-card ${compact ? 'compact' : ''}`}>
      <button type="button" className="ann-card-shot" onClick={() => att.annotation && openFeedback(att.annotation.id)} aria-label="Open the feedback">
        <img src={att.url} alt="Marked-up image" loading="lazy" />
        <span className="ann-badge">
          <ToolIcon name="annotate" size={14} /> Feedback{a && a.notes.length ? ` · ${a.notes.length} ${a.notes.length === 1 ? 'note' : 'notes'}` : ''}
        </span>
      </button>
      {a && !compact && (
        <div className="ann-card-text">
          {a.comment && <p>{a.comment}</p>}
          {a.notes.length > 0 && (
            <ol className="ann-card-notes">
              {a.notes.map((n, i) => (
                <li key={n.id}>
                  <span className="ann-num small" style={{ background: pinColor(n, a.marks), color: inkOn(pinColor(n, a.marks)) }}>
                    {i + 1}
                  </span>
                  {n.text || <i className="muted">no text</i>}
                </li>
              ))}
            </ol>
          )}
          {a.parent_id && <p className="muted small">Follows earlier feedback on the same image.</p>}
        </div>
      )}
    </div>
  );
}

/** The project in the address (#/p/<id>/...), for places that only know an attachment. */
export const projectFromHash = () => /^#\/p\/([^/]+)/.exec(location.hash)?.[1] ?? '';

/** The Annotate button laid over an image or put in a bar. */
export function AnnotateButton({ onClick, label = 'Annotate', className = '' }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button
      type="button"
      className={`ann-open-btn ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      title="Draw on this image and send it as feedback"
    >
      <ToolIcon name="annotate" size={16} /> <span>{label}</span>
    </button>
  );
}

/** "Feedback sent" on a preview, opening the newest feedback on it. */
export function FeedbackMarker({ feedback, side }: { feedback?: { id: string; side: string; created_at: number }[]; side?: string }) {
  const list = (feedback ?? []).filter((f) => side === undefined || f.side === side);
  if (!list.length) return null;
  return (
    <button type="button" className="ann-marker" onClick={(e) => (e.stopPropagation(), openFeedback(list[0].id))} title={`Feedback sent ${clock(list[0].created_at)}`}>
      <ToolIcon name="annotate" size={14} /> Feedback sent{list.length > 1 ? ` · ${list.length}` : ''}
    </button>
  );
}
