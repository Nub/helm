import { useState } from 'react';
import { api, useLive } from './api';
import { Empty, Icon, Sheet, useAction, PageHeader } from './ui';
import { shortWhen } from './time';

/**
 * Watches (server/watches.ts): standing conditions Helm checks on a schedule; a trip wakes the director. One row
 * each: name and state, then one muted line with what it measures, the condition, its value now (or why it cannot be
 * measured) and when it last tripped. The user adds, pauses and removes them.
 */

type Watch = {
  id: string;
  name: string;
  measure: string;
  condition: string;
  every_ms: number;
  state: 'active' | 'paused';
  then_note: string;
  ask_user: boolean;
  value: string | null;
  checked_at: number | null;
  error: string | null;
  firing: boolean;
  tripped_at: number | null;
  trips: number;
  needs_approval: boolean;
};
type Builtin = { id: string; label: string; unit: string };

const every = (ms: number) => (ms >= 86_400_000 ? `${Math.round(ms / 86_400_000)} d` : ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 60_000)} min`);

export function WatchesPage({ pid }: { pid: string }) {
  const { data, error, reload } = useLive<{ watches: Watch[]; builtins: Builtin[] }>(`/api/projects/${pid}/watches`, (m) => m.type === 'project' && m.projectId === pid);
  const [adding, setAdding] = useState(false);
  const act = useAction();
  if (error && !data) return <Empty title="Could not load watches">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const set = (body: Record<string, unknown>) => act.run(async () => (await api(`/api/projects/${pid}/watches`, { body }), reload()));
  return (
    <section className="watches-page">
      <PageHeader title="Watches">
        <button className="btn small" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add
        </button>
      </PageHeader>
      {!data.watches.length && <Empty title="No watches yet" />}
      <ul className="watch-list">
        {data.watches.map((w) => (
          <li key={w.id} className={`card watch ${w.firing ? 'tripped' : ''} ${w.state === 'paused' ? 'paused' : ''}`}>
            <div className="row">
              <strong className="grow one-line">{w.name}</strong>
              <b className={`watch-value mono ${w.needs_approval ? 'warn' : w.error ? 'bad' : w.firing ? 'warn' : ''}`}>{w.needs_approval ? 'Needs approval' : w.error ? 'Cannot measure' : (w.value ?? '–')}</b>
            </div>
            <span className="muted small">
              {w.measure} · trips {w.condition} · every {every(w.every_ms)}
            </span>
            {w.error && !w.needs_approval && <span className="small error-text">{w.error}</span>}
            <span className="muted small">
              {w.state === 'paused' ? 'Paused' : w.firing ? `Tripped ${shortWhen(w.tripped_at!)}; rests until it clears` : w.tripped_at ? `Last tripped ${shortWhen(w.tripped_at)}` : w.checked_at ? `Checked ${shortWhen(w.checked_at)}` : 'Not checked yet'}
            </span>
            <div className="row watch-actions">
              {w.needs_approval && (
                <button className="btn small primary" disabled={act.busy} onClick={() => act.run(async () => (await api(`/api/projects/${pid}/watches/${w.id}/approve`, { body: {} }), reload()))}>
                  Approve command
                </button>
              )}
              <button className="btn small" disabled={act.busy} onClick={() => set({ id: w.id, state: w.state === 'paused' ? 'active' : 'paused' })}>
                {w.state === 'paused' ? 'Resume' : 'Pause'}
              </button>
              <button className="btn small ghost" disabled={act.busy} onClick={() => confirm(`Remove the watch "${w.name}"?`) && set({ id: w.id, remove: true })}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      {act.error && <p className="error-text">{act.error}</p>}
      {adding && <AddWatch pid={pid} builtins={data.builtins} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), void reload())} />}
    </section>
  );
}

function AddWatch({ pid, builtins, onClose, onSaved }: { pid: string; builtins: Builtin[]; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'builtin' | 'command'>('builtin');
  const [builtin, setBuiltin] = useState(builtins[0]?.id ?? 'finding_code');
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [op, setOp] = useState<'above' | 'below'>('above');
  const [value, setValue] = useState('');
  const [hours, setHours] = useState('1');
  const [askUser, setAskUser] = useState(false);
  const { busy, error, run } = useAction();
  const save = () =>
    run(async () => {
      await api(`/api/projects/${pid}/watches`, {
        body: {
          name: name.trim() || (kind === 'builtin' ? builtins.find((b) => b.id === builtin)?.label : command.slice(0, 40)),
          measure: kind === 'builtin' ? { kind, builtin, days: 7 } : { kind, command },
          op,
          value: Number(value),
          every_minutes: Math.round(Number(hours) * 60),
          ask_user: askUser,
        },
      });
      onSaved();
    });
  return (
    <Sheet title="Add a watch" onClose={onClose}>
      <div className="form">
        <label>
          Measure
          <select value={kind === 'builtin' ? builtin : 'command'} onChange={(e) => (e.target.value === 'command' ? setKind('command') : (setKind('builtin'), setBuiltin(e.target.value)))}>
            {builtins.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
                {b.unit ? ` (${b.unit})` : ''}
              </option>
            ))}
            <option value="command">A command's number</option>
          </select>
        </label>
        {kind === 'command' && (
          <label>
            Command (read-only, in the project folder)
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="rg -c TODO src | wc -l" />
          </label>
        )}
        <div className="row wrap watch-cond">
          <select value={op} onChange={(e) => setOp(e.target.value as 'above' | 'below')} aria-label="Condition">
            <option value="above">Above</option>
            <option value="below">Below</option>
          </select>
          <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" aria-label="Value" />
          <label className="row">
            every
            <input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours between checks" />h
          </label>
        </div>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
        </label>
        <label className="row">
          <input type="checkbox" checked={askUser} onChange={(e) => setAskUser(e.target.checked)} /> Also ask me when it trips
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={busy || !value.trim() || (kind === 'command' && !command.trim())} onClick={save}>
          Add watch
        </button>
      </div>
    </Sheet>
  );
}
