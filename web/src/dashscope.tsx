import type { TaskScope } from './api';
import { Markdown, Tag, href } from './ui';
import { Fold } from './fold';
import { when } from './time';

/**
 * On a task's page: the dashboard tiles Helm computed its work affected (server/tilescope.ts), what the agent did
 * about each, and the director's check of that scope.
 */
const STATUS: Record<string, [string, string]> = {
  pending: ['tone-warning', 'not answered'],
  refreshed: ['st-done', 'refreshed'],
  unaffected: ['', 'unaffected'],
  stale: ['tone-warning', 'left stale'],
  expensive: ['tone-warning', 'stale: for the director'],
  extra: ['tone-serious', 'refreshed, not affected'],
};

/** "3 tiles · 1 stale": what the collapsed card says, so nothing that needs a look hides in it. */
function summary(scope: TaskScope) {
  const n = scope.rows.length;
  if (!n) return 'No tile affected';
  const stale = scope.rows.filter((r) => r.status === 'stale' || r.status === 'expensive').length;
  const open = scope.rows.filter((r) => r.status === 'pending').length;
  return (
    <>
      {n} {n === 1 ? 'tile' : 'tiles'}
      {stale > 0 && <span className="scope-warn"> · {stale} stale</span>}
      {open > 0 && <span className="scope-warn"> · {open} not answered</span>}
    </>
  );
}

/** On a task's page, among the last cards and collapsed until opened (remembered on this device). */
export function TaskScopeBlock({ scope, pid }: { scope: TaskScope; pid: string }) {
  const review = scope.reviews[scope.reviews.length - 1];
  return (
    <Fold
      kind="task-scope"
      title="Dashboard tiles"
      note={summary(scope)}
      openByDefault={false}
      className="task-scope"
      label="Dashboard tiles"
      head={
        review ? (
          <Tag tone={review.decision === 'accept' ? 'st-done' : 'tone-warning'}>{review.decision === 'accept' ? 'Scope checked' : 'Sent back'}</Tag>
        ) : scope.rows.length ? (
          <Tag tone="tone-warning">Not checked yet</Tag>
        ) : null
      }
    >
      {scope.rows.length ? (
        <ul className="scope-rows">
          {scope.rows.map((r) => {
            const [tone, label] = STATUS[r.status] ?? ['', r.status];
            return (
              <li key={r.tile_id}>
                <div className="row wrap">
                  <a className="one-line" href={href('p', pid, 'dashboards', r.dashboard_id)}>
                    {r.tile}
                  </a>
                  <span className="muted small">{r.dashboard}</span>
                  <span className="spacer" />
                  <Tag tone={tone}>{label}</Tag>
                </div>
                {r.reason && <p className="small scope-reason">{r.reason}</p>}
                {(r.files.length > 0 || r.docs.length > 0) && (
                  <p className="muted small scope-files">
                    {r.files.slice(0, 4).map((f) => (
                      <code key={f}>{f}</code>
                    ))}
                    {r.files.length > 4 && <span> and {r.files.length - 4} more</span>}
                    {r.docs.map((d) => (d.startsWith('doc_') ? <Markdown key={d} className="inline-md" text={`[[${d}]]`} /> : <span key={d}>{d}</span>))}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted small">No tile was affected by this task.</p>
      )}
      {scope.reviews.map((rv, i) => (
        <p key={i} className="small scope-review">
          <strong>{rv.agent_name}</strong> {rv.decision === 'accept' ? 'accepted the scope' : 'sent tiles back'}, {when(rv.created_at)}
          {rv.note ? `: ${rv.note}` : '.'}
          {rv.changes.length > 0 && (
            <span className="muted">
              {' '}
              {rv.changes.join('; ')}.
            </span>
          )}
        </p>
      ))}
    </Fold>
  );
}
