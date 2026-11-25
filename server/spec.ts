import { all, get, newId, now, run, tx } from './db.ts';
import { deleteOwnedBy } from './attachments.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { addTaskMessage, createTask, getTask, taskRef } from './tasks.ts';
import type { Author } from './tasks.ts';
import { discussionToTask, settleDiscussion } from './discussions.ts';
import { entryCounts, listSections, pathText, resolveSection, sectionTree, subtreeIds, walkTree } from './sections.ts';

/**
 * The Spec: the project's goals and designs as one sectioned, tagged document,
 * with decisions and notes attached to the entries they concern.
 *
 * Every change to an entry is kept as a revision (the entry as it was before).
 * When the owner edits a goal or design (not an agent, and not "wording only"),
 * the entry is marked changed; once the whole project has been quiet for
 * QUIET_MS, the pending edits become one planning task whose first message is
 * the diff, and the director is asked for a plan. Nothing runs until the owner
 * approves that task. All of this state is in the database, so a restart in the
 * middle of the quiet period only delays it.
 */

/**
 * Every Spec entry is one kind, 'entry': its summary says what must be true, its body how it works. 'goal' and
 * 'design' are the older names, read as entries until foldSpecKinds() migrates them.
 */
export const ENTRY = 'entry';
export const STEERABLE = [ENTRY, 'goal', 'design'];
/** Where content that used to be a decision or note entry goes now. */
export const NOT_A_KIND =
  'Decisions and notes are no longer Spec entries. Record a decision as the conclusion of a discussion, as the outcome in a task\'s thread, or with log_journal (kind decision, doc = the entry it concerns): it then shows in that entry\'s history. Put lasting context in the entry\'s own text.';
export const QUIET_MS = Math.max(1, Number(process.env.HELM_SPEC_QUIET_SECONDS ?? 120)) * 1000;
const HELM: Author = { author: 'system', name: 'Helm' };

export type Editor = { author: 'user' | 'agent'; name: string; agentId?: string };

// ---------- small helpers ----------

export function parseTags(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Tags are short lowercase words joined by hyphens: "needs-user", "ios". */
export function normTag(t: unknown): string {
  return String(t).trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

export function normTags(list: unknown): string[] {
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : [];
  const out: string[] = [];
  for (const t of raw) {
    const tag = normTag(t);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 12);
}

/**
 * Tags cut across sections, so they only help while there are few of them. An agent may give an entry at most
 * MAX_TAGS; entries written before the limit keep theirs, and an edit may keep or drop those but not add to them.
 */
export const MAX_TAGS = 3;

/** Every tag on the project's entries with how many carry it, most used first. */
export function tagCounts(projectId: string): [string, number][] {
  const n = new Map<string, number>();
  for (const r of all("SELECT tags FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design')", projectId)) for (const t of parseTags(r.tags)) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The project's tags as one line for an agent: "ios (5), security (3), …", the most used `limit` of them. */
export function tagVocabulary(projectId: string, limit = 40): string {
  const list = tagCounts(projectId);
  if (!list.length) return 'none yet';
  const shown = list.slice(0, limit).map(([t, n]) => `${t} (${n})`).join(', ');
  return list.length > limit ? `${shown}, and ${list.length - limit} more` : shown;
}

/** Why an agent's tag list for an entry is refused, or null. `existing` is the entry before the edit (null when new). */
export function tagLimitError(projectId: string, existing: Row | null, tags: unknown): string | null {
  const next = normTags(tags);
  if (next.length <= MAX_TAGS) return null;
  const had = parseTags(existing?.tags);
  // An entry from before the limit may keep (or trim) the tags it has; only adding beyond three is refused.
  if (existing && next.every((t) => had.includes(t))) return null;
  return `At most ${MAX_TAGS} tags per entry (you gave ${next.length}: ${next.join(', ')}). Pick the ones a reader would filter by, reuse the project's tags where one fits, and leave out what the section or title already says. Tags in use: ${tagVocabulary(projectId)}. Nothing was changed.`;
}

/**
 * Rename, merge or remove tags across every entry of a project in one transaction: each entry carrying any tag in
 * `from` gets `to` in their place (null removes them). Each changed entry gets a revision like any other edit by
 * `by`; a tag change never opens a planning task (tags are not content; see saveDoc).
 */
export function retagDocs(projectId: string, from: string[], to: string | null, by: Editor): { changed: number; to: string | null } | { error: string } {
  const src = [...new Set(from.map(normTag).filter(Boolean))];
  const dest = to == null || to.trim() === '' ? null : normTag(to);
  if (!src.length) return { error: 'Name at least one tag to change in from.' };
  if (to != null && to.trim() !== '' && !dest) return { error: `"${to}" is not a usable tag: use short lowercase words joined by hyphens.` };
  const docs = all("SELECT * FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design')", projectId).filter((d) => parseTags(d.tags).some((t) => src.includes(t)));
  if (!docs.length) return { error: `No entry carries ${src.map((t) => '#' + t).join(', ')}. Tags in use: ${tagVocabulary(projectId)}.` };
  let changed = 0;
  tx(() => {
    for (const d of docs) {
      const old = parseTags(d.tags);
      const next: string[] = [];
      for (const t of old) {
        const v = src.includes(t) ? dest : t;
        if (v && !next.includes(v)) next.push(v);
      }
      const json = JSON.stringify(next);
      if (json === d.tags) continue;
      run('UPDATE docs SET tags = ?, updated_at = ? WHERE id = ?', json, now(), d.id);
      recordRevision(d, d.id, projectId, 'edit', by);
      changed++;
    }
  });
  touchProject(projectId);
  return { changed, to: dest };
}

/** The first sentence of a body, for entries written before summaries existed. */
export function firstSentence(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/[*_`>#]|\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = text.match(/^(.{20,}?[.!?])(\s|$)/);
  const s = m ? m[1] : text;
  return s.length > 220 ? s.slice(0, 217).replace(/\s+\S*$/, '') + '…' : s;
}

export function docView(d: Row): Row {
  const records =
    Number(get('SELECT COUNT(*) AS n FROM doc_history_items WHERE doc_id = ?', d.id)?.n ?? 0) +
    Number(get("SELECT COUNT(*) AS n FROM journal WHERE kind = 'decision' AND (doc_id = ? OR task_id IN (SELECT task_id FROM doc_links WHERE doc_id = ?))", d.id, d.id)?.n ?? 0);
  return { ...d, tags: parseTags(d.tags), record_count: records };
}

export function getDoc(id: string): Row | undefined {
  return get('SELECT * FROM docs WHERE id = ?', id);
}

// ---------- sections ----------

// The section tree (nesting, paths, moves) lives in sections.ts; re-exported for the modules that import it from here.
export { addSection, createSection, deleteSection, ensureSectionPath, findSection, listSections, moveSection, placeSection, resolveSection, sectionIdFor, setSectionOrder, updateSection } from './sections.ts';

// ---------- saving entries ----------

export type DocInput = {
  kind?: string;
  title?: string;
  summary?: string;
  body?: string;
  importance?: number;
  importance_reason?: string;
  status?: string;
  section_id?: string | null;
  tags?: string[];
  parent_id?: string | null;
};

const CONTENT = ['title', 'summary', 'body'] as const;
const SNAPSHOT = ['kind', 'title', 'summary', 'body', 'section_id', 'tags', 'parent_id'] as const;

function recordRevision(doc: Row | null, docId: string, projectId: string, op: string, by: Editor): number {
  const snap = doc ?? {};
  const res = run(
    'INSERT INTO doc_revisions (doc_id, project_id, op, author, author_name, kind, title, summary, body, section_id, tags, parent_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    docId, projectId, op, by.author, by.name, snap.kind ?? '', snap.title ?? '', snap.summary ?? '', snap.body ?? '', snap.section_id ?? null, snap.tags ?? '[]', snap.parent_id ?? null, now(),
  );
  return Number(res.lastInsertRowid);
}

/** Check a parent: decisions and notes attach to a goal or design of the same project. */
export function parentError(projectId: string, kind: string, parentId: string | null | undefined, selfId?: string): string | null {
  if (!parentId) return null;
  if (STEERABLE.includes(kind)) return 'Only decisions and notes attach to another entry; goals and designs go in a section.';
  if (parentId === selfId) return 'An entry cannot attach to itself.';
  const p = get('SELECT kind FROM docs WHERE id = ? AND project_id = ?', parentId, projectId);
  if (!p) return `No entry with id ${parentId} on this project.`;
  if (!STEERABLE.includes(p.kind)) return 'Decisions and notes attach to a goal or a design.';
  return null;
}

/**
 * Create (existing = null) or update an entry. An owner's edit of a goal's or
 * design's title, summary or body marks it changed, unless wordingOnly.
 * Returns the id and whether it started (or joined) a pending change.
 */
export function saveDoc(
  projectId: string,
  existing: Row | null,
  input: DocInput,
  by: Editor,
  wordingOnly = false,
  because: string | null = null,
): { id: string; pending: boolean; warning?: string } | { error: string } {
  if (input.kind && !STEERABLE.includes(input.kind)) return { error: NOT_A_KIND };
  if (input.parent_id) return { error: `Entries do not attach to other entries. ${NOT_A_KIND}` };
  // One kind: a new entry is an 'entry'; an existing one keeps its stored kind until the migration renames it.
  const kind = existing?.kind ?? ENTRY;
  const parent = existing?.parent_id ?? null;
  const next = {
    kind,
    title: (input.title ?? existing?.title ?? '').trim(),
    summary: (input.summary ?? existing?.summary ?? '').trim(),
    body: input.body ?? existing?.body ?? '',
    importance: Number(input.importance ?? existing?.importance ?? 3),
    status: input.status ?? existing?.status ?? 'active',
    section_id: input.section_id !== undefined ? input.section_id || null : (existing?.section_id ?? null),
    tags: JSON.stringify(input.tags !== undefined ? normTags(input.tags) : parseTags(existing?.tags)),
    parent_id: parent,
  };
  if (!next.title) return { error: 'Give it a title.' };
  if (by.author === 'agent' && input.tags !== undefined) {
    const tagErr = tagLimitError(projectId, existing, input.tags);
    if (tagErr) return { error: tagErr };
  }
  const reason = (input.importance_reason ?? existing?.importance_reason ?? '').trim();
  // Critical and High are budgeted. Agents are refused; the owner decides, so they are only warned.
  const imp = checkImportance(projectId, 'doc', existing, { importance: next.importance, reason, counted: counted('doc', next) }, by);
  if (imp.error) return { error: imp.error };
  const over = imp.warning;
  if (next.section_id && !get('SELECT id FROM doc_sections WHERE id = ? AND project_id = ?', next.section_id, projectId)) return { error: 'No such section on this project.' };

  const id = existing?.id ?? newId('doc');
  const contentChanged = !existing || CONTENT.some((f) => next[f] !== existing[f]);
  const anyChanged = !existing || SNAPSHOT.some((f) => next[f] !== existing[f]);
  let pending = false;
  tx(() => {
    if (existing) {
      run(
        'UPDATE docs SET kind = ?, title = ?, summary = ?, body = ?, status = ?, section_id = ?, tags = ?, parent_id = ?, updated_at = ? WHERE id = ?',
        next.kind, next.title, next.summary, next.body, next.status, next.section_id, next.tags, next.parent_id, now(), id,
      );
      // Importance goes through the same path as set_importance: recorded, and pinned when the owner sets it.
      applyImportance(projectId, 'doc', existing, next.importance, reason, by, because);
    } else {
      run(
        'INSERT INTO docs (id, project_id, kind, title, summary, body, importance, importance_reason, importance_pinned, status, section_id, tags, parent_id, author, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, projectId, next.kind, next.title, next.summary, next.body, next.importance, reason, by.author === 'user' && next.importance !== 3 ? 1 : 0, next.status, next.section_id, next.tags, next.parent_id, by.author === 'user' ? 'You' : by.name, now(), now(),
      );
    }
    if (!anyChanged) return;
    const rev = recordRevision(existing, id, projectId, existing ? 'edit' : 'create', by);
    // The task or discussion this change came out of.
    if (because) linkDoc(id, because, 'changed', rev);
    if (by.author === 'user' && STEERABLE.includes(next.kind) && contentChanged && !wordingOnly) {
      markChanged(id, rev);
      pending = true;
    }
  });
  touchProject(projectId);
  return over ? { id, pending, warning: over } : { id, pending };
}

/** Start or extend a pending change; rev holds the entry as it was before this edit. */
function markChanged(docId: string, rev: number) {
  const d = getDoc(docId)!;
  const base = d.spec_state === '' || d.base_rev == null ? rev : d.base_rev;
  const batch = d.spec_state === 'changed' && d.batch_rev != null ? d.batch_rev : rev;
  run("UPDATE docs SET spec_state = 'changed', changed_at = ?, base_rev = ?, batch_rev = ? WHERE id = ?", now(), base, batch, docId);
}

/** Tidy up after an entry is removed: unlink tasks, unattach its decisions. The revisions stay. */
export function afterDocDeleted(doc: Row, by: Editor) {
  recordRevision(doc, doc.id, doc.project_id, 'delete', by);
  run('DELETE FROM doc_links WHERE doc_id = ?', doc.id);
  // Its references (the files the user attached) go with it.
  deleteOwnedBy('doc', doc.id);
  // A task's doc_id never points at an entry that is gone.
  run('UPDATE tasks SET doc_id = NULL, updated_at = ? WHERE doc_id = ?', now(), doc.id);
  run('UPDATE docs SET parent_id = NULL WHERE parent_id = ?', doc.id);
}

export function revisions(docId: string): Row[] {
  return all('SELECT * FROM doc_revisions WHERE doc_id = ? ORDER BY id DESC LIMIT 100', docId).map((r) => ({ ...r, tags: parseTags(r.tags) }));
}

// ---------- importance ----------

/**
 * Importance is scarce and relative within a project, for Spec entries (open
 * goals and designs) and open tasks alike. Critical and High are budgeted per
 * project; agents are refused beyond a budget and told who holds the level, the
 * owner is only warned. A level the owner set is pinned: agents may not change
 * it. Every change is recorded in importance_changes.
 */

export const LEVEL_NAME = ['', 'Minor', 'Low', 'Medium', 'High', 'Critical'];
export type Target = 'doc' | 'task';
export type ImportanceLimits = {
  critical_min: number;
  critical_pct: number;
  high_pct: number;
  task_critical_min: number;
  task_critical_pct: number;
  task_high_pct: number;
};
export const DEFAULT_LIMITS: ImportanceLimits = { critical_min: 3, critical_pct: 10, high_pct: 25, task_critical_min: 3, task_critical_pct: 10, task_high_pct: 25 };
const OPEN_TASK = ['planning', 'waiting', 'scheduled', 'active', 'paused'];
const TARGET_NAME = { doc: 'open goals and designs', task: 'open tasks' };

/** Whether a row counts against its project's budget: open goals and designs, open tasks (discussions are not ranked). */
export function counted(target: Target, r: Row): boolean {
  if (target === 'doc') return STEERABLE.includes(r.kind) && !['done', 'dropped'].includes(r.status);
  return OPEN_TASK.includes(r.state) && r.kind !== 'discussion';
}

export function importanceLimits(projectId: string): ImportanceLimits {
  const raw = get('SELECT importance_limits FROM projects WHERE id = ?', projectId)?.importance_limits;
  try {
    return { ...DEFAULT_LIMITS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULT_LIMITS;
  }
}

export function setImportanceLimits(projectId: string, input: Partial<ImportanceLimits>): ImportanceLimits {
  const cur = importanceLimits(projectId);
  const next = { ...cur };
  for (const k of Object.keys(DEFAULT_LIMITS) as (keyof ImportanceLimits)[]) {
    const v = Number(input[k]);
    if (input[k] !== undefined && Number.isFinite(v)) next[k] = Math.min(k.endsWith('min') ? 50 : 100, Math.max(0, Math.round(v)));
  }
  run('UPDATE projects SET importance_limits = ? WHERE id = ?', JSON.stringify(next), projectId);
  touchProject(projectId);
  return next;
}

function openRows(projectId: string, target: Target): Row[] {
  return target === 'doc'
    ? all("SELECT * FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design') AND status NOT IN ('done','dropped') ORDER BY importance DESC, importance_rank IS NULL, importance_rank, updated_at DESC", projectId)
    : all('SELECT * FROM tasks WHERE project_id = ? ORDER BY importance DESC, position', projectId).filter((t) => counted('task', t));
}

/** How many entries (or tasks) may be Critical and High, how many are, and which. */
export function importanceBudget(projectId: string, target: Target = 'doc') {
  const l = importanceLimits(projectId);
  const [min, cpct, hpct] = target === 'doc' ? [l.critical_min, l.critical_pct, l.high_pct] : [l.task_critical_min, l.task_critical_pct, l.task_high_pct];
  const open = openRows(projectId, target);
  const n = open.length;
  const caps: Record<number, number> = { 5: Math.max(min, Math.floor((n * cpct) / 100)), 4: Math.max(1, Math.floor((n * hpct) / 100)) };
  const level = (lv: number) => {
    const holders = open.filter((d) => d.importance === lv);
    return {
      count: holders.length,
      cap: caps[lv],
      over: holders.length > caps[lv],
      holders: holders.map((d) => ({ id: d.id, kind: d.kind ?? 'task', title: d.title, reason: d.importance_reason, pinned: !!d.importance_pinned, updated_at: d.updated_at })),
    };
  };
  return { open: n, rule: target === 'doc' ? { min, cpct, hpct } : { min, cpct, hpct }, critical: level(5), high: level(4) };
}

const age = (ts: number) => {
  const days = Math.floor((now() - ts) / 86400000);
  return days < 1 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

export function targetOf(id: string): { target: Target; row: Row } | null {
  const task = getTask(id);
  if (task) return { target: 'task', row: task };
  const doc = getDoc(id);
  return doc ? { target: 'doc', row: doc } : null;
}

/**
 * Whether a level may be set: pinned levels are the owner's (agents refused), and Critical and High need a
 * reason and room in the budget. Keeping the level a counted row already holds is always fine.
 * For the owner, problems come back as a warning.
 */
export function checkImportance(
  projectId: string,
  target: Target,
  row: Row | null,
  next: { importance: number; reason: string; counted: boolean },
  by: Editor,
): { error?: string; warning?: string } {
  // The user's own choice is never second-guessed: reasons and budgets bind agents only.
  const say = (msg: string) => (by.author === 'agent' ? { error: msg } : {});
  const what = target === 'doc' ? 'entry' : 'task';
  if (next.importance < 1 || next.importance > 5) return { error: 'Importance is 1 (Minor) to 5 (Critical).' };
  if (by.author === 'agent' && row?.importance_pinned && row.importance !== next.importance) {
    return {
      error:
        `The user set this ${what}'s importance to ${LEVEL_NAME[row.importance]} themselves, so it is pinned and only they can change it. ` +
        (target === 'task'
          ? `If you think it should be ${LEVEL_NAME[next.importance]}, say so with your reason in the task's thread (task_post).`
          : `If you think it should be ${LEVEL_NAME[next.importance]}, record your reason with log_journal (kind note, doc ${row.id}), or raise it with the user.`),
    };
  }
  if (!next.counted || next.importance < 4) return {};
  if (row && counted(target, row) && row.importance === next.importance) return {};
  const name = LEVEL_NAME[next.importance];
  if (!next.reason) {
    return say(`${name} needs a reason: one line anchored on the project's purpose (e.g. "without this the project fails its purpose because…", "blocks X and Y"). Most ${what === 'entry' ? 'entries' : 'tasks'} should be Medium.`);
  }
  const b = importanceBudget(projectId, target);
  const lvl = next.importance === 5 ? b.critical : b.high;
  const others = lvl.holders.filter((h) => h.id !== row?.id);
  if (others.length < lvl.cap) return {};
  const rule = next.importance === 5 ? `${b.rule.min} or ${b.rule.cpct}%, whichever is larger,` : `${b.rule.hpct}%`;
  return say(
    `The ${name} budget for ${TARGET_NAME[target]} is full: ${others.length} of ${lvl.cap} are ${name} (the user's limit is ${rule} of ${b.open}). ` +
      `To make this ${name}, demote one of these first (set_importance does both in one call), or leave it lower:\n` +
      others.map((h) => `- ${h.title} (id ${h.id}${target === 'doc' ? `, ${h.kind}` : ''}, set ${age(h.updated_at)}${h.pinned ? ', pinned by the user' : ''}): ${h.reason || '(no reason given)'}`).join('\n'),
  );
}

/** Write a level (already checked), record the change, pin it if the owner set it, and note it in a task's thread. */
export function applyImportance(projectId: string, target: Target, row: Row, level: number, reason: string, by: Editor, causeTaskId: string | null = null) {
  const changed = row.importance !== level;
  if (!changed && reason === (row.importance_reason ?? '')) return;
  const pinned = by.author === 'user' && changed ? 1 : row.importance_pinned ? 1 : 0;
  if (target === 'doc') {
    run('UPDATE docs SET importance = ?, importance_reason = ?, importance_pinned = ?, importance_rank = CASE WHEN importance = ? THEN importance_rank ELSE NULL END, updated_at = ? WHERE id = ?', level, reason, pinned, level, now(), row.id);
  } else {
    run('UPDATE tasks SET importance = ?, importance_reason = ?, importance_pinned = ?, updated_at = ? WHERE id = ?', level, reason, pinned, now(), row.id);
  }
  if (!changed) return;
  run(
    'INSERT INTO importance_changes (project_id, target, target_id, old_level, new_level, reason, author, author_name, cause_task_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    projectId, target, row.id, row.importance, level, reason, by.author, by.name, causeTaskId, now(),
  );
  if (target === 'task') {
    const cause = causeTaskId && causeTaskId !== row.id ? getTask(causeTaskId) : undefined;
    addTaskMessage(
      row,
      HELM,
      `${by.name} ${level > row.importance ? 'raised' : 'lowered'} its importance from ${LEVEL_NAME[row.importance]} to ${LEVEL_NAME[level]}${reason ? `: ${reason}` : '.'}${cause ? ` (prompted by “${cause.title}”)` : ''}${by.author === 'user' ? ' Pinned: agents leave it as you set it.' : ''}`,
      'state',
    );
  }
}

/**
 * Re-rank several entries and tasks in one call. Demotions apply before
 * promotions, so one call can swap two; if an agent's change is refused,
 * none is applied.
 */
export function setImportance(projectId: string, changes: { id: string; importance: number; reason?: string }[], by: Editor, causeTaskId: string | null = null): { error: string } | { warnings: string[]; applied: number } {
  const warnings: string[] = [];
  const items = changes.map((c) => ({ c, t: targetOf(c.id) }));
  const missing = items.find((i) => !i.t || i.t.row.project_id !== projectId);
  if (missing) return { error: `No entry or task with id ${missing.c.id} on this project.` };
  items.sort((a, b) => a.c.importance - a.t!.row.importance - (b.c.importance - b.t!.row.importance));
  let applied = 0;
  try {
    tx(() => {
      for (const { c, t } of items) {
        const { target } = t!;
        const row = target === 'doc' ? getDoc(c.id)! : getTask(c.id)!;
        if (target === 'task' && row.kind === 'discussion') throw new Error(`${row.title} is a discussion; discussions are not ranked.`);
        const reason = (c.reason ?? (c.importance === row.importance ? row.importance_reason : '')).trim();
        const res = checkImportance(projectId, target, row, { importance: c.importance, reason, counted: counted(target, row) }, by);
        if (res.error) throw new Error(`${row.title}: ${res.error}`);
        if (res.warning) warnings.push(`${row.title}: ${res.warning}`);
        applyImportance(projectId, target, row, c.importance, reason, by, causeTaskId);
        applied++;
      }
    });
  } catch (err: any) {
    return { error: err.message };
  }
  touchProject(projectId);
  return { warnings, applied };
}

export function unpinImportance(target: Target, row: Row) {
  if (target === 'doc') run('UPDATE docs SET importance_pinned = 0, importance_rank = NULL WHERE id = ?', row.id);
  else run('UPDATE tasks SET importance_pinned = 0 WHERE id = ?', row.id);
  touchProject(row.project_id);
}

/**
 * A new task's level: the explicit one if given and allowed, else the highest among the entries it
 * implements (Medium without any), lowered to the highest level that still has room in the task budget.
 */
export function initTaskImportance(task: Row, explicit: number | undefined, reason: string, by: Editor): string {
  const inherited = Number(get("SELECT MAX(d.importance) AS m FROM doc_links l JOIN docs d ON d.id = l.doc_id WHERE l.task_id = ? AND l.relation = 'implements'", task.id)?.m ?? 3);
  let level = explicit ?? inherited;
  let note = '';
  const isCounted = counted('task', task);
  if (by.author === 'agent' && isCounted) {
    while (level >= 4 && checkImportance(task.project_id, 'task', null, { importance: level, reason: reason || 'inherited from the entry it implements', counted: true }, by).error) level--;
    if (level !== (explicit ?? inherited)) note = ` It starts at ${LEVEL_NAME[level]}: the ${LEVEL_NAME[explicit ?? inherited]} budget for tasks is full (list_importance shows who holds it; set_importance can swap).`;
  }
  run('UPDATE tasks SET importance = ?, importance_reason = ? WHERE id = ?', level, reason || (explicit === undefined && inherited >= 4 ? 'inherited from the entry it implements' : ''), task.id);
  touchProject(task.project_id);
  return `Importance ${LEVEL_NAME[level]}${explicit === undefined ? ' (inherited)' : ''}.${note}`;
}

/**
 * The owner places an entry in a tier: optionally a new level, then a place in that tier
 * (before or after another entry, or at the top). Pinned, like any level the owner sets.
 */
export function placeDoc(doc: Row, level: number, place: { before?: string; after?: string; top?: boolean }): { warnings: string[] } | { error: string } {
  let warnings: string[] = [];
  if (level !== doc.importance) {
    const res = setImportance(doc.project_id, [{ id: doc.id, importance: level, reason: doc.importance_reason }], { author: 'user', name: 'You' });
    if ('error' in res) return res;
    warnings = res.warnings;
  }
  const tier = all("SELECT * FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design') AND status NOT IN ('done','dropped') AND importance = ? AND id != ? ORDER BY importance_rank IS NULL, importance_rank, updated_at DESC", doc.project_id, level, doc.id).map((d) => d.id);
  const ref = place.before ?? place.after;
  let at = place.top ? 0 : tier.length;
  if (ref && tier.includes(ref)) at = tier.indexOf(ref) + (place.after ? 1 : 0);
  tier.splice(at, 0, doc.id);
  setImportanceOrder(doc.project_id, tier);
  run('UPDATE docs SET importance_pinned = 1 WHERE id = ?', doc.id);
  return { warnings };
}

/** The owner's order of entries within one importance level. */
export function setImportanceOrder(projectId: string, ids: string[]) {
  tx(() => ids.forEach((id, i) => run('UPDATE docs SET importance_rank = ? WHERE id = ? AND project_id = ?', i + 1, id, projectId)));
  touchProject(projectId);
}

export function importanceHistory(targetId: string): Row[] {
  return all(
    'SELECT c.*, t.title AS cause_title FROM importance_changes c LEFT JOIN tasks t ON t.id = c.cause_task_id WHERE c.target_id = ? ORDER BY c.id DESC LIMIT 50',
    targetId,
  );
}

/** The latest importance change of each row in a project within the last 36 hours, for the raised/lowered marker. */
export function recentImportanceChanges(projectId: string): Row[] {
  return all(
    'SELECT c.target_id, c.old_level, c.new_level, c.reason, c.author_name, c.created_at FROM importance_changes c WHERE c.project_id = ? AND c.created_at > ? AND c.id = (SELECT MAX(id) FROM importance_changes x WHERE x.target_id = c.target_id)',
    projectId, now() - 36 * 3600 * 1000,
  );
}

/** Entries and tasks by level with reasons, for a director recalibrating. */
export function renderImportance(projectId: string, opts: { target?: Target; min_level?: number } = {}): string {
  const out: string[] = [];
  for (const target of (opts.target ? [opts.target] : ['doc', 'task']) as Target[]) {
    const b = importanceBudget(projectId, target);
    const rows = openRows(projectId, target);
    out.push(
      `# ${target === 'doc' ? 'Spec entries' : 'Tasks'} — ${b.open} ${TARGET_NAME[target]}. Critical ${b.critical.count} of ${b.critical.cap}${b.critical.over ? ' (OVER: demote before promoting)' : ''}, High ${b.high.count} of ${b.high.cap}${b.high.over ? ' (OVER: demote before promoting)' : ''}.`,
    );
    for (let l = 5; l >= Math.max(1, opts.min_level ?? 1); l--) {
      const list = rows.filter((d) => d.importance === l);
      if (!list.length) continue;
      out.push(
        `## ${LEVEL_NAME[l]} (${l})\n` +
          list
            .map((d) => `- ${d.title} (id ${d.id}${target === 'task' ? `, ${d.state}` : `, ${d.kind}`}${d.importance_pinned ? ', pinned by the user' : ''})${d.importance_reason ? `: ${d.importance_reason}` : l >= 4 ? ': (no reason given)' : ''}`)
            .join('\n'),
      );
    }
  }
  return out.join('\n\n');
}

// ---------- links to tasks ----------

export const LINK_RELATIONS = ['implements', 'changed', 'discusses'];

export function linkDoc(docId: string, taskId: string, relation: 'implements' | 'changed' | 'discusses', revisionId: number | null = null, note = '') {
  run('INSERT OR IGNORE INTO doc_links (doc_id, task_id, relation, revision_id, note, created_at) VALUES (?,?,?,?,?,?)', docId, taskId, relation, revisionId, note, now());
}

type Snapshot = { title: string; summary: string; body: string };
const snap = (r: Row): Snapshot => ({ title: r.title ?? '', summary: r.summary ?? '', body: r.body ?? '' });

/** The entry as it was after the change recorded in revision revId: the next revision's snapshot, or the entry now. */
function stateAfter(docId: string, revId: number): Snapshot | null {
  const next = get('SELECT * FROM doc_revisions WHERE doc_id = ? AND id > ? ORDER BY id LIMIT 1', docId, revId);
  if (next) return snap(next);
  const d = getDoc(docId);
  return d ? snap(d) : null;
}

/** How a task row is named in links: discussions (tasks.kind, where that column exists) and tasks alike. */
function taskLabel(t: Row) {
  return { id: t.id, title: t.title, state: t.state, kind: t.kind ?? 'task', updated_at: t.updated_at };
}

/** The changes one task made to one entry, merged into a single before/after. */
function mergedChange(docId: string, revIds: number[]) {
  const first = Math.min(...revIds);
  const last = Math.max(...revIds);
  const before = get('SELECT * FROM doc_revisions WHERE id = ?', first);
  const lastRev = get('SELECT * FROM doc_revisions WHERE id = ?', last);
  return {
    isNew: before?.op === 'create',
    before: before && before.op !== 'create' ? snap(before) : { title: '', summary: '', body: '' },
    after: stateAfter(docId, last),
    at: lastRev?.created_at ?? 0,
    by: lastRev?.author_name ?? '',
  };
}

/** For an entry: the tasks and discussions that changed it (newest first, with the diff) and every task that implements or implemented it. */
export function docHistory(docId: string) {
  const links = all('SELECT l.*, t.* , l.created_at AS linked_at FROM doc_links l JOIN tasks t ON t.id = l.task_id WHERE l.doc_id = ? ORDER BY l.id', docId);
  const changed = new Map<string, { task: Row; revs: number[] }>();
  for (const l of links.filter((l) => l.relation === 'changed' && l.revision_id != null)) {
    const g = changed.get(l.task_id) ?? { task: l, revs: [] };
    g.revs.push(l.revision_id);
    changed.set(l.task_id, g);
  }
  return {
    changes: [...changed.values()].map((g) => ({ task: taskLabel({ ...g.task, id: g.task.task_id }), ...mergedChange(docId, g.revs) })).sort((a, b) => b.at - a.at),
    implements: links.filter((l) => l.relation === 'implements').map((l) => ({ ...taskLabel({ ...l, id: l.task_id }), linked_at: l.linked_at })).sort((a, b) => b.updated_at - a.updated_at),
    // Discussions about the entry (Discuss on it, server/specdiscuss.ts), open and settled.
    discussions: links
      .filter((l) => l.relation === 'discusses')
      .map((l) => ({ ...taskLabel({ ...l, id: l.task_id }), linked_at: l.linked_at, messages: Number(get("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND kind = 'message'", l.task_id)?.n ?? 0) }))
      .sort((a, b) => b.updated_at - a.updated_at),
    revisions: revisions(docId),
    importance: importanceHistory(docId),
    records: docRecords(docId),
  };
}

/** For a task page: the entries it implements, and the Spec changes it led to with their diffs. */
export function taskSpec(taskId: string) {
  const links = all('SELECT l.*, d.kind, d.title, d.status, d.summary FROM doc_links l LEFT JOIN docs d ON d.id = l.doc_id WHERE l.task_id = ? ORDER BY l.id', taskId);
  const changed = new Map<string, { link: Row; revs: number[] }>();
  for (const l of links.filter((l) => l.relation === 'changed' && l.revision_id != null)) {
    const g = changed.get(l.doc_id) ?? { link: l, revs: [] };
    g.revs.push(l.revision_id);
    changed.set(l.doc_id, g);
  }
  return {
    implements: links.filter((l) => l.relation === 'implements' && l.title != null).map((l) => ({ id: l.doc_id, kind: l.kind, title: l.title, status: l.status, summary: l.summary })),
    changes: [...changed.values()].map((g) => {
      const c = mergedChange(g.link.doc_id, g.revs);
      const title = g.link.title ?? c.after?.title ?? c.before.title;
      return { doc: { id: g.link.doc_id, kind: g.link.kind ?? '', title, removed: g.link.title == null }, ...c };
    }),
  };
}

// ---------- diffs ----------

export type Op = { op: '=' | '-' | '+'; text: string };

/** Longest-common-subsequence diff of two token lists, merged into runs. */
export function diffTokens(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  if (A.length * B.length > 4_000_000) {
    A.forEach((t) => mid.push({ op: '-', text: t }));
    B.forEach((t) => mid.push({ op: '+', text: t }));
  } else {
    const n = A.length;
    const m = B.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        mid.push({ op: '=', text: A[i] });
        i++;
        j++;
      } else if (i < n && (j === m || L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1])) mid.push({ op: '-', text: A[i++] });
      else mid.push({ op: '+', text: B[j++] });
    }
  }
  const ops = [...a.slice(0, pre).map((t) => ({ op: '=' as const, text: t })), ...mid, ...a.slice(a.length - suf).map((t) => ({ op: '=' as const, text: t }))];
  const out: Op[] = [];
  for (const o of ops) {
    const last = out[out.length - 1];
    if (last && last.op === o.op) last.text += o.text;
    else out.push({ ...o });
  }
  return out;
}

export const words = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
const lines = (s: string) => (s ? s.split('\n').map((l) => l + '\n') : []);

export type FieldChange = { field: 'title' | 'summary' | 'body'; before: string; after: string };
export type EntryChange = { doc_id: string; kind: string; title: string; isNew: boolean; fields: FieldChange[] };

/** What changed in an entry since the revision `revId` (empty when nothing in title, summary or body did). */
export function entryChange(doc: Row, revId: number | null): EntryChange {
  const rev = revId != null ? get('SELECT * FROM doc_revisions WHERE id = ?', revId) : undefined;
  const isNew = !rev || rev.op === 'create';
  const fields: FieldChange[] = [];
  for (const f of CONTENT) {
    const before = isNew ? '' : String(rev![f] ?? '');
    const after = String(doc[f] ?? '');
    if (before !== after) fields.push({ field: f, before, after });
  }
  return { doc_id: doc.id, kind: doc.kind, title: doc.title, isNew, fields };
}

const quote = (s: string) => (s.trim() ? s.trim().split('\n').map((l) => `> ${l}`).join('\n') : '> (empty)');

/** A change as markdown for the director: titles and summaries before/after, bodies as a line diff with context. */
export function changeMarkdown(c: EntryChange): string {
  const out = [`### ${c.isNew ? 'New ' : ''}${c.kind}: ${c.title} [[${c.doc_id}]]`];
  if (c.isNew) {
    const f = (name: string) => c.fields.find((x) => x.field === name)?.after ?? '';
    if (f('summary')) out.push(`Summary:\n${quote(f('summary'))}`);
    out.push(`Body:\n${quote(f('body'))}`);
    return out.join('\n\n');
  }
  for (const f of c.fields) {
    if (f.field !== 'body') {
      out.push(`${f.field === 'title' ? 'Title' : 'Summary'} was:\n${quote(f.before)}\nnow:\n${quote(f.after)}`);
      continue;
    }
    const ops = diffTokens(lines(f.before), lines(f.after));
    const rows: string[] = [];
    ops.forEach((o, i) => {
      const ls = o.text.replace(/\n$/, '').split('\n');
      if (o.op !== '=') return rows.push(...ls.map((l) => `${o.op} ${l}`));
      // Two lines of context either side of each change.
      const head = i > 0 ? ls.slice(0, 2) : [];
      const tail = i < ops.length - 1 ? ls.slice(-2) : [];
      if (ls.length > head.length + tail.length) rows.push(...head.map((l) => `  ${l}`), '  …', ...tail.map((l) => `  ${l}`));
      else rows.push(...ls.map((l) => `  ${l}`));
    });
    out.push('Body (- removed, + added):\n```diff\n' + rows.join('\n') + '\n```');
  }
  return out.join('\n\n');
}

// ---------- the quiet period ----------

let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let tellDirector: (projectId: string, text: string) => Promise<void> = async () => {};

/** Projects whose pending spec edits have been quiet long enough, and when each is due. */
export function pendingChanges(projectId: string): { count: number; dueAt: number | null } {
  const r = get("SELECT COUNT(*) AS n, MAX(changed_at) AS last FROM docs WHERE project_id = ? AND spec_state = 'changed'", projectId);
  return { count: Number(r?.n ?? 0), dueAt: r?.last ? Number(r.last) + QUIET_MS : null };
}

export async function flushDue() {
  if (flushing) return;
  flushing = true;
  try {
    const due = all("SELECT project_id, MAX(changed_at) AS last FROM docs WHERE spec_state = 'changed' GROUP BY project_id").filter((r) => now() - Number(r.last) >= QUIET_MS);
    for (const r of due) await flushProject(r.project_id);
  } catch (err) {
    console.error('spec: flushing pending changes failed', err);
  } finally {
    flushing = false;
  }
}

/**
 * Turn a project's pending edits into planning discussions: entries that are
 * already part of an open planning task are added to it, the rest go into one
 * new planning task. The first message of each batch is the diff.
 */
export async function flushProject(projectId: string) {
  const docs = all("SELECT * FROM docs WHERE project_id = ? AND spec_state = 'changed' ORDER BY changed_at", projectId);
  if (!docs.length) return;
  const groups = new Map<string, Row[]>();
  const fresh: Row[] = [];
  for (const d of docs) {
    const t = d.plan_task_id ? getTask(d.plan_task_id) : undefined;
    const c = entryChange(d, d.batch_rev);
    if (!c.isNew && !c.fields.length) {
      // The edits cancelled out: the entry is back to how it stood before them.
      const base = entryChange(d, d.base_rev);
      const state = t?.state === 'planning' ? 'planning' : base.isNew || base.fields.length ? 'not_planned' : '';
      run('UPDATE docs SET spec_state = ?, changed_at = NULL, batch_rev = NULL, base_rev = ? WHERE id = ?', state, state ? d.base_rev : null, d.id);
      continue;
    }
    if (t && t.state === 'planning') groups.set(t.id, [...(groups.get(t.id) ?? []), d]);
    else fresh.push(d);
  }
  const notes: string[] = [];
  if (!groups.size && !fresh.length) return touchProject(projectId);
  for (const [taskId, list] of groups) notes.push(postBatch(getTask(taskId)!, list, false));
  if (fresh.length) {
    const title = fresh.length === 1 ? `Spec change: ${fresh[0].title}` : `Spec changes: ${fresh.length} entries`;
    const description =
      `Planning the work to bring the project in line with your edit${fresh.length > 1 ? 's' : ''} to the Spec:\n` +
      fresh.map((d) => `- ${d.kind} **${d.title}**`).join('\n') +
      `\n\nThe director replies here with a plan. Nothing is started until you approve this task.`;
    // An open discussion about one of these entries (Discuss, server/specdiscuss.ts) is the conversation about the change,
    // so it becomes the planning task in place: the one an applied edit came from first, else the most recent.
    const ids = fresh.map((d) => d.id);
    const disc = get(
      `SELECT t.*, l.doc_id AS about FROM doc_links l JOIN tasks t ON t.id = l.task_id
        WHERE l.doc_id IN (${ids.map(() => '?').join(',')}) AND l.relation = 'discusses' AND t.kind = 'discussion' AND t.state = 'open'
        ORDER BY EXISTS (SELECT 1 FROM doc_links c WHERE c.task_id = t.id AND c.doc_id = l.doc_id AND c.relation = 'changed') DESC, t.updated_at DESC LIMIT 1`,
      ...ids,
    );
    let task: Row;
    if (disc) {
      task = discussionToTask(disc, { state: 'planning', title: title.slice(0, 140), description, origin: 'doc' }, HELM);
      run('UPDATE tasks SET doc_id = ?, updated_at = ? WHERE id = ?', disc.about, now(), task.id);
      task = getTask(task.id)!;
    } else task = createTask(projectId, { title: title.slice(0, 140), description, state: 'planning', doc_id: fresh[0].id, origin: 'doc' }, HELM);
    notes.push(postBatch(task, fresh, true, !!disc));
  }
  touchProject(projectId);
  for (const n of notes) await tellDirector(projectId, n);
}

function postBatch(task: Row, list: Row[], created: boolean, fromDiscussion = false): string {
  const changes = list.map((d) => entryChange(d, d.batch_rev)).filter((c) => c.isNew || c.fields.length);
  tx(() => {
    for (const d of list) {
      // The owner's edits in this batch led to the task; the task is also the work to bring the project in line.
      for (const r of all("SELECT id FROM doc_revisions WHERE doc_id = ? AND id >= ? AND author = 'user' AND op IN ('create', 'edit')", d.id, d.batch_rev ?? 0)) linkDoc(d.id, task.id, 'changed', r.id);
      linkDoc(d.id, task.id, 'implements');
      run("UPDATE docs SET spec_state = 'planning', plan_task_id = ?, batch_rev = NULL, changed_at = NULL WHERE id = ?", task.id, d.id);
      // Any other open discussion about the entry is done: the change is planned in this task. It is settled, and linked
      // so the task's history shows it (a discussion never stays open with a task hanging off it).
      for (const disc of all("SELECT t.* FROM doc_links l JOIN tasks t ON t.id = l.task_id WHERE l.doc_id = ? AND l.relation = 'discusses' AND t.kind = 'discussion' AND t.state = 'open' AND t.id != ?", d.id, task.id)) {
        run('INSERT OR IGNORE INTO discussion_tasks (discussion_id, task_id, created_at) VALUES (?,?,?)', disc.id, task.id, now());
        addTaskMessage(task, HELM, `Came from the discussion "${disc.title}".`, 'state');
        settleDiscussion(disc, `The edit to "${d.title}" was applied; planning continues in the task "${task.title}".`, HELM);
      }
    }
  });
  const intro = created ? 'You changed the Spec.' : 'You changed the Spec again while this is being planned.';
  addTaskMessage(task, HELM, JSON.stringify({ intro, entries: changes }), 'change');
  const diff = changes.length ? changes.map(changeMarkdown).join('\n\n') : '(The edits cancel out: the text is back to what it was.)';
  if (created) {
    return (
      (fromDiscussion
        ? `The user applied a Spec edit from their discussion about it, and that discussion became ${taskRef(task)}, in Planning, in place: its thread (your proposals included) is the start of the task's history. What changed:\n\n${diff}\n\n`
        : `The user edited the Spec. Helm opened ${taskRef(task)} in Planning for it. What changed:\n\n${diff}\n\n`) +
      `Reply in that task's thread with task_post, giving a plan: what you understood the change to mean, what must change in the project to match it, what is unclear or risky, and a rough size. ` +
      `Ask your questions in the same thread (task_post, or ask_user with task="${task.id}"), and keep the task's description current with the plan as it is agreed. ` +
      `Do not start any work on it, change files or spawn agents for it until the user approves the task: a Planning task is a discussion, not permission.`
    );
  }
  return (
    `The user edited the Spec again; the change is part of ${taskRef(task)}, which is still in Planning. What changed this time:\n\n${diff}\n\n` +
    `Revise your plan in that task's thread with task_post and say what is different. Still do not start any work until the user approves it.`
  );
}

export function startSpecTimer(notify: (projectId: string, text: string) => Promise<void>) {
  tellDirector = notify;
  if (timer) return;
  timer = setInterval(flushDue, Math.min(5000, Math.max(500, QUIET_MS / 4)));
  void flushDue();
}

export function stopSpecTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------- the owner's decision on a planning task ----------

/** Approve, Start or Drop on a task: settle the entries it was planning. */
export function onTaskDecision(task: Row, action: string) {
  const docs = all('SELECT * FROM docs WHERE plan_task_id = ?', task.id);
  if (!docs.length) return;
  for (const d of docs) {
    if (action === 'approve' || action === 'start') {
      // The project now aims at the edited entry. Edits made after the plan was posted stay pending, measured from there.
      if (d.spec_state === 'changed') run('UPDATE docs SET plan_task_id = NULL, base_rev = batch_rev WHERE id = ?', d.id);
      else run("UPDATE docs SET spec_state = '', plan_task_id = NULL, base_rev = NULL, batch_rev = NULL WHERE id = ?", d.id);
    } else if (action === 'drop') {
      if (d.spec_state === 'changed') run('UPDATE docs SET plan_task_id = NULL WHERE id = ?', d.id);
      else run("UPDATE docs SET spec_state = 'not_planned', plan_task_id = NULL WHERE id = ?", d.id);
    }
  }
  touchProject(task.project_id);
}

/**
 * Put an entry back as it was before the owner's unplanned edits. A new entry
 * is removed. Returns a note for the director when a planning discussion was
 * still open about it, so it can drop the entry from its plan.
 */
export function revertDoc(doc: Row, by: Editor): { removed: boolean; note: string | null } | { error: string } {
  if (doc.base_rev == null || !doc.spec_state) return { error: 'There is no unplanned edit to revert on this entry.' };
  const rev = get('SELECT * FROM doc_revisions WHERE id = ?', doc.base_rev);
  if (!rev) return { error: 'The earlier version of this entry is missing.' };
  const openTask = doc.plan_task_id ? getTask(doc.plan_task_id) : undefined;
  const open = openTask && openTask.state === 'planning' ? openTask : undefined;
  let removed = false;
  tx(() => {
    if (rev.op === 'create') {
      run('DELETE FROM docs WHERE id = ?', doc.id);
      afterDocDeleted(doc, by);
      removed = true;
    } else {
      recordRevision(doc, doc.id, doc.project_id, 'revert', by);
      run(
        "UPDATE docs SET title = ?, summary = ?, body = ?, section_id = ?, tags = ?, spec_state = '', changed_at = NULL, plan_task_id = NULL, base_rev = NULL, batch_rev = NULL, updated_at = ? WHERE id = ?",
        rev.title, rev.summary, rev.body, rev.section_id, rev.tags, now(), doc.id,
      );
    }
  });
  let note: string | null = null;
  if (open) {
    addTaskMessage(open, HELM, `You reverted your edit to the ${doc.kind} “${doc.title}”${removed ? ', which removed the new entry' : ''}.`, 'state');
    note = `The user reverted their edit to the ${doc.kind} "${doc.title}" (id ${doc.id})${removed ? ' and so removed that new entry' : ''}. It is no longer part of the change planned in ${taskRef(open)}: drop it from the plan, and say in the thread what is left.`;
  }
  touchProject(doc.project_id);
  return { removed, note };
}

// ---------- reading the spec ----------

/** Entries and sections for the dashboard. */
export function specState(projectId: string) {
  return {
    sections: listSections(projectId),
    docLinks: all('SELECT l.doc_id, l.task_id, l.relation, l.revision_id, l.created_at FROM doc_links l JOIN tasks t ON t.id = l.task_id WHERE t.project_id = ? ORDER BY l.id', projectId),
    pending: pendingChanges(projectId),
    budget: importanceBudget(projectId, 'doc'),
    taskBudget: importanceBudget(projectId, 'task'),
    limits: importanceLimits(projectId),
    importanceRecent: recentImportanceChanges(projectId),
    quietSeconds: QUIET_MS / 1000,
  };
}

/** Does this project's Spec need organising: entries without a section or a summary? */
export function unorganised(projectId: string): { unsectioned: number; unsummarised: number; total: number } {
  const r = get(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN kind IN ('entry','goal','design') AND section_id IS NULL THEN 1 ELSE 0 END) AS unsectioned,
       SUM(CASE WHEN kind IN ('entry','goal','design') AND summary = '' THEN 1 ELSE 0 END) AS unsummarised
     FROM docs WHERE project_id = ?`,
    projectId,
  );
  return { total: Number(r?.total ?? 0), unsectioned: Number(r?.unsectioned ?? 0), unsummarised: Number(r?.unsummarised ?? 0) };
}

const SPEC_STATE_TEXT: Record<string, string> = {
  changed: 'changed by the user, not yet planned',
  planning: 'plan under discussion',
  not_planned: 'changed by the user, not planned (the plan was dropped)',
};

/**
 * The Spec as text for agents: sections in order with their descriptions; each
 * entry with its summary, tags and how many decisions and notes its history
 * holds. Bodies only for the ids asked for, or for everything with full.
 */
export function renderSpec(projectId: string, opts: { ids?: string[]; full?: boolean; section?: string; tag?: string } = {}): string {
  const every = all("SELECT * FROM docs WHERE project_id = ? AND kind IN ('entry','goal','design') ORDER BY importance DESC, importance_rank IS NULL, importance_rank, updated_at DESC", projectId);
  if (!every.length) return 'The Spec is empty: no entries yet.';
  const tag = opts.tag?.trim().replace(/^#/, '').toLowerCase();
  const docs = tag ? every.filter((d) => parseTags(d.tags).some((t) => t.toLowerCase() === tag)) : every;
  if (!docs.length) return `No entry is tagged "${tag}". Tags in use: ${tagVocabulary(projectId)}.`;
  const recorded = new Map<string, number>();
  for (const r of all("SELECT doc_id, COUNT(*) AS n FROM doc_history_items WHERE project_id = ? GROUP BY doc_id UNION ALL SELECT doc_id, COUNT(*) FROM journal WHERE project_id = ? AND kind = 'decision' AND doc_id IS NOT NULL GROUP BY doc_id", projectId, projectId)) {
    recorded.set(r.doc_id, (recorded.get(r.doc_id) ?? 0) + Number(r.n));
  }
  const want = new Set(opts.ids ?? []);
  const showBody = (d: Row) => opts.full || want.has(d.id);
  const summaryOf = (d: Row) => (d.summary ? d.summary : `${firstSentence(d.body)} (no summary yet)`);
  const line = (d: Row, indent = '') => {
    const tags = parseTags(d.tags);
    const bits = [`${indent}- ${d.title} ([[${d.id}]], ${LEVEL_NAME[d.importance] ?? d.importance}${d.importance_pinned ? ' (pinned by the user)' : ''}${d.importance >= 4 && d.importance_reason ? `: ${d.importance_reason}` : ''}; ${d.status}${d.spec_state ? `, ${SPEC_STATE_TEXT[d.spec_state]}` : ''})${tags.length ? ` #${tags.join(' #')}` : ''}`];
    bits.push(`${indent}  ${summaryOf(d)}`);
    if (recorded.get(d.id)) bits.push(`${indent}  history: ${recorded.get(d.id)} recorded decision(s) and note(s)`);
    if (showBody(d)) bits.push(d.body.trim() ? d.body.trim().split('\n').map((l: string) => `${indent}  | ${l}`).join('\n') : `${indent}  | (no body)`);
    return bits.join('\n');
  };
  const entry = (d: Row) => line(d);

  // Sections nest (sections.ts): each heading is the section's full path, with as many #s as its depth, and the count
  // of every entry beneath it. Entries sit under the section they are directly in.
  const tree = sectionTree(projectId);
  const { total } = entryCounts(projectId, tree);
  let only: Set<string> | null = null;
  if (opts.section) {
    const r = resolveSection(projectId, opts.section, tree);
    if ('error' in r) return `${r.error} Sections:\n${walkTree(tree).map(({ s, depth }) => `${'  '.repeat(depth - 1)}- ${pathText(tree, s.id)}`).join('\n') || '(none)'}`;
    only = new Set(subtreeIds(tree, r.section.id));
  }
  const groups: { title: string; description: string; docs: Row[]; count: number }[] = walkTree(tree)
    .filter(({ s }) => !only || only.has(s.id))
    .map(({ s, depth }) => ({ title: `${'#'.repeat(depth)} ${pathText(tree, s.id)}`, description: s.description, docs: docs.filter((d) => d.section_id === s.id), count: total.get(s.id) ?? 0 }));
  if (!only) groups.push({ title: '# No section', description: '', docs: docs.filter((d) => !d.section_id || !tree.byId.has(d.section_id)), count: 0 });
  const out: string[] = [];
  for (const g of groups) {
    if (!g.docs.length && g.title === '# No section') continue;
    const n = g.title === '# No section' ? g.docs.length : g.count;
    out.push([`${g.title} (${n} entr${n === 1 ? 'y' : 'ies'})${g.description ? ` — ${g.description}` : ''}`, ...g.docs.map(entry), ...(g.docs.length || g.count ? [] : ['(empty)'])].join('\n'));
  }
  if (!out.length) return 'The Spec has no entries in that section.';
  const missing = [...want].filter((id) => !docs.some((d) => d.id === id));
  const vocab = `\n\nTags in use (reuse these; at most ${MAX_TAGS} per entry): ${tagVocabulary(projectId)}.`;
  const hint = opts.full ? '' : '\n\nBodies are omitted. Call list_docs with ids to read the full text of the entries you need (or full: true for everything).';
  return out.join('\n\n') + (missing.length ? `\n\nNo entry with id ${missing.join(', ')}.` : '') + vocab + hint;
}

// ---------- decisions and notes as history ----------

/**
 * What an entry's history records besides edits: decisions and notes that were entries once (moved here by
 * foldSpecKinds, with their original dates), and journal decisions that name the entry or come from a task or
 * discussion linked to it. Newest first.
 */
export function docRecords(docId: string): Row[] {
  const items = all('SELECT * FROM doc_history_items WHERE doc_id = ?', docId).map((h) => ({
    key: `h${h.id}`, source: 'moved', kind: h.kind, title: h.title, summary: h.summary, body: h.body, author: h.author, at: h.created_at, task: null,
  }));
  const journal = all(
    `SELECT j.*, a.name AS agent_name, t.id AS t_id, t.title AS t_title, t.kind AS t_kind FROM journal j
       LEFT JOIN agents a ON a.id = j.agent_id LEFT JOIN tasks t ON t.id = j.task_id
     WHERE j.kind = 'decision' AND (j.doc_id = ? OR j.task_id IN (SELECT task_id FROM doc_links WHERE doc_id = ?))`,
    docId, docId,
  ).map((j) => ({
    key: `j${j.id}`, source: 'journal', kind: 'decision', title: j.title, summary: '', body: j.body, author: j.agent_name ?? 'You', at: j.ts,
    task: j.t_id ? { id: j.t_id, title: j.t_title, kind: j.t_kind ?? 'task' } : null,
  }));
  return [...items, ...journal].sort((a, b) => b.at - a.at);
}

/**
 * The move to one kind of entry, run at every start and idempotent, in one transaction:
 * goals and designs become 'entry'; each decision or note attached to an entry becomes a history item of it;
 * each loose one becomes a settled discussion (title kept, summary or first sentence as conclusion, text as the
 * first message, original dates and author). doc_conversions records where each went. Nothing is lost: the old
 * row's content is also kept as a 'delete' revision.
 */
export function foldSpecKinds(): { entries: number; history: number; discussions: number } {
  const counts = { entries: 0, history: 0, discussions: 0 };
  tx(() => {
    counts.entries = Number(run("UPDATE docs SET kind = 'entry' WHERE kind IN ('goal', 'design')").changes);
    const old = all("SELECT * FROM docs WHERE kind IN ('decision', 'note') ORDER BY created_at");
    for (const d of old) {
      const parent = d.parent_id ? get("SELECT id FROM docs WHERE id = ? AND kind IN ('entry','goal','design')", d.parent_id) : undefined;
      const author = d.author || 'You';
      if (parent) {
        run(
          'INSERT OR IGNORE INTO doc_history_items (doc_id, project_id, kind, title, summary, body, author, source_doc_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          parent.id, d.project_id, d.kind, d.title, d.summary ?? '', d.body ?? '', author, d.id, d.created_at, d.updated_at,
        );
        const item = get('SELECT id FROM doc_history_items WHERE source_doc_id = ?', d.id)!;
        run('INSERT OR IGNORE INTO doc_conversions (doc_id, project_id, kind, target, target_id, created_at) VALUES (?,?,?,?,?,?)', d.id, d.project_id, d.kind, 'history', String(item.id), now());
        counts.history++;
      } else {
        const id = newId('disc');
        const conclusion = (d.summary || firstSentence(d.body ?? '') || d.title).trim();
        const fromUser = author === 'You';
        run(
          "INSERT INTO tasks (id, project_id, kind, title, description, state, position, origin, conclusion, status_summary, created_at, updated_at) VALUES (?,?, 'discussion', ?, '', 'settled', 0, ?, ?, '', ?, ?)",
          id, d.project_id, d.title, fromUser ? 'user' : 'director', conclusion, d.created_at, d.updated_at,
        );
        run(
          "INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?, 'system', 'Helm', 'state', ?, ?)",
          id, `Moved from the Spec: this was a ${d.kind} there, recorded by ${author}.`, d.created_at,
        );
        if ((d.body ?? '').trim()) {
          run('INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?,?,?,?,?,?)', id, fromUser ? 'user' : 'director', author, 'message', d.body, d.created_at);
        }
        run('INSERT OR IGNORE INTO doc_conversions (doc_id, project_id, kind, target, target_id, created_at) VALUES (?,?,?,?,?,?)', d.id, d.project_id, d.kind, 'discussion', id, now());
        counts.discussions++;
      }
      // The row goes; its content stays in the history item or discussion, and as a revision.
      run('DELETE FROM docs WHERE id = ?', d.id);
      afterDocDeleted(d, { author: 'agent', name: 'Helm' });
    }
  });
  return counts;
}
