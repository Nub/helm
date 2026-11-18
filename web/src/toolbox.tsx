import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, useLive } from './api';
import type { Agent, ProjectState } from './api';
import { Chips, Empty, Icon, Markdown, Sheet, Tag, ago, clock, href, useAction } from './ui';

// ---------- types (mirroring server/toolbox.ts and server/personal.ts) ----------

type FileEntry = { path: string; size: number; exec: boolean; sha: string };
type Flags = { hooks: boolean; mcp: boolean; runs_on_load: boolean; scripts: boolean; allowed_tools: boolean; network: string[]; file_access: string[] };
export type Review = {
  state: 'fetching' | 'ready' | 'failed' | 'none';
  error?: string;
  fetched_at?: number;
  resolved?: { commit?: string; requested?: string; path?: string };
  files?: FileEntry[];
  size?: number;
  symlinks?: { path: string; target: string }[];
  manifest?: string | null;
  skill_docs?: { path: string; name: string; description: string; allowed_tools: string; text: string }[];
  scripts?: { path: string; text: string; truncated: boolean }[];
  bang_commands?: { path: string; line: number; command: string }[];
  hooks?: { path: string; text: string }[];
  mcp_config?: { path: string; text: string }[];
  commands?: string[];
  agents?: string[];
  flags?: Flags;
  url?: string;
  auth?: string;
  tools?: { name: string; description?: string }[];
  launch?: string;
  secrets?: { name: string; where: string; description?: string }[];
};
type Kind = 'skill' | 'plugin' | 'mcp_http' | 'mcp_stdio';
export type ToolboxItem = {
  id: string;
  kind: Kind;
  name: string;
  status: 'proposed' | 'installing' | 'installed' | 'failed' | 'declined' | 'removed';
  summary: string;
  source: { type: string; ref: string; subpath: string; pin: string; homepage: string };
  pin: { commit?: string; path?: string; hash?: string; store_path?: string; flake?: string; url?: string };
  content_hash: string;
  install_path: string;
  launch: { type?: string; url?: string; auth?: string; flake?: string; command?: string; args?: string[]; secrets?: { name: string; where: string; description?: string }[]; has_secrets: boolean };
  review: Review;
  proposal: {
    maintainer: string; license: string; adoption: string; homepage: string; problem: string; evidence: string; install_effect: string; access: string; risks: string;
    recommendation: string; recommendation_reason: string; suggested_scope: string[]; alternatives: string;
  };
  installable: number;
  not_installable_reason: string;
  origin: 'agent' | 'import';
  proposed_in_project: string | null;
  scope: 'all' | 'selected';
  scope_rows: { project_id: string; enabled: number }[];
  applies_to: string[];
  loaded_by: { id: string; name: string; project_id: string; state: string }[];
  proposer_name: string | null;
  project_name: string | null;
  decided_note: string;
  decided_at: number | null;
  error: string;
  integrity: string;
  created_at: number;
  updated_at: number;
  messages: { id: number; author: string; author_name: string; body: string; created_at: number }[];
};
type ToolboxData = { items: ToolboxItem[]; projects: { id: string; name: string }[] };
type PersonalItem = {
  key: string; kind: 'skill' | 'plugin'; name: string; origin: string; path: string; version?: string; commit?: string; hash: string; review: Review;
  item_id: string | null; item_status: string | null; state: 'new' | 'added' | 'update'; changes?: { added: string[]; removed: string[]; changed: string[] }; error?: string;
};
type LeftBehind = {
  home: string;
  hooks: { event: string; matcher: string; command: string }[];
  permissions: { allow: string[]; deny: string[]; ask: string[]; defaultMode: string };
  claude_md: string | null;
  rules: string[];
  agents: string[];
  commands: string[];
  other_settings: string[];
};

const KIND_LABEL: Record<Kind, string> = { skill: 'Skill', plugin: 'Plugin', mcp_http: 'MCP server (remote)', mcp_stdio: 'MCP server (local)' };
const STATUS_LABEL: Record<ToolboxItem['status'], string> = {
  proposed: 'Proposed', installing: 'Installing…', installed: 'Installed', failed: 'Install failed', declined: 'Declined', removed: 'Removed',
};
const short = (s?: string, n = 12) => (s ? s.slice(0, n) : '');
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const toolboxRefresh = (m: { type: string }) => m.type === 'toolbox' || m.type === 'projects' || m.type === 'reconnect';

// ---------- risk flags ----------

function FlagTags({ review, kind }: { review: Review; kind: Kind }) {
  const f = review.flags;
  const tags: ReactNode[] = [];
  if (kind === 'mcp_stdio') tags.push(<Tag key="proc" tone="tone-serious">Runs a local program</Tag>);
  if (kind === 'mcp_http') tags.push(<Tag key="net" tone="tone-warning">Sends data to {hostOf(review.url)}</Tag>);
  if (f?.hooks) tags.push(<Tag key="hooks" tone="tone-critical">Has hooks</Tag>);
  if (f?.mcp) tags.push(<Tag key="mcp" tone="tone-critical">Has .mcp.json</Tag>);
  if (f?.runs_on_load) tags.push(<Tag key="bang" tone="tone-critical">Runs commands on load</Tag>);
  if (f?.network.length) tags.push(<Tag key="network" tone="tone-serious">Network access</Tag>);
  if (f?.file_access.length) tags.push(<Tag key="files" tone="tone-serious">Touches files outside</Tag>);
  if (f?.allowed_tools) tags.push(<Tag key="allowed" tone="tone-warning">Pre-approves tools</Tag>);
  if (f?.scripts) tags.push(<Tag key="scripts" tone="tone-warning">Bundled scripts</Tag>);
  return tags.length ? <div className="tb-flags">{tags}</div> : null;
}

const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).host : 'a remote server';
  } catch {
    return 'a remote server';
  }
};

function Code({ text, label }: { text: string; label?: string }) {
  return (
    <div className="tb-code">
      {label && <div className="tb-code-label mono small">{label}</div>}
      <pre>{text}</pre>
    </div>
  );
}

function Fold({ title, children, open = false, tone = '' }: { title: ReactNode; children: ReactNode; open?: boolean; tone?: string }) {
  return (
    <details className={`tb-fold ${tone}`} open={open}>
      <summary>{title}</summary>
      <div className="tb-fold-body">{children}</div>
    </details>
  );
}

/** Everything Helm found in the fetched copy, with the parts that run code first. */
export function ReviewView({ review, kind }: { review: Review; kind: Kind }) {
  if (review.state === 'fetching') return <p className="muted small">Helm is fetching it for review…</p>;
  if (review.state === 'failed') return <p className="error-text">Helm could not fetch it for review: {review.error}</p>;
  if (review.state === 'none') return null;
  if (kind === 'mcp_http' || kind === 'mcp_stdio') {
    return (
      <div className="tb-review">
        {review.url && (
          <p>
            <span className="muted">URL</span> <span className="mono">{review.url}</span>
          </p>
        )}
        {review.launch && <Code label="What Helm runs" text={review.launch} />}
        <p>
          <span className="muted">Authentication</span> {review.auth || 'none'}
        </p>
        {!!review.secrets?.length && (
          <p>
            <span className="muted">Asks you for</span>{' '}
            {review.secrets.map((s) => `${s.name} (${s.where === 'header' ? 'HTTP header' : 'environment variable'}${s.description ? `: ${s.description}` : ''})`).join(', ')}
          </p>
        )}
        <Fold title={`Tools it declares (${review.tools?.length ?? 0}, as listed by the proposer)`}>
          {review.tools?.length ? (
            <ul className="tb-list">
              {review.tools.map((t) => (
                <li key={t.name}>
                  <span className="mono">{t.name}</span> {t.description && <span className="muted">— {t.description}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">None listed.</p>
          )}
        </Fold>
      </div>
    );
  }
  const f = review.flags;
  return (
    <div className="tb-review">
      {!!review.hooks?.length && (
        <Fold tone="tb-danger" open title={<>Hooks: shell commands that run on events, with no model involved ({review.hooks.length})</>}>
          {review.hooks.map((h) => (
            <Code key={h.path} label={h.path} text={h.text} />
          ))}
        </Fold>
      )}
      {!!review.mcp_config?.length && (
        <Fold tone="tb-danger" open title={<>MCP server configuration (Helm does not start these; it loads plugins without their MCP servers)</>}>
          {review.mcp_config.map((h) => (
            <Code key={h.path} label={h.path} text={h.text} />
          ))}
        </Fold>
      )}
      {!!review.bang_commands?.length && (
        <Fold tone="tb-danger" open title={<>Commands that run when the skill loads ({review.bang_commands.length})</>}>
          <ul className="tb-list">
            {review.bang_commands.map((b, i) => (
              <li key={i}>
                <span className="mono">{b.command}</span> <span className="muted small">{b.path}:{b.line}</span>
              </li>
            ))}
          </ul>
        </Fold>
      )}
      {(!!f?.network.length || !!f?.file_access.length) && (
        <Fold tone="tb-warn" title={<>Network and file access found in its scripts ({(f?.network.length ?? 0) + (f?.file_access.length ?? 0)} lines)</>}>
          {!!f?.network.length && (
            <>
              <p className="small muted">Network</p>
              <ul className="tb-list mono small">{f.network.map((n) => <li key={n}>{n}</li>)}</ul>
            </>
          )}
          {!!f?.file_access.length && (
            <>
              <p className="small muted">Files outside its folder, or destructive commands</p>
              <ul className="tb-list mono small">{f.file_access.map((n) => <li key={n}>{n}</li>)}</ul>
            </>
          )}
        </Fold>
      )}
      {review.skill_docs?.map((d) => (
        <Fold key={d.path} title={<>{d.path}{d.allowed_tools && <span className="tb-inline-flag"> · allowed-tools: {d.allowed_tools}</span>}</>}>
          {d.description && <p className="small">{d.description}</p>}
          <Code text={d.text} />
        </Fold>
      ))}
      {!!review.scripts?.length && (
        <Fold title={`Scripts (${review.scripts.length})`}>
          {review.scripts.map((s) => (
            <Fold key={s.path} title={<span className="mono small">{s.path}</span>}>
              <Code text={s.text + (s.truncated ? '\n… (cut off)' : '')} />
            </Fold>
          ))}
        </Fold>
      )}
      {review.manifest && (
        <Fold title=".claude-plugin/plugin.json">
          <Code text={review.manifest} />
        </Fold>
      )}
      {(!!review.commands?.length || !!review.agents?.length) && (
        <p className="small">
          {!!review.commands?.length && <>Slash commands: {review.commands.join(', ')}. </>}
          {!!review.agents?.length && <>Subagents: {review.agents.join(', ')}.</>}
        </p>
      )}
      <Fold title={`Files (${review.files?.length ?? 0}, ${kb(review.size ?? 0)})`}>
        <ul className="tb-files mono small">
          {review.files?.map((f) => (
            <li key={f.path}>
              <span>{f.path}</span>
              <span className="muted">
                {f.exec ? 'executable · ' : ''}
                {kb(f.size)}
              </span>
            </li>
          ))}
          {review.symlinks?.map((l) => (
            <li key={l.path}>
              <span>{l.path}</span>
              <span className="muted">symlink to {l.target}, not copied</span>
            </li>
          ))}
        </ul>
      </Fold>
    </div>
  );
}

// ---------- cards ----------

function SourceLine({ item }: { item: ToolboxItem }) {
  const s = item.source;
  const commit = item.pin.commit || item.review.resolved?.commit;
  return (
    <div className="tb-source small">
      <span className="mono one-line" title={s.ref}>
        {s.type === 'git' ? 'git ' : s.type === 'path' ? 'folder ' : s.type === 'nix_flake' ? 'nix ' : `${s.type} `}
        {s.ref}
        {s.subpath ? ` · ${s.subpath}` : ''}
      </span>
      <span className="muted">
        {[
          commit && `commit ${short(commit)}`,
          item.pin.store_path && item.pin.store_path.replace('/nix/store/', '').slice(0, 40),
          item.content_hash && !item.pin.store_path && `content ${short(item.content_hash)}`,
          s.pin && !commit && `pin ${s.pin}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        {(s.homepage || item.proposal.homepage) && (
          <>
            {' · '}
            <a href={s.homepage || item.proposal.homepage} target="_blank" rel="noreferrer noopener">
              homepage <Icon name="external" size={12} />
            </a>
          </>
        )}
      </span>
    </div>
  );
}

function ProposalBody({ item }: { item: ToolboxItem }) {
  const p = item.proposal;
  const row = (label: string, text: string) =>
    text ? (
      <div className="tb-row">
        <dt>{label}</dt>
        <dd>
          <Markdown text={text} />
        </dd>
      </div>
    ) : null;
  return (
    <dl className="tb-proposal">
      {row('Problem it solves', p.problem)}
      {row('Evidence', p.evidence)}
      {row('What installing does', p.install_effect)}
      {row('What it can access', p.access)}
      {row('Risks', p.risks)}
      {row('Alternatives', p.alternatives)}
      {row('Maintainer', [p.maintainer, p.license && `licence ${p.license}`, p.adoption].filter(Boolean).join(' · '))}
      {row('Suggested for', (p.suggested_scope ?? []).join(', '))}
    </dl>
  );
}

function Recommendation({ item }: { item: ToolboxItem }) {
  const r = item.proposal.recommendation;
  if (!r || item.origin === 'import') return null;
  const tone = r === 'install' ? 'tb-rec-yes' : r === 'do not install' ? 'tb-rec-no' : 'tb-rec-maybe';
  return (
    <div className={`tb-rec ${tone}`}>
      <strong>{r === 'install' ? 'Recommends installing' : r === 'do not install' ? 'Recommends not installing' : 'No recommendation'}</strong>
      {item.proposal.recommendation_reason && <span> — {item.proposal.recommendation_reason}</span>}
    </div>
  );
}

function Thread({ item }: { item: ToolboxItem }) {
  if (!item.messages.length) return null;
  return (
    <Fold title={`Conversation (${item.messages.length})`} open>
      <ul className="tb-thread">
        {item.messages.map((m) => (
          <li key={m.id} className={`tb-msg tb-msg-${m.author}`}>
            <span className="small muted">
              {m.author_name || m.author} · {ago(m.created_at)}
            </span>
            <Markdown text={m.body} />
          </li>
        ))}
      </ul>
    </Fold>
  );
}

function ItemCard({ item, data, onAction }: { item: ToolboxItem; data: ToolboxData; onAction: (a: 'install' | 'decline' | 'ask', item: ToolboxItem) => void }) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const post = (path: string, body: unknown = {}) => run(() => api(`/api/toolbox/${item.id}/${path}`, { body }));
  const projectName = (id: string) => data.projects.find((p) => p.id === id)?.name ?? id;
  const isOpen = item.status === 'proposed' || item.status === 'failed';

  return (
    <article className={`card tb-card ${item.integrity ? 'tb-bad' : ''}`}>
      <header className="tb-head">
        <div className="row wrap">
          <h3 className="tb-name">{item.name}</h3>
          <Tag tone="tb-kind">{KIND_LABEL[item.kind]}</Tag>
          <span className="spacer" />
          <Tag tone={`tb-st tb-st-${item.status}`}>{STATUS_LABEL[item.status]}</Tag>
        </div>
        <p className="tb-summary">{item.summary}</p>
        <FlagTags review={item.review} kind={item.kind} />
        <SourceLine item={item} />
        <p className="small muted">
          {item.origin === 'import' ? 'Imported from your Claude setup' : <>Proposed by {item.proposer_name ?? 'a director'}{item.project_name && <> in <a href={href('p', item.proposed_in_project!, 'overview')}>{item.project_name}</a></>}</>}
          {' · '}
          {clock(item.created_at)}
        </p>
      </header>

      {item.integrity && (
        <div className="tb-alert tb-alert-bad">
          <strong>Not loaded into sessions.</strong> {item.integrity}
          {(item.kind === 'skill' || item.kind === 'plugin') && (
            <div className="row wrap">
              <button className="btn small" disabled={busy} onClick={() => post('repair')}>
                Reinstall the reviewed copy
              </button>
            </div>
          )}
        </div>
      )}
      {!item.installable && isOpen && <div className="tb-alert">{/^cannot/i.test(item.not_installable_reason) ? item.not_installable_reason : `Helm cannot install this. ${item.not_installable_reason}`}</div>}
      {item.status === 'failed' && (
        <div className="tb-alert tb-alert-bad">
          <span>
            <strong>Install failed:</strong> {item.error.split(/\n|(?<=\.) /)[0].slice(0, 200)}
          </span>
          <Fold title="Full error">
            <Code text={item.error} />
          </Fold>
        </div>
      )}
      {item.status === 'declined' && (
        <div className="tb-alert">
          <strong>Declined</strong>
          {item.decided_at && <> {clock(item.decided_at)}</>}: {item.decided_note}
        </div>
      )}

      <Recommendation item={item} />

      {item.status === 'installed' && <InstalledControls item={item} data={data} />}

      <button className="tb-expand" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={14} /> {open ? 'Hide details' : isOpen ? 'Review the proposal and what Helm fetched' : 'Details and review snapshot'}
      </button>
      {open && (
        <div className="tb-details">
          {item.origin !== 'import' && <ProposalBody item={item} />}
          <ReviewView review={item.review} kind={item.kind} />
        </div>
      )}
      <Thread item={item} />

      <footer className="row wrap tb-actions">
        {isOpen && item.installable ? (
          <button className="btn primary" disabled={busy || (item.review.state !== 'ready' && (item.kind === 'skill' || item.kind === 'plugin'))} onClick={() => onAction('install', item)}>
            Install…
          </button>
        ) : null}
        {isOpen && (
          <button className="btn" disabled={busy} onClick={() => onAction('decline', item)}>
            Decline…
          </button>
        )}
        {isOpen && item.proposed_in_project && (
          <button className="btn quiet" disabled={busy} onClick={() => onAction('ask', item)}>
            Ask about it
          </button>
        )}
        {isOpen && item.review.state === 'failed' && (
          <button className="btn quiet" disabled={busy} onClick={() => post('refetch')}>
            Fetch again
          </button>
        )}
        {item.status === 'installed' && (
          <>
            <span className="spacer" />
            <button
              className="btn danger quiet"
              disabled={busy}
              onClick={() =>
                confirm(`Remove ${item.name}? Its files are deleted and idle agents restart without it; agents in the middle of a turn finish it first.`) && post('remove')
              }
            >
              Remove
            </button>
          </>
        )}
        {item.status === 'declined' && <span className="muted small">{item.applies_to.map(projectName).join(', ')}</span>}
      </footer>
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

function InstalledControls({ item, data }: { item: ToolboxItem; data: ToolboxData }) {
  const { busy, error, run } = useAction();
  const toggle = (projectId: string, enabled: boolean) => run(() => api(`/api/toolbox/${item.id}/projects/${projectId}`, { body: { enabled } }));
  const setScope = (scope: 'all' | 'selected') => run(() => api(`/api/toolbox/${item.id}/scope`, { body: { scope } }));
  return (
    <div className="tb-installed">
      <div className="row wrap">
        <span className="small muted">Applies to</span>
        <Chips
          value={item.scope}
          onChange={setScope}
          options={[
            { id: 'all', label: 'All projects' },
            { id: 'selected', label: 'Chosen projects' },
          ]}
        />
      </div>
      <ul className="tb-projects">
        {data.projects.map((p) => {
          const on = item.applies_to.includes(p.id);
          const loaded = item.loaded_by.filter((a) => a.project_id === p.id);
          return (
            <li key={p.id}>
              <label className="check">
                <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(p.id, e.target.checked)} />
                <span>{p.name}</span>
              </label>
              {loaded.length > 0 && (
                <span className="small tb-loaded">
                  {loaded.map((a) => (
                    <a key={a.id} href={href('p', a.project_id, 'agents', a.id)} className={`tb-ls tb-ls-${a.state}`}>
                      {a.name}
                      {a.state !== 'loaded' ? ` (${a.state})` : ''}
                    </a>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="small muted">
        {item.loaded_by.length ? `Loaded now by ${item.loaded_by.filter((a) => a.state === 'loaded').length} running agent${item.loaded_by.length === 1 ? '' : 's'}. ` : 'No running agent has it loaded right now. '}
        Changes apply when an agent's process next starts; switching it off restarts idle agents at once.
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// ---------- sheets ----------

function InstallSheet({ item, data, onClose, importPath }: { item: { name: string; kind: Kind; review: Review; launch?: ToolboxItem['launch']; proposal?: ToolboxItem['proposal'] }; data: ToolboxData; onClose: () => void; importPath?: string }) {
  const suggested = item.proposal?.suggested_scope ?? ['all'];
  const pre = data.projects.filter((p) => suggested.some((s) => s.toLowerCase() === p.name.toLowerCase() || s === p.id)).map((p) => p.id);
  const [scope, setScope] = useState<'all' | 'selected'>(pre.length && !suggested.includes('all') ? 'selected' : 'all');
  const [chosen, setChosen] = useState<string[]>(pre);
  const secrets = item.launch?.secrets ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const risky = item.review.flags?.hooks || item.review.flags?.runs_on_load || item.kind === 'mcp_stdio';
  const ready = (scope === 'all' || chosen.length > 0) && secrets.every((s) => values[s.name]?.trim());
  const install = () =>
    run(async () => {
      const body = { scope, projects: chosen, secrets: values };
      if (importPath) await api('/api/toolbox/import', { body: { ...body, path: importPath } });
      else await api(`/api/toolbox/${(item as ToolboxItem).id}/install`, { body });
      onClose();
    });
  return (
    <Sheet title={`${importPath ? 'Add' : 'Install'} ${item.name}`} onClose={onClose}>
      <div className="form">
        <p className="small">
          Helm copies exactly the version you reviewed, makes it read-only and checks it has not changed each time an agent starts. Updates come back here as a new review.
        </p>
        {risky && (
          <div className="tb-alert tb-alert-bad small">
            {item.kind === 'mcp_stdio' ? 'This starts a program on this machine for every agent session, with your user’s access.' : 'This runs commands without asking: it has hooks or commands that run when it loads.'}
          </div>
        )}
        <div>
          <p className="small muted">Which projects get it</p>
          <Chips
            value={scope}
            onChange={setScope}
            options={[
              { id: 'all', label: 'All projects' },
              { id: 'selected', label: 'Chosen projects' },
            ]}
          />
        </div>
        {scope === 'selected' &&
          data.projects.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))} />
              {p.name}
            </label>
          ))}
        {secrets.map((s) => (
          <label key={s.name}>
            {s.name} <span className="muted">({s.where === 'header' ? 'HTTP header' : 'environment variable'}{s.description ? `: ${s.description}` : ''})</span>
            <input type="password" autoComplete="off" value={values[s.name] ?? ''} onChange={(e) => setValues({ ...values, [s.name]: e.target.value })} />
          </label>
        ))}
        {secrets.length > 0 && <p className="small muted">Stored in a file only Helm’s user can read, never shown again and never put on a command line.</p>}
        <p className="small muted">Agents get it the next time their process starts.</p>
        {error && <p className="error-text">{error}</p>}
        <div className="row wrap">
          <button className="btn primary" disabled={busy || !ready} onClick={install}>
            {busy ? 'Installing…' : importPath ? 'Add to the Toolbox' : 'Install'}
          </button>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function TextSheet({ title, hint, cta, required, onSubmit, onClose }: { title: string; hint: string; cta: string; required?: boolean; onSubmit: (text: string) => Promise<unknown>; onClose: () => void }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="form">
        <label>
          {hint}
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row wrap">
          <button className="btn primary" disabled={busy || (required && !text.trim())} onClick={() => run(async () => { await onSubmit(text); onClose(); })}>
            {cta}
          </button>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ---------- import ----------

function ImportTab({ data }: { data: ToolboxData }) {
  const personal = useLive<{ items: PersonalItem[]; left: LeftBehind }>('/api/toolbox/personal', toolboxRefresh);
  const [adding, setAdding] = useState<PersonalItem | null>(null);
  if (!personal.data) return <div className="loading">{personal.error ?? 'Reading your Claude setup…'}</div>;
  const { items, left } = personal.data;
  return (
    <>
      <h2 className="tb-tab-title">Import from my Claude setup</h2>
      <p className="muted tb-intro">
        Skills and plugins in <span className="mono">{left.home}</span> that agents used to receive. Adding one copies and pins it like any other Toolbox item; your own copy is only read.
      </p>
      {!items.length && <Empty title="No personal skills or plugins found" />}
      <div className="tb-grid">
        {items.map((p) => (
          <PersonalCard key={p.key} p={p} onAdd={() => setAdding(p)} />
        ))}
      </div>
      <LeftBehindCard left={left} />
      {adding && <InstallSheet item={{ name: adding.name, kind: adding.kind, review: adding.review }} data={data} importPath={adding.path} onClose={() => setAdding(null)} />}
    </>
  );
}

function PersonalCard({ p, onAdd }: { p: PersonalItem; onAdd: () => void }) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <article className="card tb-card">
      <header className="tb-head">
        <div className="row wrap">
          <h3 className="tb-name">{p.name}</h3>
          <Tag tone="tb-kind">{KIND_LABEL[p.kind]}</Tag>
          <span className="spacer" />
          {p.state === 'added' && <Tag tone="tb-st tb-st-installed">In the Toolbox</Tag>}
          {p.state === 'update' && <Tag tone="tb-st tb-st-update">Update available</Tag>}
        </div>
        <p className="tb-summary tb-clamp" title={p.review.skill_docs?.[0]?.description}>{p.review.skill_docs?.[0]?.description || p.origin}</p>
        <FlagTags review={p.review} kind={p.kind} />
        <p className="small muted">
          {p.origin}
          {p.commit && <> · commit {short(p.commit)}</>} · {p.review.files?.length ?? 0} files
        </p>
      </header>
      {p.state === 'update' && p.changes && (
        <div className="tb-alert">
          Your personal copy differs from the pinned one.
          <ul className="tb-changes mono small">
            {p.changes.changed.map((f) => <li key={f} className="ch-changed">changed {f}</li>)}
            {p.changes.added.map((f) => <li key={f} className="ch-added">added {f}</li>)}
            {p.changes.removed.map((f) => <li key={f} className="ch-removed">removed {f}</li>)}
          </ul>
        </div>
      )}
      {p.error && <p className="error-text">{p.error}</p>}
      <button className="tb-expand" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={14} /> {open ? 'Hide contents' : 'Review contents'}
      </button>
      {open && <ReviewView review={p.review} kind={p.kind} />}
      <footer className="row wrap tb-actions">
        {p.state === 'new' && (
          <button className="btn primary" onClick={onAdd} disabled={!!p.error}>
            <Icon name="plus" size={15} /> Add…
          </button>
        )}
        {p.state === 'update' && (
          <button className="btn" disabled={busy} onClick={() => confirm(`Pin the current version of ${p.name}? Running agents keep the old one until their process restarts; idle ones restart now.`) && run(() => api(`/api/toolbox/${p.item_id}/update-from-source`, { body: {} }))}>
            Take this version
          </button>
        )}
      </footer>
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

function LeftBehindCard({ left }: { left: LeftBehind }) {
  const perms = [...left.permissions.allow.map((r) => `allow ${r}`), ...left.permissions.ask.map((r) => `ask ${r}`), ...left.permissions.deny.map((r) => `deny ${r}`)];
  const none = !left.hooks.length && !perms.length && !left.claude_md && !left.rules.length && !left.agents.length && !left.commands.length && !left.permissions.defaultMode;
  return (
    <>
      <h2>What agents no longer get</h2>
      <div className="card tb-left">
        <p className="small muted">
          Personal settings that are not imported. Agents now load only the project’s own <span className="mono">.claude/</span> and <span className="mono">CLAUDE.md</span>, plus the Toolbox.
        </p>
        {none && <p>Nothing: your personal settings have no hooks, permission rules, CLAUDE.md, rules, subagents or commands.</p>}
        {left.hooks.length > 0 && (
          <Fold title={`Hooks (${left.hooks.length})`} open>
            <ul className="tb-list mono small">{left.hooks.map((h, i) => <li key={i}>{h.event}{h.matcher ? ` [${h.matcher}]` : ''}: {h.command}</li>)}</ul>
          </Fold>
        )}
        {(perms.length > 0 || left.permissions.defaultMode) && (
          <Fold title={`Permission rules (${perms.length})`} open>
            <ul className="tb-list mono small">
              {left.permissions.defaultMode && <li>defaultMode {left.permissions.defaultMode}</li>}
              {perms.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </Fold>
        )}
        {left.claude_md && (
          <Fold title="Personal CLAUDE.md">
            <Code text={left.claude_md} />
          </Fold>
        )}
        {[['Rules', left.rules], ['Subagents', left.agents], ['Commands', left.commands]].map(([label, list]) =>
          (list as string[]).length ? (
            <p key={label as string} className="small">
              <span className="muted">{label}:</span> {(list as string[]).join(', ')}
            </p>
          ) : null,
        )}
        {left.other_settings.length > 0 && (
          <p className="small muted">
            Other personal settings agents no longer read: <span className="mono">{left.other_settings.join(', ')}</span>
          </p>
        )}
      </div>
    </>
  );
}

// ---------- page ----------

type Tab = 'proposed' | 'installed' | 'declined' | 'import';
const IN_TAB: Record<Exclude<Tab, 'import'>, ToolboxItem['status'][]> = {
  proposed: ['proposed', 'installing', 'failed'],
  installed: ['installed'],
  declined: ['declined', 'removed'],
};

export function ToolboxPage() {
  const { data, error } = useLive<ToolboxData>('/api/toolbox', toolboxRefresh);
  const [tab, setTab] = useState<Tab>('proposed');
  const [action, setAction] = useState<{ kind: 'install' | 'decline' | 'ask'; item: ToolboxItem } | null>(null);
  if (!data) return <div className="loading">{error ?? 'Loading…'}</div>;
  const count = (t: Exclude<Tab, 'import'>) => data.items.filter((i) => IN_TAB[t].includes(i.status)).length;
  const flagged = data.items.filter((i) => i.integrity && i.status === 'installed');
  const list = tab === 'import' ? [] : data.items.filter((i) => IN_TAB[tab].includes(i.status));

  return (
    <section className="toolbox-page">
      <div className="section-head">
        <div>
          <h1 className="page-title">Toolbox</h1>
          <p className="muted small">Skills, plugins and MCP servers agents get, by project. Directors propose; only you install.</p>
        </div>
      </div>
      {flagged.length > 0 && (
        <div className="tb-alert tb-alert-bad">
          <strong>{flagged.length} installed item{flagged.length === 1 ? '' : 's'} changed on disk and {flagged.length === 1 ? 'is' : 'are'} not being loaded:</strong> {flagged.map((i) => i.name).join(', ')}.
        </div>
      )}
      <Chips
        value={tab}
        onChange={setTab}
        options={[
          { id: 'proposed', label: 'Proposed', count: count('proposed') },
          { id: 'installed', label: 'Installed', count: count('installed') },
          { id: 'declined', label: 'Declined', count: count('declined') },
          { id: 'import', label: 'Import' },
        ]}
      />
      {tab === 'import' ? (
        <ImportTab data={data} />
      ) : list.length ? (
        <div className="tb-grid">
          {list.map((i) => (
            <ItemCard key={i.id} item={i} data={data} onAction={(kind, item) => setAction({ kind, item })} />
          ))}
        </div>
      ) : (
        <Empty title={tab === 'proposed' ? 'No proposals waiting' : tab === 'installed' ? 'Nothing installed yet' : 'Nothing declined'}>
          {tab === 'proposed' && <p>Directors propose tools here when they see agents struggling, or when you mention one to them.</p>}
          {tab === 'installed' && <p>Install a proposal, or add a skill from your own Claude setup under Import.</p>}
        </Empty>
      )}
      {action?.kind === 'install' && <InstallSheet item={action.item} data={data} onClose={() => setAction(null)} />}
      {action?.kind === 'decline' && (
        <TextSheet
          title={`Decline ${action.item.name}`}
          hint="Why? Directors are told this if they propose it again."
          cta="Decline"
          required
          onSubmit={(note) => api(`/api/toolbox/${action.item.id}/decline`, { body: { note } })}
          onClose={() => setAction(null)}
        />
      )}
      {action?.kind === 'ask' && (
        <TextSheet
          title={`Ask about ${action.item.name}`}
          hint={`Your question goes to the director of ${action.item.project_name}. Its answer, or a revised proposal, appears on this card.`}
          cta="Send"
          required
          onSubmit={(text) => api(`/api/toolbox/${action.item.id}/ask`, { body: { text } })}
          onClose={() => setAction(null)}
        />
      )}
    </section>
  );
}

// ---------- per project: Setup and agent page ----------

/** Setup: which Toolbox items this project's agents get. */
export function ProjectToolboxSetup({ s }: { s: ProjectState }) {
  const { data } = useLive<ToolboxData>('/api/toolbox', toolboxRefresh);
  const { busy, error, run } = useAction();
  const installed = data?.items.filter((i) => i.status === 'installed') ?? [];
  return (
    <>
      <h2>Toolbox</h2>
      <p className="muted">
        Skills, plugins and MCP servers this project’s agents get, besides the project’s own <span className="mono">.claude/</span> folder. Changes apply when an agent’s process next starts.{' '}
        <a href={href('toolbox')}>Open the Toolbox</a>
      </p>
      <div className="card tb-setup">
        {!data ? (
          <p className="muted small">Loading…</p>
        ) : installed.length ? (
          <ul className="tb-projects">
            {installed.map((i) => (
              <li key={i.id}>
                <label className="check">
                  <input type="checkbox" checked={i.applies_to.includes(s.project.id)} disabled={busy} onChange={(e) => run(() => api(`/api/toolbox/${i.id}/projects/${s.project.id}`, { body: { enabled: e.target.checked } }))} />
                  <span>
                    <strong>{i.name}</strong> <span className="muted small">{KIND_LABEL[i.kind]}</span>
                  </span>
                </label>
                {i.integrity && <Tag tone="tone-critical">Changed on disk; not loaded</Tag>}
                {!i.integrity && i.scope === 'all' && i.applies_to.includes(s.project.id) && <span className="small muted tb-note">(on for all projects)</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Nothing installed in the Toolbox yet.</p>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}

type LoadState = { id: string; name: string; kind: string; state: 'loaded' | 'failed' | 'skipped' | 'pending'; detail: string };

/** One line on the agent page: which toolbox items its current or last process loaded. */
export function AgentToolboxLine({ agent }: { agent: Agent }) {
  if (!agent.toolbox_loaded) return null;
  let rec: { at: number; items: LoadState[] };
  try {
    rec = JSON.parse(agent.toolbox_loaded);
  } catch {
    return null;
  }
  return (
    <p className="small tb-agent-line">
      <a href={href('toolbox')} className="muted">
        Toolbox
      </a>{' '}
      {rec.items.length === 0 ? (
        <span className="muted">none</span>
      ) : (
        rec.items.map((i, n) => (
          <span key={i.id} className={`tb-ls tb-ls-${i.state}`} title={i.detail || i.state}>
            {n > 0 && ' · '}
            {i.name}
            {i.state !== 'loaded' && ` (${i.state === 'skipped' ? 'skipped: changed on disk' : i.state}${i.detail && i.state === 'failed' && i.detail !== 'failed' ? `: ${i.detail}` : ''})`}
          </span>
        ))
      )}
      <span className="muted"> · as of process start {ago(rec.at)}; changes apply at the next start</span>
    </p>
  );
}
