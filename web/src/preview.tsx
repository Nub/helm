import { useEffect, useMemo, useState } from 'react';
import { ShareButton } from './share';
import type { Preview } from './api';
import { Chart, Icon, Markdown, ago, href, parseChart } from './ui';
import { closeViewer, openFrame, openViewer } from './viewer';
import type { ViewerItem } from './viewer';
import { AnnotateButton, FeedbackMarker, openAnnotator, projectFromHash } from './annotate';
import { MultiCompare } from './multicompare';
import { findPlottable, firstLine } from './plottable';

/** Open the annotation editor on one image of a preview: side '' (an image preview), 'before'/'after', or 'step:N'. */
const annotate = (p: Preview, side: string, file: string, what: string) =>
  (closeViewer(), openAnnotator({ projectId: p.project_id ?? projectFromHash(), source: { kind: 'preview', id: p.id, side }, url: fileUrl(file), title: what }));

/** An Annotate button for the viewer's bar. */
const annotateAction = (p: Preview | undefined, side: string, file: string, what: string) => (p ? <AnnotateButton onClick={() => annotate(p, side, file, what)} /> : undefined);

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

export function PreviewTile({ p, onOpen }: { p: Preview; onOpen: () => void }) {
  const chart = p.kind === 'chart' ? parseChart(p.content) : null;
  const compare = parseCompare(p);
  const guide = parseGuide(p);
  const guideCover = guide?.steps.find((s) => s.image)?.image;
  return (
    <div className="tile-wrap">
    <button className={`tile tile-${p.kind}`} onClick={onOpen}>
      <div className="tile-media">
        {p.kind === 'image' && p.file && <img src={fileUrl(p.file)} alt="" loading="lazy" />}
        {p.kind === 'video' && p.file && (
          <>
            <video src={`${fileUrl(p.file)}#t=0.1`} preload="metadata" muted playsInline />
            <span className="play-mark">
              <Icon name="play" size={20} />
            </span>
          </>
        )}
        {chart && <Chart spec={chart} compact />}
        {TEXT_KINDS.includes(p.kind) && <TextThumb p={p} />}
        {compare && (
          <div className="tile-split" aria-label={`${compare.before.label} and ${compare.after.label}`}>
            <img src={fileUrl(compare.before.file)} alt="" loading="lazy" />
            <img src={fileUrl(compare.after.file)} alt="" loading="lazy" />
            <span className="media-label split-label left">{compare.before.label}</span>
            <span className="media-label split-label right">{compare.after.label}</span>
          </div>
        )}
        {guide && (
          <>
            {guideCover ? (
              <img src={fileUrl(guideCover.file)} alt="" loading="lazy" />
            ) : (
              <div className="tile-excerpt">{guide.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}</div>
            )}
            <span className="media-label steps-label">{guide.steps.length === 1 ? '1 step' : `${guide.steps.length} steps`}</span>
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
        <span className="muted small">{ago(p.created_at)}</span>
      </div>
    </button>
    <ShareButton route={href('p', p.project_id ?? /^#\/p\/([^/]+)/.exec(location.hash)?.[1] ?? '', 'previews', p.id)} title={p.title} className="tile-share" />
    </div>
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
      {p.kind === 'markdown' && <ChartedMarkdown text={text ?? ''} />}
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

/** A markdown preview: a plottable table shows first as a chart, the table itself collapsed under it as Data. */
function ChartedMarkdown({ text }: { text: string }) {
  const plot = useMemo(() => findPlottable(text), [text]);
  if (!plot) return <Markdown text={text} />;
  const rest = `${plot.before}\n\n${plot.after}`.trim();
  return (
    <>
      <Chart spec={plot.spec} table={false} />
      <details className="chart-table">
        <summary>Data</summary>
        <Markdown text={plot.table} />
      </details>
      {rest && <Markdown text={rest} />}
    </>
  );
}

function FullScreen({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn small quiet viewer-full" onClick={onClick}>
      <Icon name="external" size={16} /> Full screen
    </button>
  );
}

// ---------- comparison ----------

export function CompareView({ c, p }: { c: CompareContent; p?: Preview }) {
  const sides = [c.before, c.after];
  return (
    <MultiCompare
      title={p?.title}
      reference={null}
      images={sides.map((s) => ({ label: s.label, src: fileUrl(s.file), width: s.width, height: s.height, caption: s.caption || undefined }))}
      onAnnotate={p && ((i) => annotate(p, i ? 'after' : 'before', sides[i].file, `${p.title} · ${sides[i].label}`))}
    />
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

// ---------- thumbnails ----------

const TEXT_KINDS = ['markdown', 'text'];

/** A markdown or text preview as a picture: a mini chart of its plottable table, else a card with its title and first line. */
function TextThumb({ p }: { p: Preview }) {
  const text = useFileText(p, true);
  const plot = useMemo(() => findPlottable(text), [text]);
  if (plot) return <div className="thumb-chart"><Chart spec={plot.spec} compact /></div>;
  const line = firstLine(text, p.title);
  return (
    <div className="thumb-card">
      <strong>{p.title}</strong>
      {line && <span>{line}</span>}
    </div>
  );
}

/** Whether PreviewThumb has a picture for a preview. */
export const hasThumb = (p: Preview | null | undefined): p is Preview => !!p && (!!previewImage(p) || p.kind === 'chart' || TEXT_KINDS.includes(p.kind));

/** A small picture of a preview for cards and rows: its image, its chart, a chart of its table, or a text card. */
export function PreviewThumb({ p }: { p: Preview }) {
  const img = previewImage(p);
  if (img) return <img src={img} alt="" loading="lazy" />;
  const chart = p.kind === 'chart' ? parseChart(p.content) : null;
  if (chart) return <div className="thumb-chart"><Chart spec={chart} compact /></div>;
  return TEXT_KINDS.includes(p.kind) ? <TextThumb p={p} /> : null;
}

/** An image to show for a preview: the image itself, a comparison's after side, or a guide's first screenshot. */
export function previewImage(p: Preview | null | undefined): string | null {
  if (!p) return null;
  if (p.kind === 'image' && p.file) return fileUrl(p.file);
  const c = parseCompare(p);
  if (c?.after?.file) return fileUrl(c.after.file);
  const g = parseGuide(p)?.steps.find((x) => x.image)?.image;
  return g?.file ? fileUrl(g.file) : null;
}


