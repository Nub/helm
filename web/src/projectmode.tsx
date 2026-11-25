import { useEffect, useState } from 'react';
import { api } from './api';
import type { ProjectState } from './api';
import { Markdown, Sheet, href, useAction, useTick } from './ui';
import { when } from './time';

/**
 * The project's mode (server/projectmode.ts), one of four from most to least automatic: Autopilot (stored running),
 * Queue only, Finish up (winding_down, then at_rest when it is done) and Stopped. Only the user changes it: the pill
 * in the project's header opens the menu, and Setup's first item shows the same four choices; both confirm in the
 * sheet with exactly what the change will do. Home shows what is still running and what is held while finishing up
 * or stopped; a stopped project has a bar on every page.
 */

export type Mode = 'running' | 'queue_only' | 'winding_down' | 'at_rest' | 'stopped';
type Choice = 'running' | 'queue_only' | 'winding_down' | 'stopped';
type AgentLine = { id: string; name: string; status: string; director: boolean; task_id: string | null; task_title: string | null; doing: string; now?: string };
export type ModeView = {
  mode: Mode;
  label: string;
  since: number | null;
  note: string;
  data: { finished?: { id: string; title: string }[]; scheduled?: number; waiting?: number; at_rest_at?: number; started_at?: number };
  counts?: { active: { id: string; title: string }[]; scheduled: number; waiting: number; working: AgentLine[] };
  held_messages?: number;
  closeout?: { id: number; title: string; body: string; ts: number };
  interrupted?: AgentLine[];
};

export const MODE_LABEL: Record<Mode, string> = { running: 'Autopilot', queue_only: 'Queue only', winding_down: 'Finish up', at_rest: 'Finish up', stopped: 'Stopped' };
/** The four the user chooses from, with the line under each name (server/projectmode.ts MODE_CHOICES). */
export const MODE_CHOICES: { mode: Choice; label: string; line: string }[] = [
  { mode: 'running', label: 'Autopilot', line: 'When the queue empties, the director schedules the next waiting task.' },
  { mode: 'queue_only', label: 'Queue only', line: 'Scheduled tasks run in order. Nothing else is scheduled for you.' },
  { mode: 'winding_down', label: 'Finish up', line: 'What runs finishes. Nothing new starts, not even scheduled tasks.' },
  { mode: 'stopped', label: 'Stopped', line: 'Every agent is interrupted now. Resumable.' },
];
/** Finishing up, at rest or stopped: the modes that hold the queue (the project rows mark only these). */
export const holdsWork = (m?: string) => m === 'winding_down' || m === 'at_rest' || m === 'stopped';
const choiceOf = (m: Mode): Choice => (m === 'at_rest' ? 'winding_down' : m);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The four choices as radio cards, the current one on: the sheet's menu and Setup's first item. */
export function ModeChoices({ mode, onPick, name = 'project-mode' }: { mode: Mode; onPick: (m: Choice) => void; name?: string }) {
  const on = choiceOf(mode);
  return (
    <div className="radio-cards mode-choices">
      {MODE_CHOICES.map((c) => (
        <label key={c.mode} className={`radio-card ${on === c.mode ? 'on' : ''} ${c.mode === 'stopped' ? 'danger' : ''}`}>
          <input type="radio" name={name} checked={on === c.mode} onChange={() => onPick(c.mode)} />
          <strong>{c.label}</strong>
          <span>{c.line}</span>
        </label>
      ))}
    </div>
  );
}

// ---------- the pill, and opening the sheet from anywhere ----------

const OPEN = 'helm-mode-sheet';
/** Open the sheet for a project, at the confirmation for `to` when given (Setup), else at the menu. */
export const openModeSheet = (projectId: string, to?: Choice) => dispatchEvent(new CustomEvent(OPEN, { detail: { projectId, to } }));

/** What the project is doing, for the pill: "2 working", "Waiting" (queued work, none running), "Idle", "At rest"; nothing while stopped. */
export function activityText(mode: Mode, working: number, queued = 0): string {
  if (mode === 'stopped') return '';
  if (mode === 'at_rest') return 'At rest';
  return working ? `${working} working` : queued ? 'Waiting' : 'Idle';
}

/**
 * The mode with what the project is doing ("Queue only · Idle", "Autopilot · 2 working"), a button that opens the
 * menu. `working` undefined leaves the activity out (the project rows); `held` shows it only while the queue is held.
 */
export function ModeChip({ projectId, mode, working, queued = 0, held = false, className = '' }: { projectId: string; mode?: string; working?: number; queued?: number; held?: boolean; className?: string }) {
  const m = (mode ?? 'running') as Mode;
  if (held && !holdsWork(m)) return null;
  const act = working === undefined ? '' : activityText(m, working, queued);
  const idle = (m === 'running' || m === 'queue_only') && !working;
  const label = act ? `${MODE_LABEL[m]} · ${act}` : MODE_LABEL[m];
  return (
    <button type="button" className={`btn small mode-chip mode-${m} ${idle ? 'mode-idle' : ''} ${className}`} onClick={(e) => (e.preventDefault(), e.stopPropagation(), openModeSheet(projectId))} aria-label={`${label}: change the mode`}>
      <span className="mode-dot" aria-hidden="true" />
      <span>
        {MODE_LABEL[m]}
        {act && <span className="mode-act"> · {act}</span>}
      </span>
    </button>
  );
}

/** Mounted once (main.tsx): the sheet for whichever project asked. */
export function ModeSheetHost() {
  const [open, setOpen] = useState<{ projectId: string; to?: Choice } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<{ projectId: string; to?: Choice }>).detail);
    addEventListener(OPEN, on);
    return () => removeEventListener(OPEN, on);
  }, []);
  return open ? <ModeSheet key={`${open.projectId}:${open.to ?? ''}`} projectId={open.projectId} to={open.to} onClose={() => setOpen(null)} /> : null;
}

// ---------- the sheet ----------

function ModeSheet({ projectId, to, onClose }: { projectId: string; to?: Choice; onClose: () => void }) {
  const [v, setV] = useState<ModeView | null>(null);
  const [step, setStep] = useState<Choice | null>(to ?? null);
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState<string[] | null>(null);
  const { busy, error, run } = useAction();
  const load = () => api<ModeView>(`/api/projects/${projectId}/mode`).then(setV).catch(() => {});
  useEffect(() => void load(), [projectId]);
  if (!v) return <Sheet title="Project mode" onClose={onClose}><p className="muted">Loading…</p></Sheet>;
  const c = v.counts!;
  const working = c.working.filter((a) => !a.director);
  const queued = c.scheduled + c.waiting;
  const set = (mode: Choice, body: Record<string, unknown> = {}) =>
    void run(async () => {
      await api(`/api/projects/${projectId}/mode`, { body: { action: 'set', mode, ...body } });
      onClose();
    });
  const interrupted = v.interrupted ?? [];
  const resumable = interrupted.filter((a) => !['done', 'closed'].includes(a.now ?? ''));
  const picked = chosen ?? resumable.map((a) => a.id);
  const target = step && step !== choiceOf(v.mode) ? step : null;
  const back = () => (to ? onClose() : setStep(null));

  return (
    <Sheet title="Project mode" onClose={onClose} className="mode-sheet">
      {v.since && v.mode !== 'running' && v.mode !== 'queue_only' && (
        <p className="muted small mode-now">
          {MODE_LABEL[v.mode]}{v.mode === 'at_rest' ? ', at rest' : ''} since {when(v.since)}
          {v.note ? ` · “${v.note}”` : ''}
        </p>
      )}

      {!target && <ModeChoices mode={v.mode} onPick={setStep} name="mode-sheet" />}

      {target === 'running' && v.mode !== 'stopped' && (
        <Confirm
          title="Autopilot?"
          lines={[c.scheduled ? `${plural(c.scheduled, 'scheduled task')} run in order.` : 'Nothing scheduled.', c.waiting ? `Then the director schedules ${plural(c.waiting, 'waiting task')} itself.` : 'Nothing waiting.']}
          go="Autopilot"
          busy={busy}
          onGo={() => set('running')}
          onBack={back}
        />
      )}
      {target === 'queue_only' && v.mode !== 'stopped' && (
        <Confirm
          title="Queue only?"
          lines={[c.scheduled ? `${plural(c.scheduled, 'scheduled task')} run in order.` : 'Nothing scheduled: idle until you schedule.', c.waiting ? `${plural(c.waiting, 'waiting task')} wait for you.` : 'Nothing waiting.', 'You are told when the queue empties.']}
          go="Queue only"
          busy={busy}
          onGo={() => set('queue_only')}
          onBack={back}
        />
      )}
      {target === 'winding_down' && v.mode !== 'stopped' && (
        <Confirm
          title="Finish up?"
          lines={[
            c.active.length ? `${plural(c.active.length, 'task')} finish${c.active.length === 1 ? 'es' : ''}${working.length ? ` (${plural(working.length, 'agent')} working)` : ''}.` : 'Nothing runs: at rest at once.',
            queued ? `${queued} queued: held.` : 'Nothing queued.',
            'You are told when it is done.',
          ]}
          note={note}
          setNote={setNote}
          go="Finish up"
          busy={busy}
          onGo={() => set('winding_down', { note })}
          onBack={back}
        />
      )}
      {target === 'stopped' && (
        <Confirm
          title="Stop all work?"
          tone="danger"
          lines={[
            c.working.length ? `Interrupts ${c.working.map((a) => a.name).join(', ')}.` : 'No agent is working.',
            'Choosing another mode picks up where they stopped.',
            'The director only answers you.',
          ]}
          note={note}
          setNote={setNote}
          go="Stop all work"
          busy={busy}
          onGo={() => set('stopped', { note })}
          onBack={back}
        />
      )}
      {target && target !== 'stopped' && v.mode === 'stopped' && (
        <div className="mode-confirm">
          <h3>Resume which agents?</h3>
          {resumable.length === 0 ? (
            <p className="muted small">No agent was working.</p>
          ) : (
            <ul className="mode-agents">
              {resumable.map((a) => (
                <li key={a.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={a.director || picked.includes(a.id)}
                      disabled={a.director}
                      onChange={(e) => setChosen(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))}
                    />
                    <span>
                      <b>{a.name}</b>
                      <span className="muted small one-line">
                        {a.director ? 'Always resumes' : a.task_title ?? 'No task'}
                        {a.doing ? ` · ${a.doing}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {!!v.held_messages && <p className="muted small">{plural(v.held_messages, 'held message')} delivered on resume.</p>}
          <div className="row">
            <button className="btn" onClick={back} disabled={busy}>
              Back
            </button>
            <span className="spacer" />
            <button className="btn primary" disabled={busy} onClick={() => set(target, { agents: picked })}>
              Resume in {MODE_LABEL[target]}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
    </Sheet>
  );
}

function Confirm({ title, lines, note, setNote, go, busy, onGo, onBack, tone = 'primary' }: { title: string; lines: string[]; note?: string; setNote?: (s: string) => void; go: string; busy: boolean; onGo: () => void; onBack: () => void; tone?: string }) {
  return (
    <div className="mode-confirm">
      <h3>{title}</h3>
      <ul className="mode-lines">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {setNote && (
        <label className="mode-note">
          <span className="small muted">Note (optional)</span>
          <input value={note} maxLength={300} placeholder="e.g. release testing" onChange={(e) => setNote(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="btn" onClick={onBack} disabled={busy}>
          Back
        </button>
        <span className="spacer" />
        <button className={`btn ${tone}`} disabled={busy} onClick={onGo}>
          {go}
        </button>
      </div>
    </div>
  );
}

// ---------- Home and the other pages ----------

/** Home: what the mode means right now, with its one action. Only while finishing up, at rest or stopped. */
export function ModeBanner({ s }: { s: ProjectState }) {
  useTick();
  const v = s.mode;
  if (!v || !holdsWork(v.mode)) return null;
  const c = v.counts;
  const queued = (c?.scheduled ?? 0) + (c?.waiting ?? 0);
  const pid = s.project.id;
  const head = (
    <div className="mode-banner-head">
      <span className={`tag mode-chip mode-${v.mode}`}>
        <span className="mode-dot" aria-hidden="true" />
        {MODE_LABEL[v.mode]}{v.mode === 'at_rest' ? ' · At rest' : ''}
      </span>
      <span className="grow" />
      <button className={`btn small ${v.mode === 'winding_down' ? '' : 'primary'}`} onClick={() => openModeSheet(pid)}>
        {v.mode === 'winding_down' ? 'Change' : 'Change…'}
      </button>
    </div>
  );
  const sinceLine = (
    <p className="muted small">
      Since {when(v.since ?? Date.now())}
      {v.note ? ` · “${v.note}”` : ''}
    </p>
  );
  if (v.mode === 'winding_down') {
    const working = (c?.working ?? []).filter((a) => !a.director);
    return (
      <section className="card mode-banner mode-banner-winding_down" aria-label="Finishing up">
        {head}
        {sinceLine}
        <p>
          {c?.active.length ? (
            <>
              Still running: {c.active.map((t, i) => (
                <span key={t.id}>
                  {i ? ', ' : ''}
                  <a href={href('p', pid, 'tasks', t.id)}>{t.title}</a>
                </span>
              ))}
              {working.length ? ` (${plural(working.length, 'agent')} working)` : ''}.
            </>
          ) : (
            'Director finishing up.'
          )}{' '}
          <b>{queued} queued, held.</b>
        </p>
      </section>
    );
  }
  if (v.mode === 'at_rest') {
    const finished = v.data.finished ?? [];
    return (
      <section className="card mode-banner mode-banner-at_rest" aria-label="At rest">
        {head}
        {sinceLine}
        <p>
          {plural(finished.length, 'task')} finished while finishing up
          {finished.length ? ': ' : ''}
          {finished.slice(0, 5).map((t, i) => (
            <span key={t.id}>
              {i ? ', ' : ''}
              <a href={href('p', pid, 'tasks', t.id)}>{t.title}</a>
            </span>
          ))}
          {finished.length > 5 ? `, and ${finished.length - 5} more` : ''}. {queued ? `${queued} remain queued (${c?.scheduled ?? 0} scheduled, ${c?.waiting ?? 0} waiting).` : 'Nothing remains queued.'}
        </p>
        {v.closeout ? (
          <details className="mode-closeout" open>
            <summary>{v.closeout.title}</summary>
            <Markdown text={v.closeout.body} className="small" />
          </details>
        ) : (
          <p className="muted small">Close-out coming from the director.</p>
        )}
      </section>
    );
  }
  const interrupted = v.interrupted ?? [];
  return (
    <section className="card mode-banner mode-banner-stopped" aria-label="Stopped">
      {head}
      {sinceLine}
      <p>
        {interrupted.length ? `Interrupted: ${interrupted.map((a) => a.name).join(', ')}.` : 'No agent was working.'} The director only answers you.
        {v.held_messages ? ` ${plural(v.held_messages, 'message')} held.` : ''}
      </p>
    </section>
  );
}

/** Every other project page while stopped: one line with Resume. */
export function StoppedBar({ s }: { s: ProjectState }) {
  const v = s.mode;
  if (v?.mode !== 'stopped') return null;
  return (
    <div className="presence mode-stopped-bar" role="status">
      <span className="mode-dot" aria-hidden="true" />
      <span className="grow">
        <b>Stopped</b>
        <span className="muted"> since {when(v.since ?? Date.now())} · nothing runs</span>
      </span>
      <button className="btn small primary" onClick={() => openModeSheet(s.project.id)}>
        Resume…
      </button>
    </div>
  );
}
