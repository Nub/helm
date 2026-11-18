import { useEffect, useRef, useState } from 'react';
import type { InboxItem } from './api';
import { AttachButton, AttachTray, dropTarget, pasteInto, useAttachDraft } from './attachments';
import { ACTION_CHOICES, KIND_LABEL, WantsMark, answerRequest, kindTone, wantsWhat } from './needs';
import { INLINE_KINDS, PreviewBody, PreviewTile } from './preview';
import { Icon, Importance, Markdown, Tag, ago, clock, go, href, useAction } from './ui';

/**
 * A request to the user (an agent's question, a permission request, a team change to approve) as a full card
 * with its answer controls: shown in the thread of the task or discussion it belongs to, and on the agent's page.
 */

/** hidePreviews: shown above it already (a pinned proposal's items). */
export function InboxCard({ item, agentName, showProject = false, hidePreviews = false }: { item: InboxItem; agentName?: string; showProject?: boolean; hidePreviews?: boolean }) {
  const [choice, setChoice] = useState('');
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const who = agentName ?? item.agent_name ?? 'An agent';
  // Waiting on the director or the independent check: still answerable by the user, first answer wins.
  const deciding = item.status === 'director' || item.status === 'check';
  const open = item.status === 'open' || deciding;
  // A question's answer can carry files: picker, paste into the box, or drop on the form (as in the composer).
  const action = item.kind === 'action';
  const question = open && (item.kind === 'question' || action);
  const draft = useAttachDraft(question ? item.project_id : undefined, `request:${item.id}`);
  const [over, setOver] = useState(false);
  const files = draft.ready.map((a) => a.id);
  const answer = (body: { choice?: string; text?: string; dismiss?: boolean }) =>
    run(async () => {
      await answerRequest(item.id, files.length && !body.dismiss ? { ...body, attachments: files } : body);
      draft.clear();
    });
  // Asked for a file: Attach leads, and the text box waits until the user chooses to answer in words.
  const wants = !!wantsWhat(item);
  const [inWords, setInWords] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const showBox = !wants || inWords || draft.items.length > 0 || !!text || !!choice;

  return (
    <article className={`card inbox-card ${open ? '' : 'handled'} ${open && item.blocking ? 'blocking' : ''}`}>
      <header className="inbox-meta">
        <Tag tone={kindTone(item.kind)}>{KIND_LABEL[item.kind]}</Tag>
        {open && !!item.blocking && <Tag tone="tone-warning">Blocking {who}</Tag>}
        {(item.kind === 'question' || action) && <Importance value={item.importance} />}
        <WantsMark r={item} />
        <span className="spacer" />
        <span className="muted small">{ago(item.created_at)}</span>
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
      <p className="muted small">
        {showProject && item.project_name && (
          <>
            <a href={href('p', item.project_id, 'tasks', 'needs')}>{item.project_name}</a> ·{' '}
          </>
        )}
        from {item.agent_id ? <a href={href('p', item.project_id, 'agents', item.agent_id)}>{who}</a> : who}
        {item.task_id && item.task_title && (
          <>
            {' · task '}
            <a href={href('p', item.project_id, 'tasks', item.task_id)}>{item.task_title}</a>
          </>
        )}
      </p>
      {item.body && !sameAsTitle(item) && <Markdown text={item.body} />}
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
      {item.previews?.length > 0 && !hidePreviews &&
        (open ? (
          <AttachedPreviews item={item} />
        ) : (
          <details className="attached-closed">
            <summary>Attached previews ({item.previews.length})</summary>
            <AttachedPreviews item={item} />
          </details>
        ))}

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

      {action && <ActionSteps item={item} who={who} />}

      {question && action && (
        <div className={`answer-form ${over ? 'drop-over' : ''}`} {...dropTarget(draft, setOver)}>
          <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} onPaste={pasteInto(draft)} placeholder="Add a note (optional)" />
          <AttachTray items={draft.items} onRemove={draft.drop} />
          <div className="row answer-actions">
            <button className="btn primary" disabled={busy || draft.uploading} onClick={() => answer({ choice: 'Done', text: text.trim() || undefined })}>
              <Icon name="check" size={15} /> {draft.uploading ? 'Uploading' : 'Done'}
            </button>
            <button className="btn" disabled={busy || draft.uploading} onClick={() => answer({ choice: ACTION_CHOICES[1], text: text.trim() || undefined })}>
              {ACTION_CHOICES[1]}
            </button>
            <AttachButton draft={draft} className="icon-btn answer-clip" label={draft.items.length ? 'Attach more' : 'Attach photos or files'} />
            <button className="btn quiet" disabled={busy} onClick={() => answer({ dismiss: true })}>
              Dismiss
            </button>
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
            <button className="btn quiet" disabled={busy} onClick={() => answer({ dismiss: true })}>
              Dismiss
            </button>
          </div>
        </div>
      )}

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
      b.className = 'btn copy-btn';
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
            <PreviewTile key={p.id} p={p} onOpen={() => go('p', item.project_id, 'previews', p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** What became of a handled request, in words: who decided what. */
export function outcomeText(item: InboxItem): string {
  const [choice, ...rest] = item.answer.split(' — ');
  const note = rest.length ? `: ${rest.join(' — ')}` : '';
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
        <Tag tone={kindTone(item.kind)}>{KIND_LABEL[item.kind]}</Tag> <b>{who}</b> {item.kind === 'permission' ? 'asked permission' : item.kind === 'structure' ? 'proposed' : item.kind === 'action' ? 'asked you to do' : 'asked'} · {clock(item.created_at)}
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
      {item.kind === 'structure' && item.body && (
        <details className="tool-input">
          <summary>The proposed change</summary>
          <Markdown text={item.body} />
        </details>
      )}
      {item.kind !== 'question' && item.kind !== 'action' && (
        <p className={`req-outcome ${good ? 'good' : 'bad'}`}>
          {outcomeText(item)}
          {item.answered_at && <span className="muted"> · {clock(item.answered_at)}</span>}
        </p>
      )}
    </div>
  );
}
