import { all } from './db.ts';
import type { Row } from './db.ts';
import { hostsPromptSection } from './hosts.ts';
import { SESSION_EXTRAS } from './agents.ts';
import { itemsForProject, safeName } from './toolbox.ts';
import { FINISHED, getAgent, projectStructure } from './store.ts';
import { buildSystemPrompt } from './structure.ts';
import { knowledgeForPrompt } from './knowledge.ts';
import { listHelmTools } from './tools.ts';

// What Setup shows about each role: the instructions Helm would send an agent of that
// role and the helm tools it would get, both computed by the code the runtime uses.

export function teamDetails(project: Row) {
  const structure = projectStructure(project);
  const agents = all('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at DESC', project.id);
  const roles = structure.roles.map((role) => {
    const isRoot = role.id === structure.root;
    const holders = agents.filter((a) => a.role_id === role.id && (isRoot ? !a.parent_id : !!a.parent_id));
    // A real agent of the role if there is one, so the text is exactly what it was sent; else a stand-in.
    const sample = holders.find((a) => !FINISHED.includes(a.status)) ?? holders[0];
    let agent: Row;
    let parent: Row | undefined;
    if (sample) {
      agent = sample;
      parent = sample.parent_id ? getAgent(sample.parent_id) : undefined;
    } else {
      // Builders report to the director, who Helm starts them for (dispatch.ts).
      const director = structure.roles.find((r) => r.id === structure.root);
      agent = { name: `(${role.name} agent's name)`, role_id: role.id, parent_id: isRoot ? null : '(parent)', quick: 0 };
      parent = isRoot ? undefined : { name: `(${director?.name ?? 'Parent'} agent's name)` };
    }
    return {
      id: role.id,
      sample: sample ? { id: sample.id, name: sample.name } : null,
      systemPrompt: buildSystemPrompt(project, structure, role, agent, parent, hostsPromptSection(project.id), knowledgeForPrompt(project.id, agent)),
      tools: listHelmTools(structure, role.id, agent.parent_id ?? null, !!agent.quick),
    };
  });
  const toolbox = itemsForProject(project.id);
  return {
    roles,
    extras: {
      ...SESSION_EXTRAS,
      mcpServers: [...SESSION_EXTRAS.mcpServers, ...toolbox.filter((i) => i.kind.startsWith('mcp')).map((i) => safeName(i.name))],
      installed: toolbox.filter((i) => !i.kind.startsWith('mcp')).map((i) => ({ kind: i.kind, name: i.name })),
    },
  };
}
