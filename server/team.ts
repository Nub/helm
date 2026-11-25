import { all, run } from './db.ts';
import { projectStructure } from './store.ts';
import { migrateRolePrompts } from './structure.ts';
import { ensureBuilderArea } from './builder.ts';

// Areas, roles and team changes were retired: the director plans and asks, and Helm starts a fresh builder per task
// (dispatch.ts). What is left of a project's stored structure is its director and builder roles.

/** Idempotent, at startup: replace old stock role instructions in every stored structure, and give it the builder role. */
export function migrateStructures() {
  for (const p of all('SELECT id, structure FROM projects')) {
    const s = projectStructure(p);
    const prompts = migrateRolePrompts(s);
    const builder = ensureBuilderArea(s);
    if (prompts || builder) run('UPDATE projects SET structure = ? WHERE id = ?', JSON.stringify(s), p.id);
  }
}
