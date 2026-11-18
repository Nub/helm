import { useEffect, useState } from 'react';
import { useLive } from './api';
import type { Meta, ProjectState, Role, RoleStamp, Structure, TeamDetails } from './api';
import { Icon, Status, Tag, clock, href, modelLabel } from './ui';

// Setup's picture of the team: each role as a card in spawn order, with what it is for,
// what Helm gives it, who holds it now and where it came from. Editing a role happens
// in place, on the same unsaved copy the save bar below commits.

const FINISHED = ['done', 'closed'];
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Route segment for a role's card: #/p/<id>/setup/role-<roleId>. */
export const roleAnchor = (roleId: string) => `role-${roleId}`;

/** Roles in the order of who may spawn whom, starting from the top level. */
function teamTree(st: Structure): { role: Role; depth: number; reachable: boolean }[] {
  const out: { role: Role; depth: number; reachable: boolean }[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number, reachable: boolean) => {
    const role = st.roles.find((r) => r.id === id);
    if (!role || seen.has(id)) return;
    seen.add(id);
    out.push({ role, depth, reachable });
    for (const c of role.canSpawn) visit(c, depth + 1, reachable);
  };
  visit(st.root, 0, true);
  // The quick helper works for whoever asks; it sits under the top level.
  if (st.quickRole) visit(st.quickRole, 1, true);
  for (const r of st.roles) visit(r.id, 0, false);
  return out;
}

const sameRole = (a: Role, b: Role) => JSON.stringify({ ...a, origin: undefined }) === JSON.stringify({ ...b, origin: undefined });

export function newRole(value: Structure): { structure: Structure; id: string } {
  let n = value.roles.length + 1;
  while (value.roles.some((r) => r.id === `role-${n}`)) n++;
  const id = `role-${n}`;
  return { id, structure: { ...value, roles: [...value.roles, { id, name: 'New role', model: 'claude-opus-5-5', effort: '', description: '', prompt: '', canSpawn: [] }] } };
}

/** Setup's choice of quick helper role and how many each agent may have at once. */
export function QuickSettings({ value, onChange }: { value: Structure; onChange: (s: Structure) => void }) {
  // Any role that does not delegate and is not the top level can be the quick helper.
  const candidates = value.roles.filter((r) => r.id === value.quickRole || (r.id !== value.root && !r.canSpawn.length));
  return (
    <>
      <label>
        Quick helper role
        <select value={value.quickRole ?? ''} onChange={(e) => onChange({ ...value, quickRole: e.target.value })}>
          <option value="">None</option>
          {candidates.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {modelLabel(r.model)}
            </option>
          ))}
        </select>
      </label>
      {value.quickRole ? (
        <label>
          Quick helpers per agent
          <input type="number" min={1} max={10} value={value.quickPerCaller ?? 2} onChange={(e) => onChange({ ...value, quickPerCaller: Number(e.target.value) })} />
        </label>
      ) : null}
    </>
  );
}

export const QUICK_HINT = 'Any agent can hand an extremely simple, fully specified job to the quick helper role; Helm closes the helper when the job is done. Helpers count toward the agent limit.';

export function TemplateSelect({ value, onChange, meta }: { value: Structure; onChange: (s: Structure) => void; meta: Meta }) {
  return (
    <label>
      Start from a template
      <select
        value=""
        onChange={(e) => {
          const t = meta.templates.find((t) => t.id === e.target.value);
          if (t && (value.roles.length === 0 || confirm(`Replace the current roles with "${t.name}"?`))) onChange({ ...structuredClone(t.structure), approval: value.approval, template: t.id });
        }}
      >
        <option value="">Choose…</option>
        {meta.templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The editing controls for one role. */
export function RoleFields({ value, index: i, onChange, models }: { value: Structure; index: number; onChange: (s: Structure) => void; models: { id: string; label: string }[] }) {
  const r = value.roles[i];
  const setRole = (patch: Partial<Role>) => onChange({ ...value, roles: value.roles.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const known = models.some((m) => m.id === r.model);
  return (
    <div className="form">
      <div className="row wrap">
        <label>
          Name
          <input value={r.name} onChange={(e) => setRole({ name: e.target.value })} />
        </label>
        <label>
          Model
          <select value={known ? r.model : '__custom'} onChange={(e) => setRole({ model: e.target.value === '__custom' ? '' : e.target.value })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="__custom">Other…</option>
          </select>
        </label>
        {!known && (
          <label>
            Model id
            <input value={r.model} onChange={(e) => setRole({ model: e.target.value })} placeholder="claude-…" />
          </label>
        )}
        <label>
          Effort
          <select value={r.effort} onChange={(e) => setRole({ effort: e.target.value })}>
            <option value="">Model default</option>
            {EFFORT_LEVELS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        One line for the agents that can spawn it
        <input value={r.description} onChange={(e) => setRole({ description: e.target.value })} />
      </label>
      <label>
        Purpose, for you (optional; shown here only)
        <textarea rows={2} value={r.purpose ?? ''} onChange={(e) => setRole({ purpose: e.target.value || undefined })} />
      </label>
      <label>
        Instructions
        <textarea rows={7} value={r.prompt} onChange={(e) => setRole({ prompt: e.target.value })} />
      </label>
      {value.quickRole === r.id ? (
        <p className="muted small">This is the quick helper role, so it does not delegate.</p>
      ) : (
      <fieldset>
        <legend>Can spawn</legend>
        <div className="row wrap">
          {value.roles
            .filter((x) => x.id !== r.id && x.id !== value.root)
            .map((x) => (
              <label key={x.id} className="check">
                <input
                  type="checkbox"
                  checked={r.canSpawn.includes(x.id)}
                  onChange={(e) => setRole({ canSpawn: e.target.checked ? [...r.canSpawn, x.id] : r.canSpawn.filter((c) => c !== x.id) })}
                />
                {x.name}
              </label>
            ))}
          {value.roles.length < 2 && <span className="muted small">Add another role first.</span>}
        </div>
      </fieldset>
      )}
      <div className="row wrap">
        {value.root !== r.id && (
          <button className="btn small" onClick={() => onChange({ ...value, root: r.id, ...(value.quickRole === r.id ? { quickRole: '' } : {}), roles: value.roles.map((x) => ({ ...x, canSpawn: x.canSpawn.filter((c) => c !== r.id) })) })}>
            Make top level
          </button>
        )}
        <span className="spacer" />
        {value.root !== r.id && (
          <button
            className="btn small quiet danger"
            onClick={() => onChange({ ...value, ...(value.quickRole === r.id ? { quickRole: '' } : {}), roles: value.roles.filter((x) => x.id !== r.id).map((x) => ({ ...x, canSpawn: x.canSpawn.filter((c) => c !== r.id) })) })}
          >
            Remove role
          </button>
        )}
      </div>
    </div>
  );
}

function Provenance({ role, s, meta }: { role: Role; s: ProjectState; meta: Meta | null }) {
  const template = meta?.templates.find((t) => t.id === s.project.structure.template)?.name;
  const from = template ? `From the ${template} template` : 'From the project template';
  const line = (verb: string, st: RoleStamp) => {
    const who = st.by === 'user' ? 'you' : st.by;
    return (
      <>
        {verb} by {who} on {clock(st.at)}
        {st.reason ? `: ${st.reason}` : ''}
        {st.journalId != null && (
          <>
            {' '}
            <a href={href('p', s.project.id, 'history', `j${st.journalId}`)}>Journal entry</a>
          </>
        )}
      </>
    );
  };
  const o = role.origin;
  return (
    <div className="provenance muted small">
      {!o?.created && <p>{from}</p>}
      {o?.created && <p>{line(o.created.by === 'user' ? 'Added' : 'Created', o.created)}</p>}
      {o?.changed && <p>{line(o.changed.by === 'user' ? 'Edited' : 'Changed', o.changed)}</p>}
    </div>
  );
}

function Given({ role, detail, extras, saved }: { role: Role; detail?: TeamDetails['roles'][number]; extras?: TeamDetails['extras']; saved: boolean }) {
  const stale = !saved && <p className="muted small">Shown for the saved version of this role. Save to see your changes here.</p>;
  return (
    <div className="given">
      <span className="label">What it is given</span>
      <details>
        <summary>Its own instructions</summary>
        {role.prompt.trim() ? <pre>{role.prompt.trim()}</pre> : <p className="muted small">None. It works from Helm's standard instructions and its task brief.</p>}
        {role.description && <p className="muted small">Agents that can spawn it see only: “{role.description}”</p>}
      </details>
      <details>
        <summary>Everything Helm adds to its system prompt</summary>
        {stale}
        {detail ? (
          <>
            <p className="muted small">
              Generated by Helm and appended to Claude Code's own system prompt
              {detail.sample ? `, as it would be for ${detail.sample.name} when its session next starts.` : '. No agent holds this role yet, so names in brackets are placeholders.'} The role's
              own instructions are the last section. The task brief arrives separately as the first message.
            </p>
            <pre>{detail.systemPrompt}</pre>
          </>
        ) : (
          <p className="muted small">{saved ? 'Loading…' : 'Not saved yet.'}</p>
        )}
      </details>
      <details>
        <summary>Helm tools{detail ? ` (${detail.tools.length})` : ''}</summary>
        {stale}
        {detail ? (
          <ul className="tool-list">
            {detail.tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span className="muted small">{t.description}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{saved ? 'Loading…' : 'Not saved yet.'}</p>
        )}
      </details>
      <details>
        <summary>Skills and MCP servers</summary>
        {extras && (
          <ul className="tool-list">
            <li>
              <strong>MCP servers</strong>
              <span className="muted small">
                {extras.mcpServers.length > 1 ? `Helm's own and the Toolbox servers enabled for this project (${extras.mcpServers.join(', ')}).` : `Only Helm's own (${extras.mcpServers.join(', ')}).`} Connectors on your Claude login and servers in the project's .mcp.json are not loaded.
              </span>
            </li>
            <li>
              <strong>Skills and plugins</strong>
              <span className="muted small">
                {extras.installed.length ? `From the Toolbox: ${extras.installed.map((x) => `${x.name} (${x.kind})`).join(', ')}. ` : 'None from the Toolbox. '}
                Every role also gets Claude Code's built-in skills and the project's own .claude folder and CLAUDE.md ({extras.settingSources.join(', ')} settings). Your personal ~/.claude (skills, plugins, hooks, permission rules) is not loaded; add what agents need from the Toolbox.
              </span>
            </li>
            <li>
              <strong>Claude Code built-in tools</strong>
              <span className="muted small">
                All of them (files, shell, web, search) except {extras.hiddenBuiltins.join(', ')}, which Helm replaces with its own. What needs your approval depends on the project's autonomy setting above.
              </span>
            </li>
          </ul>
        )}
      </details>
    </div>
  );
}

export function TeamView({ s, value, onChange, meta, focus, editing, setEditing }: {
  s: ProjectState;
  value: Structure;
  onChange: (st: Structure) => void;
  meta: Meta | null;
  focus?: string;
  editing: string | null;
  setEditing: (id: string | null) => void;
}) {
  const pid = s.project.id;
  const { data: team } = useLive<TeamDetails>(`/api/projects/${pid}/team`, (m) => m.type === 'project' && m.projectId === pid);
  const [flash, setFlash] = useState<string | null>(null);
  const server = s.project.structure;
  const name = (id: string) => value.roles.find((r) => r.id === id)?.name ?? id;

  useEffect(() => {
    if (!focus?.startsWith('role-')) return;
    const id = focus.slice(5);
    const el = document.getElementById(`team-${roleAnchor(id)}`);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setFlash(id);
    const t = window.setTimeout(() => setFlash(null), 1800);
    return () => window.clearTimeout(t);
  }, [focus]);

  return (
    <div className="roles-view">
      {teamTree(value).map(({ role, depth, reachable }) => {
        const i = value.roles.indexOf(role);
        const saved = server.roles.find((r) => r.id === role.id);
        const unsaved = !saved || !sameRole(saved, role);
        const detail = team?.roles.find((r) => r.id === role.id);
        const spawners = value.roles.filter((r) => r.canSpawn.includes(role.id));
        const holders = s.agents.filter((a) => a.role_id === role.id);
        const open = holders.filter((a) => !FINISHED.includes(a.status));
        const isEditing = editing === role.id;
        return (
          <article
            key={role.id}
            id={`team-${roleAnchor(role.id)}`}
            className={`card role-card ${depth ? 'child' : ''} ${flash === role.id ? 'flash' : ''}`}
            style={{ marginLeft: `calc(var(--indent) * ${Math.min(depth, 3)})` }}
          >
            <header className="row wrap">
              <h3>{role.name || 'Unnamed role'}</h3>
              {value.root === role.id && <Tag tone="tone-accent">Top level</Tag>}
              {value.quickRole === role.id && <Tag tone="tone-phase">Quick helper</Tag>}
              {unsaved && <Tag tone="tone-warning">{saved ? 'Unsaved changes' : 'Not saved yet'}</Tag>}
              <span className="spacer" />
              <button className="btn small" onClick={() => setEditing(isEditing ? null : role.id)} aria-expanded={isEditing}>
                {isEditing ? (
                  'Done'
                ) : (
                  <>
                    <Icon name="edit" size={14} /> Edit
                  </>
                )}
              </button>
            </header>
            <p className="mono small muted">
              {modelLabel(role.model)}
              {role.effort ? ` · ${role.effort} effort` : ' · default effort'}
            </p>
            {(role.purpose || role.description) && <p className="purpose">{role.purpose || role.description}</p>}
            <p className="small role-links">
              {value.root === role.id
                ? 'You talk to it directly.'
                : value.quickRole === role.id
                ? `Any agent can hand it a quick job${spawners.length ? `; ${spawners.map((r) => r.name).join(' or ')} may also spawn it` : ''}. Helm closes it when the job is done.`
                : spawners.length ? `Reports to ${spawners.map((r) => r.name).join(' or ')}.` : reachable ? '' : 'No role can spawn it, so it is unused.'}{' '}
              {role.canSpawn.length ? `May spawn ${role.canSpawn.map(name).join(', ')}.` : 'Does not delegate.'}
            </p>
            {isEditing && <RoleFields value={value} index={i} onChange={onChange} models={meta?.models ?? []} />}

            <div className="holders">
              <span className="label">Who holds it now</span>
              {open.length === 0 && <p className="muted small">Nobody right now.</p>}
              {open.map((a) => (
                <a key={a.id} className="holder" href={href('p', pid, 'agents', a.id)}>
                  <span className="row">
                    <strong className="one-line">{a.name}</strong>
                    <span className="spacer" />
                    <Status status={a.status} />
                  </span>
                  {a.task && <span className="clamp muted small" style={{ ['--lines' as any]: 2 }}>{a.task}</span>}
                </a>
              ))}
              {holders.length > open.length && (
                <a className="small" href={href('p', pid, 'agents')}>
                  {holders.length - open.length} finished
                </a>
              )}
            </div>

            <Given role={role} detail={detail} extras={team?.extras} saved={!!saved && !unsaved} />
            {saved && <Provenance role={saved} s={s} meta={meta} />}
          </article>
        );
      })}
    </div>
  );
}
