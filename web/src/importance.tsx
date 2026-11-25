import { useRef, useState } from 'react';
import { useDragReorder } from './drag';
import { api } from './api';
import type { Budget, ImportanceChange, ImportanceLimits, ProjectState } from './api';
import { Icon, ago, useAction } from './ui';

/**
 * Importance as words, budgets and recent movement, for Spec entries and tasks.
 * Critical and High are scarce per project (see importanceBudget on the server);
 * a level the owner sets is pinned so agents leave it alone.
 */

export const LEVEL = ['', 'Minor', 'Low', 'Medium', 'High', 'Critical'];

export const recentChange = (s: ProjectState, id: string): ImportanceChange | undefined => s.importanceRecent?.find((c) => c.target_id === id);

/** "High" with a pin when the owner set it, and a ↑/↓ marker for a day or so after it moved; tap the marker for why. */
export function ImportanceTag({ level, pinned, change, compact = false, onlyMove = false }: { level: number; pinned?: boolean; change?: ImportanceChange; compact?: boolean; onlyMove?: boolean }) {
  const [open, setOpen] = useState(false);
  const up = change && change.new_level > change.old_level;
  return (
    <span className="imp-wrap">
      {!onlyMove && (
        <span className={`tag imp imp-l${level}`} title={pinned ? 'Set or placed by you; agents leave it as it is' : `Importance: ${LEVEL[level]}`}>
          {LEVEL[level]}
          {pinned && <Icon name="pin" size={16} />}
        </span>
      )}
      {change && (
        <button
          className={`imp-move ${up ? 'up' : 'down'}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-expanded={open}
          title={change.reason}
        >
          {up ? '↑ raised' : '↓ lowered'}
        </button>
      )}
      {change && open && (
        <span className="imp-why small">
          {change.author_name} {up ? 'raised' : 'lowered'} it from {LEVEL[change.old_level]} to {LEVEL[change.new_level]} {ago(change.created_at)}
          {change.reason ? `: ${change.reason}` : '.'}
        </span>
      )}
    </span>
  );
}

function meterPart(name: string, l: Budget['critical']) {
  return (
    <span className={l.over ? 'over' : l.count === l.cap ? 'full' : ''}>
      {name} <b>{l.count}</b> of {l.cap}
    </span>
  );
}

/** "Critical 2 of 3 · High 5 of 8", in a warning state when over budget. */
export function ImportanceMeter({ budget, onOpen, label = 'Importance' }: { budget: Budget; onOpen?: () => void; label?: string }) {
  const over = budget.critical.over || budget.high.over;
  return (
    <button className={`imp-meter ${over ? 'over' : ''}`} onClick={onOpen} title="Critical and High are limited per project. Tap to re-rank.">
      <span className="label">{label}</span>
      {meterPart('Critical', budget.critical)}
      <span className="muted">·</span>
      {meterPart('High', budget.high)}
      {over && <span className="imp-over-note">over the limit</span>}
    </button>
  );
}

/** The owner sets a level (pinned from then on) with a reason, or unpins it. */
export function ImportanceControl({ id, level, reason, pinned, what }: { id: string; level: number; reason: string; pinned: boolean; what: 'entry' | 'task' }) {
  const [draft, setDraft] = useState<{ level: number; reason: string } | null>(null);
  const [warning, setWarning] = useState('');
  const { busy, error, run } = useAction();
  if (!draft) {
    return (
      <div className="imp-control">
        <span>
          <b>{LEVEL[level]}</b>
          {reason ? <span className="muted"> — {reason}</span> : level >= 4 ? <span className="muted"> — no reason given</span> : null}
          {pinned && <span className="muted small"> · set by you, agents leave it</span>}
        </span>
        <span className="row">
          <button className="link" onClick={() => setDraft({ level, reason })}>
            Change
          </button>
          {pinned && (
            <button className="link" disabled={busy} onClick={() => run(() => api(`/api/importance/${id}/unpin`, { body: {} }))}>
              Unpin
            </button>
          )}
        </span>
        {warning && <p className="imp-warning small">{warning}</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }
  const save = async () => {
    let res: { warnings?: string[] } = {};
    if (await run(async () => (res = await api(`/api/importance/${id}`, { body: { importance: draft.level, reason: draft.reason } })))) {
      setWarning(res.warnings?.length ? `Over the limit: ${res.warnings[0].split(':').slice(1).join(':').split('\n')[0].trim()} Saved anyway, since it is your call.` : '');
      setDraft(null);
    }
  };
  return (
    <div className="imp-control editing">
      <div className="row wrap">
        <select value={draft.level} onChange={(e) => setDraft({ ...draft, level: Number(e.target.value) })} aria-label="Importance">
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {LEVEL[n]}
            </option>
          ))}
        </select>
        <input value={draft.reason} placeholder={draft.level >= 4 ? 'Why: what fails or waits without it' : 'Why (optional)'} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
      </div>
      <div className="row">
        <button className="btn small primary" disabled={busy} onClick={save}>
          Set
        </button>
        <button className="btn small quiet" onClick={() => setDraft(null)}>
          Cancel
        </button>
        <span className="muted small">Agents will leave this {what}'s level as you set it.</span>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** Every open goal and design by tier, in priority order: drag or step to reorder, across tiers to change the level. */
/** Setup: the per-project limits for Critical and High, for Spec entries and for tasks. */
export function ImportanceLimitsCard({ s }: { s: ProjectState }) {
  const [form, setForm] = useState<ImportanceLimits>(s.limits);
  const { busy, error, run } = useAction();
  const dirty = JSON.stringify(form) !== JSON.stringify(s.limits);
  const field = (k: keyof ImportanceLimits, label: string) => (
    <label>
      {label}
      <input type="number" min={0} max={k.endsWith('min') ? 50 : 100} value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
    </label>
  );
  return (
    <div className="card form imp-limits">
      <p className="muted small">
        Now: Spec{' '}
        {s.budget.critical.count}/{s.budget.critical.cap} Critical, {s.budget.high.count}/{s.budget.high.cap} High · Tasks {s.taskBudget.critical.count}/{s.taskBudget.critical.cap} Critical, {s.taskBudget.high.count}/
        {s.taskBudget.high.cap} High.
      </p>
      <fieldset>
        <legend>Spec: open entries</legend>
        <div className="row wrap">
          {field('critical_min', 'Critical: at least')}
          {field('critical_pct', 'Critical: % of open')}
          {field('high_pct', 'High: % of open')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Open tasks</legend>
        <div className="row wrap">
          {field('task_critical_min', 'Critical: at least')}
          {field('task_critical_pct', 'Critical: % of open')}
          {field('task_high_pct', 'High: % of open')}
        </div>
      </fieldset>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || !dirty} onClick={() => run(() => api(`/api/projects/${s.project.id}/importance-limits`, { method: 'PATCH', body: form }))}>
          Save limits
        </button>
        {dirty && (
          <button className="btn quiet" onClick={() => setForm(s.limits)}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- one-tap override and tiered ordering ----------

/** The level as a tag the owner can tap to change: tap, then pick. The new level is pinned. */
export function ImportancePicker({ id, level, pinned, change, compact = false, startOpen = false }: { id: string; level: number; pinned: boolean; change?: ImportanceChange; compact?: boolean; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [warning, setWarning] = useState('');
  const { busy, error, run } = useAction();
  const stop = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const pick = async (n: number) => {
    let res: { warnings?: string[] } = {};
    if (n !== level && (await run(async () => (res = await api(`/api/importance/${id}`, { body: { importance: n } }))))) setWarning(res.warnings?.length ? overText(res.warnings[0]) : '');
    setOpen(false);
  };
  return (
    <span className="imp-picker-wrap" onClick={stop}>
      <button className="btn bare imp-picker" onClick={(e) => (stop(e), setOpen(!open))} aria-expanded={open} aria-label={`Importance ${LEVEL[level]}. Change`}>
        <ImportanceTag level={level} pinned={pinned} compact={compact} />
      </button>
      {change && <ImportanceTag level={level} change={change} compact onlyMove />}
      {open && (
        <span className="imp-choices" role="group" aria-label="Set importance">
          {[5, 4, 3, 2, 1].map((n) => (
            <button key={n} className={`btn small imp-choice imp-l${n} ${n === level ? 'on' : ''}`} disabled={busy} onClick={(e) => (stop(e), pick(n))}>
              {LEVEL[n]}
            </button>
          ))}
          {pinned && (
            <button className="link small" disabled={busy} onClick={(e) => (stop(e), run(() => api(`/api/importance/${id}/unpin`, { body: {} })).then(() => setOpen(false)))}>
              Unpin
            </button>
          )}
        </span>
      )}
      {warning && <span className="imp-warning small">{warning}</span>}
      {error && <span className="error-text small">{error}</span>}
    </span>
  );
}

/** The first line of an over-budget warning from the server, for the owner. */
export const overText = (w: string) => `${w.split('\n')[0].replace(/^[^:]*: /, '').replace(/ To make this.*$/, '')} Saved anyway: it is your call.`;

export type TierItem = { id: string; level: number; pinned: boolean };
type Place = { level: number; before?: string; after?: string; top?: boolean };

/**
 * Items grouped by importance tier, in priority order. Drag the handle to
 * reorder within a tier or into another tier (which changes the level), or use
 * the up, down and top buttons. Each placement goes to the server as the
 * owner's, so it is pinned.
 */
export function TieredList<T extends TierItem>({
  items,
  render,
  label,
  onWarnings,
  holdFrom,
}: {
  items: T[];
  render: (item: T) => React.ReactNode;
  label: (level: number) => React.ReactNode;
  onWarnings?: (w: string[]) => void;
  /** Where in a row a touch press and hold may pick it up (see useDragReorder); anywhere by default. */
  holdFrom?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { busy, error, run } = useAction();
  const tiers = [5, 4, 3, 2, 1];
  const inTier = (l: number) => items.filter((i) => i.level === l);

  const place = async (id: string, p: Place) => {
    let res: { warnings?: string[] } = {};
    await run(async () => (res = await api(`/api/importance/${id}/place`, { body: { importance: p.level, before: p.before, after: p.after, top: p.top } })));
    onWarnings?.(res.warnings ?? []);
  };

  /** Where a pointer at y would drop: before or after the item under it, or at the top of a tier whose heading it is over. */
  const dropAt = (y: number, id: string): Place | null => {
    const els = [...(box.current?.querySelectorAll<HTMLElement>('[data-tier-head], [data-item]') ?? [])];
    let found: Place | null = null;
    for (const el of els) {
      // The dragged row itself is skipped: it is drawn where the pointer was, not where it belongs.
      if (el.dataset.item === id) continue;
      const r = el.getBoundingClientRect();
      if (r.top > y) break;
      if (el.dataset.tierHead) found = { level: Number(el.dataset.tierHead), top: true };
      else found = y > r.top + r.height / 2 ? { level: Number(el.dataset.level), after: el.dataset.item } : { level: Number(el.dataset.level), before: el.dataset.item };
    }
    return found;
  };

  // Drag and drop is the way to reorder (grip, or press and hold the row on touch); the arrows are a keyboard fallback.
  const dropRef = useRef<Place | null>(null);
  const [drop, setDrop] = useState<Place | null>(null);
  const { drag, gripProps, rowProps } = useDragReorder({
    holdFrom,
    onMove: (id, y) => {
      dropRef.current = dropAt(y, id);
      setDrop(dropRef.current);
    },
    onDrop: (id) => {
      const p = dropRef.current;
      dropRef.current = null;
      setDrop(null);
      if (p) void place(id, p);
    },
  });

  /** Up and down step past the neighbour; from the edge of a tier they cross into the next one. */
  const step = (item: T, dir: -1 | 1) => {
    const flat = tiers.flatMap(inTier);
    const i = flat.findIndex((x) => x.id === item.id);
    const other = flat[i + dir];
    if (!other) return;
    if (other.level === item.level) return place(item.id, dir < 0 ? { level: item.level, before: other.id } : { level: item.level, after: other.id });
    return place(item.id, dir < 0 ? { level: other.level, after: other.id } : { level: other.level, before: other.id });
  };

  const d = drag ? { ...drag, drop } : null;
  return (
    <div className={`tiered ${d ? 'is-dragging' : ''}`} ref={box}>
      {tiers.map((l) => {
        const list = inTier(l);
        return (
          <div key={l} className="tier">
            <div className={`tier-head ${d?.drop?.top && d.drop.level === l ? 'drop-here' : ''}`} data-tier-head={l}>
              {label(l)}
            </div>
            {list.length === 0 && <p className="tier-empty muted small">Drop here to make it {LEVEL[l]}.</p>}
            <ol className="tier-items">
              {list.map((item, i) => (
                <li
                  key={item.id}
                  {...rowProps(item.id)}
                  data-item={item.id}
                  data-level={l}
                  className={`tier-item ${d?.id === item.id ? 'dragging' : ''} ${d?.drop?.before === item.id ? 'drop-before' : ''} ${d?.drop?.after === item.id ? 'drop-after' : ''}`}
                  style={d?.id === item.id ? { transform: `translateY(${d.dy}px)` } : undefined}
                >
                  <button className="drag-handle" aria-label="Drag to reorder" {...gripProps(item.id)}>
                    <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                      {[4, 10, 16].map((y) => [5, 11].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />))}
                    </svg>
                  </button>
                  <div className="tier-body">{render(item)}</div>
                  <span className="tier-moves" aria-label="Move with the keyboard">
                    <button className="icon-btn" disabled={busy || (i === 0 && l === 5)} onClick={() => step(item, -1)} aria-label="Move up" title="Move up">
                      ↑
                    </button>
                    <button className="icon-btn" disabled={busy} onClick={() => step(item, 1)} aria-label="Move down" title="Move down">
                      ↓
                    </button>
                    <button className="icon-btn" disabled={busy || i === 0} onClick={() => place(item.id, { level: l, top: true })} aria-label="Move to top of tier" title="Move to top of tier">
                      <Icon name="top" size={16} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
