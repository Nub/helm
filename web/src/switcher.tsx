import { useEffect, useState } from 'react';
import { switcherMove, switcherPick } from './keys';
import type { KeyboardEvent } from 'react';
import type { ProjectSummary } from './api';
import { Icon, PlainRefs, Sheet, go, href } from './ui';
import { MODE_LABEL, holdsWork } from './projectmode';
import type { Mode } from './projectmode';

/**
 * The project switcher: the project name in the top bar opens it. A search field (focused; a few letters filter, Enter
 * opens the first match), one row per project (status dot, name, mode, requests waiting; a muted second line with its
 * progress and status line), and New project and Bring in an existing session at the bottom. A full-width sheet on a
 * phone. It replaces the All projects page: Helm opens on the last project opened on this device.
 */

const LAST = 'helm:last-project';
export const rememberProject = (id: string) => {
  try {
    localStorage.setItem(LAST, id);
  } catch {
    /* private mode: nothing remembered */
  }
};
export const lastProject = (): string | null => {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
};

/** How well `q` matches `name`: prefix, then a word start, then anywhere, then its letters in order; -1 for none. */
export function fuzzyScore(name: string, q: string): number {
  const n = name.toLowerCase();
  const s = q.trim().toLowerCase();
  if (!s) return 0;
  if (n.startsWith(s)) return 4;
  if (n.split(/[\s_\-./]+/).some((w) => w.startsWith(s))) return 3;
  if (n.includes(s)) return 2;
  let i = 0;
  for (const ch of n) if (ch === s[i]) i++;
  return i === s.length ? 1 : -1;
}

/** Open the switcher from anywhere (the top bar's name on a phone, the project row's name on desktop). */
let opener: (() => void) | null = null;
export const openSwitcher = () => opener?.();

/** Mounted once by the shell: the switcher when opened. */
export function SwitcherHost({ projects, current, onHandoff }: { projects: ProjectSummary[]; current?: string; onHandoff: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    opener = () => setOpen(true);
    return () => {
      opener = null;
    };
  }, []);
  return open ? <ProjectSwitcher projects={projects} current={current} onClose={() => setOpen(false)} onHandoff={onHandoff} /> : null;
}

/** The project's name as the button that opens the switcher. */
export function SwitcherButton({ name, className = '' }: { name: string; className?: string }) {
  return (
    <button type="button" className={`btn bare switcher-open ${className}`} onClick={openSwitcher} aria-haspopup="dialog" aria-label={`${name}: switch project`}>
      <strong className="one-line">{name}</strong>
      <Icon name="chevron" size={16} />
    </button>
  );
}

export function ProjectSwitcher({ projects, current, onClose, onHandoff }: { projects: ProjectSummary[]; current?: string; onClose: () => void; onHandoff: () => void }) {
  const [q, setQ] = useState('');
  // The global Home (overview.tsx): the open requests across every project, and a card per project.
  const openRequests = projects.filter((p) => !p.archived).reduce((n, p) => n + p.openInbox, 0);
  const pool = q.trim() ? projects : projects.filter((p) => !p.archived);
  const shown = pool
    .map((p, i) => ({ p, i, score: fuzzyScore(p.name, q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || Number(!!a.p.archived) - Number(!!b.p.archived) || a.i - b.i)
    .map((x) => x.p);
  const open = (id: string) => {
    onClose();
    go('p', id, 'overview');
  };
  // Down/Up move a highlight through All projects (0) and the list (1..); Enter opens it, or the first match if none.
  const [hl, setHl] = useState(-1);
  useEffect(() => setHl(-1), [q]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHl((h) => switcherMove(h, shown.length, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const pick = switcherPick(hl, shown.length);
      if (pick === 'all') {
        onClose();
        go('home');
      } else if (pick !== null) open(shown[pick].id);
    }
  };
  useEffect(() => {
    document.querySelector('.switcher .switcher-row.hl')?.scrollIntoView({ block: 'nearest' });
  }, [hl]);
  return (
    <Sheet title="Projects" onClose={onClose} className="switcher">
      <a className={`switcher-row switcher-all ${hl === 0 ? 'hl' : ''}`} href={href('home')} onClick={onClose}>
        <Icon name="home" />
        <span className="switcher-txt">
          <span className="switcher-name one-line">All projects</span>
          <span className="muted small one-line">Requests and every project at a glance</span>
        </span>
        {openRequests > 0 && <b className="badge">{openRequests}</b>}
      </a>
      <input className="switcher-find" type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Find a project" aria-label="Find a project" autoFocus enterKeyHint="go" />
      <ul className="switcher-list">
        {shown.map((p, i) => (
          <li key={p.id}>
            <a className={`switcher-row ${p.id === current ? 'on' : ''} ${hl === i + 1 ? 'hl' : ''}`} href={href('p', p.id, 'overview')} onClick={onClose}>
              <span className={`status-dot ${p.working ? 'dot-working pulse' : p.errored ? 'dot-error' : p.openInbox ? 'dot-waiting' : ''}`} />
              <span className="switcher-txt">
                <span className="switcher-name one-line">
                  {p.name}
                  {p.archived ? <span className="muted"> · archived</span> : null}
                </span>
                <span className="muted small one-line">
                  {p.progress !== null && `${p.progress}% · `}
                  {p.statusLine ? <PlainRefs text={p.statusLine} strip /> : p.working ? `${p.working} working` : p.queued ? 'Waiting' : 'Idle'}
                </span>
              </span>
              {holdsWork(p.mode) && (
                <span className={`tag mode-chip mode-${p.mode} mini`} title={MODE_LABEL[p.mode as Mode]}>
                  <span className="mode-dot" aria-hidden="true" />
                </span>
              )}
              {p.openInbox > 0 && <b className="badge">{p.openInbox}</b>}
            </a>
          </li>
        ))}
        {!shown.length && <li className="muted small switcher-none">No project matches.</li>}
      </ul>
      <div className="switcher-foot">
        <a className="switcher-row" href={href('new')} onClick={onClose}>
          <Icon name="plus" /> New project
        </a>
        <button
          className="switcher-row"
          onClick={() => {
            onClose();
            onHandoff();
          }}
        >
          <Icon name="external" /> Bring in an existing session
        </button>
      </div>
    </Sheet>
  );
}
