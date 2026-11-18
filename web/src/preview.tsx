import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Preview } from './api';
import { Chart, Icon, Markdown, ago, parseChart } from './ui';
import { closeViewer, openFrame, openViewer } from './viewer';
import type { ViewerItem } from './viewer';
import { AnnotateButton, FeedbackMarker, openAnnotator, projectFromHash } from './annotate';

/** Open the annotation editor on one image of a preview: side '' (an image preview), 'before'/'after', or 'step:N'. */
const annotate = (p: Preview, side: string, file: string, what: string) =>
  (closeViewer(), openAnnotator({ projectId: p.project_id ?? projectFromHash(), source: { kind: 'preview', id: p.id, side }, url: fileUrl(file), title: what }));

/** An Annotate button for the viewer's bar. */
const annotateAction = (p: Preview | undefined, side: string, file: string, what: string) => (p ? <AnnotateButton onClick={() => annotate(p, side, file, what)} /> : undefined);

/** Both sides of a comparison, for the viewer. */
const compareItems = (c: CompareContent, p?: Preview): ViewerItem[] =>
  [c.before, c.after].map((s, i) => ({ src: fileUrl(s.file), width: s.width ?? undefined, height: s.height ?? undefined, label: s.label, text: s.caption ? <Markdown className="small" text={s.caption} /> : undefined, actions: annotateAction(p, i ? 'after' : 'before', s.file, `${p?.title ?? ''} · ${s.label}`) }));

// Rendering of previews, shared by the gallery, the inbox and anything else that shows them.

export const fileUrl = (file: string) => `/artifacts/${file}`;

type StoredImage = { file: string; width: number | null; height: number | null };
type CompareSide = StoredImage & { label: string; caption: string };
export type CompareContent = { before: CompareSide; after: CompareSide };
export type GuideContent = { steps: { text: string; image: StoredImage | null }[]; expect: string };

function parseJson<T>(p: Preview, kind: string): T | null {
  if (p.kind !== kind || !p.content) return null;
  try {
    return JSON.parse(p.content) as T;
  } catch {
    return null;
  }
}
export const parseCompare = (p: Preview) => parseJson<CompareContent>(p, 'compare');
export const parseGuide = (p: Preview) => parseJson<GuideContent>(p, 'guide');

/** Kinds whose full form is interactive and readable inline (in a request, on a task page), not only in the viewer. */
export const INLINE_KINDS = ['compare', 'guide'];

export function useFileText(p: Preview, enabled: boolean) {
  const [text, setText] = useState<string | null>(p.content);
  useEffect(() => {
    if (!enabled || p.content !== null || !p.file) return;
    let live = true;
    fetch(fileUrl(p.file), { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((t) => live && setText(t.slice(0, 400000)));
    return () => {
      live = false;
    };
  }, [p.id, enabled]);
  return text;
}

// ---------- gallery tile ----------

export function PreviewTile({ p, onOpen, taskTitle }: { p: Preview; onOpen: () => void; taskTitle?: string }) {
  const chart = p.kind === 'chart' ? parseChart(p.content) : null;
  const text = useFileText(p, p.kind === 'markdown' || p.kind === 'text');
  const compare = parseCompare(p);
  const guide = parseGuide(p);
  const guideCover = guide?.steps.find((s) => s.image)?.image;
  return (
    <button className={`tile tile-${p.kind}`} onClick={onOpen}>
      <div className="tile-media">
        {p.kind === 'image' && p.file && <img src={fileUrl(p.file)} alt="" loading="lazy" />}
        {p.kind === 'video' && p.file && (
          <>
            <video src={`${fileUrl(p.file)}#t=0.1`} preload="metadata" muted playsInline />
            <span className="play-badge">
              <Icon name="play" size={18} />
            </span>
          </>
        )}
        {chart && <Chart spec={chart} compact />}
        {(p.kind === 'markdown' || p.kind === 'text') && <div className="tile-excerpt">{(text ?? '').slice(0, 320)}</div>}
        {compare && (
          <div className="tile-split" aria-label={`${compare.before.label} and ${compare.after.label}`}>
            <img src={fileUrl(compare.before.file)} alt="" loading="lazy" />
            <img src={fileUrl(compare.after.file)} alt="" loading="lazy" />
            <span className="split-tag left">{compare.before.label}</span>
            <span className="split-tag right">{compare.after.label}</span>
          </div>
        )}
        {guide && (
          <>
            {guideCover ? (
              <img src={fileUrl(guideCover.file)} alt="" loading="lazy" />
            ) : (
              <div className="tile-excerpt">{guide.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}</div>
            )}
            <span className="steps-badge">{guide.steps.length === 1 ? '1 step' : `${guide.steps.length} steps`}</span>
          </>
        )}
        {['html', 'pdf', 'link'].includes(p.kind) && (
          <div className="tile-glyph">
            <Icon name={p.kind === 'link' ? 'external' : 'previews'} size={30} />
            <span>{p.kind === 'html' ? 'Page' : p.kind === 'pdf' ? 'PDF' : 'Link'}</span>
          </div>
        )}
      </div>
      {p.feedback?.length ? <span className="tile-feedback" title="You sent feedback on this" aria-label="Feedback sent" /> : null}
      <div className="tile-caption">
        <strong>{p.title}</strong>
        <span className="muted small">
          {ago(p.created_at)}
          {taskTitle && <span className="tile-task"> · {taskTitle}</span>}
        </span>
      </div>
    </button>
  );
}

// ---------- full form ----------

/** The preview itself, as shown in the viewer: media for files, interactive views for comparisons and guides. */
export function PreviewBody({ p }: { p: Preview }) {
  const text = useFileText(p, p.kind === 'markdown' || p.kind === 'text');
  const chart = p.kind === 'chart' ? parseChart(p.content) : null;
  const compare = parseCompare(p);
  const guide = parseGuide(p);
  const marker = p.feedback?.length ? (
    <div className="ann-row">
      <FeedbackMarker feedback={p.feedback} />
    </div>
  ) : null;
  if (compare) return (
    <>
      {marker}
      <CompareView c={compare} p={p} />
    </>
  );
  if (guide) return (
    <>
      {marker}
      <GuideView g={guide} p={p} />
    </>
  );
  const url = p.file ? fileUrl(p.file) : '';
  return (
    <div className={`viewer-media viewer-${p.kind}`}>
      {p.kind === 'image' && (
        <div className="ann-host">
          <button type="button" className="zv-open" onClick={() => openViewer([{ src: url, label: p.title, actions: annotateAction(p, '', p.file!, p.title) }])} aria-label={`${p.title}, full screen`}>
            <img src={url} alt={p.title} />
          </button>
          <div className="ann-over">
            <FeedbackMarker feedback={p.feedback} />
            {p.file && <AnnotateButton onClick={() => annotate(p, '', p.file!, p.title)} />}
          </div>
        </div>
      )}
      {p.kind === 'video' && <video src={url} controls playsInline autoPlay muted />}
      {chart && (
        <>
          <Chart spec={chart} />
          <FullScreen onClick={() => openViewer([{ node: <div className="zv-chart"><Chart spec={chart} /></div>, width: 640, height: 360, label: p.title }])} />
        </>
      )}
      {p.kind === 'markdown' && <Markdown text={text ?? ''} />}
      {p.kind === 'text' && <pre>{text}</pre>}
      {(p.kind === 'html' || p.kind === 'pdf') && (
        <>
          <iframe src={url} title={p.title} sandbox={p.kind === 'html' ? 'allow-scripts' : undefined} />
          <FullScreen onClick={() => openFrame({ src: url, title: p.title, sandbox: p.kind === 'html' ? 'allow-scripts' : undefined })} />
        </>
      )}
      {p.kind === 'link' && (
        <a className="btn" href={p.content ?? '#'} target="_blank" rel="noreferrer">
          <Icon name="external" size={16} /> {p.content}
        </a>
      )}
    </div>
  );
}

function FullScreen({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn small quiet viewer-full" onClick={onClick}>
      <Icon name="external" size={15} /> Full screen
    </button>
  );
}

// ---------- comparison ----------

type Size = { width: number; height: number };
type Mode = 'side' | 'slide' | 'flip';

/** Width of an element, kept current. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Sizes stored by the server, or read from the loaded image when it could not tell (SVG, AVIF). */
function useSizes(c: CompareContent) {
  const known = (s: StoredImage): Size | null => (s.width && s.height ? { width: s.width, height: s.height } : null);
  const [sizes, setSizes] = useState<[Size | null, Size | null]>([known(c.before), known(c.after)]);
  const onLoad = (i: 0 | 1) => (e: { currentTarget: HTMLImageElement }) => {
    const { naturalWidth: width, naturalHeight: height } = e.currentTarget;
    if (!width || !height || sizes[i]) return;
    setSizes((cur) => (i ? [cur[0], { width, height }] : [{ width, height }, cur[1]]));
  };
  return { sizes, onLoad };
}

const sizeText = (s: Size | null) => (s ? `${s.width}×${s.height}` : 'unknown size');

export function CompareView({ c, p }: { c: CompareContent; p?: Preview }) {
  const [picking, setPicking] = useState(false);
  const annotateSide = (i: number) => p && annotate(p, i ? 'after' : 'before', (i ? c.after : c.before).file, `${p.title} · ${(i ? c.after : c.before).label}`);
  const { ref, width } = useWidth();
  const wide = width >= 560;
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen === 'side' && !wide ? 'slide' : (chosen ?? (wide ? 'side' : 'slide'));
  const [pos, setPos] = useState(50);
  const [showing, setShowing] = useState<0 | 1>(1);
  const { sizes, onLoad } = useSizes(c);
  const [b, a] = sizes;
  const mismatch = !!(b && a && (b.width !== a.width || b.height !== a.height));
  const ratioDiffers = !!(b && a && Math.abs(b.width / b.height - a.width / a.height) > 0.01);
  // Both images are drawn at one scale, anchored top left, in a frame big enough for either:
  // a size difference shows as a gap, never as a stretched image.
  const frameW = Math.max(b?.width ?? 1, a?.width ?? 1);
  const frameH = Math.max(b?.height ?? 1, a?.height ?? 1);
  const known = !!(b && a);
  const imgStyle = (s: Size | null) => (known && mismatch && s ? { width: `${(s.width / frameW) * 100}%` } : undefined);
  const frameStyle = known ? { aspectRatio: `${frameW} / ${frameH}` } : undefined;
  // One image at a time (slider, flip) is kept within the window's height, like a single image in the viewer.
  const fitStyle = known ? { ...frameStyle, maxWidth: `calc(70dvh * ${frameW / frameH})` } : undefined;
  const sides = [c.before, c.after] as const;

  return (
    <div className="compare" ref={ref}>
      <div className="compare-bar">
        <div className="segmented compact" role="tablist" aria-label="Comparison view">
          {wide && (
            <button role="tab" aria-selected={mode === 'side'} className={mode === 'side' ? 'on' : ''} onClick={() => setChosen('side')}>
              Side by side
            </button>
          )}
          <button role="tab" aria-selected={mode === 'slide'} className={mode === 'slide' ? 'on' : ''} onClick={() => setChosen('slide')}>
            Slider
          </button>
          <button role="tab" aria-selected={mode === 'flip'} className={mode === 'flip' ? 'on' : ''} onClick={() => setChosen('flip')}>
            Flip
          </button>
        </div>
        <button type="button" className="btn small quiet" onClick={() => openViewer(compareItems(c, p), mode === 'flip' ? showing : 1)} aria-label="Full screen, zoomable">
          <Icon name="external" size={15} /> Full screen
        </button>
        {p && mode !== 'side' && <AnnotateButton onClick={() => (mode === 'flip' ? annotateSide(showing) : setPicking(!picking))} />}
      </div>
      {p && picking && mode === 'slide' && (
        <div className="ann-pick" role="group" aria-label="Which image to annotate">
          <span className="muted small">Annotate which image?</span>
          {sides.map((s, i) => (
            <button key={i} className="btn small" onClick={() => (setPicking(false), annotateSide(i))}>
              {s.label}
            </button>
          ))}
        </div>
      )}

      {mismatch && (
        <p className="compare-warning" role="note">
          <strong>{ratioDiffers ? 'Different shapes.' : 'Different sizes.'}</strong> {c.before.label} is {sizeText(b)}, {c.after.label} is {sizeText(a)}. Shown at the same scale from the top left, not stretched
          {mode !== 'flip' && (
            <>
              {'; '}
              <button className="linkish" onClick={() => setChosen('flip')}>
                Flip
              </button>{' '}
              shows each whole
            </>
          )}
          .
        </p>
      )}

      {mode === 'side' && (
        <div className="compare-side">
          {sides.map((s, i) => (
            <figure key={i}>
              <figcaption>
                <span className="label">{s.label}</span>
                {p && <AnnotateButton className="small" onClick={() => annotateSide(i)} />}
              </figcaption>
              <button type="button" className="compare-frame zv-open" style={frameStyle} onClick={() => openViewer(compareItems(c, p), i)} aria-label={`${s.label}, full screen`}>
                <img src={fileUrl(s.file)} alt={s.label} style={imgStyle(sizes[i])} onLoad={onLoad(i as 0 | 1)} />
              </button>
              {s.caption && <Markdown className="small" text={s.caption} />}
            </figure>
          ))}
        </div>
      )}

      {mode === 'slide' && <Slider c={c} pos={pos} setPos={setPos} frameStyle={fitStyle} imgStyle={(i) => imgStyle(sizes[i])} onLoad={onLoad} />}

      {mode === 'flip' && (
        <div className="compare-flip">
          <div className="segmented compact flip-switch" role="tablist" aria-label="Image shown">
            {sides.map((s, i) => (
              <button key={i} role="tab" aria-selected={showing === i} className={showing === i ? 'on' : ''} onClick={() => setShowing(i as 0 | 1)}>
                {s.label}
              </button>
            ))}
          </div>
          <button className="compare-frame flip-frame" style={fitStyle} onClick={() => setShowing(showing ? 0 : 1)} aria-label={`Showing ${sides[showing].label}; tap to show ${sides[showing ? 0 : 1].label}`}>
            {sides.map((s, i) => (
              <img key={i} src={fileUrl(s.file)} alt={s.label} style={imgStyle(sizes[i])} onLoad={onLoad(i as 0 | 1)} hidden={showing !== i} />
            ))}
            <span className={`split-tag ${showing ? 'right' : 'left'}`}>{sides[showing].label}</span>
          </button>
        </div>
      )}

      {mode !== 'side' && (c.before.caption || c.after.caption) && (
        <dl className="compare-captions">
          {sides.map(
            (s, i) =>
              s.caption && (
                <div key={i}>
                  <dt className="label">{s.label}</dt>
                  <dd>
                    <Markdown className="small" text={s.caption} />
                  </dd>
                </div>
              ),
          )}
        </dl>
      )}
    </div>
  );
}

function Slider({
  c,
  pos,
  setPos,
  frameStyle,
  imgStyle,
  onLoad,
}: {
  c: CompareContent;
  pos: number;
  setPos: (n: number) => void;
  frameStyle: object | undefined;
  imgStyle: (i: 0 | 1) => object | undefined;
  onLoad: (i: 0 | 1) => (e: { currentTarget: HTMLImageElement }) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moveTo = (clientX: number) => {
    const r = frame.current!.getBoundingClientRect();
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    frame.current!.setPointerCapture(e.pointerId);
    moveTo(e.clientX);
  };
  const move = (e: PointerEvent) => dragging.current && moveTo(e.clientX);
  const up = () => {
    dragging.current = false;
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const next = { ArrowLeft: pos - step, ArrowDown: pos - step, ArrowRight: pos + step, ArrowUp: pos + step, Home: 0, End: 100, PageDown: pos - 10, PageUp: pos + 10 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setPos(Math.min(100, Math.max(0, next)));
  };
  return (
    <div
      className="compare-frame compare-slider"
      ref={frame}
      style={frameStyle}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
    >
      <img src={fileUrl(c.after.file)} alt={c.after.label} style={imgStyle(1)} onLoad={onLoad(1)} draggable={false} />
      <div className="slider-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
        <img src={fileUrl(c.before.file)} alt={c.before.label} style={imgStyle(0)} onLoad={onLoad(0)} draggable={false} />
      </div>
      <span className="split-tag left" style={{ opacity: pos < 12 ? 0 : 1 }}>
        {c.before.label}
      </span>
      <span className="split-tag right" style={{ opacity: pos > 88 ? 0 : 1 }}>
        {c.after.label}
      </span>
      <div
        className="slider-handle"
        style={{ left: `${pos}%` }}
        role="slider"
        tabIndex={0}
        aria-label={`Divider between ${c.before.label} and ${c.after.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        aria-valuetext={`${Math.round(pos)}% ${c.before.label}`}
        onKeyDown={key}
      >
        <span className="slider-knob" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />
          </svg>
        </span>
      </div>
    </div>
  );
}

// ---------- guide ----------

export function GuideView({ g, p }: { g: GuideContent; p?: Preview }) {
  const shots = g.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.image);
  const items: ViewerItem[] = shots.map(({ s, i }) => ({
    src: fileUrl(s.image!.file),
    width: s.image!.width ?? undefined,
    height: s.image!.height ?? undefined,
    label: `Step ${i + 1} of ${g.steps.length}`,
    text: <Markdown text={s.text} />,
    actions: annotateAction(p, `step:${i}`, s.image!.file, `${p?.title ?? ''} · step ${i + 1}`),
  }));
  const setZoom = (i: number) => openViewer(items, shots.findIndex((x) => x.i === i));
  return (
    <div className="guide">
      <ol className="guide-steps">
        {g.steps.map((s, i) => (
          <li key={i} className="guide-step">
            <span className="step-num" aria-hidden="true">
              {i + 1}
            </span>
            <div className="step-body">
              {s.image && (
                <button className="step-shot" onClick={() => setZoom(i)} aria-label={`Step ${i + 1} screenshot, full screen`}>
                  <img src={fileUrl(s.image.file)} alt="" loading="lazy" style={s.image.width && s.image.height ? { aspectRatio: `${s.image.width} / ${s.image.height}` } : undefined} />
                </button>
              )}
              <Markdown className="step-text" text={s.text} />
            </div>
          </li>
        ))}
      </ol>
      {g.expect && (
        <div className="guide-expect">
          <Icon name="check" size={20} />
          <div>
            <span className="label">When it works</span>
            <Markdown text={g.expect} />
          </div>
        </div>
      )}
    </div>
  );
}

