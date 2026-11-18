import { useRef, useState } from 'react';
import { api, useLive } from './api';
import type { ProjectState } from './api';
import { Sheet, href, useAction } from './ui';

/** Moving a session from another tool into Helm. The prompt text lives in the server (server/handoff.ts). */
type HandoffInfo = { prompt: string; otherMachineLine: string; hostname: string; message: string };

/**
 * Copies the exact text. Where the clipboard API is missing or refused (plain http on the LAN is not a secure
 * context), copies it from a hidden textarea, and failing that selects the shown block for the user to copy.
 */
async function copyText(text: string, block: HTMLElement | null): Promise<'copied' | 'selected'> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return 'copied';
    }
  } catch {
    // Fall through.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    // Fall through.
  }
  area.remove();
  if (ok) return 'copied';
  if (!block) return 'selected';
  const range = document.createRange();
  range.selectNodeContents(block);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  return 'selected';
}

/**
 * The prompt is hard-wrapped at about 85 columns, which reflows into ragged lines on a phone. For display, the
 * wrapped lines of each paragraph or list item are joined and list items get a hanging indent; Copy copies the text
 * as it is.
 */
function reflow(text: string): { indent: number; hang: number; text: string }[] {
  const out: { indent: number; hang: number; text: string }[] = [];
  for (const raw of text.split('\n')) {
    const body = raw.trimStart();
    const indent = raw.length - body.length;
    const marker = /^(- |\d+\. |#+ )/.exec(body)?.[0] ?? '';
    const prev = out[out.length - 1];
    if (body && prev?.text && !marker && !prev.text.startsWith('#')) prev.text += ' ' + body;
    else out.push({ indent, hang: marker.startsWith('#') ? 0 : marker.length, text: body });
  }
  return out;
}

/** The explanation, the prompt with Copy, the different-machine toggle and what happens next. */
export function HandoffPrompt() {
  const { data } = useLive<HandoffInfo>('/api/handoff', () => false);
  const [elsewhere, setElsewhere] = useState(false);
  const [copied, setCopied] = useState<'' | 'copied' | 'selected'>('');
  const block = useRef<HTMLPreElement>(null);
  if (!data) return <div className="loading">Loading…</div>;
  const text = elsewhere ? `${data.prompt}\n\n${data.otherMachineLine}` : data.prompt;
  const copy = async () => {
    setCopied(await copyText(text, block.current));
    setTimeout(() => setCopied(''), 2500);
  };
  return (
    <div className="handoff">
      <p>
        If an agent in another tool has been working on a project, paste this prompt into that session first. It makes the agent leave the repository clean and write
        everything the director needs into a <span className="mono">HANDOFF.md</span> file at its root.
      </p>
      <div className="handoff-bar">
        <label className="handoff-toggle">
          <input type="checkbox" checked={elsewhere} onChange={(e) => setElsewhere(e.target.checked)} />
          The old session is on a different machine
        </label>
        <button type="button" className="btn small primary" onClick={copy}>
          {copied === 'copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copied === 'selected' && <p className="small muted">This browser would not copy by itself. The prompt is selected: copy it from there.</p>}
      <pre ref={block} className="handoff-prompt" tabIndex={0} aria-label="Handoff prompt">
        {reflow(text).map((l, i) =>
          l.text ? (
            <span key={i} style={{ paddingLeft: `${l.indent + l.hang}ch`, textIndent: `-${l.hang}ch` }}>
              {l.text}
            </span>
          ) : (
            <span key={i} aria-hidden="true" className="handoff-gap" />
          ),
        )}
      </pre>
      <ol className="handoff-steps">
        <li>Paste the prompt into the old session and let it finish.</li>
        <li>
          When it has committed <span className="mono">HANDOFF.md</span>, come back here and open that folder as an <strong>Existing folder</strong>
          {elsewhere ? <> (once the repository is on {data.hostname})</> : null}, or <strong>Clone</strong> the repository.
        </li>
        <li>The project's home then offers to have the director read the handoff. It sets up the Spec, tasks and discussions and asks you what is unclear before starting work.</li>
      </ol>
    </div>
  );
}

export function HandoffSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Bring in an existing session" onClose={onClose}>
      <HandoffPrompt />
      <p>
        <a className="btn" href={href('new')} onClick={onClose}>
          New project
        </a>
      </p>
    </Sheet>
  );
}

/** On the Overview while the project's HANDOFF.md has not been sent to the director or dismissed (again once it changes). */
export function HandoffCard({ s }: { s: ProjectState }) {
  const { busy, error, run } = useAction();
  const h = s.handoff;
  if (!h?.file || !h.offer) return null;
  const act = (action: 'send' | 'dismiss') => run(() => api(`/api/projects/${s.project.id}/handoff`, { body: { action } }));
  return (
    <div className="handoff-card" role="region" aria-label="Handoff file">
      <strong>{h.offer === 'updated' ? 'The handoff file has been updated' : 'This project has a handoff file from a previous session'}</strong>
      <span className="small muted">
        <span className="mono">{h.file.name}</span> at the root of the project folder. The director reads it, sets up the Spec, tasks and discussions, and asks you about anything unclear
        before starting work.
      </span>
      <div className="row wrap">
        <button className="btn small primary" disabled={busy} onClick={() => act('send')}>
          Have the director read it
        </button>
        <button className="btn small quiet" disabled={busy} onClick={() => act('dismiss')}>
          Dismiss
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
