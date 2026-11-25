import { useState } from 'react';
import { api, useLive } from './api';
import { Icon, Sheet, Tag, href, useAction } from './ui';
import { bytes } from './disk';
import { when } from './time';

/**
 * Test builds (server/testbuilds.ts): a task's build of the release recipe for the user to try, kept apart from
 * releases. On the test request (Download, Get link), on the task's page, and in the Releases page's Test builds view
 * with Download, Get link, Delete and Rebuild.
 */

export type TestBuild = {
  id: string;
  n: number;
  label: string;
  task: { id: string; title: string; state: string } | null;
  commit: string;
  state: 'ready' | 'waiting' | 'feedback' | 'superseded' | 'removed';
  made_by: string;
  created_at: number;
  feedback_at: number | null;
  removed_at: number | null;
  removed_why: string;
  flag: string;
  rebuild_asked_at: number | null;
  request: { id: string; status: string } | null;
  files: { id: string; name: string; file: string | null; url: string | null; bytes: number | null; sha256: string | null }[];
};

const STATE: Record<TestBuild['state'], [string, string]> = {
  ready: ['', 'Made'],
  waiting: ['tone-warning', 'Waiting for feedback'],
  feedback: ['st-done', 'Feedback given'],
  superseded: ['', 'Superseded'],
  removed: ['', 'Files removed'],
};
const size = (n: number | null) => (n == null ? '' : n < 1000 ? `${n} B` : bytes(n));

/** Each file with Download and Get link; nothing when the files are gone. */
export function TestBuildFiles({ b }: { b: TestBuild }) {
  const [linkFor, setLinkFor] = useState<TestBuild['files'][number] | null>(null);
  const files = b.files.filter((f) => f.url);
  if (!files.length) return null;
  return (
    <ul className="tb-files">
      {files.map((f) => (
        <li key={f.id} className="row">
          <span className="grow one-line">
            <strong>{f.name}</strong> <span className="muted small">{f.file} · {size(f.bytes)}</span>
          </span>
          <button className="btn small quiet" onClick={() => setLinkFor(f)}>
            Get link
          </button>
          <a className="btn small primary" href={f.url!} download={f.file ?? undefined}>
            <Icon name="download" size={16} /> Download
          </a>
        </li>
      ))}
      {linkFor && <TestLinkSheet buildId={b.id} file={linkFor} onClose={() => setLinkFor(null)} />}
    </ul>
  );
}

/** On a test request (inbox.tsx): the build it carries. */
export function RequestTestBuild({ id }: { id: string }) {
  const { data } = useLive<TestBuild>(`/api/test-builds/${id}`, (m) => m.type === 'project');
  if (!data) return null;
  return (
    <div className="tb-request">
      <span className="label">
        {data.label} · {data.commit.slice(0, 7)}
      </span>
      {data.state === 'removed' ? <p className="muted small">Its files were removed ({data.removed_why}).</p> : <TestBuildFiles b={data} />}
    </div>
  );
}

const DURATION_LABEL: Record<string, string> = { '15m': '15 minutes', '1h': '1 hour', '1d': '1 day', '7d': '7 days' };

function TestLinkSheet({ buildId, file, onClose }: { buildId: string; file: TestBuild['files'][number]; onClose: () => void }) {
  const [duration, setDuration] = useState('1h');
  const [made, setMade] = useState<{ url: string; expires_at: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const make = () =>
    run(async () => {
      const r = await api<{ path: string; expires_at: number }>(`/api/test-builds/${buildId}/links`, { body: { file: file.id, duration } });
      setMade({ url: `${location.origin}${r.path}`, expires_at: r.expires_at });
    });
  return (
    <Sheet title={`Download link: ${file.name}`} onClose={onClose}>
      {!made ? (
        <div className="form">
          <p className="small muted">Anyone with the link can download this, without signing in, until it expires or the build's files are removed.</p>
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
          <p className="small muted">Expires {when(made.expires_at)}. It is shown only now.</p>
          <button className="btn primary" onClick={() => void navigator.clipboard?.writeText(made.url).then(() => setCopied(true), () => {})}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </Sheet>
  );
}

/** One build as a card: its task, state, commit, files and Delete or Rebuild. */
function BuildCard({ b, pid, showTask = true }: { b: TestBuild; pid: string; showTask?: boolean }) {
  const { busy, error, run } = useAction();
  const [tone, label] = STATE[b.state];
  const total = b.files.reduce((n, f) => n + (f.url ? f.bytes ?? 0 : 0), 0);
  return (
    <li className="card tb-card">
      <div className="row wrap">
        <strong className="grow one-line">{showTask && b.task ? <a href={href('p', pid, 'tasks', b.task.id)}>{b.label}</a> : `Test build ${b.n}`}</strong>
        <Tag tone={tone}>{label}</Tag>
      </div>
      <p className="muted small">
        {b.commit.slice(0, 7)} · {when(b.created_at)}
        {total ? ` · ${size(total)}` : ''}
        {b.state === 'removed' ? ` · ${b.removed_why}` : ''}
      </p>
      {b.flag && <p className="small tb-flag">{b.flag}</p>}
      <TestBuildFiles b={b} />
      <div className="row wrap">
        {b.state !== 'removed' ? (
          <button className="btn small quiet" disabled={busy} onClick={() => confirm(`Delete the files of ${b.label}? Its record stays, with Rebuild.`) && void run(() => api(`/api/test-builds/${b.id}/files`, { method: 'DELETE' }))}>
            <Icon name="trash" size={16} /> Delete
          </button>
        ) : (
          <button className="btn small" disabled={busy || !!b.rebuild_asked_at} onClick={() => void run(() => api(`/api/test-builds/${b.id}/rebuild`, { method: 'POST' }))}>
            {b.rebuild_asked_at ? 'Rebuild asked' : 'Rebuild'}
          </button>
        )}
      </div>
      {error && <p className="error-text small">{error}</p>}
    </li>
  );
}

/** The Releases page's Test builds view: every build, by task, newest first. */
export function TestBuildsList({ pid }: { pid: string }) {
  const { data } = useLive<{ builds: TestBuild[]; keep_days: number }>(`/api/projects/${pid}/test-builds`, (m) => m.type === 'project' && m.projectId === pid);
  if (!data) return <div className="loading">Loading…</div>;
  if (!data.builds.length) return <p className="muted">No test builds yet. A task makes one when it asks you to try something on your machine.</p>;
  return (
    <>
      <p className="muted small">Files go {data.keep_days} {data.keep_days === 1 ? 'day' : 'days'} after your feedback once the task is quiet (Setup), while their commit can rebuild them.</p>
      <ul className="tb-list">
        {data.builds.map((b) => (
          <BuildCard key={b.id} b={b} pid={pid} />
        ))}
      </ul>
    </>
  );
}

/** On a task's page (in About): its own builds. */
export function TaskTestBuilds({ builds, pid }: { builds?: TestBuild[]; pid: string }) {
  if (!builds?.length) return null;
  return (
    <div className="task-tb">
      <span className="label">Test builds</span>
      <ul className="tb-list">
        {builds.map((b) => (
          <BuildCard key={b.id} b={b} pid={pid} showTask={false} />
        ))}
      </ul>
    </div>
  );
}
