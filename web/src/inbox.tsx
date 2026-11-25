import { useEffect, useRef, useState } from 'react';
import { ShareButton } from './share';
import { RequestTestBuild } from './testbuilds';
import type { InboxItem } from './api';
import { AttachButton, AttachTray, dropTarget, pasteInto, useAttachDraft } from './attachments';
import { useStoredText } from './drafts';
import { ACTION_CHOICES, actOf, ErrorDetails, KIND_LABEL, LimitAll, ScheduledResume, WantsMark, answerRequest, appliesToAll, errorChoices, kindTone, wantsWhat } from './needs';
import { INLINE_KINDS, PreviewBody, PreviewTile } from './preview';
import { openChat } from './chat';
import { Icon, Importance, Markdown, Tag, ago, clock, go, href, openPreview, useAction } from './ui';
import { api } from './api';
import { dayTime } from './time';
import { ProposalCard } from './specdiscuss';

/**
 * A request to the user, as its one full card: the only shape a request is shown in (Needs you, the project's Needs
 * response, the Home card, the thread of its task or discussion, the agent's page). The whole ask, never clamped: the
 * task or discussion it belongs to as the card's title line (a link; nothing for a request on no task), its kind, the
 * request's own title and text, a to-do's steps, an
 * error's details, a permission's command and why it asks, attached previews, the recommendation, then the answer
 * controls. Kinds differ only in their label and their controls.
 *
 * context: the line linking to its task or discussion (left out in that task's own thread). hidePreviews: shown
 * above it already (a pinned proposal's items). onAnswered: told after an answer was sent (the Home card moves on).
 */
export function InboxCard({ item, agentName, hidePreviews = false, context = true, onAnswered, openHref }: { item: InboxItem; agentName?: string; hidePreviews?: boolean; context?: boolean; onAnswered?: (what: string) => void; openHref?: string | null }) {
  const [choice, setChoice] = useState('');
  // What is typed (a note, an answer) and the files attached are kept per request until it is answered (drafts.ts).
  const draftKey = `request:${item.id}`;
  const [text, setText] = useStoredText(draftKey);
  const [all, setAll] = useState(true);
  const { busy, error, run } = useAction();
  // No agent: Helm itself asked (a watch's command to approve, an update, a release).
  const who = agentName ?? item.agent_name ?? (item.agent_id ? 'An agent' : 'Helm');
  // Waiting on the director or the independent check: still answerable by the user, first answer wins.
  const deciding = item.status === 'director' || item.status === 'check';
  const open = item.status === 'open' || deciding;
  // A question's answer can carry files: picker, paste into the box, or drop on the form (as in the composer).
  const action = item.kind === 'action';
  const question = open && (item.kind === 'question' || action);
  const draft = useAttachDraft(question ? item.project_id : undefined, `request:${item.id}`, draftKey);
  const [over, setOver] = useState(false);
  const files = draft.ready.map((a) => a.id);
  const answer = (body: { choice?: string; text?: string; dismiss?: boolean; all?: boolean; perform?: boolean }) =>
    run(async () => {
      await answerRequest(item.id, files.length && !body.dismiss ? { ...body, attachments: files } : body);
      draft.clear();
      onAnswered?.(body.dismiss ? 'Dismissed' : `Answered “${body.choice ?? (body.perform ? actOf(item)?.button : null) ?? 'Done'}”`);
    });
  // Where it belongs: its task or discussion, else the agent that asked (a request on no task), else the project.
  const thread = item.task_id ? href('p', item.project_id, item.task_kind === 'discussion' ? 'discussions' : 'tasks', item.task_id) : null;
  // Open (top right, beside Share) and Ask (the bottom row, before Dismiss): the same on every card; a card shown in its
  // own thread (context false) is already there, so it has no Open.
  const openTo = openHref !== undefined ? openHref : context ? thread ?? (item.agent_id ? href('p', item.project_id, 'agents', item.agent_id) : null) : null;
  const ask = (
    <button className="btn quiet" disabled={busy} onClick={() => openChat({ kind: 'request', id: item.id })}>
      <Icon name="discuss" size={16} /> Ask
    </button>
  );
  const dismiss = (
    <button className="btn quiet" disabled={busy} onClick={() => answer({ dismiss: true })}>
      Dismiss
    </button>
  );
  // Asked for a file: Attach leads, and the text box waits until the user chooses to answer in words.
  const wants = !!wantsWhat(item);
  const [inWords, setInWords] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const showBox = !wants || inWords || draft.items.length > 0 || !!text || !!choice;
  const cards = item.payload.spec_cards ?? [];
  const cardsOpen = open ? item.payload.spec_open ?? 0 : 0;

  return (
    <article className={`card inbox-card ${open ? '' : 'handled'} ${open && item.blocking ? 'blocking' : ''}`} data-kctx={`request:${item.id}`}>
      <ShareButton route={thread ?? href('home', 'needs')} title={item.task_title ?? 'Request'} className="card-share" />
      {open && openTo && (
        <a className="icon-btn share card-open" href={openTo} aria-label="Open" title="Open">
          <Icon name="external" size={20} />
        </a>
      )}
      {/* The card is titled with its task or discussion; the project is the section it sits in (needs.tsx). */}
      {context && item.task_title && (
        <h3 className="req-task">
          {thread ? <a href={thread}>{item.task_title}</a> : item.task_title}
        </h3>
      )}
      <header className="inbox-meta">
        <Tag tone={kindTone(item.kind)}>{KIND_LABEL[item.kind]}</Tag>
        {open && !!item.blocking && <Tag tone="tone-warning">Blocking</Tag>}
        {(item.kind === 'question' || action) && <Importance value={item.importance} />}
        <WantsMark r={item} />
        {/* Deferred before and asked again (server/reminders.ts): when it was first asked. */}
        {item.payload.asked_again && <span className="muted small">Asked again · first {dayTime(item.payload.asked_again.first_at)}</span>}
        <span className="spacer" />
        <span className="muted small">
          {item.agent_id ? <a href={href('p', item.project_id, 'agents', item.agent_id)}>{who}</a> : who} · {ago(item.created_at)}
        </span>
      </header>
      {deciding && (
        <p className="deciding">
          <span className="deciding-dot" aria-hidden="true" />
          <span>
            <b>{item.status === 'check' ? 'An independent check is deciding' : 'Director is deciding'}</b>
            {item.director_queue && item.director_queue.count > 1 && (
              <span className="muted">
                {' '}
                · {item.director_queue.count} waiting, oldest {ago(item.director_queue.oldest)}
              </span>
            )}
            <span className="muted"> · this does not need you, but you can answer first</span>
          </span>
        </p>
      )}
      <h3>{item.title}</h3>
      {/* A permission's body is a shortened copy of its command, which is shown in full below. */}
      {item.body && !sameAsTitle(item) && !(item.kind === 'permission' && item.payload.input) && <Markdown text={item.body} />}
      {action && <ActionSteps item={item} who={who} />}
      <ErrorDetails r={item} open={open} />
      {item.kind === 'permission' && item.payload.danger && (
        <p className="danger-reason">
          <span className="label">Why this asks you</span> {item.payload.danger}
        </p>
      )}

      {item.kind === 'permission' && item.payload.input && (
        <details className="tool-input" open={open}>
          <summary>{item.payload.toolName}</summary>
          <pre>{item.payload.input}</pre>
        </details>
      )}
      {/* A test build it carries (testbuilds.tsx): its files with Download and Get link. */}
      {item.payload.test_build && <RequestTestBuild id={item.payload.test_build} />}
      {item.previews?.length > 0 && !hidePreviews &&
        (open ? (
          <AttachedPreviews item={item} />
        ) : (
          <details className="attached-closed">
            <summary>Attached previews ({item.previews.length})</summary>
            <AttachedPreviews item={item} />
          </details>
        ))}
      {/* Spec edit cards it is about (server/speccards.ts): decided here, and the last one decided settles it. */}
      {open && cards.length > 0 && (
        <div className="req-spec-cards">
          {cards.map((id) => (
            <ProposalCard key={id} body={JSON.stringify({ id })} ts={item.created_at} projectId={item.project_id} />
          ))}
        </div>
      )}

      {item.kind === 'permission' && item.payload.triage?.passed && (
        <div className="recommendation">
          <span className="label">{item.payload.triage.by ?? 'The director'} passed this to you</span>
          <Markdown text={item.payload.triage.passed} />
        </div>
      )}
      {item.kind === 'permission' && item.payload.triage?.fell && <p className="muted small">{item.payload.triage.fell}</p>}
      {item.payload.recommendation && (
        <div className="recommendation">
          <span className="label">{who} recommends</span>
          <Markdown text={item.payload.recommendation} />
        </div>
      )}

      {!open && (
        <p className="answer">
          <span className="label">{item.status === 'dismissed' ? 'Dismissed' : 'You answered'}</span> {item.answer}
        </p>
      )}

      {/* Its inline action (reqactions.ts): Helm does it when tapped, and the request closes. */}
      {question && actOf(item)?.button && (
        <div className="row answer-actions">
          <button className="btn primary" disabled={busy} onClick={() => answer({ perform: true })}>
            {actOf(item)!.button}
          </button>
        </div>
      )}

      {question && action && (
        <div className={`answer-form ${over ? 'drop-over' : ''}`} {...dropTarget(draft, setOver)}>
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onPaste={pasteInto(draft)} placeholder={cardsOpen ? "Add a note to Can't / not yet" : 'Add a note, or press Done'} />
          <AttachTray items={draft.items} onRemove={draft.drop} />
          <div className="row answer-actions">
            {/* A note on its own settles it as Done, with the note: one button, Send. With Spec cards open, deciding them is Done. */}
            {!cardsOpen && (
              <button className={`btn ${actOf(item) ? '' : 'primary'}`} disabled={busy || draft.uploading} onClick={() => answer({ choice: 'Done', text: text.trim() || undefined })}>
                <Icon name={text.trim() ? 'send' : 'check'} size={16} /> {draft.uploading ? 'Uploading' : text.trim() ? 'Send' : 'Done'}
              </button>
            )}
            <button className="btn" disabled={busy || draft.uploading} onClick={() => answer({ choice: ACTION_CHOICES[1], text: text.trim() || undefined })}>
              {ACTION_CHOICES[1]}
            </button>
            <AttachButton draft={draft} className="icon-btn answer-clip" label={draft.items.length ? 'Attach more' : 'Attach photos or files'} />
            {ask}
            {dismiss}
          </div>
        </div>
      )}

      {question && !action && (
        <div className={`answer-form ${over ? 'drop-over' : ''}`} {...dropTarget(draft, setOver)}>
          {item.options.length > 0 && (
            <div className="options">
              {item.options.map((o) => (
                <button key={o.label} className={`option ${choice === o.label ? 'on' : ''}`} onClick={() => setChoice(choice === o.label ? '' : o.label)} aria-pressed={choice === o.label}>
                  <strong>{o.label}</strong>
                  {o.detail && <span>{o.detail}</span>}
                </button>
              ))}
            </div>
          )}
          {showBox && (
            <textarea
              ref={box}
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={pasteInto(draft)}
              placeholder={draft.items.length ? 'Add a note (optional)' : item.options.length ? 'Add a note, or write a different answer' : 'Your answer'}
            />
          )}
          <AttachTray items={draft.items} onRemove={draft.drop} />
          <div className="row answer-actions">
            {!showBox ? (
              <AttachButton draft={draft} className="btn primary req-attach" label="Attach photos or files">
                <Icon name="clip" size={16} /> Attach
              </AttachButton>
            ) : (
              <button
                className="btn primary"
                disabled={busy || draft.uploading || (!choice && !text.trim() && !files.length)}
                onClick={() => answer({ choice: choice || undefined, text: text.trim() || undefined })}
              >
                {draft.uploading ? 'Uploading' : 'Send answer'}
              </button>
            )}
            {showBox && <AttachButton draft={draft} className="icon-btn answer-clip" label={draft.items.length ? 'Attach more' : 'Attach photos or files'} />}
            {wants && !showBox && (
              <button
                className="btn quiet"
                onClick={() => {
                  setInWords(true);
                  setTimeout(() => box.current?.focus(), 0);
                }}
              >
                Answer in words instead
              </button>
            )}
            {ask}
            {dismiss}
          </div>
        </div>
      )}

      {open && item.kind === 'agent_error' && (
        <div className="answer-form">
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note (optional)" />
          <div className="row answer-actions">
            {/* A note alone resumes the agent with it (the first choice), like pressing Resume. */}
            {text.trim() && (
              <button className="btn primary" disabled={busy} onClick={() => answer({ text: text.trim() })}>
                <Icon name="send" size={16} /> Send
              </button>
            )}
            {errorChoices(item).map((c, i) => (
              <button
                key={c}
                className={`btn ${i === 0 && !text.trim() ? 'primary' : c === 'Close the agent' ? 'quiet' : ''}`}
                disabled={busy}
                onClick={() => (c !== 'Close the agent' || confirm(`Close ${who}? Its history stays.`)) && answer({ choice: c, text: text.trim() || undefined, ...(appliesToAll(c) && all && (item.payload.limit_peers ?? 0) > 1 ? { all: true } : {}) })}
              >
                {c}
              </button>
            ))}
            {ask}
            {dismiss}
          </div>
          <LimitAll r={item} all={all} setAll={setAll} />
        </div>
      )}
      {!open && item.kind === 'agent_error' && <ScheduledResume agentId={item.agent_id} text={item.payload.resumes_text} />}

      {open && item.kind === 'structure' && (
        <div className="answer-form">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Note for ${who} (optional)`} />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => answer({ choice: 'Approve', text: text.trim() || undefined })}>
              Approve
            </button>
            <button className="btn danger" disabled={busy} onClick={() => answer({ choice: 'Deny', text: text.trim() || undefined })}>
              Deny
            </button>
          </div>
        </div>
      )}

      {open && item.kind === 'permission' && (
        <div className="answer-form">
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Why deny? (optional)" />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => answer({ choice: 'Allow' })}>
              Allow once
            </button>
            {item.payload.canAlways && (
              <button className="btn" disabled={busy} onClick={() => answer({ choice: 'Always allow' })}>
                Always allow
              </button>
            )}
            <button className="btn danger" disabled={busy} onClick={() => answer({ choice: 'Deny', text: text.trim() || undefined })}>
              Deny
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

/**
 * A to-do's steps, with a Copy button on each code block (commands are meant to be pasted), and what the agent will
 * do once it is done. Copy falls back to selecting the text where the clipboard API is not offered (plain http).
 */
function ActionSteps({ item, who }: { item: InboxItem; who: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const steps = item.payload.steps ?? '';
  useEffect(() => {
    for (const pre of ref.current?.querySelectorAll('pre') ?? []) {
      if (pre.parentElement?.classList.contains('copy-wrap')) continue;
      const wrap = document.createElement('div');
      wrap.className = 'copy-wrap';
      pre.replaceWith(wrap);
      wrap.append(pre);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small copy-code';
      b.textContent = 'Copy';
      const said = (t: string) => {
        b.textContent = t;
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      };
      b.onclick = () => {
        const text = pre.textContent ?? '';
        if (navigator.clipboard) return void navigator.clipboard.writeText(text).then(() => said('Copied'), () => said('Select and copy'));
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        said(document.execCommand('copy') ? 'Copied' : 'Selected');
      };
      wrap.append(b);
    }
  }, [steps]);
  if (!steps && !item.payload.after) return null;
  return (
    <div className="action-steps">
      {steps && (
        <div ref={ref}>
          <span className="label">Steps</span>
          <Markdown text={steps} />
        </div>
      )}
      {item.payload.after && (
        <p className="small">
          <span className="label">Once it is done</span> {who}: {item.payload.after}
        </p>
      )}
    </div>
  );
}

/** What the agent attached to a request: comparisons and guides in full, other kinds as gallery tiles. */
function AttachedPreviews({ item }: { item: InboxItem }) {
  const inline = item.previews.filter((p) => INLINE_KINDS.includes(p.kind));
  const tiles = item.previews.filter((p) => !INLINE_KINDS.includes(p.kind));
  return (
    <div className="attached">
      {inline.map((p) => (
        <section key={p.id} className="attached-preview">
          <h4>{p.title}</h4>
          <PreviewBody p={p} />
          {p.caption && <Markdown className="small" text={p.caption} />}
        </section>
      ))}
      {tiles.length > 0 && (
        <div className="preview-strip">
          {tiles.map((p) => (
            <PreviewTile key={p.id} p={p} onOpen={() => openPreview(item.project_id, p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** When a deferred request's reminder comes, in words. */
export const reminderText = (r: { due_text: string | null; due_at: number | null }) => (r.due_text ? `Reminds you ${r.due_text}` : r.due_at ? `Reminds you ${dayTime(r.due_at)}` : 'Reminds you later');

/**
 * A request answered "not now" (server/reminders.ts): one line saying when Helm asks again, with a control to change it
 * (next session, in 1 hour, tomorrow) or not be reminded.
 */
export function ReminderLine({ r, title }: { r: { id: string; due_text: string | null; due_at: number | null }; title?: React.ReactNode }) {
  const { busy, error, run } = useAction();
  const set = (when: string) => run(() => api(`/api/reminders/${r.id}`, { body: { when } }));
  return (
    <div className="reminder-line small">
      {title}
      <span className="muted">
        <Icon name="clock" size={16} /> {reminderText(r)}
      </span>
      <select aria-label="Change when to be reminded" value="" disabled={busy} onChange={(e) => e.target.value && void set(e.target.value)}>
        <option value="">Change</option>
        <option value="session">Next session</option>
        <option value="hour">In 1 hour</option>
        <option value="tomorrow">Tomorrow</option>
        <option value="never">Don't remind</option>
      </select>
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

/** What became of a handled request, in words: who decided what. */
export function outcomeText(item: InboxItem): string {
  const [choice, ...rest] = item.answer.split(' — ');
  const note = rest.length ? `: ${rest.join(' — ')}` : '';
  if (item.status === 'dismissed' && /^(Withdrawn|Agent closed)/.test(item.answer)) return item.answer;
  if (item.status === 'dismissed') return item.answer && item.answer !== 'Dismissed' ? `Dismissed: ${item.answer}` : 'Dismissed by you';
  if (item.kind === 'permission') {
    if (item.decided_by === 'auto') return 'Allowed automatically: the project is Unrestricted and this was not on the dangerous list';
    if (item.decided_by === 'director' || item.decided_by === 'check') {
      const verb = choice === 'Always allow' ? 'Always allowed' : choice === 'Allow' ? 'Allowed' : choice === 'Deny' ? 'Denied' : choice;
      return `${verb} by ${item.decided_by === 'check' ? 'the independent check' : 'Director'}${item.decision_reason ? `: ${item.decision_reason}` : ''}`;
    }
    const label = choice === 'Always allow' ? 'Always allowed by you' : choice === 'Allow' ? 'Allowed once by you' : choice === 'Deny' ? 'Denied by you' : choice;
    return label + note;
  }
  if (item.kind === 'structure') return `${choice} by you${note}`;
  if (item.kind === 'agent_error') return `${choice === 'Resume' ? 'Resumed by you' : choice === 'Ask the director' ? 'Passed to the director by you' : choice === 'Close the agent' ? 'Closed by you' : choice}${note}`;
  if (item.kind === 'action') return `${choice === 'Done' ? 'Done, by you' : `${choice}, you said`}${note}`;
  return `You answered: ${item.answer}`;
}

/** A handled request in a thread: what was asked and, for permissions and team changes, the outcome and when. */
/** A body that only repeats the title (apart from trailing punctuation), as a to-do filed from a lead and steps has. */
const bare = (s: string) => s.trim().replace(/[\s.:;,!…]+$/, '').toLowerCase();
const sameAsTitle = (item: InboxItem) => !!item.body && bare(item.body) === bare(item.title);

export function RequestOutcome({ item, asker }: { item: InboxItem; asker?: string }) {
  const who = asker ?? item.agent_name ?? 'An agent';
  const good = item.status === 'answered' && /^(Allow|Always allow|Approved)/.test(item.answer) && !/not applied/.test(item.answer);
  return (
    <div className={`tl-card tl-question tl-req-${item.kind}`}>
      <span className="msg-meta">
        <Tag tone={kindTone(item.kind)}>{KIND_LABEL[item.kind]}</Tag> <b>{who}</b> {item.kind === 'agent_error' ? 'stopped with an error' : item.kind === 'permission' ? 'asked permission' : item.kind === 'structure' ? 'proposed' : item.kind === 'action' ? 'asked you to do' : 'asked'} · {clock(item.created_at)}
      </span>
      <strong className={item.kind === 'permission' ? 'req-perm-line' : ''}>{item.kind === 'permission' ? item.line : item.title}</strong>
      {(item.kind === 'question' || item.kind === 'action') && item.body && !sameAsTitle(item) && <Markdown text={item.body} />}
      {item.kind === 'action' && item.payload.steps && (
        <details className="tool-input">
          <summary>Steps</summary>
          <Markdown text={item.payload.steps} />
        </details>
      )}
      {item.kind === 'permission' && item.payload.danger && <p className="small danger-reason">{item.payload.danger}</p>}
      {item.kind === 'permission' && item.payload.input && (
        <details className="tool-input">
          <summary>{item.payload.toolName}</summary>
          <pre>{item.payload.input}</pre>
        </details>
      )}
      {item.kind === 'agent_error' && item.body && <p className="small">{item.body}</p>}
      <ErrorDetails r={item} />
      {item.kind === 'structure' && item.body && (
        <details className="tool-input">
          <summary>The proposed change</summary>
          <Markdown text={item.body} />
        </details>
      )}
      {item.kind === 'agent_error' && <ScheduledResume agentId={item.agent_id} text={item.payload.resumes_text} />}
      {item.reminder && <ReminderLine r={item.reminder} />}
      {item.status === 'withdrawn' && (
        <p className="req-outcome muted">
          Withdrawn: {item.answer}
          {item.answered_at && <span className="muted"> · {clock(item.answered_at)}</span>}
        </p>
      )}
      {item.kind !== 'question' && item.kind !== 'action' && item.status !== 'withdrawn' && (
        <p className={`req-outcome ${good ? 'good' : 'bad'}`}>
          {outcomeText(item)}
          {item.answered_at && <span className="muted"> · {clock(item.answered_at)}</span>}
        </p>
      )}
    </div>
  );
}
