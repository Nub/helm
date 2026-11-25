import { useState } from 'react';
import { useLive } from './api';
import { Fold } from './fold';
import { duration } from './sessions';
import { when } from './time';

/**
 * A task's "Where the time went" (server/tasktime.ts): collapsed at the bottom of the task page, after History and
 * above the dashboard tiles; its header says the work time and the biggest item ("42 min · mostly compiling"). Open: one
 * bar of the work time by kind, the five biggest items in a sentence, then every item grouped by kind, biggest first,
 * each opening into its runs in order. Re-runs of a failing command stand out.
 */
type Run = { at: number; ms: number; failed: boolean };
type Item = { kind: string; key: string; label: string; ms: number; idle_ms: number; runs: Run[]; failed: number; alongside: boolean };
export type TaskTimeView = {
  time: { work_ms: number | null; measured_ms: number; other_ms: number; items: Item[]; kinds: { kind: string; label: string; ms: number }[]; outside: { waiting_you_ms: number; review_ms: number; queued_ms: number; host_free_ms: number }; model: { turns: number; slow_turns: number; tokens: number } } | null;
  headline: string;
  sentence: string;
  kinds: Record<string, string>;
};

const short = (ms: number) => (ms >= 60_000 ? duration(ms) : `${Math.max(1, Math.round(ms / 1000))} s`);
/** The validated series order (styles.css --series-N), one colour per kind in a fixed order. */
const ORDER = ['model', 'compile', 'test', 'run', 'git', 'script', 'command', 'files', 'helm', 'web', 'subagents', 'tools', 'idle', 'other'];
const colour = (kind: string) => (kind === 'other' || kind === 'idle' ? 'var(--line-strong)' : `var(--series-${(ORDER.indexOf(kind) % 8) + 1})`);

export function TaskTimeCard({ taskId }: { taskId: string }) {
  const { data } = useLive<TaskTimeView>(`/api/tasks/${taskId}/time`, (m) => m.type === 'project');
  if (!data?.time) return null;
  const x = data.time;
  const total = x.work_ms ?? x.measured_ms;
  const main = x.items.filter((i) => !i.alongside);
  const along = x.items.filter((i) => i.alongside);
  const byKind = x.kinds.map((k) => ({ ...k, items: main.filter((i) => i.kind === k.kind) }));
  return (
    <Fold
      kind="tasktime"
      openByDefault={false}
      className="task-time"
      label="Where the time went"
      title={
        <>
          Where the time went <span className="task-time-head muted">{data.headline}</span>
        </>
      }
    >
      <div className="tt-bar" role="img" aria-label={x.kinds.map((k) => `${k.label} ${short(k.ms)}`).join(', ')}>
        {total > 0 && x.kinds.map((k) => <span key={k.kind} style={{ width: `${(k.ms / total) * 100}%`, background: colour(k.kind) }} title={`${k.label}: ${short(k.ms)}`} />)}
      </div>
      {data.sentence && <p className="small">{data.sentence}.</p>}
      {byKind.map((k) => (
        <section key={k.kind} className="tt-kind">
          <h3 className="tt-kind-title small">
            <i style={{ background: colour(k.kind) }} /> {k.label}
            <span className="muted"> · {short(k.ms)}</span>
          </h3>
          <ul className="tt-items">
            {k.items.map((i) => (
              <ItemRow key={i.key} i={i} />
            ))}
          </ul>
        </section>
      ))}
      {along.length > 0 && (
        <section className="tt-kind">
          <h3 className="tt-kind-title small muted">Alongside (other agents and subagents, not added to the bar)</h3>
          <ul className="tt-items">
            {along.map((i) => (
              <ItemRow key={`a:${i.key}`} i={i} />
            ))}
          </ul>
        </section>
      )}
      <p className="muted small">
        Measured from the agents' transcripts; "Not attributed" is work time they do not account for. Outside the work time: waiting on you {short(x.outside.waiting_you_ms)}, review {short(x.outside.review_ms)}, queued {short(x.outside.queued_ms)}
        {x.outside.host_free_ms ? `, a host free while a heavy job waited ${short(x.outside.host_free_ms)}` : ''}. The model: {x.model.turns} stretches{x.model.slow_turns ? `, ${x.model.slow_turns} slow` : ''}, {Math.round(x.model.tokens / 1000)}k tokens.
      </p>
    </Fold>
  );
}

function ItemRow({ i }: { i: Item }) {
  const [open, setOpen] = useState(false);
  // A command run again and again while it fails: the thing to look at.
  const rerunFailing = i.runs.length > 1 && i.failed > 0;
  return (
    <li className={`tt-item ${rerunFailing ? 'tt-flag' : ''}`}>
      <button className="tt-item-row" aria-expanded={open} onClick={() => setOpen(!open)} disabled={!i.runs.length}>
        <span className="one-line">{i.label}</span>
        <span className="tt-item-n small">{short(i.ms)}</span>
      </button>
      <span className="muted small tt-item-sub">
        {i.runs.length > 1 ? `${i.runs.length} runs` : i.runs.length === 1 ? '1 run' : ''}
        {i.failed ? <span className="bad"> · {i.failed} failed</span> : null}
        {i.idle_ms ? ` · idle on it ${short(i.idle_ms)}` : ''}
      </span>
      {open && (
        <ol className="tt-runs small">
          {i.runs.map((r, k) => (
            <li key={k} className={r.failed ? 'bad' : ''}>
              <span className="muted">{when(r.at)}</span> {short(r.ms)}
              {r.failed ? ' · failed' : ''}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
