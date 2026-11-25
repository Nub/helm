import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { needsAnswered } from './requests.ts';

/**
 * Requests about Spec edit cards (the director's propose_doc_edit, server/specdiscuss.ts). A question or to-do whose
 * payload.spec_cards lists proposal ids shows those cards inside the request (web/src/inbox.tsx), so Apply and Not
 * this are where the user answers. While any is open a to-do cannot be marked Done (answers.ts); deciding the last
 * one settles the request by itself, with what was decided as its answer. A newer proposal that supersedes a linked
 * one takes its place in the request; settling the discussion withdraws a request whose cards it closed.
 *
 * Linking happens when the request is filed (tools.ts ask_user): the ids passed in spec_cards, else proposal ids
 * written in its text, else for a to-do that asks to apply Spec edits, the open cards in its thread (or, naming
 * Spec cards or proposed edits outright, the project's).
 */

const IDS = /\bprop_[a-z0-9]+\b/gi;
const APPLY = /\bapply\b/i;
const ABOUT_CARDS = /\b(spec|cards?|propos(al|als|ed))\b/i;
const NAMES_CARDS = /\b(spec (edit )?cards?|proposed (spec )?edits?)\b/i;

const openIn = (where: string, ...args: unknown[]): string[] => all(`SELECT id FROM doc_proposals WHERE status = 'open' AND ${where} ORDER BY created_at`, ...args).map((r) => r.id);

/** The cards a new request is about. An explicit id that is not an open card on the project is an error. */
export function cardsFor(projectId: string, kind: string, home: Row | undefined, text: string, explicit?: string[]): { ids: string[] } | { error: string } {
  if (explicit?.length) {
    const ids = [...new Set(explicit)];
    for (const id of ids) {
      const p = get('SELECT status FROM doc_proposals WHERE id = ? AND project_id = ?', id, projectId);
      if (!p) return { error: `No Spec edit card ${id} on this project: pass the ids propose_doc_edit returned. Nothing was filed.` };
      if (p.status !== 'open') return { error: `Spec edit card ${id} is already ${p.status}: leave it out. Nothing was filed.` };
    }
    return { ids };
  }
  const named = [...new Set((text.match(IDS) ?? []).map((s) => s.toLowerCase()))];
  const mentioned = named.length ? openIn(`project_id = ? AND id IN (${named.map(() => '?').join(',')})`, projectId, ...named) : [];
  if (mentioned.length) return { ids: mentioned };
  if (kind !== 'action' || !APPLY.test(text) || !ABOUT_CARDS.test(text)) return { ids: [] };
  const here = home ? openIn('discussion_id = ?', home.id) : [];
  if (here.length) return { ids: here };
  return { ids: NAMES_CARDS.test(text) ? openIn('project_id = ?', projectId) : [] };
}

const cardsOf = (r: Row): string[] => {
  try {
    const ids = JSON.parse(r.payload || '{}').spec_cards;
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
};

/** How many of a request's cards are still open (0 when it has none). */
export function openCards(r: Row): number {
  const ids = cardsOf(r);
  if (!ids.length) return 0;
  return Number(get(`SELECT COUNT(*) AS n FROM doc_proposals WHERE status = 'open' AND id IN (${ids.map(() => '?').join(',')})`, ...ids)?.n ?? 0);
}

/** Open or held requests listing a card. */
const requestsWith = (propId: string): Row[] =>
  all("SELECT * FROM inbox WHERE status IN ('open', 'held') AND kind IN ('question', 'action') AND payload LIKE ?", `%"${propId}"%`).filter((r) => cardsOf(r).includes(propId));

/**
 * A card was applied, declined or closed: each request listing it whose cards are now all decided is settled, with
 * what became of them as its answer. Returns a line for the director's note ('' when nothing settled).
 */
export function settleCardRequests(propIds: string[]): string {
  const done: Row[] = [];
  for (const propId of propIds) {
    for (const r of requestsWith(propId)) {
      if (done.some((d) => d.id === r.id) || openCards(r) > 0) continue;
      const ids = cardsOf(r);
      const rows = all(`SELECT status FROM doc_proposals WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      const n = (s: string) => rows.filter((x) => x.status === s).length;
      const applied = n('applied');
      const declined = n('declined');
      const what = ids.length === 1 ? (applied ? 'applied' : 'declined') : [applied && `applied ${applied}`, declined && `declined ${declined}`].filter(Boolean).join(', ');
      tx(() => {
        if (!applied && !declined) run("UPDATE inbox SET status = 'withdrawn', answer = ?, answered_at = ? WHERE id = ?", 'Its Spec edit cards were closed.', now(), r.id);
        else run("UPDATE inbox SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?", `${r.kind === 'action' ? 'Done' : 'Decided'} — ${what} of the Spec edit card${ids.length === 1 ? '' : 's'}`, now(), r.id);
        needsAnswered(r.id);
        if (r.task_id) run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), r.task_id);
      });
      touchProject(r.project_id);
      done.push(r);
    }
  }
  return done.length ? ` This settled your request${done.length === 1 ? '' : 's'} ${done.map((r) => `"${r.title}" (${r.id})`).join(', ')}: no other answer to it follows.` : '';
}

/** A newer proposal superseded older ones: requests listing an older one list the newer one too. */
export function carryCards(olderIds: string[], newId: string) {
  for (const old of olderIds) {
    for (const r of requestsWith(old)) {
      const payload = JSON.parse(r.payload || '{}');
      if (payload.spec_cards.includes(newId)) continue;
      payload.spec_cards = [...payload.spec_cards, newId];
      run('UPDATE inbox SET payload = ? WHERE id = ?', JSON.stringify(payload), r.id);
    }
  }
}
