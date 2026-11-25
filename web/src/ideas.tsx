import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, ReactNode } from 'react';
import { api, useLive } from './api';
import type { IdeaCard, IdeaFrame, IdeasBoard, ProjectState } from './api';
import { Icon, Markdown, Sheet, go, href, useAction } from './ui';
import { openViewer } from './viewer';
import { toJpegIfHeic } from './attachments';
import { pinchStart, pinchView, zoomAround } from './zoom';
import type { PinchStart, View } from './zoom';

/**
 * The Ideas board (server/ideas.ts): a free canvas of notes, links and images, with named frames around groups of
 * them. Pan with a drag on the background, zoom with a pinch, the wheel or the corner buttons. A card or a frame's
 * title moves at once with a mouse; on touch, a long press picks it up (a quick drag pans the board instead), so the
 * board scrolls naturally under a finger. Discuss on a frame starts a discussion with its cards. Each device keeps its
 * own view (localStorage).
 */

const MIN_K = 0.15;
const MAX_K = 3;
const HOLD_MS = 300;
const SLOP = 8;

type Target = { kind: 'card' | 'frame'; id: string };
type Gesture =
  | { kind: 'pan'; id: number; sx: number; sy: number; px: number; py: number; moved: boolean }
  | ({ kind: 'pinch'; a: number; b: number } & PinchStart)
  | { kind: 'press'; id: number; target: Target; sx: number; sy: number; timer: number; touch: boolean }
  | { kind: 'move'; id: number; target: Target; sx: number; sy: number }
  | { kind: 'resize'; id: number; target: Target; sx: number; sy: number; w: number; h: number };
/** What a gesture in progress does to the board, shown before it is saved. */
type Drag = { target: Target; dx: number; dy: number; dw: number; dh: number } | null;

type Editing =
  | { kind: 'note'; card?: IdeaCard }
  | { kind: 'link'; card?: IdeaCard }
  | { kind: 'frame'; frame?: IdeaFrame };

const viewKey = (pid: string) => `helm.ideas.view.${pid}`;
const readView = (pid: string): View | null => {
  try {
    const v = JSON.parse(localStorage.getItem(viewKey(pid)) ?? 'null');
    return v && [v.k, v.px, v.py].every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
};
const inside = (x: number, y: number, f: { x: number; y: number; w: number; h: number }) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h;

export function IdeasPage({ s }: { s: ProjectState }) {
  const pid = s.project.id;
  const path = `/api/projects/${pid}/ideas`;
  const { data, error, reload } = useLive<IdeasBoard>(path, (m) => m.type === 'project' && m.projectId === pid);
  const [board, setBoard] = useState<IdeasBoard | null>(null);
  const [view, setViewState] = useState<View | null>(() => readView(pid));
  const viewRef = useRef<View | null>(view);
  /** The user has panned or zoomed (or this device kept a view): the board is no longer refitted as the stage settles. */
  const userMoved = useRef(!!view);
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Target | null>(null);
  const [drag, setDragState] = useState<Drag>(null);
  const dragRef = useRef<Drag>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busyText, setBusyText] = useState('');
  const act = useAction();
  const gesture = useRef<Gesture | null>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef<{ id: string; at: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const setView = (v: View, byUser = true) => {
    viewRef.current = v;
    if (byUser) userMoved.current = true;
    setViewState(v);
  };
  const setDrag = (d: Drag) => {
    dragRef.current = d;
    setDragState(d);
  };

  // The server's board, except while a gesture is changing it (it is taken once the gesture is saved).
  useEffect(() => {
    if (data && !gesture.current && !dragRef.current) setBoard(data);
  }, [data]);

  // Remember this device's view of the board, once the user has set it.
  useEffect(() => {
    if (!view || !userMoved.current) return;
    const t = setTimeout(() => localStorage.setItem(viewKey(pid), JSON.stringify(view)), 300);
    return () => clearTimeout(t);
  }, [view, pid]);

  // The stage fills the screen down to the chat bar (and the phone's bottom bar).
  useLayoutEffect(() => {
    const fit = () => {
      const el = stageRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      let bottom = window.visualViewport?.height ?? innerHeight;
      for (const q of ['.chat-dock', 'nav.tabs']) {
        const r = document.querySelector(q)?.getBoundingClientRect();
        if (r && r.height && r.top > top + 100 && r.top < bottom) bottom = r.top;
      }
      const h = Math.max(280, Math.round(bottom - top - 10));
      el.style.height = `${h}px`;
      setStage({ w: el.clientWidth, h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (stageRef.current) ro.observe(stageRef.current.parentElement!);
    addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      removeEventListener('resize', fit);
    };
  }, []);

  // First visit on this device: fit everything in view, again as the stage settles, until the user moves it.
  useEffect(() => {
    if (userMoved.current || !stage || !board) return;
    setView(fitTo(board, stage), false);
  }, [stage, board]);

  const zoomAt = (factor: number, sx: number, sy: number) => {
    const v = viewRef.current;
    if (!v) return;
    setView(zoomAround(v, Math.min(MAX_K, Math.max(MIN_K, v.k * factor)), sx, sy));
  };

  // Wheel: a pinch on a trackpad (ctrl) or a mouse wheel zooms; a two-finger scroll on a trackpad pans.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.('.ideas-bar, .ideas-zoom')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || e.metaKey || mouseWheel) zoomAt(Math.exp(-Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY)) * 0.006), e.clientX - r.left, e.clientY - r.top);
      else {
        const v = viewRef.current;
        if (v) setView({ ...v, px: v.px - e.deltaX, py: v.py - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ----- saving -----
  const save = async (fn: () => Promise<unknown>) => {
    await act.run(fn);
    await reload();
  };
  const findCard = (id: string) => board?.cards.find((c) => c.id === id);
  const findFrame = (id: string) => board?.frames.find((f) => f.id === id);
  /** Where a gesture leaves a card or frame (and a frame's cards). */
  const placed = (b: IdeasBoard, d: NonNullable<Drag>): IdeasBoard => ({
    frames: b.frames.map((f) => (d.target.kind === 'frame' && f.id === d.target.id ? { ...f, x: f.x + d.dx, y: f.y + d.dy, w: f.w + d.dw, h: f.h + d.dh } : f)),
    cards: b.cards.map((c) =>
      (d.target.kind === 'card' && c.id === d.target.id) || (d.target.kind === 'frame' && c.frame_id === d.target.id && !d.dw && !d.dh)
        ? { ...c, x: c.x + d.dx, y: c.y + d.dy, w: d.target.kind === 'card' ? Math.max(80, c.w + d.dw) : c.w, h: d.target.kind === 'card' ? Math.max(60, c.h + d.dh) : c.h }
        : c,
    ),
  });
  const commitDrag = () => {
    const d = dragRef.current;
    setLifted(null);
    if (!d || !board) return setDrag(null);
    const next = placed(board, d);
    setBoard(next);
    setDrag(null);
    if (!d.dx && !d.dy && !d.dw && !d.dh) return;
    const r = (d.target.kind === 'card' ? next.cards : next.frames).find((x) => x.id === d.target.id)!;
    const body = d.dw || d.dh ? { w: Math.round(r.w), h: Math.round(r.h) } : { x: Math.round(r.x), y: Math.round(r.y) };
    void save(() => api(`/api/ideas/${d.target.kind === 'card' ? 'cards' : 'frames'}/${d.target.id}`, { method: 'PATCH', body }));
  };

  // ----- pointers -----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startPan = (id: number, sx: number, sy: number) => {
    const v = viewRef.current!;
    gesture.current = { kind: 'pan', id, sx, sy, px: v.px, py: v.py, moved: false };
  };
  const pickUp = (g: { id: number; target: Target; sx: number; sy: number }) => {
    gesture.current = { kind: 'move', id: g.id, target: g.target, sx: g.sx, sy: g.sy };
    setLifted(g.target.id);
    setSel(g.target);
    setDrag({ target: g.target, dx: 0, dy: 0, dw: 0, dh: 0 });
  };
  const tap = (t: Target) => {
    const now = Date.now();
    const again = lastTap.current && lastTap.current.id === t.id && now - lastTap.current.at < 350;
    lastTap.current = { id: t.id, at: now };
    setSel(t);
    if (!again) return;
    lastTap.current = null;
    if (t.kind === 'frame') setEditing({ kind: 'frame', frame: findFrame(t.id) });
    else {
      const c = findCard(t.id);
      if (c?.kind === 'note' || c?.kind === 'link') setEditing({ kind: c.kind, card: c });
      if (c?.kind === 'image' && c.image) openViewer([{ src: c.image.url, label: c.image.name }], 0);
    }
  };

  const onDown = (e: RPointerEvent) => {
    if (!viewRef.current) return;
    if ((e.target as Element).closest('.ideas-bar, .ideas-zoom, a, button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    stageRef.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g0 = gesture.current;
    if (ptrs.current.size >= 2) {
      // A second finger: a pinch, unless something is already picked up (it stays with the first finger).
      if (g0?.kind === 'move' || g0?.kind === 'resize') return;
      if (g0?.kind === 'press') clearTimeout(g0.timer);
      const [a, b] = [...ptrs.current.entries()];
      gesture.current = { kind: 'pinch', a: a[0], b: b[0], ...pinchStart(viewRef.current, a[1], b[1]) };
      return;
    }
    const el = (e.target as Element).closest('[data-resize], [data-card], [data-frame]') as HTMLElement | null;
    if (el?.dataset.resize) {
      const [kind, id] = el.dataset.resize.split(':') as ['card' | 'frame', string];
      const r = kind === 'card' ? findCard(id) : findFrame(id);
      if (!r) return;
      gesture.current = { kind: 'resize', id: e.pointerId, target: { kind, id }, sx: p.x, sy: p.y, w: r.w, h: r.h };
      setDrag({ target: { kind, id }, dx: 0, dy: 0, dw: 0, dh: 0 });
      return;
    }
    if (el) {
      const target: Target = el.dataset.card ? { kind: 'card', id: el.dataset.card } : { kind: 'frame', id: el.dataset.frame! };
      const touch = e.pointerType === 'touch';
      const timer = touch ? window.setTimeout(() => gesture.current?.kind === 'press' && pickUp(gesture.current), HOLD_MS) : 0;
      gesture.current = { kind: 'press', id: e.pointerId, target, sx: p.x, sy: p.y, timer, touch };
      return;
    }
    startPan(e.pointerId, p.x, p.y);
  };

  const onMove = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    const v = viewRef.current;
    if (!g || !v) return;
    if (g.kind === 'pinch') {
      const a = ptrs.current.get(g.a);
      const b = ptrs.current.get(g.b);
      if (a && b) setView(pinchView(g, a, b, MIN_K, MAX_K));
      return;
    }
    if (e.pointerId !== g.id) return;
    if (g.kind === 'pan') {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > 3) g.moved = true;
      setView({ k: v.k, px: g.px + p.x - g.sx, py: g.py + p.y - g.sy });
      return;
    }
    if (g.kind === 'press') {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) <= (g.touch ? SLOP : 3)) return;
      clearTimeout(g.timer);
      // Moving before the hold: on touch the board pans; a mouse drags at once.
      if (g.touch) {
        startPan(g.id, g.sx, g.sy);
        (gesture.current as Extract<Gesture, { kind: 'pan' }>).moved = true;
        setView({ k: v.k, px: v.px + p.x - g.sx, py: v.py + p.y - g.sy });
      } else pickUp(g);
      return;
    }
    if (g.kind === 'move') setDrag({ target: g.target, dx: (p.x - g.sx) / v.k, dy: (p.y - g.sy) / v.k, dw: 0, dh: 0 });
    if (g.kind === 'resize') {
      const minW = g.target.kind === 'card' ? 80 : 160;
      const minH = g.target.kind === 'card' ? 60 : 120;
      setDrag({ target: g.target, dx: 0, dy: 0, dw: Math.max(minW, g.w + (p.x - g.sx) / v.k) - g.w, dh: Math.max(minH, g.h + (p.y - g.sy) / v.k) - g.h });
    }
  };

  const onUp = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // One finger left: it pans until it is lifted too.
      const rest = [...ptrs.current.entries()][0];
      if (rest) {
        startPan(rest[0], rest[1].x, rest[1].y);
        (gesture.current as Extract<Gesture, { kind: 'pan' }>).moved = true;
      } else gesture.current = null;
      return;
    }
    if (!g || e.pointerId !== g.id) return;
    gesture.current = null;
    const done = e.type === 'pointerup';
    if (g.kind === 'pan' && !g.moved && done) setSel(null);
    if (g.kind === 'press') {
      clearTimeout(g.timer);
      if (done) tap(g.target);
    }
    if (g.kind === 'move' || g.kind === 'resize') {
      if (done) commitDrag();
      else {
        setDrag(null);
        setLifted(null);
      }
    }
    if (data && !dragRef.current) setBoard(data);
  };

  // ----- adding -----
  const center = (w = 0, h = 0) => {
    const v = viewRef.current ?? { k: 1, px: 0, py: 0 };
    const st = stage ?? { w: 390, h: 600 };
    return { x: Math.round((st.w / 2 - v.px) / v.k - w / 2), y: Math.round((st.h / 2 - v.py) / v.k - h / 2) };
  };
  const addNote = (text: string, at = center(220, 150)) => save(() => api(`/api/projects/${pid}/ideas/cards`, { body: { kind: 'note', text, ...at } }));
  const addLink = (url: string, at = center(260, 220)) => save(() => api(`/api/projects/${pid}/ideas/cards`, { body: { kind: 'link', url, ...at } }));
  const uploadImages = async (files: File[], at?: { x: number; y: number }) => {
    const images = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (!images.length) return;
    setBusyText(images.length === 1 ? 'Adding the image…' : `Adding ${images.length} images…`);
    try {
      let i = 0;
      for (const raw of images) {
        const f = await toJpegIfHeic(raw);
        // Sized to the image's shape, 240 units on its longer side.
        let w = 240;
        let h = 240;
        try {
          const bmp = await createImageBitmap(f);
          const r = bmp.height / bmp.width;
          bmp.close();
          if (r > 1) w = Math.max(80, Math.round(240 / r));
          else h = Math.max(60, Math.round(240 * r));
        } catch {}
        const p = at ? { x: at.x + i * 32, y: at.y + i * 32 } : (({ x, y }) => ({ x: x + i * 32, y: y + i * 32 }))(center(w, h));
        const form = new FormData();
        form.append('file', f, f.name);
        await act.run(async () => {
          const res = await fetch(`/api/projects/${pid}/ideas/images?x=${p.x}&y=${p.y}&w=${w}&h=${h}`, { method: 'POST', body: form, credentials: 'same-origin' });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status}).`);
        });
        i++;
      }
    } finally {
      setBusyText('');
      await reload();
    }
  };
  const addFrame = (name: string) => {
    const v = viewRef.current ?? { k: 1, px: 0, py: 0 };
    const st = stage ?? { w: 390, h: 600 };
    const w = Math.round(Math.min(600, (st.w * 0.8) / v.k));
    const h = Math.round(Math.min(420, (st.h * 0.6) / v.k));
    return save(() => api(`/api/projects/${pid}/ideas/frames`, { body: { name, w, h, ...center(w, h) } }));
  };

  // Paste: images become image cards, an address a link, other text a note (not while typing in a field).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as Element | null;
      if (editing || t?.closest?.('input, textarea, [contenteditable]')) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void uploadImages(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (!text) return;
      e.preventDefault();
      if (/^https?:\/\/\S+$/i.test(text)) void addLink(text);
      else void addNote(text);
    };
    addEventListener('paste', onPaste);
    return () => removeEventListener('paste', onPaste);
  });

  const toWorld = (sx: number, sy: number) => {
    const v = viewRef.current ?? { k: 1, px: 0, py: 0 };
    return { x: Math.round((sx - v.px) / v.k), y: Math.round((sy - v.py) / v.k) };
  };

  // ----- actions on the selection -----
  const remove = (t: Target) => {
    if (!confirm(t.kind === 'frame' ? 'Delete this frame? Its cards stay on the board.' : 'Delete this card?')) return;
    setSel(null);
    void save(() => api(`/api/ideas/${t.kind === 'card' ? 'cards' : 'frames'}/${t.id}`, { method: 'DELETE' }));
  };
  const discuss = async (f: IdeaFrame) => {
    let id = '';
    const ok = await act.run(async () => {
      id = (await api<{ id: string }>(`/api/ideas/frames/${f.id}/discuss`, { method: 'POST', body: {} })).id;
    });
    if (ok && id) go('p', pid, 'discussions', id);
  };

  // ----- drawing -----
  const shown = useMemo(() => (board && drag ? placed(board, drag) : board), [board, drag]);
  const dropFrame = useMemo(() => {
    if (!shown || !drag || drag.target.kind !== 'card' || drag.dw || drag.dh) return null;
    const c = shown.cards.find((x) => x.id === drag.target.id);
    if (!c) return null;
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    return shown.frames.filter((f) => inside(cx, cy, f)).sort((a, b) => a.w * a.h - b.w * b.h)[0]?.id ?? null;
  }, [shown, drag]);

  const selCard = sel?.kind === 'card' ? shown?.cards.find((c) => c.id === sel.id) : undefined;
  const selFrame = sel?.kind === 'frame' ? shown?.frames.find((f) => f.id === sel.id) : undefined;
  const v = view;
  const empty = shown && !shown.cards.length && !shown.frames.length;

  return (
    <div className="ideas-page">
      <div
        ref={stageRef}
        className={`ideas-stage${drag ? ' dragging' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          if (!files.length) return;
          e.preventDefault();
          const p = local(e);
          void uploadImages(files, toWorld(p.x, p.y));
        }}
      >
        {v && shown && (
          <div className="ideas-world" style={{ transform: `translate(${v.px}px, ${v.py}px) scale(${v.k})` }}>
            {shown.frames.map((f) => (
              <div key={f.id} className={`idea-frame${sel?.id === f.id ? ' sel' : ''}${dropFrame === f.id ? ' drop' : ''}${lifted === f.id ? ' lifted' : ''}`} style={{ left: f.x, top: f.y, width: f.w, height: f.h }}>
                <div className="idea-frame-head" data-frame={f.id}>
                  <span className="idea-frame-name">{f.name || 'Untitled'}</span>
                  {f.discussion && (
                    <a className="idea-frame-link" href={href('p', pid, 'discussions', f.discussion.id)}>
                      <Icon name="discuss" size={16} />
                    </a>
                  )}
                </div>
                {sel?.id === f.id && <div className="idea-resize" data-resize={`frame:${f.id}`} />}
              </div>
            ))}
            {shown.cards.map((c) => (
              <div
                key={c.id}
                data-card={c.id}
                className={`idea-card idea-${c.kind}${sel?.id === c.id ? ' sel' : ''}${lifted === c.id ? ' lifted' : ''}`}
                style={{ left: c.x, top: c.y, width: c.w, height: c.h, zIndex: lifted === c.id ? 100000 : c.z }}
              >
                <CardBody c={c} />
                {sel?.id === c.id && <div className="idea-resize" data-resize={`card:${c.id}`} />}
              </div>
            ))}
          </div>
        )}
        {!shown && <div className="ideas-empty">{error ?? 'Loading…'}</div>}
        {empty && <div className="ideas-empty">Add a note, a link or an image. Draw a frame around cards to discuss them.</div>}

        <div className="ideas-bar">
          <button className="btn small" onClick={() => setEditing({ kind: 'note' })}>
            <Icon name="plus" size={16} /> Note
          </button>
          <button className="btn small" onClick={() => setEditing({ kind: 'link' })}>
            <Icon name="plus" size={16} /> Link
          </button>
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            <Icon name="plus" size={16} /> Image
          </button>
          <button className="btn small" onClick={() => setEditing({ kind: 'frame' })}>
            <Icon name="plus" size={16} /> Frame
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void uploadImages(files);
            }}
          />
        </div>

        <div className="ideas-zoom">
          <button className="btn small quiet" aria-label="Zoom out" onClick={() => stage && zoomAt(1 / 1.25, stage.w / 2, stage.h / 2)}>
            −
          </button>
          <button className="btn small quiet" aria-label="Zoom in" onClick={() => stage && zoomAt(1.25, stage.w / 2, stage.h / 2)}>
            +
          </button>
          <button className="btn small quiet" aria-label="Fit everything" onClick={() => board && stage && setView(fitTo(board, stage))}>
            Fit
          </button>
        </div>

        {(selCard || selFrame || busyText || act.error) && (
          <div className="ideas-actions">
            {busyText && <span className="muted">{busyText}</span>}
            {act.error && !busyText && <span className="error-text">{act.error}</span>}
            {selCard && !busyText && (
              <>
                {selCard.kind === 'link' && selCard.url && (
                  <a className="btn small" href={selCard.url} target="_blank" rel="noreferrer noopener">
                    Open
                  </a>
                )}
                {selCard.kind === 'image' && selCard.image && <button className="btn small" onClick={() => openViewer([{ src: selCard.image!.url, label: selCard.image!.name }], 0)}>View</button>}
                {selCard.kind !== 'image' && <button className="btn small" onClick={() => setEditing({ kind: selCard.kind as 'note' | 'link', card: selCard })}>Edit</button>}
                <button className="btn small danger" onClick={() => remove({ kind: 'card', id: selCard.id })}>
                  Delete
                </button>
              </>
            )}
            {selFrame && !busyText && (
              <>
                {selFrame.discussion ? (
                  <a className="btn small primary" href={href('p', pid, 'discussions', selFrame.discussion.id)}>
                    Discussion
                  </a>
                ) : (
                  <button className="btn small primary" disabled={act.busy} onClick={() => discuss(selFrame)}>
                    Discuss
                  </button>
                )}
                <button className="btn small" onClick={() => setEditing({ kind: 'frame', frame: selFrame })}>
                  Rename
                </button>
                <button className="btn small danger" onClick={() => remove({ kind: 'frame', id: selFrame.id })}>
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {editing && (
        <Editor
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={async (value) => {
            const e = editing;
            setEditing(null);
            if (e.kind === 'note') return e.card ? save(() => api(`/api/ideas/cards/${e.card!.id}`, { method: 'PATCH', body: { text: value } })) : addNote(value);
            if (e.kind === 'link') return e.card ? save(() => api(`/api/ideas/cards/${e.card!.id}`, { method: 'PATCH', body: { text: value } })) : addLink(value);
            return e.frame ? save(() => api(`/api/ideas/frames/${e.frame!.id}`, { method: 'PATCH', body: { name: value } })) : addFrame(value);
          }}
        />
      )}
    </div>
  );
}

/** The view that shows the whole board, at most at full size. */
function fitTo(b: IdeasBoard, st: { w: number; h: number }): View {
  const items = [...b.cards, ...b.frames];
  if (!items.length) return { k: 1, px: 16, py: 64 };
  const x0 = Math.min(...items.map((i) => i.x));
  const y0 = Math.min(...items.map((i) => i.y));
  const x1 = Math.max(...items.map((i) => i.x + i.w));
  const y1 = Math.max(...items.map((i) => i.y + i.h));
  // Room for the bar above and the zoom buttons below.
  const pad = 24;
  const top = 56;
  const bottom = 56;
  const k = Math.min(1, Math.max(MIN_K, Math.min((st.w - pad * 2) / (x1 - x0), (st.h - top - bottom) / (y1 - y0))));
  return { k, px: (st.w - (x1 - x0) * k) / 2 - x0 * k, py: top + (st.h - top - bottom - (y1 - y0) * k) / 2 - y0 * k };
}

function CardBody({ c }: { c: IdeaCard }) {
  if (c.kind === 'note') return <div className="idea-note-body">{c.text.trim() ? <Markdown text={c.text} /> : <span className="muted">Empty note</span>}</div>;
  if (c.kind === 'image')
    return c.image?.kind === 'image' ? <img src={c.image.url} alt={c.image.name} draggable={false} /> : <div className="idea-note-body muted">{c.image?.name ?? 'Image'}</div>;
  return (
    <div className="idea-link-body">
      {c.image ? <img src={c.image.url} alt="" draggable={false} /> : <div className="idea-link-noimg">{c.fetching ? 'Fetching…' : <Icon name="external" size={20} />}</div>}
      <div className="idea-link-text">
        <b>{c.text || c.url}</b>
        <span className="muted">{c.site}</span>
      </div>
    </div>
  );
}

function Editor({ editing, onClose, onSave }: { editing: Editing; onClose: () => void; onSave: (value: string) => void }) {
  const initial = editing.kind === 'frame' ? (editing.frame?.name ?? '') : (editing.card?.text ?? '');
  const [value, setValue] = useState(initial);
  const title =
    editing.kind === 'note' ? (editing.card ? 'Edit note' : 'New note') : editing.kind === 'link' ? (editing.card ? 'Link title' : 'New link') : editing.frame ? 'Rename frame' : 'New frame';
  const newLink = editing.kind === 'link' && !editing.card;
  const ready = editing.kind === 'frame' || value.trim().length > 0;
  let field: ReactNode;
  if (editing.kind === 'note')
    field = <textarea autoFocus rows={8} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Markdown: **bold**, - lists, [links](https://…)" />;
  else
    field = (
      <input
        autoFocus
        type={newLink ? 'url' : 'text'}
        inputMode={newLink ? 'url' : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && ready && onSave(value.trim())}
        placeholder={newLink ? 'https://…' : editing.kind === 'frame' ? 'e.g. Onboarding' : 'Title'}
      />
    );
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="ideas-editor">
        {field}
        <div className="row">
          <span className="spacer" />
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => onSave(editing.kind === 'note' ? value : value.trim())}>
            {(editing.kind === 'frame' ? editing.frame : editing.card) ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
