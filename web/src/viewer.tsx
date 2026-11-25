import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, useScrollLock } from './ui';
import { clampView, pinchStart, pinchView, zoomAround } from './zoom';
import type { Box, PinchStart, View } from './zoom';

/**
 * The one full-screen image viewer, used wherever an image opens: preview images, each side of a comparison, guide
 * steps, attachments and references, report screenshots, feedback images and charts. Touch first: pinch zooms around
 * the fingers, one or two fingers pan when the image is bigger than the screen, a double tap toggles between the
 * starting view and 2.5× at that point. At the starting view a swipe down closes and a sideways swipe moves between
 * images; when zoomed in, swipes pan instead. The image never leaves the screen. ＋ / − / Fit buttons do the same for
 * one hand or a mouse; wheel and keys work on a desktop.
 *
 * A tall image (a full-page screenshot, a sheet of mockups) starts fitted to the width and scrolls vertically, since
 * shrunk to the screen's height its text is unreadable; pinching out still shows it whole.
 */
export type ViewerItem = {
  /** The full-resolution file. */
  src?: string;
  /** Instead of an image: content drawn at width×height (a chart, an image with marks over it). */
  node?: ReactNode;
  width?: number;
  height?: number;
  /** Shown in the bar: "Step 2", the side's label, a file name. */
  label?: string;
  text?: ReactNode;
  /** Extra buttons for the bar (Annotate, open the original). */
  actions?: ReactNode;
};

type Open = { items: ViewerItem[]; index: number } | { frame: Frame };
type Frame = { src: string; title: string; sandbox?: string };
let setOpenGlobal: ((o: Open | null) => void) | null = null;

/**
 * An HTML or PDF preview full screen inside the app, with a Close button always in view: in an installed iOS app a
 * new-tab link opens a browser sheet the user may not find their way back from. The page behind stays locked; the
 * frame scrolls, and pinch zooms the view as on any page. Open in browser is still there for a PDF Safari only shows
 * in part inside a frame.
 */
export function openFrame(frame: Frame) {
  setOpenGlobal?.({ frame });
}

/** Open the viewer on items[index]. */
export function openViewer(items: ViewerItem[], index = 0) {
  setOpenGlobal?.({ items, index: Math.max(0, Math.min(items.length - 1, index)) });
}
export const closeViewer = () => setOpenGlobal?.(null);

/** Mounted once by the app shell. */
export function ViewerHost() {
  const [open, setOpen] = useState<Open | null>(null);
  useEffect(() => {
    setOpenGlobal = setOpen;
    return () => {
      setOpenGlobal = null;
    };
  }, []);
  if (!open) return null;
  if ('frame' in open) return createPortal(<FrameView {...open.frame} onClose={() => setOpen(null)} />, document.body);
  return createPortal(<Viewer items={open.items} index={open.index} setIndex={(index) => setOpen({ ...open, index })} onClose={() => setOpen(null)} />, document.body);
}

function FrameView({ src, title, sandbox, onClose }: Frame & { onClose: () => void }) {
  useScrollLock();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="zv zv-frame" role="dialog" aria-modal="true" aria-label={title}>
      <div className="zv-frame-bar on-media">
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
        <strong className="one-line">{title}</strong>
        <a className="btn small quiet" href={src} target="_blank" rel="noreferrer">
          <Icon name="external" size={16} /> Open in browser
        </a>
      </div>
      <iframe src={src} title={title} sandbox={sandbox} />
    </div>
  );
}

type Ptr = { x: number; y: number };
type Gesture =
  | { kind: 'drag'; id: number; sx: number; sy: number; px: number; py: number; t: number; moved: boolean }
  | ({ kind: 'pinch'; a: number; b: number } & PinchStart)
  | null;

const TALL = 1.6; // fitted to the width, an image this many screens tall starts that way instead of shrunk to fit
const DOUBLE_TAP = 2.5;

function Viewer({ items, index, setIndex, onClose }: { items: ViewerItem[]; index: number; setIndex: (i: number) => void; onClose: () => void }) {
  const item = items[index];
  const prev = index > 0 ? index - 1 : null;
  const next = index < items.length - 1 ? index + 1 : null;
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Box | null>(null);
  const [size, setSize] = useState<{ W: number; H: number } | null>(item.width && item.height ? { W: item.width, H: item.height } : null);
  const [view, setView] = useState<View | null>(null);
  // How far a swipe has pulled the image beyond what panning can absorb: it follows the finger, then closes or turns.
  const [pull, setPull] = useState({ x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const ptrs = useRef(new Map<number, Ptr>());
  const gesture = useRef<Gesture>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  useScrollLock();
  // Safari's own page zoom would fight the pinch.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    return () => document.removeEventListener('gesturestart', stop);
  }, []);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStage({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new image: its size comes from the file (or the item), and the view starts afresh, unless it has the same
  // natural size as the last one (two shots of one screen): then the zoom and pan carry over, to compare a spot.
  const carry = useRef<{ W: number; H: number; view: View } | null>(null);
  useEffect(() => {
    const next = item.width && item.height ? { W: item.width, H: item.height } : null;
    setPull({ x: 0, y: 0 });
    if (next && size && next.W === size.W && next.H === size.H) return;
    carry.current = size && viewRef.current ? { ...size, view: viewRef.current } : null;
    setSize(next);
    setView(null);
  }, [index, items]);

  const W = size?.W ?? 1;
  const H = size?.H ?? 1;
  const containK = stage && size ? Math.min(stage.w / W, stage.h / H) : 1;
  const widthK = stage && size ? stage.w / W : 1;
  const tall = !!stage && H * widthK > stage.h * TALL;
  const homeK = tall ? widthK : containK;
  const minK = Math.min(containK, homeK);
  const maxK = Math.max(homeK * 6, 1);
  const clamp = (v: View) => (stage ? clampView(v, W, H, stage, minK, maxK) : v);
  const home = (): View | null => (stage && size ? clamp({ k: homeK, px: (stage.w - W * homeK) / 2, py: 0 }) : null);
  const zoomed = !!view && view.k > homeK * 1.01;
  const scrolls = !!view && !!stage && (W * view.k > stage.w + 1 || H * view.k > stage.h + 1);

  useEffect(() => {
    if (!stage || !size) return;
    // A size read from the file that matches the last image's takes its view back.
    const c = carry.current;
    carry.current = null;
    setView((v) => (v ? clamp(v) : c && c.W === size.W && c.H === size.H ? clamp(c.view) : home()));
  }, [stage?.w, stage?.h, size?.W, size?.H]);

  const zoomTo = (k: number, sx?: number, sy?: number) => {
    const v = viewRef.current;
    if (!v || !stage) return;
    setView(clamp(zoomAround(v, Math.min(maxK, Math.max(minK, k)), sx ?? stage.w / 2, sy ?? stage.h / 2)));
  };
  const toggleZoom = (sx: number, sy: number) => {
    if (zoomed) setView(home());
    else zoomTo(homeK * DOUBLE_TAP, sx, sy);
  };

  // Keys: Escape closes, arrows turn, + − 0 zoom. Captured, ahead of a sheet or lightbox underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.documentElement.classList.contains('ann-open')) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && prev !== null) setIndex(prev);
      else if (e.key === 'ArrowRight' && next !== null) setIndex(next);
      else if (e.key === '+' || e.key === '=') zoomTo((viewRef.current?.k ?? homeK) * 1.5);
      else if (e.key === '-') zoomTo((viewRef.current?.k ?? homeK) / 1.5);
      else if (e.key === '0') setView(home());
      else return;
      e.stopPropagation();
      e.preventDefault();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  });

  // Wheel: ctrl (a trackpad pinch) zooms, otherwise it pans. Needs a non-passive listener.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      if (!v) return;
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomTo(v.k * Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01), e.clientX - r.left, e.clientY - r.top);
      else setView(clamp({ ...v, px: v.px - e.deltaX, py: v.py - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const local = (e: { clientX: number; clientY: number }): Ptr => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startDrag = (id: number, p: Ptr, moved = false) => {
    const v = viewRef.current!;
    gesture.current = { kind: 'drag', id, sx: p.x, sy: p.y, px: v.px, py: v.py, t: Date.now(), moved };
  };

  const onDown = (e: RPointerEvent) => {
    if (!viewRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    stageRef.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    if (ptrs.current.size === 2) {
      const [[a, pa], [b, pb]] = [...ptrs.current.entries()];
      setPull({ x: 0, y: 0 });
      gesture.current = { kind: 'pinch', a, b, ...pinchStart(viewRef.current, pa, pb) };
    } else if (ptrs.current.size === 1) startDrag(e.pointerId, p);
  };

  const onMove = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const a = ptrs.current.get(g.a);
      const b = ptrs.current.get(g.b);
      if (a && b) setView(clamp(pinchView(g, a, b, minK, maxK)));
      return;
    }
    if (e.pointerId !== g.id) return;
    const dx = p.x - g.sx;
    const dy = p.y - g.sy;
    if (Math.hypot(dx, dy) > 8) g.moved = true;
    if (!g.moved) return;
    const raw = { k: viewRef.current!.k, px: g.px + dx, py: g.py + dy };
    const v = clamp(raw);
    setView(v);
    // At the starting view, what the pan could not take becomes a swipe: down to close, sideways to turn.
    if (!zoomed) setPull({ x: items.length > 1 ? raw.px - v.px : 0, y: Math.max(0, raw.py - v.py) });
  };

  const onUp = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // One finger left: it pans until it is lifted too.
      const rest = [...ptrs.current.entries()][0];
      if (rest) startDrag(rest[0], rest[1], true);
      else gesture.current = null;
      return;
    }
    if (ptrs.current.size) return;
    gesture.current = null;
    const p = local(e);
    const swipe = pull;
    setPull({ x: 0, y: 0 });
    if (!g || e.type !== 'pointerup') return;
    if (!g.moved) {
      // A tap; a second within 300 ms near the first is a double tap.
      const t = Date.now();
      const last = lastTap.current;
      if (last && t - last.t < 320 && Math.hypot(p.x - last.x, p.y - last.y) < 40) {
        lastTap.current = null;
        toggleZoom(p.x, p.y);
      } else lastTap.current = { t, x: p.x, y: p.y };
      return;
    }
    if (swipe.y > 90 && swipe.y > Math.abs(swipe.x)) onClose();
    else if (swipe.x < -60 && next !== null) setIndex(next);
    else if (swipe.x > 60 && prev !== null) setIndex(prev);
  };

  const pct = view && stage ? Math.round((view.k / homeK) * 100) : 100;
  const dim = Math.min(1, pull.y / 300);
  return (
    <div className="zv" role="dialog" aria-modal="true" aria-label={item.label || 'Image'} style={{ ['--zv-dim' as any]: 1 - dim * 0.7 }}>
      <div className="zv-top on-media solid">
        <span className="zv-count">{items.length > 1 ? `${index + 1} of ${items.length}` : ''}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <div ref={stageRef} className={`zv-stage ${scrolls ? 'pans' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {!size && item.src && <div className="zv-loading">Loading…</div>}
        <div
          className="zv-content"
          style={{
            width: W,
            height: H,
            visibility: view ? 'visible' : 'hidden',
            transform: view ? `translate(${view.px + pull.x}px, ${view.py + pull.y}px) scale(${view.k})` : undefined,
          }}
        >
          {item.node ??
            (item.src && (
              <img
                key={item.src}
                src={item.src}
                alt={item.label ?? ''}
                draggable={false}
                onLoad={(e) => !(item.width && item.height) && setSize({ W: e.currentTarget.naturalWidth || 1, H: e.currentTarget.naturalHeight || 1 })}
              />
            ))}
        </div>
      </div>
      <div className="zv-bar lightbox-bar on-media">
        {items.length > 1 && (
          <button className="icon-btn" disabled={prev === null} onClick={() => prev !== null && setIndex(prev)} aria-label="Previous">
            <Icon name="back" />
          </button>
        )}
        <div className="lightbox-text">
          {item.label && <span className="label">{item.label}</span>}
          {item.text}
        </div>
        {items.length > 1 && (
          <button className="icon-btn flip-x" disabled={next === null} onClick={() => next !== null && setIndex(next)} aria-label="Next">
            <Icon name="back" />
          </button>
        )}
        <div className="zv-zoom on-media" role="group" aria-label="Zoom">
          <button className="icon-btn" onClick={() => zoomTo((view?.k ?? homeK) / 1.5)} disabled={!view || view.k <= minK * 1.001} aria-label="Zoom out">
            <span aria-hidden="true">−</span>
          </button>
          <button className="zv-fit" onClick={() => setView(home())} aria-label={zoomed ? 'Back to the starting view' : 'Starting view'}>
            {pct === 100 ? 'Fit' : `${pct}%`}
          </button>
          <button className="icon-btn" onClick={() => zoomTo((view?.k ?? homeK) * 1.5)} disabled={!view || view.k >= maxK * 0.999} aria-label="Zoom in">
            <span aria-hidden="true">+</span>
          </button>
        </div>
        {item.actions}
      </div>
    </div>
  );
}
