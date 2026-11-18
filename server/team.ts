import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { FINISHED, addJournal, getAgent, getProject, projectStructure, touchProject } from './store.ts';
import { applyStructureChange, describeChanges, migrateQuickRole, migrateRolePrompts, needsApproval, renderStructure, stampOrigins, summarizeChanges, validateStructure } from './structure.ts';
import type { RoleChange, Structure } from './structure.ts';
import { createRequest, landedOn } from './requests.ts';

// The root agent's control over the team structure: get_structure, update_structure,
// and the user's approval of changes the project's policy holds back.

export type StructureChange = { reason: string; roles?: RoleChange[]; remove?: string[]; maxAgents?: number; quickRole?: string; quickPerCaller?: number };

/** Role id → names of agents holding it that are not finished. */
function openRoleHolders(projectId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of all('SELECT name, role_id, status FROM agents WHERE project_id = ?', projectId)) {
    if (FINISHED.includes(a.status)) continue;
    out.set(a.role_id, [...(out.get(a.role_id) ?? []), a.name]);
  }
  return out;
}

export function structureText(projectId: string): string {
  const open = new Map([...openRoleHolders(projectId)].map(([k, v]) => [k, v.length]));
  return renderStructure(projectStructure(getProject(projectId)!), open);
}

const TAKES_EFFECT =
  'New roles can be spawned immediately. Changes to an existing role’s model or instructions reach an agent that is already running only when its session next starts. The role list in your own instructions refreshes on your next session; until then use get_structure.';

function commit(projectId: string, agentId: string | null, before: Structure, after: Structure, reason: string, note = '') {
  const body = [reason.trim(), describeChanges(before, after).join('\n'), note].filter(Boolean).join('\n\n');
  tx(() => {
    addJournal(projectId, agentId, 'decision', `Team structure changed: ${summarizeChanges(before, after)}`, body);
    // Roles the change touched remember who made it and why, for Setup.
    const journalId = get('SELECT MAX(id) AS id FROM journal WHERE project_id = ?', projectId)?.id as number | undefined;
    const by = (agentId && getAgent(agentId)?.name) || 'Director';
    const stamped = stampOrigins(before, after, { by, at: now(), reason: reason.trim(), journalId });
    run('UPDATE projects SET structure = ? WHERE id = ?', JSON.stringify(stamped), projectId);
  });
  touchProject(projectId);
}

/** update_structure: apply at once, or file it for approval. Returns the text for the agent and whether it failed. */
export function requestStructureChange(agent: Row, change: StructureChange): { text: string; error?: boolean } {
  const project = getProject(agent.project_id)!;
  const before = projectStructure(project);
  const res = applyStructureChange(before, change, openRoleHolders(project.id));
  if ('error' in res) return { text: res.error, error: true };
  const after = res.structure;
  // The policy is the user's: whatever the agent passed, it carries through unchanged.
  if (before.approval === undefined) delete after.approval;
  else after.approval = before.approval;

  // A call that changes nothing writes nothing: no journal entry, no request.
  if (summarizeChanges(before, after) === 'no change') {
    return { text: `Nothing to change: the team structure already matches what you sent, so nothing was written.\n\n${structureText(project.id)}` };
  }
  const why = needsApproval(before, after);
  if (!why) {
    commit(project.id, agent.id, before, after, change.reason);
    return { text: `Applied: ${summarizeChanges(before, after)}.\n${TAKES_EFFECT}\n\n${structureText(project.id)}` };
  }

  const title = `Approve team change: ${summarizeChanges(before, after)}`;
  const body = [`**Why:** ${change.reason.trim()}`, `**Needs your approval because:** ${why}`, `**Changes:**\n\n${describeChanges(before, after).join('\n')}`].join('\n\n');
  const { home } = createRequest({
    projectId: project.id, agentId: agent.id, kind: 'structure', title: title.slice(0, 160), body,
    options: [{ label: 'Approve' }, { label: 'Deny' }], payload: { reason: change.reason, base: before, proposed: after }, importance: 4, blocking: false,
  });
  return { text: `Not applied yet: ${why} Asked the user to approve "${title}". ${landedOn(home)} Their answer will arrive as a message; carry on with work that does not depend on it, and do not wait in a loop.` };
}

/** The user answered a 'structure' request. Returns the message for the agent that proposed it. */
export function resolveStructureProposal(item: Row, decision: 'approve' | 'deny' | 'dismiss', note: string): { message: string; answer: string } {
  const payload = JSON.parse(item.payload);
  const reply = note ? `\nThe user added: ${note}` : '';
  if (decision === 'dismiss') return { answer: 'Dismissed', message: 'The user dismissed this team change without approving it; nothing was applied.' };
  if (decision === 'deny') {
    return { answer: ['Denied', note].filter(Boolean).join(' — '), message: `The user denied this team change; nothing was applied.${reply}` };
  }
  const project = getProject(item.project_id)!;
  const current = projectStructure(project);
  const proposed: Structure = payload.proposed;
  let problem: string | null = null;
  if (JSON.stringify(current) !== JSON.stringify(payload.base)) {
    problem = 'the team structure changed after you proposed this, so it was computed from an out-of-date team';
  } else {
    problem = validateStructure(proposed);
    if (!problem) {
      const open = openRoleHolders(project.id);
      const stuck = current.roles.filter((r) => !proposed.roles.some((p) => p.id === r.id) && open.get(r.id)?.length);
      if (stuck.length) problem = `agents now hold roles it removes (${stuck.map((r) => `${r.id}: ${open.get(r.id)!.join(', ')}`).join('; ')}); close them first`;
    }
  }
  if (problem) {
    return {
      answer: [`Approved, but not applied: ${problem}`, note].filter(Boolean).join(' — '),
      message: `The user approved this team change, but it was not applied: ${problem}. Call get_structure and propose it again if it is still wanted.${reply}`,
    };
  }
  commit(project.id, item.agent_id, current, proposed, payload.reason ?? '', 'Approved by the user.');
  return {
    answer: ['Approved', note].filter(Boolean).join(' — '),
    message: `The user approved this team change and it has been applied.${reply}\n${TAKES_EFFECT}`,
  };
}

/** Idempotent, at startup: replace old stock role instructions in every stored structure, and make a role "quick" the quick helper where none was ever set. */
export function migrateStructures() {
  for (const p of all('SELECT id, structure FROM projects')) {
    const s = projectStructure(p);
    const prompts = migrateRolePrompts(s);
    if (migrateQuickRole(s) || prompts) run('UPDATE projects SET structure = ? WHERE id = ?', JSON.stringify(s), p.id);
  }
}
