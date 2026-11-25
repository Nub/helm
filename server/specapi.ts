import type { FastifyInstance, FastifyReply } from 'fastify';
import { get } from './db.ts';
import type { Row } from './db.ts';
import { rootAgent, sendToAgent, tellDirector } from './agents.ts';
import { DOC_STATUSES, getProject } from './store.ts';
import { getTask, moveTask } from './tasks.ts';
import { NOT_A_KIND, STEERABLE, placeDoc, importanceHistory, setImportance, setImportanceLimits, setImportanceOrder, targetOf, unpinImportance, docHistory, addSection, deleteSection, ensureSectionPath, getDoc, placeSection, normTags, revertDoc, revisions, saveDoc, setSectionOrder, unorganised, updateSection } from './spec.ts';
import type { DocInput, Editor } from './spec.ts';
import { sendThreadMessage } from './taskapi.ts';
import { pendingAttachments } from './attachments.ts';
import { SPEC_MODES, beginSpecWork, decideEntry, getSpecItem, getSpecWork, setSpecWorkStop, specCardView } from './specwork.ts';
import type { SpecMode } from './specwork.ts';
import { applyProposal, declineProposal, getProposal, proposalView, startSpecDiscussion } from './specdiscuss.ts';

const OWNER: Editor = { author: 'user', name: 'You' };

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

/** The fields of a doc from a request body; undefined where not given. Section may be an id, a name or a path (missing levels created). */
function docInput(projectId: string, b: Record<string, any>): DocInput | string {
  // One kind of entry. The old names of it pass; decision and note are refused with where that content goes now.
  if (b.kind !== undefined && !STEERABLE.includes(b.kind)) return NOT_A_KIND;
  if (b.status !== undefined && !DOC_STATUSES.includes(b.status)) return `Status must be one of ${DOC_STATUSES.join(', ')}.`;
  const input: DocInput = {};
  for (const f of ['title', 'summary', 'body', 'status', 'importance_reason'] as const) if (typeof b[f] === 'string') input[f] = b[f];
  if (b.importance !== undefined) input.importance = Math.min(5, Math.max(1, Number(b.importance) || 3));
  if (Array.isArray(b.tags) || typeof b.tags === 'string') input.tags = normTags(b.tags);
  if (b.parent_id) return `Entries do not attach to other entries. ${NOT_A_KIND}`;
  if (b.section_id !== undefined) input.section_id = b.section_id || null;
  if (typeof b.section === 'string') {
    if (!b.section.trim()) input.section_id = null;
    else {
      const r = ensureSectionPath(projectId, b.section);
      if ('error' in r) return r.error;
      input.section_id = r.id;
    }
  }
  return input;
}

/** The text sent to the director by "Ask the director to organise the Spec": an ordinary message from the user. */
function organiseMessage(projectId: string): string {
  const u = unorganised(projectId);
  return [
    `Please organise the Spec so it reads as the project's source of truth.` +
      (u.unsectioned || u.unsummarised ? ` Right now ${u.unsectioned} entries have no section and ${u.unsummarised} have no summary.` : ''),
    `- Every entry is one kind now: its summary says what must be true, its text how it works. Where two entries describe the what and the how of the same subject (an old goal and its design), merge them into one entry and keep the other's useful text in it; tell me which you merged.`,
    `- Group entries into a handful of sections (chapters such as "Dashboard" or "Deployment"), each with a one-line description, in a sensible reading order (set_section).`,
    `- Sections may nest up to three levels (set_section with parent). A section without subsections holds at most eight entries and gets subsections only once it holds eight; do not nest for its own sake. Moving entries and sections is organisation, not a change of meaning.`,
    `- Give every entry a summary: one sentence (at most 30 words) that stands on its own in the collapsed view.`,
    `- Keep tags few and shared: at most three per entry, short ones that cut across sections (for example ios, security, needs-user), none that only repeats the section or title. Merge near-synonyms and drop tags used once with retag, in one call per change.`,
    `- Recalibrate importance to fit the budgets (list_importance, then set_importance in one call): Critical only where the project fails its purpose without it or it blocks most other work, High for what the current phase requires, most entries Medium, each High and Critical with a one-line reason. Leave levels I pinned as they are.`,
    `- Entry text describes the intended result only. Move "where it stands" and progress paragraphs out of the bodies: progress belongs on tasks (status summaries) and in the journal.`,
    `Do this with set_doc, set_section and retag; it is reorganising, not a change of intent, so keep the meaning of every entry. If an entry is out of date or two say the same thing, ask me rather than deleting it.`,
  ].join('\n');
}

export function registerSpecApi(app: FastifyInstance) {
  /** The owner adds an entry. A goal or design starts a planning discussion unless wording_only. */
  app.post('/api/projects/:id/docs', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const input = docInput(project.id, b);
    if (typeof input === 'string') return bad(reply, input);
    const res = saveDoc(project.id, null, input, OWNER, !!b.wording_only);
    return 'error' in res ? bad(reply, res.error) : res;
  });

  /** The owner edits an entry. Status and importance alone are a quiet correction; Begin and Stop tell the director. */
  app.patch('/api/docs/:id', async (req, reply) => {
    const doc = getDoc((req.params as any).id);
    if (!doc) return bad(reply, 'No such document', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const input = docInput(doc.project_id, b);
    if (typeof input === 'string') return bad(reply, input);
    const res = saveDoc(doc.project_id, doc, input, OWNER, !!b.wording_only);
    return 'error' in res ? bad(reply, res.error) : res;
  });

  /** The tasks and discussions that changed an entry (with diffs), the tasks that implement it, and its revisions. */
  app.get('/api/docs/:id/history', async (req, reply) => {
    const doc = getDoc((req.params as any).id);
    if (!doc) return bad(reply, 'No such document', 404);
    return docHistory(doc.id);
  });

  app.get('/api/docs/:id/revisions', async (req, reply) => {
    const doc = getDoc((req.params as any).id);
    if (!doc) return bad(reply, 'No such document', 404);
    return { revisions: revisions(doc.id), base_rev: doc.base_rev };
  });

  /** "Revert my edit": back to the entry as it was before the owner's unplanned edits. */
  app.post('/api/docs/:id/revert', async (req, reply) => {
    const doc = getDoc((req.params as any).id);
    if (!doc) return bad(reply, 'No such document', 404);
    const res = revertDoc(doc, OWNER);
    if ('error' in res) return bad(reply, res.error);
    if (res.note) await tellDirector(doc.project_id, res.note);
    return { ok: true, removed: res.removed };
  });

  /**
   * "Discuss" on an entry: the open discussion about it, or a new one starting with a snapshot of the entry. An
   * optional first message goes in and on to the director, with what the discussion is for (server/specdiscuss.ts).
   */
  app.post('/api/docs/:id/discuss', async (req, reply) => {
    const doc = getDoc((req.params as any).id);
    if (!doc) return bad(reply, 'No such document', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const text = String(b.text ?? '').trim();
    const files = pendingAttachments(doc.project_id, b.attachments);
    if ('error' in files) return bad(reply, files.error);
    const { discussion, created } = startSpecDiscussion(doc);
    if (text || files.rows.length) await sendThreadMessage(discussion, text, files.rows);
    // kind 'task': the entry's open planning task, which is the conversation about it now.
    return { id: discussion.id, created, kind: discussion.kind };
  });

  app.get('/api/proposals/:id', async (req, reply) => {
    const p = getProposal((req.params as any).id);
    return p ? proposalView(p) : bad(reply, 'No such proposal', 404);
  });

  /** The owner applies a proposed edit: the same path as their own edit (wording_only skips the planning task). */
  app.post('/api/proposals/:id/apply', async (req, reply) => {
    const p = getProposal((req.params as any).id);
    if (!p) return bad(reply, 'No such proposal', 404);
    const res = applyProposal(p, !!(req.body as any)?.wording_only);
    if ('error' in res) return bad(reply, res.error, res.code);
    await tellDirector(p.project_id, res.note);
    return { ok: true, pending: res.pending };
  });

  app.post('/api/proposals/:id/decline', async (req, reply) => {
    const p = getProposal((req.params as any).id);
    if (!p) return bad(reply, 'No such proposal', 404);
    const res = declineProposal(p, String((req.body as any)?.note ?? '').trim().slice(0, 2000));
    if ('error' in res) return bad(reply, res.error, res.code);
    await tellDirector(p.project_id, res.note);
    return { ok: true };
  });

  // ---------- sections ----------

  /** A new section, at the top level or under parent_id; at most three levels, names unique among siblings. */
  app.post('/api/projects/:id/sections', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const res = addSection(project.id, String(b.name ?? ''), String(b.description ?? ''), b.parent_id ? String(b.parent_id) : null);
    if ('error' in res) return bad(reply, res.error);
    if (b.position) placeSection(res.section, undefined, Number(b.position));
    return { id: res.section.id };
  });

  /** Rename or describe a section, and move it: parent_id (null for the top level) and/or position among its siblings. */
  app.patch('/api/sections/:id', async (req, reply) => {
    const s = get('SELECT * FROM doc_sections WHERE id = ?', (req.params as any).id);
    if (!s) return bad(reply, 'No such section', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const name = typeof b.name === 'string' ? b.name.trim() : undefined;
    if (name !== undefined || typeof b.description === 'string') {
      const res = updateSection(s, { name, description: typeof b.description === 'string' ? b.description : undefined });
      if ('error' in res) return bad(reply, res.error);
    }
    if (b.parent_id !== undefined || b.position) {
      const res = placeSection(get('SELECT * FROM doc_sections WHERE id = ?', s.id)!, b.parent_id === undefined ? undefined : b.parent_id || null, b.position ? Number(b.position) : undefined);
      if ('error' in res) return bad(reply, res.error);
    }
    return { ok: true };
  });

  app.post('/api/projects/:id/sections/order', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const ids = (req.body as any)?.ids;
    if (!Array.isArray(ids)) return bad(reply, 'Give the section ids in order.');
    setSectionOrder(project.id, ids.map(String));
    return { ok: true };
  });

  /** Remove a section: its entries and subsections move up to its parent. */
  app.delete('/api/sections/:id', async (req, reply) => {
    const s = get('SELECT * FROM doc_sections WHERE id = ?', (req.params as any).id);
    if (!s) return bad(reply, 'No such section', 404);
    return { ok: true, ...deleteSection(s as Row) };
  });

  // ---------- importance ----------

  /** The owner sets the importance of an entry or a task. It is pinned: agents may not change it. Over-budget is a warning. */
  app.post('/api/importance/:id', async (req, reply) => {
    const t = targetOf((req.params as any).id);
    if (!t) return bad(reply, 'No such entry or task', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const level = Number(b.importance);
    if (!(level >= 1 && level <= 5)) return bad(reply, 'Importance is 1 (Minor) to 5 (Critical).');
    const res = setImportance(t.row.project_id, [{ id: t.row.id, importance: level, reason: typeof b.reason === 'string' ? b.reason : undefined }], OWNER);
    return 'error' in res ? bad(reply, res.error) : { ok: true, warnings: res.warnings };
  });

  /** The owner drags an entry or task within or across tiers: level (optional) and place (before/after an id, or top). */
  app.post('/api/importance/:id/place', async (req, reply) => {
    const t = targetOf((req.params as any).id);
    if (!t) return bad(reply, 'No such entry or task', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const level = b.importance === undefined ? t.row.importance : Number(b.importance);
    if (!(level >= 1 && level <= 5)) return bad(reply, 'Importance is 1 (Minor) to 5 (Critical).');
    const place = { before: b.before ? String(b.before) : undefined, after: b.after ? String(b.after) : undefined, top: !!b.top };
    if (t.target === 'doc') {
      const res = placeDoc(t.row, level, place);
      return 'error' in res ? bad(reply, res.error) : { ok: true, warnings: res.warnings };
    }
    let warnings: string[] = [];
    if (level !== t.row.importance) {
      const res = setImportance(t.row.project_id, [{ id: t.row.id, importance: level, reason: t.row.importance_reason }], OWNER);
      if ('error' in res) return bad(reply, res.error);
      warnings = res.warnings;
    }
    const task = getTask(t.row.id)!;
    const err = moveTask(task, place.before ? { before: place.before } : place.after ? { after: place.after } : place.top ? 'top' : 'bottom', 'user');
    return err ? bad(reply, err) : { ok: true, warnings };
  });

  app.post('/api/importance/:id/unpin', async (req, reply) => {
    const t = targetOf((req.params as any).id);
    if (!t) return bad(reply, 'No such entry or task', 404);
    unpinImportance(t.target, t.row);
    return { ok: true };
  });

  /** The owner's order of entries within one level. */
  app.post('/api/projects/:id/importance/order', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const ids = (req.body as any)?.ids;
    if (!Array.isArray(ids)) return bad(reply, 'Give the entry ids in order.');
    setImportanceOrder(project.id, ids.map(String));
    return { ok: true };
  });

  app.patch('/api/projects/:id/importance-limits', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { limits: setImportanceLimits(project.id, (req.body ?? {}) as any) };
  });

  /**
   * Spec work (specwork.ts): Review, Revise or Create, each a discussion with the director. A new one starts with the
   * user's ask as their first message, with the mode's brief for the director; an open one of the mode is resumed.
   */
  app.post('/api/projects/:id/spec-work', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!SPEC_MODES.includes(b.mode)) return bad(reply, `mode is one of ${SPEC_MODES.join(', ')}.`);
    const res = await beginSpecWork(project.id, b.mode as SpecMode, { ask: typeof b.ask === 'string' ? b.ask : '', section: typeof b.section === 'string' ? b.section : '', findings: Array.isArray(b.findings) ? b.findings.map(String) : [] });
    if ('error' in res) return bad(reply, res.error);
    return { id: res.discussion.id, created: res.created };
  });

  /** Stop after the current section, or continue (the bar at the top of a Spec work discussion). */
  app.post('/api/spec-work/:id/:action', async (req, reply) => {
    const { id, action } = req.params as any;
    const d = getTask(id);
    if (!d || !getSpecWork(id)) return bad(reply, 'No such Spec work', 404);
    if (action !== 'stop' && action !== 'continue') return bad(reply, 'stop or continue', 404);
    const res = setSpecWorkStop(d, action === 'stop');
    if ('error' in res) return bad(reply, res.error, 409);
    await tellDirector(d.project_id, res.note);
    return { ok: true };
  });

  /** A findings or proposed-entries card in a Spec work thread. */
  app.get('/api/spec-cards/:message', async (req, reply) => {
    const v = specCardView(Number((req.params as any).message));
    return v ?? bad(reply, 'No such card', 404);
  });

  /** Accept (written as the user's entry) or drop a proposed entry. The director sees the tally with its next post. */
  app.post('/api/spec-items/:id/:action', async (req, reply) => {
    const { id, action } = req.params as any;
    const item = getSpecItem(id);
    if (!item) return bad(reply, 'No such item', 404);
    if (action !== 'accept' && action !== 'drop') return bad(reply, 'accept or drop', 404);
    const res = decideEntry(item, action === 'accept');
    return 'error' in res ? bad(reply, res.error, res.code ?? 400) : { ok: true };
  });

  /** "Ask the director to organise the Spec": sent as the owner's own message, so it shows in the conversation. */
  app.post('/api/projects/:id/spec/organise', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    await sendToAgent(rootAgent(project).id, organiseMessage(project.id), { kind: 'user', name: 'You' });
    return { ok: true };
  });
}

