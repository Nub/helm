import { useEffect, useRef, useState } from 'react';
import { clearDraft, useStoredText } from './drafts';
import type { ReactNode } from 'react';
import { api, useLive } from './api';
import type { Dashboard, ProjectState, Tile, TileHistoryEntry } from './api';
import { Chart, Empty, Icon, Markdown, PlainRefs, RefLinks, Sheet, Tag, href, go, useAction, PageHeader } from './ui';
import { lookupRef, useRefs } from './refcache';
import { plainRefs, refIds } from './refs';
import type { ChartSpec } from './ui';
import { openFrame, openViewer } from './viewer';
import type { ViewerItem } from './viewer';
import { when } from './time';
import { MultiCompare } from './multicompare';

/**
 * Dashboards (server/dashboards.ts, dashrules.ts): pages of tiles agents keep current. The user describes a dashboard
 * and asks for changes in words (the director builds them); here they look, rearrange (drag on a desktop, Arrange with
 * ↑ ↓ on a phone), rename, remove, pin a tile to Home and ask the director to refresh one.
 *
 * Every dashboard reads the same way: titled sections in order (a contents line on a phone), and tiles that share one
 * header (a short title, one caption line, the rest behind an info tap) and one footer (as of when; Stale and Refresh
 * failed shown alike), in three sizes on one grid. Images of one view are a compare tile (multicompare.tsx, the same
 * component previews use); the numbers that score them a scores table with the same row labels; images and galleries
 * open in the one viewer. A dashboard's key names its series once, with the palette's colours.
 */

const fileUrl = (file: string) => `/artifacts/${file}`;
const short = (c: string | null | undefined) => (c ? c.slice(0, 7) : null);

export function DashboardsPage({ s, sub }: { s: ProjectState; sub?: string }) {
  const pid = s.project.id;
  const { data, error } = useLive<{ on: boolean; dashboards: Dashboard[] }>(`/api/projects/${pid}/dashboards`, (m) => m.type === 'project' && m.projectId === pid);
  const [creating, setCreating] = useState(false);
  if (error && !data) return <Empty title="Could not load the dashboards">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const list = data.dashboards;
  // One dashboard opens directly; the list is a tap away (All dashboards) once there are more.
  // A tile's own link (from search) opens its dashboard with the tile full screen.
  const tileSub = sub?.startsWith('tile_') ? sub : undefined;
  const open = tileSub ? list.find((d) => d.tiles.some((t) => t.id === tileSub)) : sub ? list.find((d) => d.id === sub) : list.length === 1 ? list[0] : undefined;
  const off = !data.on && (
    <a className="needs-banner" href={href('p', pid, 'setup', 'agent-context')}>
      <span>
        <strong>Dashboards are off</strong>
        <span className="muted small">Turn them on in Setup.</span>
      </span>
    </a>
  );
  if (open) return (
    <>
      {off}
      <DashboardView key={open.id} pid={pid} d={open} many={list.length > 1} onNew={() => setCreating(true)} tile={tileSub} />
      {creating && <NewDashboard pid={pid} onClose={() => setCreating(false)} />}
    </>
  );
  return (
    <section className="dash-page">
      <PageHeader title="Dashboards">
        {data.on && (
          <button className="btn small" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New dashboard
          </button>
        )}
      </PageHeader>
      {off}
      {sub && <p className="muted small">That dashboard was removed.</p>}
      {!list.length ? (
        <div className="empty dash-empty">
          <strong>No dashboards yet</strong>
          {data.on && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={16} /> New dashboard
            </button>
          )}
        </div>
      ) : (
        <ul className="dash-list">
          {list.map((d) => {
            const stale = d.tiles.filter((t) => t.stale).length;
            const cover = d.tiles.find((t) => t.kind === 'image' && t.data?.file);
            return (
              <li key={d.id}>
                <a className="card dash-list-item" href={href('p', pid, 'dashboards', d.id)}>
                  {cover && <img src={fileUrl(cover.data.file)} alt="" loading="lazy" />}
                  <span className="dash-list-text">
                    <strong className="one-line">{d.title}</strong>
                    <span className="muted small">
                      {d.tiles.length} {d.tiles.length === 1 ? 'tile' : 'tiles'}
                      {stale ? ` · ${stale} stale` : ''}
                    </span>
                  </span>
                  {d.state === 'building' && <Tag tone="tone-warning">Being built</Tag>}
                  <Icon name="chevron" size={16} />
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <NewDashboard pid={pid} onClose={() => setCreating(false)} />}
    </section>
  );
}

/** "New dashboard": the user's words, nothing to configure. */
function NewDashboard({ pid, onClose }: { pid: string; onClose: () => void }) {
  const key = `new-dashboard:${pid}`;
  const [text, setText] = useStoredText(key);
  const { busy, error, run } = useAction();
  const send = () =>
    run(async () => {
      const r = await api<{ id: string }>(`/api/projects/${pid}/dashboards`, { body: { description: text } });
      clearDraft(key);
      onClose();
      go('p', pid, 'dashboards', r.id);
    });
  return (
    <Sheet title="New dashboard" onClose={onClose}>
      <div className="form dash-new">
        <textarea autoFocus rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. A gallery of every level from the same three camera angles, so I can see how they look after each change." />
        {error && <p className="error-text small">{error}</p>}
        <div className="row">
          <span className="spacer" />
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || text.trim().length < 8} onClick={() => void send()}>
            <Icon name="send" size={16} /> Ask the director
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The dashboard's sections in reading order: each top-level section followed by its sub-sections; tiles in no section
 * (or in one that is gone) gather at the end, marked, until the director sorts them (the rules ask for a section).
 */
type SectionView = { id: string; title: string; sub: boolean; none?: boolean; hasSubs: boolean; match: (t: Tile) => boolean };
function sectionsOf(d: Dashboard): SectionView[] {
  const all = [...(d.sections ?? [])].sort((a, b) => a.position - b.position);
  const ids = new Set(all.map((x) => x.id));
  const out: SectionView[] = [];
  for (const top of all.filter((x) => !x.parent_id || !ids.has(x.parent_id))) {
    const subs = all.filter((x) => x.parent_id === top.id);
    out.push({ id: top.id, title: top.title, sub: false, hasSubs: subs.length > 0, match: (t) => t.section_id === top.id });
    for (const sub of subs) out.push({ id: sub.id, title: sub.title, sub: true, hasSubs: false, match: (t) => t.section_id === sub.id });
  }
  if (d.tiles.some((t) => !t.section_id || !ids.has(t.section_id))) out.push({ id: 'none', title: out.length ? 'Other' : 'Tiles', sub: false, none: out.length > 0, hasSubs: false, match: (t) => !t.section_id || !ids.has(t.section_id) });
  return out;
}

/** The viewer's items for image tiles (a gallery, or one image): the same viewer previews use. */
function galleryItems(tiles: Tile[]): ViewerItem[] {
  return tiles.filter((t) => t.data?.file).map((t) => ({ src: fileUrl(t.data.file), width: t.data.width ?? undefined, height: t.data.height ?? undefined, label: t.title }));
}

/** The dashboard's key: each series named once with its palette colour; tiles use these names. */
function DashKey({ d }: { d: Dashboard }) {
  if (!d.key?.length) return null;
  return (
    <p className="dash-key small" aria-label="Key">
      {d.key.map((k) => (
        <span key={k.name}>
          <i style={{ background: `var(--series-${k.color})` }} /> {k.name}
        </span>
      ))}
    </p>
  );
}
/** A label's colour from the dashboard's key, if it names it. */
const keyColor = (d: Dashboard | undefined, label: string) => d?.key?.find((k) => k.name.toLowerCase() === label.trim().toLowerCase())?.color;

/** Tiles in order, those sharing a group gathered where the first of them is (a gallery). */
type Unit = { key: string; group: string | null; tiles: Tile[] };
export function units(tiles: Tile[]): Unit[] {
  const out: Unit[] = [];
  for (const t of tiles) {
    const g = t.group.trim();
    const u = g ? out.find((x) => x.group === g) : undefined;
    if (u) u.tiles.push(t);
    else out.push({ key: g ? `g:${g}` : t.id, group: g || null, tiles: [t] });
  }
  return out;
}

function DashboardView({ pid, d, many, onNew, tile: startTile }: { pid: string; d: Dashboard; many: boolean; onNew: () => void; tile?: string }) {
  const [arrange, setArrange] = useState(false);
  const [changing, setChanging] = useState(false);
  const [menu, setMenu] = useState(false);
  const [openTile, setOpenTile] = useState<string | null>(startTile ?? null);
  const { error, run, busy } = useAction();
  const waiting = d.tiles.some((t) => t.asked_at);
  const order = (ids: string[]) => run(() => api(`/api/dashboards/${d.id}`, { method: 'PATCH', body: { order: ids } }));
  const flat = units(d.tiles).flatMap((u) => u.tiles.map((t) => t.id));
  /** Move a unit (a tile, or a whole gallery) one place up or down. */
  const moveUnit = (key: string, by: number) => {
    const us = units(d.tiles);
    const i = us.findIndex((u) => u.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= us.length) return;
    [us[i], us[j]] = [us[j], us[i]];
    void order(us.flatMap((u) => u.tiles.map((t) => t.id)));
  };
  const moveInGroup = (id: string, by: number) => {
    const ids = [...flat];
    const i = ids.indexOf(id);
    const g = d.tiles.find((t) => t.id === id)!.group;
    let j = i + by;
    while (j >= 0 && j < ids.length && d.tiles.find((t) => t.id === ids[j])!.group !== g) j += by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void order(ids);
  };
  // Desktop: drag a tile (or a gallery by its heading) onto another to put it there.
  const dragging = useRef<string | null>(null);
  const dropOn = (targetKey: string) => {
    const from = dragging.current;
    dragging.current = null;
    if (!from || from === targetKey) return;
    const us = units(d.tiles);
    const i = us.findIndex((u) => u.key === from);
    const j = us.findIndex((u) => u.key === targetKey);
    if (i < 0 || j < 0) return;
    const [u] = us.splice(i, 1);
    us.splice(j, 0, u);
    void order(us.flatMap((x) => x.tiles.map((t) => t.id)));
  };
  const rename = () => {
    const t = prompt('Rename the dashboard', d.title);
    if (t && t.trim() && t.trim() !== d.title) void run(() => api(`/api/dashboards/${d.id}`, { method: 'PATCH', body: { title: t.trim() } }));
  };
  const remove = () => {
    if (confirm(`Remove the dashboard "${d.title}" with its ${d.tiles.length} tiles and their history?`)) void run(async () => {
      await api(`/api/dashboards/${d.id}`, { method: 'DELETE' });
      go('p', pid, 'dashboards');
    });
  };
  const tile = openTile ? d.tiles.find((t) => t.id === openTile) : undefined;

  return (
    <section className={`dash-page dash-view ${arrange ? 'arranging' : ''}`}>
      {many && (
        <a className="dash-back small" href={href('p', pid, 'dashboards')}>
          <Icon name="back" size={16} /> All dashboards
        </a>
      )}
      <div className="section-head dash-head">
        <h1 className="page-title dash-title">{d.title}</h1>
        {arrange ? (
          <button className="btn small primary" onClick={() => setArrange(false)}>
            <Icon name="check" size={16} /> Done
          </button>
        ) : (
          <div className="dash-actions">
            {d.tiles.length > 0 && (
              <button className="btn small" aria-label={waiting ? 'Refreshing: the director has been asked' : undefined} disabled={busy || waiting} onClick={() => void run(() => api(`/api/dashboards/${d.id}/ask-refresh`, { body: {} }))}>
                <span className={waiting ? 'spin-icon' : ''}><Icon name="refresh" size={16} /></span>{waiting ? '' : ' Refresh'}
              </button>
            )}
            <button className="btn small" onClick={() => setChanging(true)}>
              <Icon name="edit" size={16} /> Change
            </button>
            <button className="icon-btn" aria-label="More for this dashboard" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Icon name="more" />
            </button>
          </div>
        )}
      </div>
      {menu && !arrange && (
        <div className="dash-menu card" role="menu" onClick={() => setMenu(false)}>
          {d.tiles.length > 1 && (
            <button role="menuitem" onClick={() => setArrange(true)}>
              Arrange tiles
            </button>
          )}
          <button role="menuitem" onClick={rename}>
            Rename
          </button>
          <button role="menuitem" onClick={onNew}>
            New dashboard
          </button>
          <button role="menuitem" className="danger" onClick={remove}>
            Remove dashboard
          </button>
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
      {d.state === 'building' && (
        <div className="dash-building card">
          <Tag tone="tone-warning">Being built</Tag>
          <span className="small">
            The director is building this from your description{d.tiles.length ? `; ${d.tiles.length} ${d.tiles.length === 1 ? 'tile' : 'tiles'} so far` : ''}.
          </span>
          {d.task && <Markdown className="small" text={`[[${d.task.id}]]`} />}
        </div>
      )}
      {arrange && <p className="muted small">Move tiles with the arrows{matchMedia('(pointer: fine)').matches ? ' or drag them' : ''}.</p>}
      <DashKey d={d} />
      {sectionsOf(d).length > 1 && (
        <nav className="dash-contents small" aria-label="Sections">
          {sectionsOf(d).filter((x) => !x.sub).map((x) => (
            <a key={x.id} href={`#${x.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`sec-${x.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))}>
              {x.title}
            </a>
          ))}
        </nav>
      )}
      {!d.tiles.length ? (
        <p className="muted small">No tiles yet.</p>
      ) : (
        sectionsOf(d).map((sec) => {
          const tilesHere = d.tiles.filter((t) => sec.match(t));
          if (!tilesHere.length && !sec.hasSubs) return null;
          return (
            <section key={sec.id} id={`sec-${sec.id}`} className={`dash-section ${sec.sub ? 'sub' : ''}`} aria-label={sec.title}>
              {sec.sub ? <h3 className="dash-section-title">{sec.title}</h3> : <h2 className="dash-section-title">{sec.title}</h2>}
              {sec.none && <p className="muted small">Not in a section yet: the director is asked to sort these.</p>}
              <div className="dash-grid">
                {units(tilesHere).map((u, k, all) => {
                  const dragProps = {
                    draggable: matchMedia('(pointer: fine)').matches,
                    onDragStart: () => (dragging.current = u.key),
                    onDragOver: (e: React.DragEvent) => e.preventDefault(),
                    onDrop: () => dropOn(u.key),
                  };
                  const arrows = arrange && (
                    <span className="dash-arrows">
                      <button className="icon-btn" aria-label="Move up" disabled={k === 0} onClick={() => moveUnit(u.key, -1)}>
                        <Icon name="top" size={16} />
                      </button>
                      <button className="icon-btn flip" aria-label="Move down" disabled={k === all.length - 1} onClick={() => moveUnit(u.key, 1)}>
                        <Icon name="top" size={16} />
                      </button>
                    </span>
                  );
                  if (u.group) {
                    const gallery = galleryItems(u.tiles);
                    return (
                      <div key={u.key} className="dash-gallery card size-l" {...dragProps}>
                        <div className="dash-gallery-head">
                          <h3 className="one-line">{u.group}</h3>
                          <span className="muted small">{u.tiles.length} pictures</span>
                          <span className="spacer" />
                          {arrows}
                        </div>
                        <div className="dash-gallery-grid">
                          {u.tiles.map((t, i) => (
                            <TileCard key={t.id} t={t} d={d} small onOpen={() => (t.data?.file ? openViewer(gallery, gallery.findIndex((g) => g.label === t.title)) : setOpenTile(t.id))} onDetails={() => setOpenTile(t.id)} arrange={arrange} onMove={(by) => moveInGroup(t.id, by)} first={i === 0} last={i === u.tiles.length - 1} />
                          ))}
                        </div>
                      </div>
                    );
                  }
                  const t = u.tiles[0];
                  return (
                    <div key={u.key} className={`dash-cell kind-${t.kind} size-${t.size ?? 'm'}`} {...dragProps}>
                      <TileCard t={t} d={d} onOpen={() => (t.kind === 'image' && t.data?.file ? openViewer(galleryItems([t]), 0) : setOpenTile(t.id))} onDetails={() => setOpenTile(t.id)} arrows={arrows} />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
      {changing && <ChangeDashboard d={d} onClose={() => setChanging(false)} />}
      {tile && <TileFull t={tile} onClose={() => setOpenTile(null)} />}
    </section>
  );
}

function ChangeDashboard({ d, onClose }: { d: Dashboard; onClose: () => void }) {
  const key = `dashboard-change:${d.id}`;
  const [text, setText] = useStoredText(key);
  const [sent, setSent] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Sheet title="Change this dashboard" onClose={onClose}>
      {sent ? (
        <div className="form">
          <p>Sent to the director. It adjusts the tiles and tells you in the dashboard's task when it is done.</p>
          <Markdown text={`[[${sent}]]`} />
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="form">
          <textarea autoFocus rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Add the night variant of each level, and drop the desert." />
          {error && <p className="error-text small">{error}</p>}
          <div className="row">
            <span className="spacer" />
            <button className="btn quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void run(async () => { const r = await api<{ task_id: string }>(`/api/dashboards/${d.id}/change`, { body: { text } }); clearDraft(key); setSent(r.task_id); })}>
              <Icon name="send" size={16} /> Send
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ---------- one tile ----------

/** "as of 4:12 pm" on a tile; full screen adds the commit (times in the user's zone through the shared formatter). */
export function AsOf({ t, commit = false }: { t: Tile; commit?: boolean }) {
  if (!t.built) return <span className="muted small">no data yet</span>;
  if (!commit) return <span className="muted small dash-asof">as of {when(t.built.at)}</span>;
  return (
    <span className="muted small dash-asof" title={t.built.commit ?? ''}>
      as of {short(t.built.commit) ? <code>{short(t.built.commit)}</code> : 'an unknown commit'}, {when(t.built.at)}
    </span>
  );
}

function StaleChip({ t }: { t: Tile }) {
  const [open, setOpen] = useState(false);
  if (!t.stale && !t.error) return null;
  return (
    <span className="dash-state-wrap">
      <button className={`tag dash-state ${t.error ? 'tone-critical' : 'tone-warning'}`} aria-expanded={open} onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))}>
        {t.error ? 'Refresh failed' : 'Stale'}
      </button>
      {open && (
        <span className="dash-why card small" role="note" onClick={(e) => e.stopPropagation()}>
          {t.error && (
            <span>
              <strong>Last refresh failed</strong> ({t.error.agent}, {when(t.error.at)}): {t.error.message}. The last good data is shown.
            </span>
          )}
          {t.stale && (
            <span>
              <strong>Out of date:</strong> {t.stale.reason}
              {t.stale.task_id && (
                <>
                  {' '}
                  <Markdown className="inline-md" text={`[[${t.stale.task_id}]]`} />
                </>
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

/**
 * One tile, the same frame for every kind: a header (its title on one line, an info tap for the longer notes, one
 * muted caption line) and a footer (as of when, and Stale or Refresh failed). A compare or scores tile shows its
 * widget in place; others open full screen (an image in the viewer).
 */
function TileCard({ t, d, onOpen, onDetails, small = false, arrange = false, arrows, onMove, first, last }: { t: Tile; d?: Dashboard; onOpen: () => void; onDetails?: () => void; small?: boolean; arrange?: boolean; arrows?: ReactNode; onMove?: (by: number) => void; first?: boolean; last?: boolean }) {
  const [info, setInfo] = useState(false);
  const refresh = useAction();
  const inPlace = t.kind === 'compare' || t.kind === 'scores';
  return (
    <article className={`dash-tile card ${small ? 'small' : ''} ${t.stale ? 'is-stale' : ''}`} aria-label={t.title}>
      <header className="dash-tile-head">
        <h3 className="one-line" title={t.title}>
          {t.title}
        </h3>
        {t.kind === 'page' && <Tag tone="tone-warning">Custom page</Tag>}
        {(t.info || t.page_reason) && !small && (
          <button className="icon-btn dash-info" aria-label={`About ${t.title}`} aria-expanded={info} onClick={() => setInfo(!info)}>
            <span aria-hidden="true">i</span>
          </button>
        )}
        {!arrange && (
          <button
            className={`icon-btn dash-refresh ${t.asked_at ? 'pending' : ''}`}
            aria-label={t.asked_at ? `${t.title}: the director is refreshing it` : `Ask the director to refresh ${t.title}`}
            disabled={refresh.busy || !!t.asked_at}
            onClick={() => void refresh.run(() => api(`/api/tiles/${t.id}/ask-refresh`, { body: {} }))}
          >
            <Icon name="refresh" size={16} />
          </button>
        )}
        {onDetails && inPlace && !arrange && (
          <button className="icon-btn" aria-label={`${t.title}: history and how it is kept current`} onClick={onDetails}>
            <Icon name="more" size={16} />
          </button>
        )}
        {arrows}
        {arrange && onMove && (
          <span className="dash-arrows">
            <button className="icon-btn" aria-label="Move earlier" disabled={first} onClick={() => onMove(-1)}>
              <Icon name="back" size={16} />
            </button>
            <button className="icon-btn flip-h" aria-label="Move later" disabled={last} onClick={() => onMove(1)}>
              <Icon name="back" size={16} />
            </button>
          </span>
        )}
      </header>
      {t.caption && !small && <p className="dash-caption muted small one-line" title={t.caption}>{t.caption}</p>}
      {info && (
        <div className="dash-info small">
          {t.page_reason && <p><strong>Why a custom page:</strong> {t.page_reason}</p>}
          {t.info && <Markdown text={t.info} />}
        </div>
      )}
      {inPlace ? (
        <div className="dash-tile-body in-place">
          <TileContent t={t} compact d={d} />
        </div>
      ) : (
        <button className="dash-tile-body" onClick={onOpen} aria-label={`Open ${t.title} full screen`} disabled={arrange}>
          <TileContent t={t} compact d={d} />
        </button>
      )}
      <footer className="dash-tile-foot">
        <AsOf t={t} />
        <StaleChip t={t} />
      </footer>
    </article>
  );
}

/** What a tile shows, by kind; `compact` in the grid, larger full screen. */
export function TileContent({ t, compact = false, data, d }: { t: Tile; compact?: boolean; data?: any; d?: Dashboard }) {
  const v = data ?? t.data;
  if (!v) return <span className="muted small dash-nodata">No data yet</span>;
  switch (t.kind) {
    case 'number':
      return <NumberView v={v} history={t.history} compact={compact} />;
    case 'chart':
      return <ChartTile v={v as ChartSpec} compact={compact} />;
    case 'table':
      return <TableView v={v} compact={compact} />;
    case 'scores':
      // The reference the scores are measured against is not a contender for best: the compare tile beside it names it.
      return <ScoresView v={v} d={d} reference={d?.tiles.find((x) => x.kind === 'compare' && x.section_id === t.section_id)?.data?.reference} />;
    case 'compare':
      return (
        <MultiCompare
          compact={compact}
          title={t.title}
          images={(v.images ?? []).map((im: any) => ({ label: im.label, src: fileUrl(im.file), width: im.width, height: im.height, caption: im.caption }))}
          reference={v.reference ? (v.images ?? []).findIndex((im: any) => im.label === v.reference) : null}
        />
      );
    case 'image':
      return <img className="dash-img" src={fileUrl(v.file)} alt={v.caption ?? t.title} loading="lazy" width={v.width ?? undefined} height={v.height ?? undefined} />;
    case 'text':
      return compact ? <div className="dash-text"><Markdown text={v.markdown} /></div> : <Markdown text={v.markdown} />;
    case 'page':
      return compact ? (
        <span className="dash-page-tile">
          <Icon name="external" size={20} /> Open the page
        </span>
      ) : (
        <iframe className="dash-frame" src={fileUrl(v.file)} title={t.title} sandbox="allow-scripts" />
      );
  }
  return null;
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function NumberView({ v, history, compact }: { v: any; history: TileHistoryEntry[]; compact: boolean }) {
  const values = history.map((h) => h.data?.value).filter((x): x is number => typeof x === 'number');
  const prev = values.length > 1 ? values[values.length - 2] : null;
  const delta = prev !== null ? v.value - prev : null;
  const good = delta === null || delta === 0 || !v.better ? null : (delta < 0) === (v.better === 'lower');
  const onTarget = typeof v.target === 'number' && v.better ? (v.better === 'lower' ? v.value <= v.target : v.value >= v.target) : null;
  const gauge = typeof v.min === 'number' && typeof v.max === 'number';
  const pct = gauge ? Math.max(0, Math.min(100, ((v.value - v.min) / (v.max - v.min)) * 100)) : 0;
  const tpct = gauge && typeof v.target === 'number' ? Math.max(0, Math.min(100, ((v.target - v.min) / (v.max - v.min)) * 100)) : null;
  return (
    <div className={`dash-number ${compact ? '' : 'large'}`}>
      {v.label && <span className="muted small">{compact ? <PlainRefs text={v.label} /> : <RefLinks text={v.label} />}</span>}
      <span className="dash-value">
        <b>{fmt(v.value)}</b>
        {v.unit && <span className="dash-unit">{v.unit}</span>}
      </span>
      <span className="small dash-number-sub">
        {delta !== null && delta !== 0 && (
          <span className={good === null ? 'muted' : good ? 'good' : 'bad'}>
            {delta > 0 ? '▲' : '▼'} {fmt(Math.abs(delta))}
            {v.unit ? ` ${v.unit}` : ''}
          </span>
        )}
        {typeof v.target === 'number' && (
          <span className={onTarget === null ? 'muted' : onTarget ? 'good' : 'bad'}>
            target {fmt(v.target)}
            {v.unit ? ` ${v.unit}` : ''}
          </span>
        )}
      </span>
      {gauge && (
        <span className="dash-gauge" role="meter" aria-valuenow={v.value} aria-valuemin={v.min} aria-valuemax={v.max}>
          <span className="dash-gauge-fill" style={{ width: `${pct}%` }} />
          {tpct !== null && <span className="dash-gauge-target" style={{ left: `${tpct}%` }} />}
        </span>
      )}
      {values.length > 1 && <Spark values={values} />}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const W = 120;
  const H = 28;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4)}`).join(' ');
  return (
    <svg className="dash-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={`Trend over the last ${values.length} values`} role="img">
      <polyline points={pts} fill="none" stroke="var(--series-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A chart whose labels may name Helm items ([[id]]): drawn with their titles. Full screen, the items are listed as
 * links under it, since bars are too small to tap on a phone.
 */
function ChartTile({ v, compact }: { v: ChartSpec; compact: boolean }) {
  const raw = (v.labels ?? []).map(String);
  const ids = refIds(raw.join('\n'));
  useRefs(ids);
  const spec = ids.length ? { ...v, labels: raw.map((l) => plainRefs(l, lookupRef)) } : v;
  // Each item with its value when the chart has one series ("26 min").
  const one = v.series.length === 1 ? v.series[0].values : null;
  const items = ids.length && !compact ? raw.map((l, i) => ({ l, n: one?.[i] })).filter((x) => refIds(x.l).length) : [];
  return (
    <div className={compact ? 'dash-chart-mini' : ''}>
      <Chart spec={spec} width={compact ? 400 : 640} />
      {items.length > 0 && (
        <ul className="dash-items">
          {items.map((x, i) => (
            <li key={i}>
              <span>
                <RefLinks text={x.l} />
              </span>
              {typeof x.n === 'number' && (
                <span className="muted small dash-item-n">
                  {fmt(x.n)}
                  {v.unit ? ` ${v.unit}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A scores table: typed columns (a unit, which way is better), numbers right-aligned, the best in each column marked,
 * row labels as the compare tile names its images (and in the key's colour), so the two read as one.
 */
function ScoresView({ v, d, reference }: { v: { columns: { name: string; unit?: string; better?: 'higher' | 'lower' }[]; rows: { label: string; values: (number | string | null)[] }[] }; d?: Dashboard; reference?: string }) {
  const best = v.columns.map((c, k) => {
    if (!c.better) return null;
    const nums = v.rows.filter((r) => r.label !== reference).map((r) => r.values[k]).filter((x): x is number => typeof x === 'number');
    return nums.length > 1 ? (c.better === 'lower' ? Math.min(...nums) : Math.max(...nums)) : null;
  });
  return (
    <div className="table-scroll dash-table dash-scores">
      <table>
        <thead>
          <tr>
            <th />
            {v.columns.map((c) => (
              <th key={c.name} className="num" title={c.better ? `${c.better === 'lower' ? 'Lower' : 'Higher'} is better` : undefined}>
                {c.name}
                {c.unit && <span className="dash-unit-h"> {c.unit}</span>}
                {c.better && <span className="dash-better" aria-hidden="true">{c.better === 'lower' ? ' ↓' : ' ↑'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {v.rows.map((r) => {
            const color = keyColor(d, r.label);
            return (
              <tr key={r.label}>
                <th scope="row" className="dash-score-label">
                  {color && <i className="dash-swatch" style={{ background: `var(--series-${color})` }} />}
                  {r.label}
                </th>
                {r.values.map((x, k) => {
                  const isBest = r.label !== reference && typeof x === 'number' && best[k] !== null && x === best[k];
                  return (
                    <td key={k} className={`num ${isBest ? 'best' : ''}`} aria-label={isBest ? `${x}, best` : undefined}>
                      {x === null ? '—' : typeof x === 'number' ? fmt(x) : x}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TableView({ v, compact }: { v: any; compact: boolean }) {
  const rows: any[][] = compact ? v.rows.slice(0, 8) : v.rows;
  return (
    <div className="table-scroll dash-table">
      <table>
        <thead>
          <tr>
            {v.columns.map((c: string) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, k) => (
                <td key={k} className={typeof c === 'number' ? 'num' : ''}>
                  {c === null ? '—' : typeof c === 'number' ? fmt(c) : typeof c === 'boolean' ? (c ? 'yes' : 'no') : compact ? <PlainRefs text={String(c)} /> : <RefLinks text={String(c)} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {compact && v.rows.length > rows.length && <span className="muted small">and {v.rows.length - rows.length} more rows</span>}
    </div>
  );
}

// ---------- full screen ----------

function TileFull({ t, onClose }: { t: Tile; onClose: () => void }) {
  const { data: full } = useLive<Tile>(`/api/tiles/${t.id}`, (m) => m.type === 'project');
  const tile = full ?? t;
  const hist = tile.history;
  const [pick, setPick] = useState<number | null>(null);
  const shown = pick !== null ? hist.find((h) => h.id === pick) : undefined;
  const { busy, error, run } = useAction();
  const [asked, setAsked] = useState(false);
  useEffect(() => setPick(null), [t.id]);
  const images = (): ViewerItem[] =>
    hist.filter((h) => h.data?.file).map((h, i, a) => ({
      src: fileUrl(h.data.file),
      width: h.data.width ?? undefined,
      height: h.data.height ?? undefined,
      label: `${i === a.length - 1 ? 'Now' : `${a.length - 1 - i} before`} · ${short(h.commit) ?? ''} · ${when(h.at)}`,
    }));
  const openImage = (entryId?: number) => {
    const items = images();
    const i = entryId ? hist.filter((h) => h.data?.file).findIndex((h) => h.id === entryId) : items.length - 1;
    openViewer(items, Math.max(0, i));
  };
  // A number's history drawn as a line; a chart's series as they were then.
  const trend: ChartSpec | null =
    tile.kind === 'number' && hist.length > 1 ? { type: 'line', labels: hist.map((h) => short(h.commit) ?? when(h.at)), series: [{ name: tile.title, values: hist.map((h) => h.data?.value) }], unit: tile.data?.unit } : null;
  const pin = () => run(() => api(`/api/tiles/${t.id}`, { method: 'PATCH', body: { pinned: !tile.pinned } }));
  const ask = () => run(async () => {
    await api(`/api/tiles/${t.id}/ask-refresh`, { body: {} });
    setAsked(true);
  });
  const remove = () => confirm(`Remove the tile "${tile.title}" and its history?`) && run(async () => {
    await api(`/api/tiles/${t.id}`, { method: 'DELETE' });
    onClose();
  });
  const rename = () => {
    const n = prompt('Rename the tile', tile.title);
    if (n && n.trim() && n.trim() !== tile.title) void run(() => api(`/api/tiles/${t.id}`, { method: 'PATCH', body: { title: n.trim() } }));
  };
  return (
    <Sheet title={tile.title} onClose={onClose} wide className="dash-full">
      <div className="dash-full-meta">
        <AsOf t={tile} commit />
        <StaleChip t={tile} />
        {tile.expensive && <Tag>expensive: refreshed when the director asks</Tag>}
      </div>
      {tile.caption && <Markdown className="muted small" text={tile.caption} />}
      {shown && (
        <p className="small dash-old">
          Showing the data as of <code>{short(shown.commit)}</code>, {when(shown.at)}.{' '}
          <button className="linkish" onClick={() => setPick(null)}>
            Back to now
          </button>
        </p>
      )}
      <div className={`dash-full-body kind-${tile.kind}`}>
        {tile.kind === 'image' && (shown?.data ?? tile.data) ? (
          <button className="dash-img-open" onClick={() => openImage(shown?.id)} aria-label="Open zoomable, with its history">
            <TileContent t={tile} data={shown?.data} />
          </button>
        ) : tile.kind === 'page' && tile.data ? (
          <>
            <TileContent t={tile} data={shown?.data} />
            <button className="btn small" onClick={() => openFrame({ src: fileUrl((shown?.data ?? tile.data).file), title: tile.title, sandbox: 'allow-scripts' })}>
              <Icon name="external" size={16} /> Full screen
            </button>
          </>
        ) : (
          <TileContent t={tile} data={shown?.data} />
        )}
      </div>
      {trend && (
        <>
          <h3 className="dash-sub">Trend</h3>
          <Chart spec={trend} />
        </>
      )}
      {tile.kind === 'image' && images().length > 1 && (
        <>
          <h3 className="dash-sub">History</h3>
          <div className="dash-hist-strip">
            {hist.filter((h) => h.data?.file).slice().reverse().map((h) => (
              <button key={h.id} onClick={() => openImage(h.id)} aria-label={`As of ${short(h.commit)}, ${when(h.at)}`}>
                <img src={fileUrl(h.data.file)} alt="" loading="lazy" />
                <span className="small muted">{short(h.commit)} · {when(h.at)}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {tile.kind !== 'image' && tile.kind !== 'number' && hist.length > 1 && (
        <>
          <h3 className="dash-sub">History</h3>
          <ul className="dash-hist-list">
            {hist.slice().reverse().map((h, i) => (
              <li key={h.id}>
                <button className={`linkish ${(pick ?? hist[hist.length - 1].id) === h.id ? 'on' : ''}`} onClick={() => setPick(i === 0 ? null : h.id)}>
                  <code>{short(h.commit) ?? '—'}</code> {when(h.at)}
                  {i === 0 ? ' (now)' : ''}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="dash-full-actions">
        <button className="btn small" disabled={busy || asked || !!tile.asked_at} onClick={() => void ask()}>
          {asked || tile.asked_at ? 'Asked the director' : 'Ask the director to refresh'}
        </button>
        <button className="btn small" disabled={busy} onClick={() => void pin()}>
          <Icon name="pin" size={16} /> {tile.pinned ? 'Unpin from Home' : 'Pin to Home'}
        </button>
        <button className="btn small quiet" onClick={rename}>
          Rename
        </button>
        <button className="btn small quiet danger" onClick={() => void remove()}>
          Remove
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
      <details className="dash-how">
        <summary>How it is kept current</summary>
        <dl>
          <dt>Depends on</dt>
          <dd>
            {[...tile.deps.paths.map((p) => <code key={p}>{p}</code>), ...tile.deps.docs.map((d) => <Markdown key={d} className="inline-md" text={`[[${d}]]`} />), ...tile.deps.tags.map((g) => <Tag key={g}>{g}</Tag>)]}
            {!tile.deps.paths.length && !tile.deps.docs.length && !tile.deps.tags.length && <span className="muted">nothing</span>}
          </dd>
          <dt>Recipe</dt>
          <dd>
            {tile.recipe ? (
              <>
                <pre className="dash-recipe">{tile.recipe.command}</pre>
                <span className="muted small">
                  in <code>{tile.recipe.cwd}</code>
                  {tile.recipe.host ? ` on ${tile.recipe.host}` : ''}
                  {tile.recipe.duration ? `, about ${tile.recipe.duration}` : ''}
                </span>
                {tile.recipe.notes && <p className="small">{tile.recipe.notes}</p>}
              </>
            ) : (
              <span className="muted">none recorded</span>
            )}
          </dd>
          {tile.built && (
            <>
              <dt>Built from</dt>
              <dd className="small">
                <code>{short(tile.built.commit) ?? 'unknown commit'}</code>, {when(tile.built.at)}, by {tile.built.agent}
                {tile.built.task_id && (
                  <>
                    {' '}
                    for <Markdown className="inline-md" text={`[[${tile.built.task_id}]]`} />
                  </>
                )}
              </dd>
            </>
          )}
          <dt>History</dt>
          <dd className="small">{tile.history_count} kept</dd>
        </dl>
      </details>
    </Sheet>
  );
}

/** Home: the tiles pinned there, compact, opening the dashboard they belong to. */
export function PinnedTiles({ s }: { s: ProjectState }) {
  const pinned = s.dashboards?.on ? s.dashboards.pinned : [];
  if (!pinned.length) return null;
  return (
    <section className="dash-pinned" aria-label="Pinned dashboard tiles">
      {pinned.map((t) => (
        <a key={t.id} className={`dash-tile card pinned ${t.stale ? 'is-stale' : ''}`} href={href('p', s.project.id, 'dashboards', t.dashboard_id)}>
          <header className="dash-tile-head">
            <h3 className="one-line">{t.title}</h3>
            {(t.stale || t.error) && <span className={`tag dash-state ${t.error ? 'tone-critical' : 'tone-warning'}`}>{t.error ? 'Refresh failed' : 'Stale'}</span>}
          </header>
          <div className="dash-tile-body">
            <TileContent t={t} compact />
          </div>
          <footer className="dash-tile-foot">
            <AsOf t={t} />
          </footer>
        </a>
      ))}
    </section>
  );
}
