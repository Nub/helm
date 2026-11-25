import { run } from './db.ts';
import type { Row } from './db.ts';
import { dispatchWork } from './agents.ts';
import { addTaskMessage, createTask, getTask } from './tasks.ts';
import { setTouches } from './subagents.ts';
import { holdsNewWork } from './projectmode.ts';
import { HELM_WORK_NOTE } from './specadherence.ts';

/**
 * Work the user asked for with a tap that someone must build (a release's artifacts, a test build, a rebuild, a tile
 * refresh): the director does not build, so Helm makes it a Scheduled task like any other, whose description is the
 * brief and the recipe, with what it touches and its check, and a fresh builder does it (dispatch.ts). Skilled by
 * default; Routine for a tile refresh. While the project is finishing up or stopped it waits as Waiting. `doneNote`:
 * what the director is told when its builder finishes (a release's artifacts built: finish it).
 */
export function builderTask(
  projectId: string,
  input: { title: string; brief: string; touches: string[]; check: string; tier?: 'skilled' | 'routine'; tierReason?: string; doneNote?: string },
): Row {
  const held = holdsNewWork(projectId);
  const t = createTask(projectId, { title: input.title.slice(0, 140), description: input.brief, state: held ? 'waiting' : 'scheduled', origin: 'user', origin_note: HELM_WORK_NOTE }, { author: 'system', name: 'Helm' });
  if (input.touches.length) setTouches(t.id, input.touches);
  const tier = input.tier ?? 'skilled';
  run('UPDATE tasks SET check_how = ?, tier = ?, tier_reason = ?, done_note = ? WHERE id = ?', input.check, tier, input.tierReason ?? (tier === 'skilled' ? 'default: hard to judge' : 'a recipe run with a named check'), input.doneNote ?? null, t.id);
  if (held) addTaskMessage(t, { author: 'system', name: 'Helm' }, 'Added as Waiting: the project is not running. Schedule it once you resume.', 'state');
  else dispatchWork(projectId);
  return getTask(t.id)!;
}
