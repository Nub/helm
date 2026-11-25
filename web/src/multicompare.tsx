import './multicompare.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as RKeyboardEvent, PointerEvent as RPointerEvent, ReactNode } from 'react';
import { Icon, Markdown } from './ui';
import { closeViewer, openViewer } from './viewer';
import { AnnotateButton } from './annotate';
import { clampView, pinchStart, pinchView, zoomAround } from './zoom';
import type { Box, PinchStart, View } from './zoom';

/**
 * A comparison of 2 to 8 labelled images of the same viewpoint (two open on the slider): side by side, a slider between any two, flipping
 * through them one at a time, and each image's difference from a reference. Zoom and pan are one shared view, applied
 * to every image in view in every mode, so the same spot stays under the eye whatever is shown.
 *
 * The shared view is kept independent of pane size: a zoom factor over "fitted" and the point of the frame at the
 * pane's centre, in the frame's natural pixels. Each pane turns it into its own View (zoom.ts) to draw and to apply a
 * gesture, then back. Images are drawn at one scale from the top left of a frame as big as the largest of them, so a
 * size difference shows as a gap and nothing is stretched.
 */
export type CompareImage = { label: string; src: string; width?: number | null; height?: number | null; caption?: string };

type Mode = 'side' | 'slide' | 'flip' | 'diff';
type Size = { w: number; h: number };
/** z: zoom over fitted; (cx, cy): the frame point at the pane's centre. null is fitted. */
type Shared = { z: number; cx: number; cy: number } | null;

const MAX_Z = 8;
const DOUBLE_TAP = 2.5;
const AMPLIFY = 4;

export function MultiCompare({
  images,
  reference = null,
  title,
  onAnnotate,
  compact = false,
}: {
  images: CompareImage[];
  reference?: number | null;
  title?: string;
  onAnnotate?: (index: number) => void;
  compact?: boolean;
}) {
  const n = images.length;
  const given = reference !== null && reference >= 0 && reference < n ? reference : null;
  // The difference needs a reference; with exactly two images the first is one.
  const refI = given ?? (n === 2 ? 0 : null);
  const others = images.map((_, i) => i).filter((i) => i !== refI);

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sizes = useSizes(images);
  const known = sizes.every((s) => s !== undefined);
  const good = sizes.filter((s): s is Size => !!s);
  const frame: Size = good.length ? { w: Math.max(...good.map((s) => s.w)), h: Math.max(...good.map((s) => s.h)) } : { w: 4, h: 3 };
  const distinct = [...new Set(good.map((s) => `${s.w}×${s.h}`))];

  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen === 'diff' && refI === null ? 'side' : (chosen ?? (n === 2 ? 'slide' : 'side'));
  const [zv, setZv] = useState<Shared>(null);
  const [showing, setShowing] = useState(0);
  const firstOther = others[0] ?? (n > 1 ? 1 : 0);
  const [pair, setPair] = useState<[number, number]>(given !== null ? [given, firstOther] : [0, 1]);
  const [diffI, setDiffI] = useState(firstOther);
  const [picking, setPicking] = useState(false);
  const [pos, setPos] = useState(50);

  const cycle = (d: number) => setShowing((s) => (s + d + n) % n);
  const cur = Math.min(showing, n - 1);
  const [a, b] = pair.map((i) => Math.min(i, n - 1));

  /** Picking the image the other side already shows swaps them. */
  const pick = (side: 0 | 1, i: number) => setPair(([x, y]) => (side === 0 ? (i === y ? [i, x] : [i, y]) : i === x ? [y, i] : [x, i]));

  const diff = useDiff(mode === 'diff' && refI !== null ? images[refI] : null, mode === 'diff' ? images[diffI] : null, refI !== null ? sizes[refI] : undefined, sizes[diffI]);

  const inView = mode === 'side' ? images.map((_, i) => i) : mode === 'flip' ? [cur] : mode === 'slide' ? [a, b] : refI !== null ? [refI, diffI] : [];
  const fullAt = mode === 'flip' ? cur : mode === 'slide' ? b : mode === 'diff' ? diffI : 0;
  const openFull = (at: number) =>
    openViewer(
      images.map((im, i) => ({
        src: im.src,
        width: sizes[i]?.w ?? im.width ?? undefined,
        height: sizes[i]?.h ?? im.height ?? undefined,
        label: im.label,
        text: im.caption ? <Markdown className="small" text={im.caption} /> : undefined,
        actions: onAnnotate ? <AnnotateButton onClick={() => (closeViewer(), onAnnotate(i))} /> : undefined,
      })),
      at,
    );

  // 2 columns on a phone, up to 4 on a wide screen; four images are never 3 + 1.
  const wideCols = width < 560 ? 2 : width < 900 ? 3 : 4;
  const cols = Math.max(2, n === 4 && wideCols === 3 ? 2 : Math.min(n, wideCols));
  const pane = { frame, zv, setZv, wheel: !compact };
  const fitStyle: CSSProperties = { maxWidth: `calc(70dvh * ${frame.w / frame.h})` };

  const onKey = (e: RKeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (mode === 'flip' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) cycle(e.key === 'ArrowLeft' ? -1 : 1);
    else if (e.key === '0' && zv) setZv(null);
    else return;
    e.preventDefault();
  };

  const modes: { key: Mode; text: string }[] = [
    { key: 'side', text: 'Side by side' },
    { key: 'slide', text: 'Slider' },
    { key: 'flip', text: 'Flip' },
    ...(refI !== null ? [{ key: 'diff' as Mode, text: 'Difference' }] : []),
  ];
  const pickable = mode === 'slide' ? [a, b] : mode === 'diff' && refI !== null ? [refI, diffI] : [];

  return (
    <div className={`mc ${compact ? 'mc-compact' : ''}`} ref={rootRef} role="group" aria-label={title ? `${title}: comparison` : 'Comparison'} onKeyDown={onKey}>
      <div className="mc-bar">
        <Tabs className="segmented compact mc-modes" label="Comparison view" items={modes} value={mode} onChange={(m) => (setChosen(m), setPicking(false))} />
        <div className="mc-tools">
          <button type="button" className="btn small quiet mc-fit" onClick={() => setZv(null)} disabled={!zv} aria-label={zv ? `Zoomed ${Math.round(zv.z * 100)}%; fit` : 'Fitted'}>
            {zv ? `${Math.round(zv.z * 100)}% · Fit` : 'Fit'}
          </button>
          <button type="button" className="btn small quiet" onClick={() => openFull(fullAt)} aria-label="Full screen, zoomable">
            <Icon name="external" size={16} /> Full screen
          </button>
          {onAnnotate && mode === 'flip' && <AnnotateButton onClick={() => onAnnotate(cur)} />}
          {onAnnotate && pickable.length > 0 && <AnnotateButton onClick={() => setPicking(!picking)} />}
        </div>
      </div>
      {onAnnotate && picking && pickable.length > 0 && (
        <div className="mc-pick" role="group" aria-label="Which image to annotate">
          <span className="muted small">Annotate which image?</span>
          {pickable.map((i) => (
            <button key={i} type="button" className="btn small mc-chip-btn" title={images[i].label} onClick={() => (setPicking(false), onAnnotate(i))}>
              <span>{images[i].label}</span>
            </button>
          ))}
        </div>
      )}

      {known && distinct.length > 1 && (
        <p className="muted small mc-note" role="note">
          Sizes differ ({distinct.join(', ')}): drawn at one scale from the top left, not stretched.
        </p>
      )}

      {mode === 'side' && (
        <div className="mc-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {images.map((im, i) => (
            <figure key={i} className="mc-fig">
              <figcaption>
                <span className="mc-label">{im.label}</span>
                {onAnnotate && <AnnotateButton className="small" onClick={() => onAnnotate(i)} />}
              </figcaption>
              <Pane {...pane} style={fitStyle} label={im.label} ready={known}>
                {(st) => <Layer style={st} images={[im]} sizes={[sizes[i]]} />}
              </Pane>
              {!compact && im.caption && <Markdown className="small" text={im.caption} />}
            </figure>
          ))}
        </div>
      )}

      {mode === 'slide' && (
        <>
          {n > 2 && (
            <div className="mc-pairs">
              {([0, 1] as const).map((side) => (
                <div key={side} className="mc-pair">
                  <span className="mc-side" aria-hidden="true">
                    {side ? 'B' : 'A'}
                  </span>
                  <Chips label={`Image ${side ? 'B, right' : 'A, left'} of the slider`} images={images} value={side ? b : a} onChange={(i) => pick(side, i)} />
                </div>
              ))}
            </div>
          )}
          <Pane
            {...pane}
            style={fitStyle}
            label={`${images[a].label} and ${images[b].label}`}
            ready={known}
            slide={setPos}
            extra={
              <>
                <span className="media-label split-label left mc-tag" style={{ opacity: pos < 12 ? 0 : 1 }}>
                  {images[a].label}
                </span>
                <span className="media-label split-label right mc-tag" style={{ opacity: pos > 88 ? 0 : 1 }}>
                  {images[b].label}
                </span>
                <SliderHandle pos={pos} setPos={setPos} a={images[a].label} b={images[b].label} />
              </>
            }
          >
            {(st) => (
              <>
                <Layer style={st} images={[images[b]]} sizes={[sizes[b]]} />
                <div className="mc-clip" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
                  <Layer style={st} images={[images[a]]} sizes={[sizes[a]]} />
                </div>
              </>
            )}
          </Pane>
        </>
      )}

      {mode === 'flip' && (
        <>
          <Chips label="Image shown" images={images} value={cur} onChange={setShowing} />
          <Pane
            {...pane}
            style={fitStyle}
            label={`Showing ${images[cur].label}, ${cur + 1} of ${n}; tap or press the arrow keys for the next`}
            ready={known}
            onTap={(undo) => cycle(undo ? -1 : 1)}
            focusable
            extra={<span className="media-label split-label left mc-tag mc-tag-wide">{images[cur].label}</span>}
          >
            {(st) => <Layer style={st} images={images} sizes={sizes} only={cur} />}
          </Pane>
        </>
      )}

      {mode === 'diff' && refI !== null && (
        <>
          {others.length > 1 && <Chips label="Compared with the reference" images={images} value={diffI} onChange={setDiffI} skip={refI} />}
          <p className="muted small mc-note">
            {images[diffI].label} against {images[refI].label}, differences ×{AMPLIFY}
            {diff.status === 'ok' && diff.share !== undefined && ` · ${diff.share === 0 ? 'no pixel differs' : `${fmtShare(diff.share)} of pixels differ`}`}
          </p>
          {diff.status === 'size' || diff.status === 'fail' ? (
            <p className="muted small mc-note" role="note">
              {diff.status === 'size' ? 'The two images differ in size, so there is no pixel-by-pixel difference: use Slider or Flip.' : 'The images could not be read to work out the difference.'}
            </p>
          ) : (
            <Pane {...pane} style={fitStyle} label={`Difference between ${images[diffI].label} and ${images[refI].label}`} ready={known && diff.status === 'ok'}>
              {(st) => (
                <div className="mc-content" style={st}>
                  {diff.data && <DiffCanvas data={diff.data} />}
                </div>
              )}
            </Pane>
          )}
        </>
      )}

      {!compact && mode !== 'side' && inView.some((i) => images[i].caption) && (
        <dl className="mc-captions">
          {inView.map(
            (i) =>
              images[i].caption && (
                <div key={i}>
                  <dt className="label">{images[i].label}</dt>
                  <dd>
                    <Markdown className="small" text={images[i].caption!} />
                  </dd>
                </div>
              ),
          )}
        </dl>
      )}
    </div>
  );
}

const fmtShare = (s: number) => (s < 0.001 ? 'under 0.1%' : `${(s * 100).toFixed(s < 0.1 ? 1 : 0)}%`);

/** Natural sizes: given, or read from the file. undefined while loading, null when the file could not be loaded. */
function useSizes(images: CompareImage[]): (Size | null | undefined)[] {
  const given = (im: CompareImage) => (im.width && im.height ? { w: im.width, h: im.height } : undefined);
  const [read, setRead] = useState<Record<string, Size | null>>({});
  const key = images.map((im) => `${im.src}|${im.width ?? ''}|${im.height ?? ''}`).join('\n');
  useEffect(() => {
    let live = true;
    for (const im of images) {
      if (given(im) || im.src in read) continue;
      const img = new Image();
      img.onload = () => live && setRead((r) => ({ ...r, [im.src]: img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null }));
      img.onerror = () => live && setRead((r) => ({ ...r, [im.src]: null }));
      img.src = im.src;
    }
    return () => {
      live = false;
    };
  }, [key]);
  return images.map((im) => given(im) ?? read[im.src]);
}

type Diff = { status: 'idle' | 'busy' | 'ok' | 'size' | 'fail'; data?: ImageData; share?: number };

/** The amplified per-pixel difference of two equally sized images, worked out in the browser. */
function useDiff(ref: CompareImage | null, other: CompareImage | null, refSize: Size | null | undefined, otherSize: Size | null | undefined): Diff {
  const [diff, setDiff] = useState<Diff & { key?: string }>({ status: 'idle' });
  const key = ref && other ? `${ref.src}\n${other.src}` : '';
  const sizeDiffers = !!(refSize && otherSize && (refSize.w !== otherSize.w || refSize.h !== otherSize.h));
  useEffect(() => {
    if (!ref || !other || sizeDiffers || diff.key === key) return;
    let live = true;
    setDiff({ key, status: 'busy' });
    (async () => {
      try {
        const [x, y] = await Promise.all([load(ref.src), load(other.src)]);
        if (x.naturalWidth !== y.naturalWidth || x.naturalHeight !== y.naturalHeight) return live && setDiff({ key, status: 'size' });
        const w = x.naturalWidth;
        const h = x.naturalHeight;
        const da = pixels(x, w, h);
        const db = pixels(y, w, h);
        const out = new ImageData(w, h);
        const o = out.data;
        let changed = 0;
        for (let i = 0; i < o.length; i += 4) {
          const r = Math.abs(da[i] - db[i]);
          const g = Math.abs(da[i + 1] - db[i + 1]);
          const bl = Math.abs(da[i + 2] - db[i + 2]);
          const al = Math.abs(da[i + 3] - db[i + 3]);
          if (r || g || bl || al) changed++;
          o[i] = Math.min(255, (r + al) * AMPLIFY);
          o[i + 1] = Math.min(255, (g + al) * AMPLIFY);
          o[i + 2] = Math.min(255, (bl + al) * AMPLIFY);
          o[i + 3] = 255;
        }
        if (live) setDiff({ key, status: 'ok', data: out, share: changed / (w * h) });
      } catch {
        if (live) setDiff({ key, status: 'fail' });
      }
    })();
    return () => {
      live = false;
      // Unfinished work is started again next time.
      setDiff((d) => (d.key === key && d.status === 'busy' ? { status: 'idle' } : d));
    };
  }, [key, sizeDiffers]);
  if (!key) return { status: 'idle' };
  if (sizeDiffers) return { status: 'size' };
  return diff.key === key ? diff : { status: 'busy' };
}

async function load(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** RGBA pixels of an image; throws when the canvas may not read them (another origin). */
function pixels(img: HTMLImageElement, w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (!x) throw new Error('no canvas');
  x.drawImage(img, 0, 0);
  return x.getImageData(0, 0, w, h).data;
}

function DiffCanvas({ data }: { data: ImageData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = data.width;
    c.height = data.height;
    c.getContext('2d')?.putImageData(data, 0, 0);
  }, [data]);
  return <canvas ref={ref} className="mc-diff" style={{ width: data.width, height: data.height }} aria-hidden="true" />;
}

/** The frame's content: images at their natural size from the top left, moved by the shared view. */
function Layer({ style, images, sizes, only }: { style: CSSProperties; images: CompareImage[]; sizes: (Size | null | undefined)[]; only?: number }) {
  return (
    <div className="mc-content" style={style}>
      {images.map((im, i) => {
        const s = sizes[i];
        if (s === null) return only === undefined || only === i ? <span key={i} className="mc-missing">{im.label}: could not load</span> : null;
        return <img key={i} src={im.src} alt={im.label} draggable={false} hidden={only !== undefined && only !== i} style={s ? { width: s.w, height: s.h } : undefined} />;
      })}
    </div>
  );
}

type Ptr = { x: number; y: number };
type Gesture = { kind: 'drag'; id: number; sx: number; sy: number; px: number; py: number; moved: boolean; slide: boolean } | ({ kind: 'pinch'; a: number; b: number } & PinchStart) | null;

/**
 * One image area. It draws the shared view at its own size and turns wheel, pinch, drag and double tap into a new
 * shared view. With `slide`, a drag at the fitted view moves the slider instead of panning.
 */
function Pane({
  frame,
  zv,
  setZv,
  wheel,
  style,
  label,
  ready,
  slide,
  onTap,
  focusable,
  extra,
  children,
}: {
  frame: Size;
  zv: Shared;
  setZv: (s: Shared) => void;
  wheel: boolean;
  style?: CSSProperties;
  label: string;
  ready: boolean;
  slide?: (pos: number) => void;
  onTap?: (undo: boolean) => void;
  focusable?: boolean;
  extra?: ReactNode;
  children: (content: CSSProperties) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const box: Box = { w, h: (w * frame.h) / frame.w };
  const fitK = w / frame.w || 1;
  const clamp = (v: View) => clampView(v, frame.w, frame.h, box, fitK, fitK * MAX_Z);
  const toView = (s: Shared): View => (s ? clamp({ k: fitK * s.z, px: box.w / 2 - s.cx * fitK * s.z, py: box.h / 2 - s.cy * fitK * s.z }) : { k: fitK, px: 0, py: 0 });
  const set = (v: View) => {
    const c = clamp(v);
    setZv(c.k <= fitK * 1.001 ? null : { z: c.k / fitK, cx: (box.w / 2 - c.px) / c.k, cy: (box.h / 2 - c.py) / c.k });
  };
  const view = toView(zv);
  const zvRef = useRef(zv);
  zvRef.current = zv;
  const ptrs = useRef(new Map<number, Ptr>());
  const gesture = useRef<Gesture>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  // Safari's own page zoom would fight the pinch; the wheel zooms (a trackpad pinch arrives as ctrl + wheel).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      if (!w || (!wheel && !e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = toView(zvRef.current);
      set(zoomAround(v, Math.min(fitK * MAX_Z, Math.max(fitK, v.k * Math.exp(-Math.max(-40, Math.min(40, e.deltaY)) * 0.01))), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener('gesturestart', stop);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('gesturestart', stop);
      el.removeEventListener('wheel', onWheel);
    };
  });

  const local = (e: { clientX: number; clientY: number }): Ptr => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const slideTo = (p: Ptr) => slide?.(Math.min(100, Math.max(0, (p.x / (w || 1)) * 100)));
  const startDrag = (id: number, p: Ptr, moved = false) => {
    const v = toView(zvRef.current);
    const sliding = !!slide && !zvRef.current && !moved;
    gesture.current = { kind: 'drag', id, sx: p.x, sy: p.y, px: v.px, py: v.py, moved, slide: sliding };
    if (sliding) slideTo(p);
  };

  const onDown = (e: RPointerEvent) => {
    if (!ready || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((e.target as HTMLElement).closest('.mc-handle')) return;
    ref.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    if (ptrs.current.size === 2) {
      const [[ia, pa], [ib, pb]] = [...ptrs.current.entries()];
      gesture.current = { kind: 'pinch', a: ia, b: ib, ...pinchStart(toView(zvRef.current), pa, pb) };
    } else if (ptrs.current.size === 1) startDrag(e.pointerId, p);
  };

  const onMove = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    const p = local(e);
    ptrs.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const pa = ptrs.current.get(g.a);
      const pb = ptrs.current.get(g.b);
      if (pa && pb) set(pinchView(g, pa, pb, fitK, fitK * MAX_Z));
      return;
    }
    if (e.pointerId !== g.id) return;
    const dx = p.x - g.sx;
    const dy = p.y - g.sy;
    if (Math.hypot(dx, dy) > 6) g.moved = true;
    if (g.slide) return slideTo(p);
    if (g.moved && zvRef.current) set({ k: toView(zvRef.current).k, px: g.px + dx, py: g.py + dy });
  };

  const onUp = (e: RPointerEvent) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      const rest = [...ptrs.current.entries()][0];
      if (rest) startDrag(rest[0], rest[1], true);
      else gesture.current = null;
      return;
    }
    if (ptrs.current.size) return;
    gesture.current = null;
    if (!g || g.moved || e.type !== 'pointerup') return;
    const p = local(e);
    const t = Date.now();
    const last = lastTap.current;
    if (last && t - last.t < 320 && Math.hypot(p.x - last.x, p.y - last.y) < 40) {
      // A double tap: take back what the first tap did, and toggle between fitted and 2.5× at that point.
      lastTap.current = null;
      onTap?.(true);
      if (zvRef.current) setZv(null);
      else set(zoomAround(toView(null), fitK * DOUBLE_TAP, p.x, p.y));
    } else {
      lastTap.current = { t, x: p.x, y: p.y };
      onTap?.(false);
    }
  };

  const content: CSSProperties = { width: frame.w, height: frame.h, transform: `translate(${view.px}px, ${view.py}px) scale(${view.k})` };
  return (
    <div className="mc-pane-wrap" style={style}>
      <div
        ref={ref}
        className={`compare-frame mc-pane ${zv ? 'zoomed' : ''} ${slide ? 'slides' : ''} ${onTap ? 'taps' : ''}`}
        style={{ aspectRatio: `${frame.w} / ${frame.h}` }}
        role={focusable ? 'button' : 'img'}
        tabIndex={focusable ? 0 : undefined}
        aria-label={label}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={focusable && onTap ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onTap(false)) : undefined}
      >
        {ready ? children(content) : <span className="mc-loading muted small">Loading…</span>}
        {ready && extra}
      </div>
    </div>
  );
}

function SliderHandle({ pos, setPos, a, b }: { pos: number; setPos: (n: number) => void; a: string; b: string }) {
  const dragging = useRef(false);
  const el = useRef<HTMLDivElement>(null);
  const moveTo = (clientX: number) => {
    const r = el.current!.parentElement!.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  const key = (e: RKeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const next = { ArrowLeft: pos - step, ArrowDown: pos - step, ArrowRight: pos + step, ArrowUp: pos + step, Home: 0, End: 100, PageDown: pos - 10, PageUp: pos + 10 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setPos(Math.min(100, Math.max(0, next)));
  };
  return (
    <div
      ref={el}
      className="slider-handle mc-handle"
      style={{ left: `${pos}%` }}
      role="slider"
      tabIndex={0}
      aria-label={`Divider between ${a} and ${b}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos)}
      aria-valuetext={`${Math.round(pos)}% ${a}`}
      onKeyDown={key}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.stopPropagation();
        dragging.current = true;
        el.current!.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => dragging.current && moveTo(e.clientX)}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
    >
      <span className="slider-knob" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
        </svg>
      </span>
    </div>
  );
}

/** A tablist with roving focus: arrow keys, Home and End move between the tabs. */
function Tabs<T>({ items, value, onChange, label, className }: { items: { key: T; text: string; title?: string }[]; value: T; onChange: (v: T) => void; label: string; className: string }) {
  const onKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((x) => x.key === value);
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const j = (to + items.length) % items.length;
    onChange(items[j].key);
    (e.currentTarget.querySelectorAll('[role=tab]')[j] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKey}>
      {items.map((x, i) => (
        <button key={i} type="button" role="tab" aria-selected={x.key === value} tabIndex={x.key === value ? 0 : -1} className={x.key === value ? 'on' : ''} title={x.title} onClick={() => onChange(x.key)}>
          <span>{x.text}</span>
        </button>
      ))}
    </div>
  );
}

/** A row of label chips, one per image (less `skip`). Long labels end with an ellipsis; the whole label is the title. */
function Chips({ images, value, onChange, label, skip }: { images: CompareImage[]; value: number; onChange: (i: number) => void; label: string; skip?: number }) {
  const items = images.map((im, i) => ({ key: i, text: im.label, title: im.label })).filter((x) => x.key !== skip);
  return <Tabs className="mc-chips" label={label} items={items} value={value} onChange={onChange} />;
}
