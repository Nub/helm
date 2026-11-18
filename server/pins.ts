import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { attachmentView } from './attachments.ts';
import { inboxView, touchProject } from './store.ts';
import { addTaskMessage, getTask, previewRow } from './tasks.ts';
import type { Author } from './tasks.ts';

/**
 * Pinned proposals: a small ordered set of items (previews or attachments) at the very top of a task or discussion,
 * the options the director is asking the user to look at, so they never have to dig through a long thread for them.
 *
 * Pins come in numbered rounds. The highest round with pinned items is the one shown; earlier rounds collapse into
 * "Earlier proposals". Each round may carry a question and be linked to a request (ask_user): its answer controls sit
 * under the items, and when the user answers, the choice is recorded on the round (and the chosen item stays shown).
 * Unpinning only marks the pin; the preview or attachment itself is never touched.
 */

export type PinInput = { id: string; label?: string };

const clean = (s: string | undefined, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What `id` names on the project: a preview or an attachment. */
function resolveItem(projectId: string, id: string): { preview_id: string } | { attachment_id: string } | null {
  if (get('SELECT id FROM previews WHERE id = ? AND project_id = ?', id, projectId)) return { preview_id: id };
  if (get('SELECT id FROM attachments WHERE id = ? AND project_id = ?', id, projectId)) return { attachment_id: id };
  return null;
}

const itemId = (p: Row) => (p.preview_id ?? p.attachment_id) as string;

function activePins(taskId: string, round?: number): Row[] {
  return round === undefined
    ? all('SELECT * FROM pins WHERE task_id = ? AND unpinned_at IS NULL ORDER BY round, position, id', taskId)
    : all('SELECT * FROM pins WHERE task_id = ? AND round = ? AND unpinned_at IS NULL ORDER BY position, id', taskId, round);
}

const roundRow = (taskId: string, round: number) => get('SELECT * FROM proposal_rounds WHERE task_id = ? AND round = ?', taskId, round);

function ensureRound(taskId: string, round: number): Row {
  run('INSERT OR IGNORE INTO proposal_rounds (task_id, round, created_at) VALUES (?,?,?)', taskId, round, now());
  return roundRow(taskId, round)!;
}

/**
 * The round shown: the highest with pinned items; else the highest whose question or linked request is still
 * waiting (a proposal can be a question alone); 0 when there is no proposal.
 */
export function currentRound(taskId: string): number {
  const pinned = get('SELECT MAX(round) AS r FROM pins WHERE task_id = ? AND unpinned_at IS NULL', taskId)?.r as number | null;
  const asked = get(
    "SELECT MAX(r.round) AS r FROM proposal_rounds r LEFT JOIN inbox i ON i.id = r.request_id WHERE r.task_id = ? AND (r.question != '' OR i.status = 'open')",
    taskId,
  )?.r as number | null;
  return Math.max(pinned ?? 0, asked ?? 0);
}

/**
 * The round new pins go to when none is named: the current one, unless it was already decided (a revision after the
 * user chose starts the next round); 1 when there is none.
 */
export function roundForNew(taskId: string): number {
  const cur = currentRound(taskId);
  if (!cur) return (get('SELECT MAX(round) AS r FROM proposal_rounds WHERE task_id = ?', taskId)?.r as number | null ?? 0) + 1;
  return roundRow(taskId, cur)?.decided_at ? cur + 1 : cur;
}

/** A pin on the task by pin id, or by the id of the item pinned (in `round` if given, else the newest round holding it). */
export function findPin(taskId: string, ref: string, round?: number): Row | undefined {
  if (/^\d+$/.test(ref)) return get('SELECT * FROM pins WHERE id = ? AND task_id = ? AND unpinned_at IS NULL', Number(ref), taskId);
  return get(
    `SELECT * FROM pins WHERE task_id = ? AND (preview_id = ? OR attachment_id = ?) AND unpinned_at IS NULL ${round ? 'AND round = ?' : ''} ORDER BY round DESC LIMIT 1`,
    taskId, ref, ref, ...(round ? [round] : []),
  );
}

const byName = (by: Author) => (by.author === 'user' ? 'You' : by.name);

/**
 * Pin items to `round` (default: roundForNew), in the order given, after what that round already holds. An item
 * already pinned there keeps its place and takes the new label if one is given. Checks every id first: a call that
 * fails changes nothing.
 */
export function pinItems(task: Row, items: PinInput[], by: Author, round?: number, note = true): { round: number; pins: Row[] } | { error: string } {
  if (!items.length) return { error: 'Nothing to pin.' };
  const resolved = items.map((i) => ({ ...i, item: resolveItem(task.project_id, i.id) }));
  const missing = resolved.filter((r) => !r.item).map((r) => r.id);
  if (missing.length) return { error: `No preview or attachment with id ${missing.join(', ')} on this project.` };
  const r = round ?? roundForNew(task.id);
  if (!Number.isInteger(r) || r < 1 || r > 99) return { error: 'round must be a whole number from 1 to 99.' };
  const added: string[] = [];
  const pins = tx(() => {
    ensureRound(task.id, r);
    let pos = (get('SELECT MAX(position) AS p FROM pins WHERE task_id = ? AND round = ? AND unpinned_at IS NULL', task.id, r)?.p as number | null) ?? 0;
    for (const it of resolved) {
      const existing = findPin(task.id, it.id, r);
      const label = clean(it.label, 120);
      if (existing && existing.round === r) {
        if (label) run('UPDATE pins SET label = ? WHERE id = ?', label, existing.id);
        continue;
      }
      const def = 'preview_id' in it.item! ? get('SELECT title FROM previews WHERE id = ?', it.item.preview_id)?.title : get('SELECT name FROM attachments WHERE id = ?', it.item!.attachment_id)?.name;
      run(
        'INSERT INTO pins (project_id, task_id, preview_id, attachment_id, label, round, position, pinned_by, pinned_at) VALUES (?,?,?,?,?,?,?,?,?)',
        task.project_id, task.id, 'preview_id' in it.item! ? it.item.preview_id : null, 'attachment_id' in it.item! ? it.item.attachment_id : null,
        label || clean(def, 120), r, ++pos, by.author === 'user' ? 'user' : by.name, now(),
      );
      added.push(label || clean(def, 120));
    }
    run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), task.id);
    return activePins(task.id, r);
  });
  if (note && added.length) {
    const what = added.map((l) => `"${l}"`).join(', ');
    addTaskMessage(task, { author: 'system', name: 'Helm' }, `${byName(by)} pinned ${what} to the top${r > 1 ? ` (round ${r})` : ''}.`, 'state');
  }
  touchProject(task.project_id);
  return { round: r, pins };
}

/** Unpin: the pin is kept as history (unpinned_at); the item itself stays where it was. */
export function unpin(task: Row, refs: string[], by: Author, round?: number): { error: string } | { removed: string[] } {
  const pins = refs.map((ref) => ({ ref, pin: findPin(task.id, ref, round) }));
  const missing = pins.filter((p) => !p.pin).map((p) => p.ref);
  if (missing.length) return { error: `Nothing pinned with id ${missing.join(', ')} on ${task.title}.` };
  tx(() => {
    for (const { pin } of pins) run('UPDATE pins SET unpinned_at = ? WHERE id = ?', now(), pin!.id);
    run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), task.id);
  });
  const removed = pins.map((p) => p.pin!.label as string);
  addTaskMessage(task, { author: 'system', name: 'Helm' }, `${byName(by)} unpinned ${removed.map((l) => `"${l}"`).join(', ')}.`, 'state');
  touchProject(task.project_id);
  return { removed };
}

export function relabel(task: Row, ref: string, label: string, round?: number): string | null {
  const pin = findPin(task.id, ref, round);
  if (!pin) return `Nothing pinned with id ${ref} on ${task.title}.`;
  const l = clean(label, 120);
  if (!l) return 'A label cannot be empty.';
  run('UPDATE pins SET label = ? WHERE id = ?', l, pin.id);
  touchProject(task.project_id);
  return null;
}

/** Put a round's pins in the order of `refs` (pin or item ids); any left out keep their order after them. */
export function orderPins(task: Row, refs: string[], round?: number): string | null {
  const r = round ?? currentRound(task.id);
  const pins = activePins(task.id, r);
  const picked: Row[] = [];
  for (const ref of refs) {
    const p = pins.find((x) => String(x.id) === ref || itemId(x) === ref);
    if (!p) return `Nothing pinned with id ${ref} in round ${r} of ${task.title}.`;
    if (!picked.includes(p)) picked.push(p);
  }
  const order = [...picked, ...pins.filter((p) => !picked.includes(p))];
  tx(() => order.forEach((p, i) => run('UPDATE pins SET position = ? WHERE id = ?', i + 1, p.id)));
  touchProject(task.project_id);
  return null;
}

export function setQuestion(task: Row, round: number, question: string) {
  ensureRound(task.id, round);
  run('UPDATE proposal_rounds SET question = ? WHERE task_id = ? AND round = ?', question.trim().slice(0, 2000), task.id, round);
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), task.id);
  touchProject(task.project_id);
}

/** Link a request (on this task) to a round: its answer controls show under the items, and its answer is the choice. */
export function linkRequest(task: Row, round: number, requestId: string): string | null {
  const req = get('SELECT * FROM inbox WHERE id = ?', requestId);
  if (!req || req.project_id !== task.project_id) return `No request ${requestId} on this project.`;
  if (req.task_id !== task.id) return `Request ${requestId} is on another task or discussion; link a request asked on ${task.title}.`;
  if (req.kind !== 'question') return 'Only a question (ask_user) can be linked to a proposal.';
  tx(() => {
    ensureRound(task.id, round);
    // One round per request.
    run('UPDATE proposal_rounds SET request_id = NULL WHERE request_id = ? AND NOT (task_id = ? AND round = ?)', requestId, task.id, round);
    run('UPDATE proposal_rounds SET request_id = ? WHERE task_id = ? AND round = ?', requestId, task.id, round);
    // Answered before it was linked: record its answer as the choice now.
    if (req.status === 'answered') recordChoice(task, round, req.answer, req.answered_at, JSON.parse(req.options || '[]'), false);
  });
  touchProject(task.project_id);
  return null;
}

/** Unlink a round's request (it stays on the task as an ordinary request). */
export function unlinkRequest(task: Row, round: number) {
  run('UPDATE proposal_rounds SET request_id = NULL WHERE task_id = ? AND round = ?', task.id, round);
  touchProject(task.project_id);
}

/** Which pin a choice names: by label ("P1" or the full label), then by the option's place, then by the item's title. */
function matchPin(pins: Row[], options: { label: string }[], choice: string): Row | undefined {
  const c = choice.trim().toLowerCase();
  if (!c || !pins.length) return undefined;
  const exact = pins.find((p) => String(p.label).toLowerCase() === c);
  if (exact) return exact;
  const keyed = (f: (s: string) => string) => {
    const keys = pins.map((p) => f(String(p.label).toLowerCase()));
    if (new Set(keys).size !== keys.length || keys.some((k) => !k)) return undefined;
    const i = keys.indexOf(f(c));
    return i < 0 ? undefined : pins[i];
  };
  const head = (s: string) => s.split(/[:—–]/)[0].trim();
  const word = (s: string) => s.split(/[\s:—–,.]/)[0].trim();
  const byKey = keyed(head) ?? keyed(word);
  if (byKey) return byKey;
  const chosen = options.findIndex((o) => o.label.trim().toLowerCase() === c);
  if (chosen >= 0 && options.length === pins.length) return pins[chosen];
  return pins.find((p) => p.preview_id && String(get('SELECT title FROM previews WHERE id = ?', p.preview_id)?.title ?? '').toLowerCase() === c);
}

function recordChoice(task: Row, round: number, answer: string, at: number, options: { label: string }[], note = true) {
  const pins = activePins(task.id, round);
  // The choice is the option picked (before any words added with " — ").
  const choice = String(answer ?? '').split(' — ')[0];
  const pin = matchPin(pins, options, choice) ?? matchPin(pins, options, answer);
  run('UPDATE proposal_rounds SET choice = ?, chosen_pin = ?, decided_at = ? WHERE task_id = ? AND round = ?', answer, pin?.id ?? null, at, task.id, round);
  if (note) addTaskMessage(getTask(task.id)!, { author: 'system', name: 'Helm' }, `Recorded on the pinned proposal${round > 1 ? ` (round ${round})` : ''}: chosen ${pin ? `"${pin.label}"` : `"${clean(answer, 160)}"`}.`, 'state');
}

/** Record a choice by hand (a manager, when the user chose in conversation): a pinned item, or free text. */
export function choose(task: Row, round: number, ref: string | null, text: string): string | null {
  const pin = ref ? findPin(task.id, ref, round) : undefined;
  if (ref && !pin) return `Nothing pinned with id ${ref} in round ${round} of ${task.title}.`;
  ensureRound(task.id, round);
  const answer = text.trim() || (pin ? String(pin.label) : '');
  if (!answer) return 'Say what was chosen: a pinned item id, or the choice in words.';
  run('UPDATE proposal_rounds SET choice = ?, chosen_pin = ?, decided_at = ? WHERE task_id = ? AND round = ?', answer, pin?.id ?? null, now(), task.id, round);
  addTaskMessage(task, { author: 'system', name: 'Helm' }, `Recorded on the pinned proposal${round > 1 ? ` (round ${round})` : ''}: chosen "${pin ? pin.label : clean(answer, 160)}".`, 'state');
  touchProject(task.project_id);
  return null;
}

/** Clear a round's recorded choice (it was recorded by mistake, or the user changed their mind). */
export function clearChoice(task: Row, round: number) {
  run('UPDATE proposal_rounds SET choice = \'\', chosen_pin = NULL, decided_at = NULL WHERE task_id = ? AND round = ?', task.id, round);
  touchProject(task.project_id);
}

/** Called when a question is answered: if it is linked to a proposal round, the answer becomes that round's choice. */
export function noteRequestAnswered(requestId: string) {
  const req = get('SELECT * FROM inbox WHERE id = ?', requestId);
  const r = get('SELECT * FROM proposal_rounds WHERE request_id = ?', requestId);
  if (!req || !r || req.status !== 'answered') return;
  const task = getTask(r.task_id);
  if (!task) return;
  recordChoice(task, r.round, req.answer, req.answered_at ?? now(), JSON.parse(req.options || '[]'));
  touchProject(task.project_id);
}

// ---------- views ----------

function pinView(p: Row): Row | null {
  const base = { pin_id: p.id, label: p.label, round: p.round, position: p.position, pinned_by: p.pinned_by, pinned_at: p.pinned_at };
  if (p.preview_id) {
    const pv = get('SELECT * FROM previews WHERE id = ?', p.preview_id);
    return pv ? { ...base, item_id: pv.id, preview: previewRow(pv) } : null;
  }
  const a = get('SELECT * FROM attachments WHERE id = ?', p.attachment_id);
  return a ? { ...base, item_id: a.id, attachment: attachmentView(a) } : null;
}

function roundView(taskId: string, round: number, pins: Row[]): Row {
  const r = roundRow(taskId, round);
  const req = r?.request_id ? get('SELECT inbox.*, agents.name AS agent_name FROM inbox LEFT JOIN agents ON agents.id = inbox.agent_id WHERE inbox.id = ?', r.request_id) : undefined;
  const items = pins.filter((p) => p.round === round).map(pinView).filter((x): x is Row => !!x);
  return {
    round,
    question: r?.question ?? '',
    request: req ? inboxView(req) : null,
    choice: r?.decided_at ? { text: r.choice, pin_id: r.chosen_pin, at: r.decided_at } : null,
    items,
  };
}

/** The proposal area of a task or discussion page, or null when nothing is pinned or asked. */
export function proposalView(taskId: string): Row | null {
  const cur = currentRound(taskId);
  if (!cur) return null;
  const pins = activePins(taskId);
  const earlierRounds = [...new Set(pins.filter((p) => p.round < cur).map((p) => p.round as number))].sort((a, b) => b - a);
  return { ...roundView(taskId, cur, pins), earlier: earlierRounds.map((n) => roundView(taskId, n, pins)) };
}

/** A small image for an item, for list rows: the image, a comparison's after side, a guide's first screenshot. */
function thumbOf(v: Row): string | null {
  if (v.attachment) return v.attachment.kind === 'image' ? v.attachment.url : null;
  const p = v.preview;
  if (p.kind === 'image' && p.file) return `/artifacts/${p.file}`;
  try {
    if (p.kind === 'compare') return `/artifacts/${JSON.parse(p.content).after.file}`;
    if (p.kind === 'guide') {
      const s = JSON.parse(p.content).steps.find((x: Row) => x.image);
      return s ? `/artifacts/${s.image.file}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** What a list row shows: up to three thumbnails, how many items, whether the linked decision is waiting, the choice. */
export function proposalSummary(taskId: string): Row | null {
  const cur = currentRound(taskId);
  if (!cur) return null;
  const v = roundView(taskId, cur, activePins(taskId, cur));
  return {
    round: cur,
    count: v.items.length,
    waiting: v.request?.status === 'open',
    chosen: v.choice ? (v.items.find((i: Row) => i.pin_id === v.choice.pin_id)?.label ?? v.choice.text) : null,
    thumbs: v.items.slice(0, 3).map((i: Row) => ({ label: i.label, url: thumbOf(i), kind: i.preview?.kind ?? i.attachment?.kind })),
  };
}

/** The proposal for agents, in a few lines; '' when there is none. */
export function renderProposal(taskId: string): string {
  const v = proposalView(taskId);
  if (!v) return '';
  const lines = [`Pinned proposal, round ${v.round}${v.question ? `: ${v.question.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`];
  for (const i of v.items) lines.push(`  - ${i.label} (${i.preview ? `preview ${i.item_id}` : `attachment ${i.item_id}`})`);
  if (v.request) lines.push(`  linked request: "${v.request.title}" (${v.request.status === 'open' ? 'waiting for the user' : v.request.status})`);
  if (v.choice) lines.push(`  chosen: ${v.items.find((i: Row) => i.pin_id === v.choice.pin_id)?.label ?? v.choice.text}`);
  if (v.earlier.length) lines.push(`  earlier rounds: ${v.earlier.map((e: Row) => `${e.round} (${e.items.length} items${e.choice ? `, chose ${e.items.find((i: Row) => i.pin_id === e.choice.pin_id)?.label ?? e.choice.text}` : ''})`).join(', ')}`);
  return lines.join('\n');
}
