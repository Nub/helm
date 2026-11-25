import { all, get } from './db.ts';
import type { Row } from './db.ts';
import { addTaskMessage, getTask } from './tasks.ts';

/**
 * What started an agent's turn decides where its end-of-turn reply belongs.
 * A reply to something the user said in the general conversation is dialogue and
 * shows in the Overview's conversation panel. A turn started by an agent's report,
 * a Helm note, a message in a task's thread or an answer to a task's question is
 * not: its reply goes to that task's thread (when it names one) and stays in the
 * full transcript.
 */
export type Trigger = { dialogue: boolean; about: string | null };

const TAG = /^<(agent-report|user-answer|helm-note|task-message|discussion-message|project-message|toolbox-question|agent-question|review-request|manager-answer|permission-requests)([^>]*)>/;
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

export function classifyTrigger(text: string, from: { kind: string } | undefined): Trigger {
  const m = TAG.exec(text);
  if (!m) return { dialogue: from?.kind === 'user', about: null };
  const [, tag, attrs] = m;
  if (tag === 'task-message') return { dialogue: false, about: attr(attrs, 'task') };
  if (tag === 'discussion-message') return { dialogue: false, about: attr(attrs, 'discussion') };
  // Another project's director (crossproject.ts): about this side of the thread.
  if (tag === 'project-message') return { dialogue: false, about: attr(attrs, 'discussion') };
  // Asked on a Toolbox item; the answer goes to the item's thread through propose_tool.
  if (tag === 'toolbox-question') return { dialogue: false, about: null };
  // Between an agent and its manager (consults.ts); the task's thread already shows the pair, so the reply is not added there.
  if (tag === 'agent-question' || tag === 'review-request' || tag === 'manager-answer') return { dialogue: false, about: null };
  // Permission requests for the director to decide (triage.ts): decided with decide_permission, nothing to show.
  if (tag === 'permission-requests') return { dialogue: false, about: null };
  if (tag === 'user-answer') {
    // An answer to a question about a task belongs to the task; any other answer is the user talking.
    const task = attr(attrs, 'task');
    return { dialogue: !task, about: task };
  }
  if (tag === 'agent-report') {
    const id = attr(attrs, 'id');
    const agent = id ? get('SELECT task_id FROM agents WHERE id = ?', id) : undefined;
    return { dialogue: false, about: agent?.task_id ?? null };
  }
  // helm-note: about a task when it names exactly one.
  // Notes name items as [[id]] (taskRef); older ones as (id ...).
  const ids = [...new Set([...text.matchAll(/(?:\(id |\[\[)((?:task|disc)_[0-9a-f]+)(?:\)|\]\])/g)].map((x) => x[1]))];
  return { dialogue: false, about: ids.length === 1 ? ids[0] : null };
}

/** The trigger an inbound event recorded, or worked out now for events from before it was recorded. */
export function eventTrigger(data: Row): Trigger {
  if (typeof data.dialogue === 'boolean') return { dialogue: data.dialogue, about: data.about ?? null };
  return classifyTrigger(String(data.text ?? ''), data.from);
}

/** The inbound events a turn answered: those after the previous end-of-turn result, up to `beforeId`. */
export function turnInbound(agentId: string, beforeId: number): Row[] {
  const prev = get("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'result' AND id < ?", agentId, beforeId)?.id ?? 0;
  return all("SELECT id, ts, data FROM events WHERE agent_id = ? AND kind = 'inbound' AND id > ? AND id < ? ORDER BY id", agentId, prev, beforeId).map((e) => ({
    ...e,
    data: JSON.parse(e.data),
  }));
}

/** Whether a turn replied to the user: any of its triggers was dialogue. A turn with no recorded trigger counts as dialogue. */
export function isDialogueTurn(inbound: Row[]): boolean {
  return !inbound.length || inbound.some((e) => eventTrigger(e.data).dialogue);
}

/**
 * Decide what a finished turn of a top-level agent was. For a non-dialogue turn about
 * exactly one task or discussion, its reply is added to that thread, unless the agent
 * already wrote there during the turn.
 */
export function routeTurn(agent: Row, nextEventId: number, text: string): { dialogue: boolean; routed: string | null } {
  const inbound = turnInbound(agent.id, nextEventId);
  if (isDialogueTurn(inbound)) return { dialogue: true, routed: null };
  const about = [...new Set(inbound.map((e) => eventTrigger(e.data).about).filter(Boolean))] as string[];
  const body = text.trim();
  if (about.length !== 1 || !body) return { dialogue: false, routed: null };
  const task = getTask(about[0]);
  if (!task || task.project_id !== agent.project_id) return { dialogue: false, routed: null };
  const since = inbound[0].ts;
  const posted = get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND author = 'director' AND created_at >= ? LIMIT 1", task.id, since);
  if (posted) return { dialogue: false, routed: null };
  addTaskMessage(task, { author: 'director', name: agent.name }, body);
  return { dialogue: false, routed: task.id };
}

/** Whether an event belongs in the conversation panel: what the user said, replies to it, notes and errors. */
export function inDialogue(agentId: string, e: Row): boolean {
  if (e.kind === 'inbound') return e.data?.from?.kind === 'user';
  if (e.kind === 'result') {
    if (!e.data?.ok) return true;
    // Rewritten shorter at Helm's request (brevity.ts): the rewrite is shown instead.
    if (e.data.replaced) return false;
    if (typeof e.data.dialogue === 'boolean') return e.data.dialogue;
    return isDialogueTurn(turnInbound(agentId, e.id));
  }
  return true;
}

/**
 * The exchange between the user and an agent, without the work in between and
 * without turns that answered other agents or Helm (those live in task threads and
 * the full transcript): newest `limit` events before `before`, oldest first.
 */
export function listDialogue(agentId: string, before: number | null, limit: number): Row[] {
  const out: Row[] = [];
  let cursor = before ?? Number.MAX_SAFE_INTEGER;
  const batch = limit * 3;
  while (out.length < limit) {
    const rows = all("SELECT id, agent_id, ts, kind, data FROM events WHERE agent_id = ? AND id < ? AND kind IN ('inbound', 'result', 'note', 'error') ORDER BY id DESC LIMIT ?", agentId, cursor, batch);
    for (const r of rows) {
      cursor = r.id;
      const e = { ...r, data: JSON.parse(r.data) };
      if (inDialogue(agentId, e)) out.push(e);
      if (out.length >= limit) break;
    }
    if (rows.length < batch) break;
  }
  return out.reverse();
}
