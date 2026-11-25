import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getProject, touchProject } from './store.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { addTaskMessage, findTask, getTask, isDiscussion } from './tasks.ts';
import type { Author } from './tasks.ts';
import { createDiscussion } from './discussions.ts';
import { ensureSectionPath, getDoc, normTags, saveDoc, STEERABLE } from './spec.ts';
import type { Editor } from './spec.ts';
import { pathText, resolveSection, sectionTree, subtreeIds, walkTree } from './sections.ts';
import { bodyError, placementError, summaryError } from './speclimits.ts';

/**
 * Spec work: the Spec page's three processes, each a discussion with the director that goes section by section and
 * can be stopped after any section and continued later.
 * - Review: a read-only audit. Per section the director posts findings (post_spec_findings): match, gap (built but
 *   not in the Spec) or disagree (the Spec says X, the code does Y). Nothing changes; the user picks findings and
 *   starts a Revise from them.
 * - Revise: from picked findings, or from what the user wants changed. Structure first, then wording; each change is
 *   a card the user applies (propose_doc_edit for an entry, propose_spec_entries for a new one).
 * - Create: for a project with no Spec (or an imported one): the director maps the project and proposes entries,
 *   part by part (propose_spec_entries); the user accepts or drops each, and accepted ones are written as theirs.
 * The user's Stop sets spec_work.stop; the next post's result tells the director to end there. Continue clears it.
 */

export const SPEC_MODES = ['review', 'revise', 'create'] as const;
export type SpecMode = (typeof SPEC_MODES)[number];
export const FINDING_KINDS = ['match', 'gap', 'disagree'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

const TITLE: Record<SpecMode, string> = { review: 'Spec review', revise: 'Spec revise', create: 'Create the Spec' };
const USER: Author = { author: 'user', name: 'You' };
const HELM: Author = { author: 'system', name: 'Helm' };
const OWNER: Editor = { author: 'user', name: 'You' };
const NONE = 'none';

export const getSpecWork = (discussionId: string): Row | undefined => get('SELECT * FROM spec_work WHERE discussion_id = ?', discussionId);

/** The open discussion of this mode, if any (the newest). */
export function openSpecWork(projectId: string, mode: SpecMode): Row | undefined {
  return get(
    "SELECT t.* FROM spec_work w JOIN tasks t ON t.id = w.discussion_id WHERE w.project_id = ? AND w.mode = ? AND t.kind = 'discussion' AND t.state = 'open' ORDER BY w.created_at DESC LIMIT 1",
    projectId,
    mode,
  );
}

const entryCount = (projectId: string) => Number(get(`SELECT COUNT(*) AS n FROM docs WHERE project_id = ? AND kind IN (${STEERABLE.map(() => '?').join(',')})`, projectId, ...STEERABLE)?.n ?? 0);

/** The units a Review goes through, in reading order: sections holding entries, then the entries with no section. */
export function reviewUnits(projectId: string, focus = ''): { id: string; name: string; docs: Row[] }[] {
  const tree = sectionTree(projectId);
  const docs = all(`SELECT id, title, summary, section_id FROM docs WHERE project_id = ? AND kind IN (${STEERABLE.map(() => '?').join(',')}) AND status != 'dropped' ORDER BY created_at`, projectId, ...STEERABLE);
  const within = focus && tree.byId.has(focus) ? new Set(subtreeIds(tree, focus)) : null;
  const units = walkTree(tree)
    .filter(({ s }) => !within || within.has(s.id))
    .map(({ s }) => ({ id: s.id as string, name: pathText(tree, s.id), docs: docs.filter((d) => d.section_id === s.id) }))
    .filter((u) => u.docs.length);
  const loose = docs.filter((d) => !d.section_id || !tree.byId.has(d.section_id));
  if (!within && loose.length) units.push({ id: NONE, name: 'Not in a section', docs: loose });
  return units;
}

const doneOf = (w: Row): string[] => {
  try {
    return JSON.parse(w.done) ?? [];
  } catch {
    return [];
  }
};

/** Where a Review stands: sections done and the next one, for the bar at the top of the discussion and the director. */
export function reviewProgress(w: Row): { total: number; done: number; next: { id: string; name: string; docs: Row[] } | null } {
  const units = reviewUnits(w.project_id, w.focus);
  const done = new Set(doneOf(w));
  return { total: units.length, done: units.filter((u) => done.has(u.id)).length, next: units.find((u) => !done.has(u.id)) ?? null };
}

/**
 * Start one of the three, or return its open discussion of that mode to resume it. A Revise started from picked
 * findings is always new, and those findings are marked picked. Returns the discussion, whether it is new, and the
 * user's first message for it (sent as theirs, with the mode's brief attached for the director: specWorkExtras).
 */
export function startSpecWork(
  projectId: string,
  mode: SpecMode,
  input: { ask?: string; section?: string; findings?: string[] } = {},
): { discussion: Row; created: boolean; first: string } | { error: string } {
  if (!SPEC_MODES.includes(mode)) return { error: `Mode is one of ${SPEC_MODES.join(', ')}.` };
  const ask = (input.ask ?? '').trim().slice(0, 2000);
  const findings = (input.findings ?? []).length ? all(`SELECT * FROM spec_items WHERE project_id = ? AND id IN (${input.findings!.map(() => '?').join(',')}) AND kind IN ('gap','disagree')`, projectId, ...input.findings!) : [];
  if ((input.findings ?? []).length && !findings.length) return { error: 'Those findings are not on this project.' };
  let focus = '';
  if (input.section) {
    const r = resolveSection(projectId, input.section);
    if ('error' in r) return { error: r.error };
    focus = r.section.id;
  }
  if (mode === 'review' && !entryCount(projectId)) return { error: 'The Spec has no entries to review yet: use Create.' };
  const open = openSpecWork(projectId, mode);
  if (open && !findings.length && !ask && !focus) return { discussion: open, created: false, first: '' };
  const tree = sectionTree(projectId);
  const where = focus ? ` of ${pathText(tree, focus)}` : '';
  const first =
    mode === 'review'
      ? `Review the Spec${where} against the project, one section at a time.`
      : mode === 'create'
        ? ask || 'Build a Spec for this project from what is here.'
        : findings.length
          ? `Revise the Spec from ${findings.length === 1 ? 'this Review finding' : `these ${findings.length} Review findings`}.${ask ? ` ${ask}` : ''}`
          : ask || `Revise the Spec${where}.`;
  const discussion = tx(() => {
    const d = createDiscussion(projectId, { title: `${TITLE[mode]}${focus ? `: ${tree.byId.get(focus)?.name}` : ''}`.slice(0, 140), summary: '', origin: 'user' }, USER);
    run('INSERT INTO spec_work (discussion_id, project_id, mode, focus, ask, created_at) VALUES (?,?,?,?,?,?)', d.id, projectId, mode, focus, ask, now());
    if (findings.length) {
      run(`UPDATE spec_items SET status = 'picked', result = ?, decided_at = ? WHERE id IN (${findings.map(() => '?').join(',')})`, d.id, now(), ...findings.map((f) => f.id));
      addTaskMessage(d, HELM, `Picked from the Review:\n${findings.map((f) => `- ${f.kind === 'gap' ? 'Gap' : 'Disagrees'}${f.section ? ` (${f.section})` : ''}: ${f.text}`).join('\n')}`, 'state');
    }
    return getTask(d.id)!;
  });
  touchProject(projectId);
  return { discussion, created: true, first };
}

/** The user's Stop (after the current section) or Continue. Returns the note for the director, or an error. */
export function setSpecWorkStop(d: Row, stop: boolean): { note: string } | { error: string } {
  const w = getSpecWork(d.id);
  if (!w) return { error: 'This is not a Spec Review, Revise or Create discussion.' };
  if (d.state !== 'open') return { error: 'It is closed.' };
  if (!!w.stop === stop) return { error: stop ? 'It is already stopping.' : 'It is not stopped.' };
  tx(() => {
    run('UPDATE spec_work SET stop = ? WHERE discussion_id = ?', stop ? 1 : 0, d.id);
    addTaskMessage(d, HELM, stop ? 'You asked to stop after this section.' : 'You asked to continue.', 'state');
  });
  touchProject(d.project_id);
  if (stop) return { note: `The user asked [[${d.id}]] to stop after the current section. Finish and post it, then end there.` };
  const next = w.mode === 'review' ? reviewProgress({ ...w, stop: 0 }).next : null;
  return { note: `The user asked [[${d.id}]] to continue.${next ? ` Next section: ${next.name} (${next.id}).` : ' Carry on from where it stopped.'}` };
}

/** A bare "stop" or "continue" typed in a Spec work thread does what the bar's button does (the message still goes on). */
export function onSpecWorkMessage(d: Row, text: string) {
  const w = getSpecWork(d.id);
  if (!w || d.state !== 'open') return;
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(stop|pause|stop here|stop after this section)$/.test(t) && !w.stop) setSpecWorkStop(d, true);
  else if (/^(continue|resume|go on|carry on)$/.test(t) && w.stop) setSpecWorkStop(d, false);
}

/** What comes after a post: stop, the next section, or the end. */
function after(w: Row): string {
  const fresh = getSpecWork(w.discussion_id)!;
  if (fresh.stop) return 'The user asked to stop here: end your turn now. If they press Continue you are told.';
  if (fresh.mode === 'review') {
    const p = reviewProgress(fresh);
    if (p.next) return `${p.done} of ${p.total} sections done. Next: ${p.next.name} (${p.next.id}), entries ${p.next.docs.map((d) => d.id).join(', ')}.`;
    return `All ${p.total} sections are done. Post a short closing note in the thread (task_post): the most important gaps and disagreements. The user picks findings on the cards to start a Revise.`;
  }
  const decided = all("SELECT status, COUNT(*) AS n FROM spec_items WHERE discussion_id = ? AND kind = 'entry' GROUP BY status", fresh.discussion_id);
  const n = (s: string) => Number(decided.find((r) => r.status === s)?.n ?? 0);
  return `Continue with the next part. So far: ${n('accepted')} accepted, ${n('dropped')} dropped, ${n('open')} not decided yet.`;
}

function workOf(agent: Row, ref: string, modes: SpecMode[]): { d: Row; w: Row } | { error: string } {
  const d = findTask(agent.project_id, ref);
  const w = d ? getSpecWork(d.id) : undefined;
  if (!d || !w || !isDiscussion(d)) return { error: `No Spec ${modes.join(' or ')} discussion "${ref}" on this project.` };
  if (!modes.includes(w.mode)) return { error: `[[${d.id}]] is a Spec ${w.mode}; this is for a Spec ${modes.join(' or ')}.` };
  if (d.state !== 'open') return { error: `[[${d.id}]] is closed.` };
  return { d, w };
}

/** Review: the findings for one section, as one card in the thread. */
export function postFindings(
  agent: Row,
  ref: string,
  sectionRef: string,
  findings: { kind: FindingKind; text: string; doc?: string }[],
): { text: string } | { error: string } {
  const res = workOf(agent, ref, ['review']);
  if ('error' in res) return res;
  const { d, w } = res;
  const units = reviewUnits(d.project_id, w.focus);
  const key = sectionRef.trim();
  const unit = units.find((u) => u.id === key || u.name.toLowerCase() === key.toLowerCase()) ?? units.find((u) => u.name.toLowerCase().endsWith(key.toLowerCase()));
  if (!unit) return { error: `No section "${sectionRef}" in this Review. Sections: ${units.map((u) => `${u.name} (${u.id})`).join('; ')}.` };
  if (!findings.length) return { error: 'Give at least one finding; a section that matches is one match finding.' };
  for (const f of findings) {
    if (!FINDING_KINDS.includes(f.kind)) return { error: `kind is one of ${FINDING_KINDS.join(', ')}.` };
    if (f.doc && !get('SELECT 1 AS x FROM docs WHERE id = ? AND project_id = ?', f.doc, d.project_id)) return { error: `No Spec entry ${f.doc} on this project.` };
  }
  tx(() => {
    const mid = addTaskMessage(d, { author: 'director', name: agent.name }, JSON.stringify({ section: unit.name }), 'findings');
    for (const f of findings) {
      run('INSERT INTO spec_items (id, project_id, discussion_id, message_id, kind, section, text, doc_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)', newId('sf'), d.project_id, d.id, mid, f.kind, unit.name, f.text.trim().slice(0, 600), f.doc || null, now());
    }
    const done = [...new Set([...doneOf(w), unit.id])];
    run('UPDATE spec_work SET done = ? WHERE discussion_id = ?', JSON.stringify(done), d.id);
  });
  touchProject(d.project_id);
  return { text: `Posted ${findings.length} finding(s) for ${unit.name} in [[${d.id}]]. ${after(w)}` };
}

export type EntryInput = { title: string; summary: string; body?: string; section: string; tags?: string[] };

/** Create or Revise: proposed new entries, one card in the thread with Accept and Drop on each. */
export function proposeEntries(agent: Row, ref: string, entries: EntryInput[]): { text: string } | { error: string } {
  const res = workOf(agent, ref, ['create', 'revise']);
  if ('error' in res) return res;
  const { d, w } = res;
  if (!entries.length) return { error: 'Give at least one entry.' };
  for (const e of entries) if (!e.title.trim() || !e.summary.trim() || !e.section.trim()) return { error: 'Each entry needs a title, a summary (what must be true) and a section path.' };
  // Size limits (speclimits.ts): each summary and text, and the sections the whole batch lands in.
  for (const e of entries) {
    const limit = summaryError(e.summary, `The summary of "${e.title.trim()}"`) ?? bodyError(e.body ?? '', `The text of "${e.title.trim()}"`);
    if (limit) return { error: limit.replace('Nothing was changed.', 'Nothing was posted.') };
  }
  const placed = placementError(d.project_id, entries.map((e) => ({ ref: e.section, count: 1 })));
  if (placed) return { error: placed.replace('Nothing was changed.', 'Nothing was posted.') };
  const part = [...new Set(entries.map((e) => e.section.trim()))].join(', ');
  tx(() => {
    const mid = addTaskMessage(d, { author: 'director', name: agent.name }, JSON.stringify({ section: part }), 'entries');
    for (const e of entries) {
      const data = { title: e.title.trim().slice(0, 140), summary: e.summary.trim().slice(0, 400), body: (e.body ?? '').trim(), section: e.section.trim(), tags: normTags(e.tags ?? []) };
      run('INSERT INTO spec_items (id, project_id, discussion_id, message_id, kind, section, text, data, created_at) VALUES (?,?,?,?,?,?,?,?,?)', newId('se'), d.project_id, d.id, mid, 'entry', data.section, data.title, JSON.stringify(data), now());
    }
  });
  touchProject(d.project_id);
  return { text: `Posted ${entries.length} proposed entr${entries.length === 1 ? 'y' : 'ies'} in [[${d.id}]]; the user accepts or drops each (accepted ones are written as theirs). ${after(w)}` };
}

/** The user accepts a proposed entry (written as theirs, wording only: it describes what is there) or drops it. */
export function decideEntry(item: Row, accept: boolean): { text: string } | { error: string; code?: number } {
  if (item.kind !== 'entry') return { error: 'Only a proposed entry is accepted or dropped.' };
  if (item.status !== 'open') return { error: `It is already ${item.status}.`, code: 409 };
  const d = getTask(item.discussion_id);
  if (!accept) {
    tx(() => {
      run("UPDATE spec_items SET status = 'dropped', decided_at = ? WHERE id = ?", now(), item.id);
      if (d) addTaskMessage(d, HELM, `You dropped the proposed entry "${item.text}".`, 'state');
    });
    touchProject(item.project_id);
    return { text: `The user dropped the proposed entry "${item.text}".` };
  }
  const data = JSON.parse(item.data || '{}');
  const out = tx(() => {
    const sec = data.section ? ensureSectionPath(item.project_id, data.section) : null;
    if (sec && 'error' in sec) return sec;
    const r = saveDoc(item.project_id, null, { title: data.title, summary: data.summary, body: data.body ?? '', tags: data.tags ?? [], section_id: sec ? sec.id : null }, OWNER, true, d?.id ?? null);
    if ('error' in r) return r;
    if (d) addTaskMessage(d, HELM, `You accepted "${data.title}": it is now in the Spec.`, 'state');
    run("UPDATE spec_items SET status = 'accepted', doc_id = ?, decided_at = ? WHERE id = ?", r.id, now(), item.id);
    return r;
  });
  if ('error' in out) return { error: out.error };
  touchProject(item.project_id);
  return { text: `The user accepted "${data.title}": written as [[${out.id}]].` };
}

export const getSpecItem = (id: string): Row | undefined => get('SELECT * FROM spec_items WHERE id = ?', id);

/** A findings or entries card: the items its message holds. */
export function specCardView(messageId: number): Row | null {
  const m = get('SELECT id, task_id, author_name, kind, body, created_at FROM task_messages WHERE id = ?', messageId);
  if (!m) return null;
  const items = all('SELECT id, kind, section, text, doc_id, data, status, result FROM spec_items WHERE message_id = ? ORDER BY rowid', messageId).map((i) => {
    const doc = i.doc_id ? getDoc(i.doc_id) : undefined;
    return { id: i.id, kind: i.kind, text: i.text, doc_id: i.doc_id, doc_title: doc?.title ?? null, entry: i.kind === 'entry' ? JSON.parse(i.data || '{}') : null, status: i.status, result: i.result };
  });
  let section = '';
  try {
    section = JSON.parse(m.body).section ?? '';
  } catch {}
  return { message_id: m.id, discussion_id: m.task_id, kind: m.kind, section, author_name: m.author_name, created_at: m.created_at, items };
}

/** The open Spec work of a project and where each stands, for the Spec page and the bar on its discussion. */
export function specWorkState(projectId: string): Row[] {
  return all("SELECT w.* FROM spec_work w JOIN tasks t ON t.id = w.discussion_id WHERE w.project_id = ? AND t.kind = 'discussion' AND t.state = 'open' ORDER BY w.created_at DESC", projectId).map((w) => {
    const p = w.mode === 'review' ? reviewProgress(w) : null;
    return { discussion_id: w.discussion_id, mode: w.mode, stop: !!w.stop, done: p?.done ?? null, total: p?.total ?? null };
  });
}

/**
 * Start (or resume) Spec work and, when new, send the user's first message to the director with the mode's brief:
 * the same envelope as a message typed in the thread (taskapi.ts sendThreadMessage). Used by the Spec page and by the
 * import question's Build a Spec.
 */
export async function beginSpecWork(projectId: string, mode: SpecMode, input: { ask?: string; section?: string; findings?: string[] } = {}): Promise<{ discussion: Row; created: boolean } | { error: string }> {
  const res = startSpecWork(projectId, mode, input);
  if ('error' in res) return res;
  if (res.created) {
    const d = res.discussion;
    addTaskMessage(d, USER, res.first);
    const extra = specWorkExtras(getTask(d.id)!)!;
    await sendToAgent(rootAgent(getProject(projectId)!).id, `<discussion-message discussion="${d.id}" title="${String(d.title).replace(/"/g, "'")}"${extra.attrs}>\n${res.first}${extra.context}\n</discussion-message>`, { kind: 'user', name: 'You' }, [], false);
    touchProject(projectId);
  }
  return { discussion: res.discussion, created: res.created };
}

// ---------- the director's brief ----------

function briefFor(d: Row, w: Row): string {
  const tree = sectionTree(d.project_id);
  const where = w.focus ? ` It covers ${pathText(tree, w.focus)} only.` : '';
  if (w.mode === 'review') {
    const units = reviewUnits(d.project_id, w.focus);
    return [
      `This is a Spec Review the user started: a read-only audit of the Spec against the project as it is.${where} Nothing changes in it: do not edit the Spec, propose edits or start work here.`,
      `Go one section at a time, in this order:\n${units.map((u) => `- ${u.name} (${u.id}): ${u.docs.map((x) => x.id).join(', ')}`).join('\n')}`,
      `For each section, run one subagent with the built-in Agent tool, model "opus" (its findings show as cards). Give it the section's entries in full (list_docs with their ids) and ask it to check them against the code, the tasks and their history, and to return findings: match (the Spec and the project agree), gap (built or planned but not in the Spec), disagree (the Spec says X, the code does Y: say both, with file paths). One or two plain sentences each; name the entry when there is one.`,
      `Post each section's findings with post_spec_findings (discussion ${d.id}, section). Its result names the next section, or tells you the user stopped: then end your turn. The user picks findings on the cards to start a Revise.`,
    ].join('\n\n');
  }
  if (w.mode === 'revise') {
    const picked = all("SELECT kind, section, text, doc_id FROM spec_items WHERE result = ? AND status = 'picked' ORDER BY rowid", d.id);
    return [
      `This is a Spec Revise the user started.${where}${w.ask ? ` They want: ${w.ask}` : ''}`,
      ...(picked.length ? [`It starts from these Review findings:\n${picked.map((f) => `- ${f.kind === 'gap' ? 'Gap' : 'Disagrees'} (${f.section}): ${f.text}${f.doc_id ? ` [entry ${f.doc_id}]` : ''}`).join('\n')}`] : []),
      `First propose the structure in the thread (task_post): sections to merge, split, move or rename, entries to merge or move, and why. Wait for the user to agree. Section renames and moves agreed here change no meaning: make them yourself. Then the wording, entry by entry: a change to an existing entry is propose_doc_edit (entry, discussion ${d.id}); a new entry (a split, or a gap) is propose_spec_entries (discussion ${d.id}). The user applies each card; meaning changes only through those cards.`,
      `For a disagreement between the Spec and the code, ask the user in the thread: change the Spec (an edit card) or change the code. Code changes become tasks: list them in the conclusion you propose (task_post conclude: true) once the cards are decided.`,
    ].join('\n\n');
  }
  const n = entryCount(d.project_id);
  return [
    `This is a Spec Create the user started: build the project's Spec from what is here (it has ${n} entr${n === 1 ? 'y' : 'ies'} now).${w.ask ? ` They said: ${w.ask}` : ''}`,
    `First map the project: its purpose, its parts, how it is built and run (README, layout, build files, recent history). For a large project, run subagents with the built-in Agent tool, model "opus", one part each. Then propose the sections in the thread (task_post) and, one part at a time, its entries with propose_spec_entries (discussion ${d.id}): a title, a one-line summary of what must be true, the text of how it works, and the section path. Describe the project as it is, not plans. The user accepts, changes (by replying) or drops each one; accepted ones are written as theirs.`,
    `Each post's result tells you whether the user stopped: then end your turn. At the end, post what is still not covered (task_post) and propose a conclusion (task_post conclude: true).`,
  ].join('\n\n');
}

/**
 * With the user's first message in a Spec work discussion: the mode's brief for the director, attached after their
 * words (the thread shows only the words). Later messages carry only the mode.
 */
export function specWorkExtras(d: Row): { attrs: string; context: string } | null {
  if (!isDiscussion(d)) return null;
  const w = getSpecWork(d.id);
  if (!w) return null;
  const first = Number(get("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND author = 'user' AND kind = 'message'", d.id)?.n ?? 0) <= 1;
  const attrs = ` spec-work="${w.mode}"`;
  return { attrs, context: first ? `\n\n<spec-work mode="${w.mode}" discussion="${d.id}">\n${briefFor(d, w)}\n</spec-work>` : '' };
}

// ---------- import: one question ----------

/** Whether a folder brought in holds a project (anything besides git's own files). */
export function hasCode(entries: string[]): boolean {
  return entries.some((e) => !['.git', '.gitignore', '.gitattributes', '.DS_Store'].includes(e));
}

export const CREATE_QUESTION = {
  title: 'Build a Spec from the code?',
  body: [
    'This project has no Spec yet. The Spec says what the project should be, entry by entry, and it is what agents plan against.',
    '- Agents plan new work against it, and work that does not fit it is caught before it starts.',
    '- Drift between the Spec and the code is found when it is reviewed.',
    '',
    'Yes starts **Create**: the director maps the project and proposes sections and entries part by part; you accept, change or drop each. It costs roughly one long director session (more for a large project), and you can stop it after any part.',
  ].join('\n'),
  yes: 'Build a Spec',
};
