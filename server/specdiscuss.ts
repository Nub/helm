import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { addTaskMessage, getTask, isDiscussion, taskRef } from './tasks.ts';
import type { Author } from './tasks.ts';
import { createDiscussion } from './discussions.ts';
import { ensureSectionPath, getDoc, linkDoc, normTags, parseTags, resolveSection, saveDoc } from './spec.ts';
import { pathText, sectionTree } from './sections.ts';
import type { DocInput, Editor } from './spec.ts';

/**
 * Discussing a Spec entry with the director. "Discuss" on an entry opens the one open discussion about it (doc_links
 * relation 'discusses'), or starts one whose first item quotes the entry as it was then. In it the director proposes
 * edits with propose_doc_edit; a proposal never changes the entry. The owner applies one (the same path as an owner
 * edit: a revision linked to the discussion as 'changed', and unless "wording only" the planning flow in spec.ts) or
 * declines it. A newer proposal for the same entry supersedes older open ones; settling the discussion closes the rest.
 *
 * Staleness: a proposal records the entry's values of the fields it changes. If any of those fields has changed since,
 * Apply is refused and the card says what changed underneath; the owner asks for a fresh proposal. Changes to fields
 * the proposal does not touch do not block it (it only writes its own fields).
 */

const HELM: Author = { author: 'system', name: 'Helm' };
const OWNER: Editor = { author: 'user', name: 'You' };

export const FIELDS = ['title', 'summary', 'body', 'tags', 'section'] as const;
export type Field = (typeof FIELDS)[number];
export type Fields = {
  title: string;
  summary: string;
  body: string;
  tags: string[];
  section: string;
};
const FIELD_NAME: Record<Field, string> = {
  title: 'title',
  summary: 'summary',
  body: 'text',
  tags: 'tags',
  section: 'section',
};

/** The proposable fields of an entry as they are now; section by its path, "Combat / Weapons" ('' for none). */
export function entryFields(doc: Row): Fields {
  const section = doc.section_id ? pathText(sectionTree(doc.project_id), doc.section_id) : '';
  return {
    title: doc.title ?? '',
    summary: doc.summary ?? '',
    body: doc.body ?? '',
    tags: parseTags(doc.tags),
    section,
  };
}

const same = (f: Field, a: unknown, b: unknown) => (f === 'tags' ? JSON.stringify(a ?? []) === JSON.stringify(b ?? []) : String(a ?? '') === String(b ?? ''));

/** The open discussion about an entry, if any (the newest when there are several). */
export function openSpecDiscussion(docId: string): Row | undefined {
  return get(
    "SELECT t.* FROM doc_links l JOIN tasks t ON t.id = l.task_id WHERE l.doc_id = ? AND l.relation = 'discusses' AND t.kind = 'discussion' AND t.state = 'open' ORDER BY l.id DESC LIMIT 1",
    docId,
  );
}

/** The entry a discussion is about, if it is one (the most recently linked). */
export function entryOfDiscussion(taskId: string): Row | undefined {
  return get("SELECT d.* FROM doc_links l JOIN docs d ON d.id = l.doc_id WHERE l.task_id = ? AND l.relation = 'discusses' ORDER BY l.id DESC LIMIT 1", taskId);
}

/** The planning task now open for an entry's change, if any: the conversation about the entry while it lasts. */
export function openPlanTask(doc: Row): Row | undefined {
  const t = doc.plan_task_id ? getTask(doc.plan_task_id) : undefined;
  return t && t.kind === 'task' && t.state === 'planning' ? t : undefined;
}

/** Whether a task is the planning task for an entry (Planning, and planning this entry or linked to it). */
function plansEntry(t: Row, doc: Row): boolean {
  if (t.kind !== 'task' || t.state !== 'planning') return false;
  return doc.plan_task_id === t.id || !!get("SELECT 1 AS x FROM doc_links WHERE task_id = ? AND doc_id = ? AND relation IN ('implements', 'changed')", t.id, doc.id);
}

/**
 * Open the conversation about an entry: its open planning task (the discussion about it became that task, or the
 * change is being planned there), else the open discussion, else a new one starting with a snapshot of the entry.
 */
export function startSpecDiscussion(doc: Row): {
  discussion: Row;
  created: boolean;
} {
  const plan = openPlanTask(doc);
  if (plan) return { discussion: plan, created: false };
  const open = openSpecDiscussion(doc.id);
  if (open) return { discussion: open, created: false };
  const discussion = tx(() => {
    const d = createDiscussion(
      doc.project_id,
      {
        title: `Spec: ${doc.title}`.slice(0, 140),
        summary: '',
        origin: 'user',
      },
      { author: 'user', name: 'You' },
    );
    linkDoc(doc.id, d.id, 'discusses');
    // Quoted as it is now, so the thread still reads right after the entry changes.
    addTaskMessage(
      d,
      HELM,
      JSON.stringify({
        intro: 'You opened this discussion about the Spec entry. It read:',
        doc_id: doc.id,
        ...entryFields(doc),
      }),
      'spec',
    );
    return getTask(d.id)!;
  });
  touchProject(doc.project_id);
  return { discussion, created: true };
}

/** The entry as text for the director. */
function entryText(doc: Row): string {
  const f = entryFields(doc);
  return [
    `Title: ${f.title}`,
    `Summary: ${f.summary || '(none)'}`,
    `Section: ${f.section || '(none)'} · Tags: ${f.tags.length ? f.tags.join(', ') : '(none)'}`,
    `Text:\n${f.body.trim() || '(empty)'}`,
  ].join('\n');
}

/**
 * What a message in a discussion about an entry carries to the director: a spec-entry attribute on every message and,
 * with the user's first message, what the discussion is for and the entry's current text. The conversation panel
 * shows only the user's words (web/src/project.tsx cuts at "\n\n<spec-entry").
 */
export function specMessageExtras(d: Row): { attrs: string; context: string } {
  if (!isDiscussion(d)) return { attrs: '', context: '' };
  const doc = entryOfDiscussion(d.id);
  if (!doc) return { attrs: '', context: '' };
  const first = Number(get("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND author = 'user' AND kind = 'message'", d.id)?.n ?? 0) <= 1;
  const attrs = ` spec-entry="${doc.id}"${first ? ' new="true"' : ''}`;
  if (!first) return { attrs, context: '' };
  const context =
    `\n\n<spec-entry id="${doc.id}">\n` +
    `This is a discussion about improving or changing the Spec entry "${doc.title}" (id ${doc.id}). Work with the user on it. ` +
    `Propose concrete edits with propose_doc_edit (entry ${doc.id}, discussion ${d.id}) rather than editing the entry yourself: the user applies or declines each proposal on a card in this thread. ` +
    `Do not start any work on it. Answer in the thread with task_post; give the discussion a one-line summary with update_discussion.\n\n` +
    `The entry now:\n${entryText(doc)}\n</spec-entry>`;
  return { attrs, context };
}

// ---------- proposals ----------

export type ProposalInput = {
  title?: string;
  summary?: string;
  body?: string;
  tags?: string[];
  section?: string;
  rationale: string;
};

/** The director proposes an edit. Returns the text for the tool result. */
export function proposeEdit(agent: Row, docRef: string, discRef: string, input: ProposalInput): { error: string } | { text: string; id: string } {
  const doc = get('SELECT * FROM docs WHERE id = ? AND project_id = ?', docRef, agent.project_id);
  if (!doc)
    return {
      error: `No Spec entry with id ${docRef} on this project. list_docs shows them.`,
    };
  const d = getTask(discRef);
  if (!d || d.project_id !== agent.project_id)
    return {
      error: `No discussion "${discRef}" on this project. list_discussions shows them.`,
    };
  if (!isDiscussion(d) && !plansEntry(d, doc))
    return {
      error: `Cannot propose in ${taskRef(d)}: it is a task that is not in Planning for this entry. Propose Spec edits in a discussion about the entry, or in the entry's planning task while it is in Planning.`,
    };
  if (isDiscussion(d) && d.state !== 'open')
    return {
      error: `Cannot propose in ${taskRef(d)}: it is settled. Reopen it (update_discussion state open) or propose in an open discussion about the entry.`,
    };
  const now_ = entryFields(doc);
  const wanted: Partial<Fields> = {};
  if (input.title !== undefined) wanted.title = input.title.trim();
  if (input.summary !== undefined) wanted.summary = input.summary.trim();
  if (input.body !== undefined) wanted.body = input.body;
  if (input.tags !== undefined) wanted.tags = normTags(input.tags);
  if (input.section !== undefined) {
    wanted.section = input.section.trim();
    // A name or the end of a path that names the entry's own section is no change; an ambiguous one is refused now.
    const r = wanted.section ? resolveSection(doc.project_id, wanted.section) : null;
    if (r && 'section' in r && r.section.id === doc.section_id) wanted.section = now_.section;
    else if (r && 'error' in r && !r.missing) return { error: r.error };
  }
  if (wanted.title === '') return { error: 'The title cannot be empty.' };
  const changes: Partial<Fields> = {};
  const base: Partial<Fields> = {};
  for (const f of FIELDS) {
    if (wanted[f] === undefined || same(f, wanted[f], now_[f])) continue;
    (changes as any)[f] = wanted[f];
    (base as any)[f] = now_[f];
  }
  if (!Object.keys(changes).length)
    return {
      error: 'That is what the entry already says: nothing to propose. Pass only the fields you want changed, with their new text.',
    };
  const id = newId('prop');
  const superseded = tx(() => {
    const older = all("SELECT id FROM doc_proposals WHERE doc_id = ? AND status = 'open'", doc.id);
    run("UPDATE doc_proposals SET status = 'superseded', decided_at = ? WHERE doc_id = ? AND status = 'open'", now(), doc.id);
    run(
      'INSERT INTO doc_proposals (id, project_id, doc_id, discussion_id, agent_id, author_name, changes, base, rationale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      doc.project_id,
      doc.id,
      d.id,
      agent.id,
      agent.name,
      JSON.stringify(changes),
      JSON.stringify(base),
      input.rationale.trim(),
      now(),
    );
    if (isDiscussion(d)) linkDoc(doc.id, d.id, 'discusses');
    addTaskMessage(d, { author: 'director', name: agent.name }, JSON.stringify({ id }), 'proposal');
    return older.length;
  });
  touchProject(doc.project_id);
  const what = Object.keys(changes)
    .map((f) => FIELD_NAME[f as Field])
    .join(', ');
  return {
    id,
    text:
      `Posted proposal ${id} (${what} of "${doc.title}") as a card in ${taskRef(d)}${superseded ? `; it supersedes ${superseded} earlier open proposal(s) for this entry` : ''}. ` +
      `The entry is unchanged until the user applies it; you will get a note when they apply or decline it. Do not also make the edit with set_doc.`,
  };
}

const parse = (s: string): Partial<Fields> => {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
};

/** Fields whose value in the entry is no longer what the proposal was based on. */
export function staleFields(p: Row, doc: Row | undefined): Field[] {
  if (!doc) return [];
  const base = parse(p.base);
  const cur = entryFields(doc);
  return (Object.keys(base) as Field[]).filter((f) => !same(f, base[f], cur[f]));
}

const show = (f: Field, v: unknown) => (f === 'tags' ? ((v as string[]) ?? []).join(', ') : String(v ?? ''));

/** A proposal for the dashboard card. */
export function proposalView(p: Row): Row {
  const doc = getDoc(p.doc_id);
  const changes = parse(p.changes);
  const base = parse(p.base);
  const cur = doc ? entryFields(doc) : null;
  const stale = p.status === 'open' ? staleFields(p, doc) : [];
  return {
    id: p.id,
    doc_id: p.doc_id,
    doc_title: doc?.title ?? base.title ?? '',
    doc_exists: !!doc,
    discussion_id: p.discussion_id,
    author_name: p.author_name,
    rationale: p.rationale,
    status: p.status,
    wording_only: !!p.wording_only,
    note: p.note,
    created_at: p.created_at,
    decided_at: p.decided_at,
    fields: (Object.keys(changes) as Field[]).map((f) => ({
      field: f,
      before: show(f, base[f]),
      after: show(f, changes[f]),
    })),
    // What changed underneath: the field as proposed against, and as it is now.
    stale: stale.map((f) => ({
      field: f,
      was: show(f, base[f]),
      now: show(f, cur?.[f]),
    })),
  };
}

export function getProposal(id: string): Row | undefined {
  return get('SELECT * FROM doc_proposals WHERE id = ?', id);
}

const STATUS_WORD: Record<string, string> = {
  applied: 'already applied',
  declined: 'declined',
  superseded: 'superseded by a newer proposal',
  closed: 'closed: its discussion was settled',
};

/** The owner applies a proposal. Returns a note for the director. */
export function applyProposal(p: Row, wordingOnly: boolean): { error: string; code?: number } | { note: string; pending: boolean } {
  if (p.status !== 'open')
    return {
      error: `This proposal is ${STATUS_WORD[p.status] ?? p.status}.`,
      code: 409,
    };
  const doc = getDoc(p.doc_id);
  if (!doc) return { error: 'The entry has been removed.', code: 409 };
  const stale = staleFields(p, doc);
  if (stale.length) {
    return {
      error: `The entry's ${stale.map((f) => FIELD_NAME[f]).join(' and ')} changed since this was proposed, so it no longer applies cleanly. Ask for a fresh proposal, or decline this one.`,
      code: 409,
    };
  }
  const d = getTask(p.discussion_id);
  const changes = parse(p.changes);
  const input: DocInput = {};
  if (changes.title !== undefined) input.title = changes.title;
  if (changes.summary !== undefined) input.summary = changes.summary;
  if (changes.body !== undefined) input.body = changes.body;
  if (changes.tags !== undefined) input.tags = changes.tags;
  if (changes.section !== undefined) {
    const r = changes.section ? ensureSectionPath(doc.project_id, changes.section) : null;
    if (r && 'error' in r) return { error: r.error, code: 409 };
    input.section_id = r ? r.id : null;
  }
  const out = tx(() => {
    // The owner's edit: a revision linked to the discussion as 'changed', and unless wording only, the planning flow.
    const res = saveDoc(doc.project_id, doc, input, OWNER, wordingOnly, d?.id ?? null);
    if ('error' in res) return res;
    const rev = get('SELECT MAX(id) AS id FROM doc_revisions WHERE doc_id = ?', doc.id)?.id ?? null;
    run("UPDATE doc_proposals SET status = 'applied', wording_only = ?, revision_id = ?, decided_at = ? WHERE id = ?", wordingOnly ? 1 : 0, rev, now(), p.id);
    if (d) {
      addTaskMessage(
        d,
        HELM,
        `You applied the proposed edit to "${doc.title}"${wordingOnly ? ' as wording only: no planning task.' : res.pending ? (d.kind === 'task' ? '. After a quiet moment the change is added to this planning task.' : '. After a quiet moment this discussion becomes the planning task for it.') : '.'}`,
        'state',
      );
    }
    return res;
  });
  if ('error' in out) return { error: out.error };
  touchProject(doc.project_id);
  const where = d ? ` in ${taskRef(d)}` : '';
  return {
    pending: out.pending,
    note: wordingOnly
      ? `The user applied your proposed edit ${p.id} to the Spec entry "${doc.title}" (id ${doc.id})${where} as wording only: the entry now reads as proposed, and no planning task follows.`
      : `The user applied your proposed edit ${p.id} to the Spec entry "${doc.title}" (id ${doc.id})${where}. It counts as the user's edit: after the quiet period Helm ${d?.kind === 'task' ? 'adds the change to that planning task' : 'turns the discussion into the planning task for it, in place'} and tells you. Do not start work before then.`,
  };
}

/** The owner declines a proposal, with an optional note. Returns a note for the director. */
export function declineProposal(p: Row, note: string): { error: string; code?: number } | { note: string } {
  if (p.status !== 'open')
    return {
      error: `This proposal is ${STATUS_WORD[p.status] ?? p.status}.`,
      code: 409,
    };
  const doc = getDoc(p.doc_id);
  const d = getTask(p.discussion_id);
  const title = doc?.title ?? parse(p.base).title ?? 'the entry';
  tx(() => {
    run("UPDATE doc_proposals SET status = 'declined', note = ?, decided_at = ? WHERE id = ?", note, now(), p.id);
    if (d) addTaskMessage(d, HELM, `You declined the proposed edit to "${title}"${note ? `: ${note}` : '.'}`, 'state');
  });
  touchProject(p.project_id);
  return {
    note:
      `The user declined your proposed edit ${p.id} to the Spec entry "${title}" (id ${p.doc_id})${d ? ` in ${taskRef(d)}` : ''}${note ? `, saying: ${note}` : ' without a note'}. ` +
      `The entry is unchanged. If it helps, propose a revised edit there with propose_doc_edit; otherwise leave it.`,
  };
}
