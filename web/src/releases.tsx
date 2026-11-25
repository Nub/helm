import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { jumpTo } from './fold';
import { TestBuildsList } from './testbuilds';
import { api, useLive } from './api';
import type { ProjectState } from './api';
import { Empty, Icon, Markdown, Sheet, Tag, clock, href, go, useAction, PageHeader } from './ui';
import { openChat } from './chat';
import { bytes } from './disk';
import { when } from './time';

/**
 * Releases (server/releases.ts). The user cuts a release (one button, with Helm's proposed version), reads and edits
 * the change log the director wrote, downloads the files the agents built, and asks to publish (a confirmation they
 * answer). The recipe is at the top: edited in place, worked out with the director (who proposes it as a card), and
 * proven with a test build the user starts (server/recipework.ts).
 */

type Artifact = { id: string; name: string; url: string | null; file: string | null; bytes: number; sha256: string; removed: boolean };
type Release = {
  id: string;
  version: string;
  commit: string;
  state: 'drafting' | 'building' | 'ready' | 'failed' | 'published';
  notes: string;
  task_id: string | null;
  tasks: { id: string; title: string }[];
  tag: string | null;
  error: string | null;
  created_at: number;
  ready_at: number | null;
  published_at: number | null;
  published_how: string | null;
  can_publish: boolean;
  publish_pending: boolean;
  artifacts: Artifact[];
};
type Recipe = { artifacts: { name: string; command: string; cwd: string; host?: string; files: string[]; duration?: string; notes?: string }[]; scheme: string; publish: string; updated_at: number | null };
type Data = { on: boolean; recipe: Recipe; releases: Release[]; tests?: Record<string, TestBuild>; recipe_proposal?: RecipeProposal | null; proposal: { version: string; commit: string | null; previous: { version: string } | null; tasks: { id: string }[]; open: string | null } | null };

const STATE: Record<Release['state'], string> = { drafting: 'Writing the change log', building: 'Building', ready: 'Ready', failed: 'Failed', published: 'Published' };
const short = (c: string | null) => (c ? c.slice(0, 7) : '');

const useReleases = (pid: string) => useLive<Data>(`/api/projects/${pid}/releases`, (m) => m.type === 'project' && m.projectId === pid);

/**
 * Ship: getting the work out, on one page. For Helm's own project first the Helm update (update.tsx HelmUpdate, passed
 * in as `helm`); then the releases with their recipe, notes and downloads; then the test builds by task. `sub`: a
 * release's id opens it; "test-builds" scrolls to the test builds (the old Releases page's view).
 */
export function ShipPage({ s, sub, helm }: { s: ProjectState; sub?: string; helm?: ReactNode }) {
  const pid = s.project.id;
  const { data, error } = useReleases(pid);
  const [cutting, setCutting] = useState(false);
  const loaded = !!data;
  useEffect(() => {
    if (loaded && sub === 'test-builds') jumpTo('#ship-test-builds');
  }, [loaded, sub]);
  // A release's page waits for the list rather than showing Ship first.
  if (sub && sub !== 'test-builds' && !data && !error) return <div className="loading">Loading…</div>;
  const open = sub && data?.releases.find((r) => r.id === sub);
  if (open) return <ReleaseView pid={pid} r={open} />;
  const p = data?.proposal;
  return (
    <section className="narrow releases-page ship-page">
      <PageHeader title="Ship" />
      {helm && (
        <section className="ship-sec helm-page" aria-label="Helm update">
          <h2>Helm update</h2>
          {helm}
        </section>
      )}
      <section className="ship-sec" aria-label="Releases">
        <div className="section-head">
          <h2>Releases</h2>
          {data?.on && p && !p.open && (
            <button className="btn small primary" onClick={() => setCutting(true)}>
              Cut release
            </button>
          )}
        </div>
        {error && !data ? (
          <p className="error-text small">Could not load the releases: {error}</p>
        ) : !data ? (
          <div className="loading">Loading…</div>
        ) : (
          <>
            {!data.on && (
              <a className="needs-banner" href={href('p', pid, 'setup', 'agent-context')}>
                <span>
                  <strong>Releases are off</strong>
                  <span className="muted small">Turn them on in Setup.</span>
                </span>
              </a>
            )}
            {data.on && <RecipeCard s={s} data={data} />}
            {!data.releases.length ? (
              <p className="muted">No releases yet.{data.on && p ? ` The next would be ${p.version}, with ${p.tasks.length} finished ${p.tasks.length === 1 ? 'task' : 'tasks'}.` : ''}</p>
            ) : (
              <ul className="dash-list">
                {data.releases.map((r) => (
                  <li key={r.id}>
                    <a className="card dash-list-item" href={href('p', pid, 'ship', r.id)}>
                      <span className="dash-list-text">
                        <strong className="one-line">{r.version}</strong>
                        <span className={`small ${r.state === 'failed' ? 'err-text' : 'muted'}`}>
                          {STATE[r.state]} · {when(r.published_at ?? r.ready_at ?? r.created_at)}
                        </span>
                      </span>
                      <Icon name="chevron" size={16} />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
      {/* Tasks' builds for the user to try, never in the release list (testbuilds.tsx). */}
      <section id="ship-test-builds" className="ship-sec" aria-label="Test builds">
        <h2>Test builds</h2>
        <TestBuildsList pid={pid} />
      </section>
      {cutting && p && data && <CutRelease pid={pid} p={p} recipe={data.recipe} onClose={() => setCutting(false)} />}
    </section>
  );
}

function CutRelease({ pid, p, recipe, onClose }: { pid: string; p: NonNullable<Data['proposal']>; recipe: Recipe; onClose: () => void }) {
  const [version, setVersion] = useState(p.version);
  const { busy, error, run } = useAction();
  const cut = () =>
    run(async () => {
      const r = await api<Release>(`/api/projects/${pid}/releases`, { body: { version } });
      onClose();
      go('p', pid, 'ship', r.id);
    });
  return (
    <Sheet title="Cut release" onClose={onClose}>
      <div className="form">
        <label>
          Version
          <input value={version} onChange={(e) => setVersion(e.target.value)} autoCapitalize="off" autoCorrect="off" />
        </label>
        <p className="small">{recipe.artifacts.length ? `Builds ${buildsLine(recipe)}.` : buildsLine(recipe)}</p>
        <p className="muted small">
          From {short(p.commit) || 'the main line'}, with {p.tasks.length} {p.tasks.length === 1 ? 'task' : 'tasks'} finished since {p.previous ? p.previous.version : 'the start'}. The director writes the change log and has the files built.
        </p>
        {error && <p className="error-text small">{error}</p>}
        <div className="row">
          <span className="spacer" />
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !version.trim() || !p.commit} onClick={() => void cut()}>
            Cut release
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function ReleaseView({ pid, r }: { pid: string; r: Release }) {
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const editable = ['drafting', 'building', 'ready'].includes(r.state);
  const save = () => run(async () => (await api(`/api/releases/${r.id}/notes`, { method: 'PUT', body: { notes: editing } }), setEditing(null)));
  // Files the confirmation and opens it: the user confirms there, each time.
  const publish = () => run(async () => go('p', pid, 'request', (await api<{ request: string }>(`/api/releases/${r.id}/publish`, { method: 'POST' })).request));
  const kept = r.artifacts.filter((a) => !a.removed);
  // Download links that work without signing in (server/dllinks.ts): for a ready or published release's files.
  const shareable = r.state === 'ready' || r.state === 'published';
  const [linkFor, setLinkFor] = useState<{ artifact: string | null; label: string } | null>(null);
  return (
    <section className="narrow release-page">
      <a className="back" href={href('p', pid, 'ship')}>
        <Icon name="back" size={16} /> Ship
      </a>
      <h1 className="page-title">{r.version}</h1>
      <p className={`small ${r.state === 'failed' ? 'err-text' : 'muted'}`}>
        {STATE[r.state]} · {when(r.published_at ?? r.ready_at ?? r.created_at)} · {r.tag ?? short(r.commit)}
      </p>
      {r.error && <p className="error-text small">{r.error}</p>}
      {r.can_publish && (
        <div className="row release-publish">
          {r.publish_pending ? (
            <span className="muted small">Publishing waits for your confirmation under Needs you, or is under way.</span>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => void publish()}>
              Publish
            </button>
          )}
        </div>
      )}
      {r.published_how && <Markdown className="small" text={r.published_how} />}

      <div className="section-head">
        <h2>Change log</h2>
        {editable && editing === null && (
          <button className="btn small quiet" onClick={() => setEditing(r.notes)}>
            <Icon name="edit" size={16} /> Edit
          </button>
        )}
      </div>
      {editing !== null ? (
        <div className="form">
          <textarea className="release-notes-edit" rows={12} value={editing} onChange={(e) => setEditing(e.target.value)} />
          <div className="row">
            <span className="spacer" />
            <button className="btn quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
          </div>
        </div>
      ) : r.notes ? (
        <div className="card">
          <Markdown text={r.notes} />
        </div>
      ) : (
        <p className="muted">The director is writing it.</p>
      )}
      {error && <p className="error-text small">{error}</p>}

      {(r.artifacts.length > 0 || r.state === 'building') && <h2>Files</h2>}
      {r.artifacts.length > 0 && (
        <ul className="release-files">
          {r.artifacts.map((a) => (
            <li key={a.id} className="card">
              <div className="row">
                <strong className="grow one-line">{a.name}</strong>
                {a.url && shareable && (
                  <button className="btn small quiet" onClick={() => setLinkFor({ artifact: a.id, label: a.name })}>
                    Get link
                  </button>
                )}
                {a.url && shareable ? (
                  // Through the signed-in session (releaseapi.ts), saved under the file's real name; no link is made.
                  <a className="btn small primary" href={`/api/releases/${r.id}/download?artifact=${encodeURIComponent(a.id)}`} download={a.file ?? undefined}>
                    <Icon name="download" size={16} /> Download
                  </a>
                ) : !a.url ? (
                  <span className="muted small">removed</span>
                ) : null}
              </div>
              <p className="muted small mono one-line" title={a.sha256}>
                {a.bytes < 1000 ? `${a.bytes} B` : bytes(a.bytes)} · sha256 {a.sha256}
              </p>
            </li>
          ))}
        </ul>
      )}
      {shareable && kept.length > 1 && (
        <div className="row release-all-link">
          <span className="grow muted small">All {kept.length} files as one archive</span>
          <button className="btn small quiet" onClick={() => setLinkFor({ artifact: null, label: 'All files (.tar)' })}>
            Get link
          </button>
          <a className="btn small primary" href={`/api/releases/${r.id}/download`} download>
            <Icon name="download" size={16} /> Download all
          </a>
        </div>
      )}
      {shareable && <LiveLinks releaseId={r.id} />}
      {linkFor && <LinkSheet releaseId={r.id} target={linkFor} onClose={() => setLinkFor(null)} />}
      {r.state === 'building' && !kept.length && <p className="muted">Being built.</p>}

      {r.tasks.length > 0 && (
        <>
          <h2>In this release</h2>
          <Markdown className="small" text={r.tasks.map((t) => `- [[${t.id}]]`).join('\n')} />
        </>
      )}
    </section>
  );
}

// ---------- download links ----------

type Link = { id: string; file: string; expires_at: number; uses: number; last_used_at: number | null };
const DURATION_LABEL: Record<string, string> = { '15m': '15 minutes', '1h': '1 hour', '1d': '1 day', '7d': '7 days' };

/** Get link: how long it lasts, then the address to copy. Anyone with it can download the file, without signing in. */
function LinkSheet({ releaseId, target, onClose }: { releaseId: string; target: { artifact: string | null; label: string }; onClose: () => void }) {
  const [duration, setDuration] = useState('1h');
  const [made, setMade] = useState<{ url: string; expires_at: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const make = () =>
    run(async () => {
      const r = await api<{ path: string; expires_at: number }>(`/api/releases/${releaseId}/links`, { body: { artifact: target.artifact, duration } });
      setMade({ url: `${location.origin}${r.path}`, expires_at: r.expires_at });
    });
  return (
    <Sheet title={`Download link: ${target.label}`} onClose={onClose}>
      {!made ? (
        <div className="form">
          <p className="small muted">Anyone with the link can download this, without signing in, until it expires or you revoke it.</p>
          <div className="chips" role="radiogroup" aria-label="How long it lasts">
            {Object.entries(DURATION_LABEL).map(([k, label]) => (
              <button key={k} role="radio" aria-checked={duration === k} className={duration === k ? 'chip on' : 'chip'} onClick={() => setDuration(k)}>
                {label}
              </button>
            ))}
          </div>
          {error && <p className="error-text small">{error}</p>}
          <button className="btn primary" disabled={busy} onClick={() => void make()}>
            Make link
          </button>
        </div>
      ) : (
        <div className="form">
          <input className="mono" readOnly value={made.url} onFocus={(e) => e.target.select()} aria-label="Download link" />
          <p className="small muted">Expires {when(made.expires_at)}. It is shown only now; make another if you lose it.</p>
          <button
            className="btn primary"
            onClick={() => {
              void navigator.clipboard?.writeText(made.url).then(() => setCopied(true), () => {});
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </Sheet>
  );
}

/** A release's live links: which file, when each expires, how often it was used, and Revoke. */
function LiveLinks({ releaseId }: { releaseId: string }) {
  const { data, reload } = useLive<{ links: Link[] }>(`/api/releases/${releaseId}/links`, (m) => m.type === 'project');
  const { busy, run } = useAction();
  if (!data?.links.length) return null;
  return (
    <>
      <h2>Download links</h2>
      <ul className="release-links card">
        {data.links.map((l) => (
          <li key={l.id} className="row">
            <span className="grow">
              <span className="one-line">{l.file}</span>
              <span className="muted small">
                Expires {when(l.expires_at)} · {l.uses ? `used ${l.uses} ${l.uses === 1 ? 'time' : 'times'}` : 'not used yet'}
              </span>
            </span>
            <button className="btn small quiet" disabled={busy} onClick={() => run(async () => (await api(`/api/links/${l.id}`, { method: 'DELETE' }), reload()))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Setup › Releases: the recipe lives on the Ship page now; a link there. */
export function ReleaseRecipeSetup({ s }: { s: ProjectState }) {
  if (!s.releases?.on) return null;
  return (
    <>
      <h2 id="releases">Releases</h2>
      <a className="card row release-recipe-link" href={href('p', s.project.id, 'ship')}>
        <span className="grow">The release recipe is on the Ship page.</span>
        <Icon name="chevron" size={16} />
      </a>
    </>
  );
}

// ---------- the recipe (server/recipework.ts) ----------

type RecipeArtifact = Recipe['artifacts'][number];
type TestBuild = { id: string; status: 'running' | 'done' | 'failed'; commit: string | null; bytes: number | null; url: string | null; file: string | null; error: string | null; started_at: number; finished_at: number | null };
type RecipeProposal = { id: string; author_name: string; recipe: Pick<Recipe, 'artifacts' | 'scheme' | 'publish'>; rationale: string; status: 'open' | 'applied' | 'declined' | 'superseded'; note: string; created_at: number; discussion_id: string | null };

const hasRecipe = (r: Pick<Recipe, 'artifacts' | 'publish'>) => r.artifacts.length > 0 || !!r.publish;
/** "1 file: Windows zip, about 6 min": what a release builds, for the card's folded line and Cut release. */
export function buildsLine(r: Pick<Recipe, 'artifacts'>): string {
  const a = r.artifacts;
  if (!a.length) return 'No files: a release is its change log and tag.';
  const times = a.map((x) => x.duration).filter(Boolean);
  return `${a.length} ${a.length === 1 ? 'file' : 'files'}: ${a.map((x) => x.name).join(', ')}${times.length ? `, about ${times.join(' + ')}` : ''}`;
}
const scheme = (s: string) => (s === 'date' ? 'by date' : 'semver');

/** "Set this up with the director": the chat on the project's Release recipe discussion, with a first message to send. */
const discussRecipe = async (pid: string) => {
  const r = await api<{ discussion_id: string }>(`/api/projects/${pid}/release-recipe/discuss`, { method: 'POST' });
  openChat({ kind: 'discussion', id: r.discussion_id }, { draft: 'Help me set up the release recipe: what a release should build, where, and how it is published.' });
};

/** The top of the Releases page: the recipe, folded once there is one; edit it, work it out with the director, test it. */
function RecipeCard({ s, data }: { s: ProjectState; data: Data }) {
  const pid = s.project.id;
  const r = data.recipe;
  const [open, setOpen] = useState(!hasRecipe(r));
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const test = (name: string) => run(() => api(`/api/projects/${pid}/release-recipe/test`, { body: { artifact: name } }));
  return (
    <section className="card release-recipe" aria-label="Release recipe">
      <button type="button" className="fold-toggle recipe-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={16} />
        <h2 className="now-label">Recipe</h2>
        {!open && <span className="muted small one-line">{hasRecipe(r) ? buildsLine(r) : 'Not set up'}</span>}
      </button>
      {open && (
        <div className="recipe-body">
          {!hasRecipe(r) && <p className="muted small">A release here has no files yet.</p>}
          {r.artifacts.map((a) => (
            <RecipeArtifactRow key={a.name} a={a} t={data.tests?.[a.name]} onTest={() => void test(a.name)} busy={busy} />
          ))}
          <p className="small">
            Versions {scheme(r.scheme)}
            {r.publish ? '' : ' · releases stay in Helm'}
          </p>
          {r.publish && (
            <div className="recipe-publish">
              <strong className="small">Publish</strong>
              <Markdown className="small" text={r.publish} />
            </div>
          )}
          {error && <p className="error-text small">{error}</p>}
          <div className="row wrap recipe-actions">
            <button className="btn small" onClick={() => setEditing(true)}>
              <Icon name="edit" size={16} /> {hasRecipe(r) ? 'Edit' : 'Set it up'}
            </button>
            <button className="btn small quiet" disabled={busy} onClick={() => void run(() => discussRecipe(pid))}>
              Set this up with the director
            </button>
          </div>
        </div>
      )}
      {data.recipe_proposal && <RecipeProposalView p={data.recipe_proposal} s={s} />}
      {editing && <RecipeEditor s={s} initial={r} onClose={() => setEditing(false)} save={(recipe) => api(`/api/projects/${pid}/release-recipe`, { method: 'PUT', body: recipe })} />}
    </section>
  );
}

function RecipeArtifactRow({ a, t, onTest, busy }: { a: RecipeArtifact; t?: TestBuild; onTest?: () => void; busy?: boolean }) {
  return (
    <div className="recipe-artifact">
      <div className="row">
        <strong className="grow one-line">{a.name}</strong>
        {onTest && (
          <button className="btn small quiet" disabled={busy || t?.status === 'running'} onClick={onTest}>
            {t?.status === 'running' ? 'Building…' : 'Test build'}
          </button>
        )}
      </div>
      <p className="muted small mono recipe-command">{a.command}</p>
      <p className="muted small">
        in {a.cwd}
        {a.host ? ` on ${a.host}` : ''} → {a.files.join(', ')}
        {a.duration ? ` · about ${a.duration}` : ''}
      </p>
      {t?.status === 'done' && t.url && (
        <p className="small">
          Test build {when(t.finished_at ?? t.started_at)}:{' '}
          <a href={t.url} download={t.file ?? undefined}>
            {t.file} · {(t.bytes ?? 0) < 1000 ? `${t.bytes} B` : bytes(t.bytes ?? 0)}
          </a>
        </p>
      )}
      {t?.status === 'failed' && <p className="error-text small">Test build failed: {t.error}</p>}
    </div>
  );
}

/** The recipe the director proposed: in its discussion's thread and on the Releases page. Apply, Change or Not this. */
function RecipeProposalView({ p, s }: { p: RecipeProposal; s: ProjectState }) {
  const [changing, setChanging] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const open = p.status === 'open';
  const STATUS: Record<RecipeProposal['status'], string> = { open: 'Proposed', applied: 'Applied', declined: 'Declined', superseded: 'Replaced by a newer one' };
  return (
    <div className={`tl-card recipe-proposal ${open ? '' : 'prop-dim'}`}>
      <span className="msg-meta">
        <b>{p.author_name || 'Director'}</b> · proposed release recipe · {clock(p.created_at)}
      </span>
      <p className="small">
        <Tag tone={open ? 'tone-accent' : 'tone-todo'}>{STATUS[p.status]}</Tag> {p.rationale}
      </p>
      {p.recipe.artifacts.map((a) => (
        <RecipeArtifactRow key={a.name} a={a} />
      ))}
      <p className="small">
        Versions {scheme(p.recipe.scheme)}
        {p.recipe.publish ? '' : ' · releases stay in Helm'}
      </p>
      {p.recipe.publish && <Markdown className="small" text={p.recipe.publish} />}
      {p.status === 'declined' && p.note && <p className="muted small">Your note: {p.note}</p>}
      {open && !declining && (
        <div className="row wrap">
          <button className="btn small primary" disabled={busy} onClick={() => void run(() => api(`/api/recipe-proposals/${p.id}/apply`, { method: 'POST' }))}>
            Apply
          </button>
          <button className="btn small" disabled={busy} onClick={() => setChanging(true)}>
            Change
          </button>
          <button className="btn small quiet" disabled={busy} onClick={() => setDeclining(true)}>
            Not this
          </button>
        </div>
      )}
      {open && declining && (
        <div className="form">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What is wrong with it? (optional, goes to the director)" />
          <div className="row">
            <button className="btn small quiet" onClick={() => setDeclining(false)}>
              Back
            </button>
            <span className="spacer" />
            <button className="btn small" disabled={busy} onClick={() => void run(() => api(`/api/recipe-proposals/${p.id}/decline`, { body: { note } }))}>
              Not this
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
      {changing && <RecipeEditor s={s} initial={p.recipe} title="Change and apply" cta="Apply" onClose={() => setChanging(false)} save={(recipe) => api(`/api/recipe-proposals/${p.id}/apply`, { body: { recipe } })} />}
    </div>
  );
}

/** A recipe proposal's card in a thread (tasks.tsx): the message body is {"id": …}. */
export function RecipeProposalCard({ body, s }: { body: string; s: ProjectState }) {
  let id = '';
  try {
    id = JSON.parse(body).id;
  } catch {}
  const pid = s.project.id;
  const { data, error } = useLive<RecipeProposal>(id ? `/api/recipe-proposals/${id}` : null, (m) => m.type === 'project' && m.projectId === pid);
  if (error) return <div className="tl-card error-text small">{error}</div>;
  if (!data) return <div className="tl-card muted small">Loading the proposed recipe…</div>;
  return <RecipeProposalView p={data} s={s} />;
}

type FormArtifact = { name: string; command: string; cwd: string; host: string; files: string; duration: string };
const toForm = (a: RecipeArtifact): FormArtifact => ({ name: a.name, command: a.command, cwd: a.cwd, host: a.host ?? '', files: a.files.join('\n'), duration: a.duration ?? '' });
const blank = (): FormArtifact => ({ name: '', command: '', cwd: '.', host: '', files: '', duration: '' });

/** The recipe as a small form: artifacts, versions, publish steps. The server checks it as the director's tool does. */
function RecipeEditor({ s, initial, onClose, save, title = 'Release recipe', cta = 'Save' }: { s: ProjectState; initial: Pick<Recipe, 'artifacts' | 'scheme' | 'publish'>; onClose: () => void; save: (r: unknown) => Promise<unknown>; title?: string; cta?: string }) {
  const [arts, setArts] = useState<FormArtifact[]>(() => initial.artifacts.map(toForm));
  const [sch, setSch] = useState(initial.scheme === 'date' ? 'date' : 'semver');
  const [publish, setPublish] = useState(initial.publish);
  const { busy, error, run } = useAction();
  const hosts = s.hosts ?? [];
  const set = (i: number, patch: Partial<FormArtifact>) => setArts(arts.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const submit = () =>
    run(async () => {
      await save({
        artifacts: arts.map((a) => ({ name: a.name, command: a.command, cwd: a.cwd, host: a.host || undefined, files: a.files.split(/[\n,]/).map((f) => f.trim()).filter(Boolean), duration: a.duration || undefined })),
        scheme: sch,
        publish,
      });
      onClose();
    });
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="form recipe-form">
        {arts.map((a, i) => (
          <fieldset key={i} className="card recipe-form-artifact">
            <div className="row">
              <strong className="grow">File {i + 1}</strong>
              <button className="btn small quiet" onClick={() => setArts(arts.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            <label>
              Name
              <input value={a.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="e.g. Windows zip" />
            </label>
            <label>
              Command
              <textarea className="mono" rows={2} value={a.command} onChange={(e) => set(i, { command: e.target.value })} placeholder="npm ci && npm run package:win" spellCheck={false} autoCapitalize="off" />
            </label>
            <div className="row wrap recipe-form-pair">
              <label>
                Folder
                <input className="mono" value={a.cwd} onChange={(e) => set(i, { cwd: e.target.value })} spellCheck={false} autoCapitalize="off" />
              </label>
              <label>
                Host
                <select value={a.host} onChange={(e) => set(i, { host: e.target.value })}>
                  <option value="">Here</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.name}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Files it produces (one per line)
              <textarea className="mono" rows={1} value={a.files} onChange={(e) => set(i, { files: e.target.value })} placeholder="dist/app-win.zip" spellCheck={false} autoCapitalize="off" />
            </label>
            <label>
              How long it takes
              <input value={a.duration} onChange={(e) => set(i, { duration: e.target.value })} placeholder="6 min" />
            </label>
          </fieldset>
        ))}
        <button className="btn small" onClick={() => setArts([...arts, blank()])}>
          <Icon name="plus" size={16} /> Add a file
        </button>
        <label>
          Versions
          <select value={sch} onChange={(e) => setSch(e.target.value)}>
            <option value="semver">Semver (1.4.0)</option>
            <option value="date">By date (2026.11.19)</option>
          </select>
        </label>
        <label>
          Publish steps (optional, markdown)
          <textarea rows={3} value={publish} onChange={(e) => setPublish(e.target.value)} placeholder="Leave empty: releases stay in Helm" />
        </label>
        <p className="muted small">Takes effect for the next release. No passwords or tokens: refer to ones already on the machine.</p>
        {error && <p className="error-text small">{error}</p>}
        <div className="row">
          <span className="spacer" />
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>
            {cta}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
