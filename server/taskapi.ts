import type { FastifyInstance, FastifyReply } from 'fastify';
import { markSeen, peerView } from './crossproject.ts';
import { parallelHint } from './dispatch.ts';
import { buildsForTask } from './testbuilds.ts';
import { CONSOLIDATE_ASK, applyConsolidation, consolidationDiscussion, consolidationView, declineConsolidation, getConsolidation } from './merge.ts';
import { taskScope } from './tilescope.ts';
import { runningCommands } from './commands.ts';
import { all, get, now, run, tx } from './db.ts';
const clock = now;
import type { Row } from './db.ts';
import { reportsForTask } from './reports.ts';
import { bindAttachments, pendingAttachments } from './attachments.ts';
import { dispatchWork, rootAgent, sendToAgent, tellDirector } from './agents.ts';
import { onTaskDecision, taskSpec } from './spec.ts';
import { getProject, touchProject } from './store.ts';
import { anotherTaskFrom, canMakeAnotherTask, cannotBecomeDiscussion, concludeDiscussion, createDiscussion, makeTaskFromDiscussion, discussionToTask, listDiscussions, reopenDiscussion, settleDiscussion, taskToDiscussion } from './discussions.ts';
import { OPEN_TASK_STATES, QUEUE_ORDER, STATE_LABEL, USER, addTaskMessage, createTask, getTask, isDiscussion, moveTask, setTaskState, taskDetail, taskRef, unfiledNeed } from './tasks.ts';
import type { Move } from './tasks.ts';
import { batchDiscussions } from './discrevisit.ts';
import { specMessageExtras, startTaskSpecDiscussion } from './specdiscuss.ts';
import { onSpecWorkMessage } from './specwork.ts';
import { taskReferences } from './taskrefs.ts';
import { taskStatus } from './taskstatus.ts';
import { partsView } from './taskparts.ts';
import { boundaries } from './sessions.ts';
import { orderPins, pinItems, relabel, unpin } from './pins.ts';
import { contextBlock } from './chatcontext.ts';
import type { Viewing } from './chatcontext.ts';
import { holdsNewWork } from './projectmode.ts';
import { ACTIONS, modeWords, queuePlace, taskAction } from './taskactions.ts';
import { setBell } from './bell.ts';
import { setWaits } from './waits.ts';
import { KINDS, headline, taskTime, topSentence } from './tasktime.ts';
import { userTier } from './workrules.ts';
import { projectTimeline } from './timeline.ts';


function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

export function registerTaskApi(app: FastifyInstance) {
  // The Work page's Timeline, throughput and flow (timeline.ts): tasks of the last `days` (1 to 90) and every open one.
  app.get('/api/projects/:id/timeline', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const days = Math.min(90, Math.max(1, Number((req.query as any)?.days) || 28));
    return projectTimeline(project.id, days);
  });

  // Where a task's time went (tasktime.ts): kept for a finished task, computed for an open one.
  app.get('/api/tasks/:id/time', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!get('SELECT 1 AS x FROM tasks WHERE id = ?', id)) return bad(reply, 'No such task', 404);
    const time = taskTime(id);
    return { time, headline: time ? headline(time) : '', sentence: time ? topSentence(time) : '', kinds: KINDS };
  });

  // Consolidate tasks (Work page, merge.ts): a discussion with the director about the tasks that are not running; the
  // first time, the user's ask goes to it. Its proposals are cards the user applies or declines here.
  app.post('/api/projects/:id/consolidate', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const { d, created } = consolidationDiscussion(project.id);
    if (created) await sendThreadMessage(d, CONSOLIDATE_ASK, []);
    return { discussion_id: d.id, created };
  });
  app.get('/api/consolidations/:id', async (req, reply) => {
    const c = getConsolidation((req.params as any).id);
    return c ? consolidationView(c) : bad(reply, 'No such proposal', 404);
  });
  app.post('/api/consolidations/:id/:action', async (req, reply) => {
    const { id, action } = req.params as any;
    const c = getConsolidation(id);
    if (!c) return bad(reply, 'No such proposal', 404);
    if (action === 'apply') {
      const res = applyConsolidation(c);
      if ('error' in res) return bad(reply, res.error, res.code ?? 400);
      await tellDirector(c.project_id, `The user applied your proposal in [[${c.discussion_id}]]: ${res.text}`).catch(() => {});
      return res;
    }
    if (action === 'decline') {
      const e = declineConsolidation(c);
      if (e) return bad(reply, e.error, e.code ?? 400);
      await tellDirector(c.project_id, `The user declined your proposal in [[${c.discussion_id}]] (${c.kind}: ${c.gain}).`).catch(() => {});
      return { ok: true };
    }
    return bad(reply, 'apply or decline', 404);
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const detail = taskDetail((req.params as any).id);
    if (!detail) return bad(reply, 'No such task', 404);
    // The user opened a thread with another project: its replies are read (crossproject.ts).
    markSeen(detail.task.id);
    // Session and away boundaries across the task's life, for dividers in its history.
    const periods = boundaries(detail.task.project_id, detail.task.created_at, detail.timeline.length ? Math.max(clock(), detail.timeline[detail.timeline.length - 1].ts) : clock());
    return { ...detail, reports: reportsForTask(detail.task.id), spec: taskSpec(detail.task.id), references: detail.task.kind === 'task' ? taskReferences(detail.task) : null, parallel: parallelHint(detail.task), status: detail.task.kind === 'task' ? taskStatus(detail.task) : null, parts: detail.task.kind === 'task' ? partsView(detail.task.id) : [], periods, now: clock(), commands: runningCommands(detail.task.id), dashboards: taskScope(detail.task.id), dashboard: get('SELECT id, title, state FROM dashboards WHERE task_id = ?', detail.task.id) ?? null, test_builds: buildsForTask(detail.task.id), peer: peerView(detail.task.id) };
  });

  /**
   * The user adds a task: Waiting, or Scheduled at the end of the queue. Only a scheduled one wakes the
   * director; a waiting one is quiet (adding forty should not cost forty turns) and the director sees it
   * in list_tasks when it next picks up work.
   */
  app.post('/api/projects/:id/tasks', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const title = String(b.title ?? '').trim();
    if (!title) return bad(reply, 'Give it a title.');
    // Winding down, at rest or stopped (projectmode.ts): a new task waits; the user schedules it once they resume.
    const held = !!b.scheduled && holdsNewWork(project.id);
    const state = b.scheduled && !held ? 'scheduled' : 'waiting';
    const docId = b.doc_id && get('SELECT id FROM docs WHERE id = ? AND project_id = ?', b.doc_id, project.id) ? b.doc_id : null;
    const task = createTask(project.id, { title, description: String(b.description ?? ''), state, doc_id: docId, origin: 'user' }, USER);
    if (held) addTaskMessage(task, { author: 'system', name: 'Helm' }, `Added as Waiting, not Scheduled: the project is ${modeWords(project.id)}. Schedule it once the project runs again.`, 'state');
    if (state === 'scheduled') {
      await tellDirector(project.id, `The user added ${taskRef(task)} as Scheduled.` + (task.description ? `\n\n${task.description}\n\n` : ' ') + `Helm starts a fresh builder for it in queue order.${queuePlace(task)}`);
      dispatchWork(project.id);
    }
    return { id: task.id, ...(held ? { note: `Added as Waiting: the project is ${modeWords(project.id)}.` } : {}) };
  });

  /** Edit title, description or linked goal. Only an edit to an active task wakes the director. */
  app.patch('/api/tasks/:id', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim() : task.title;
    const description = typeof b.description === 'string' ? b.description : task.description;
    let docId = task.doc_id;
    if (b.doc_id !== undefined) docId = b.doc_id && get('SELECT id FROM docs WHERE id = ? AND project_id = ?', b.doc_id, task.project_id) ? b.doc_id : null;
    if (title === task.title && description === task.description && docId === task.doc_id) return { ok: true };
    const changed = [title !== task.title && 'title', description !== task.description && 'description', docId !== task.doc_id && 'linked goal'].filter(Boolean).join(', ');
    tx(() => {
      run('UPDATE tasks SET title = ?, description = ?, doc_id = ?, updated_at = ? WHERE id = ?', title, description, docId, now(), task.id);
      addTaskMessage(task, { author: 'system', name: 'Helm' }, `You edited the ${changed}.`, 'state');
    });
    if (task.state === 'active') {
      const updated = getTask(task.id)!;
      await tellDirector(
        task.project_id,
        `The user edited ${taskRef(updated)}, which is active (changed: ${changed}).` +
          (title !== task.title ? ` The title was "${task.title}".` : '') +
          (description !== task.description ? `\n\nThe description is now:\n${description || '(empty)'}\n\n` : ' ') +
          `Adjust the work to match, and tell the agents working on it.`,
      );
    }
    return { ok: true };
  });

  /** The task menu's "Review before it lands" (builder.ts isRisky): the user marks a task for review, or unmarks it. */
  app.post('/api/tasks/:id/review', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task || task.kind !== 'task') return bad(reply, 'No such task', 404);
    const on = !!(req.body as any)?.on;
    run('UPDATE tasks SET risky = ?, updated_at = ? WHERE id = ?', on ? 1 : 0, now(), task.id);
    addTaskMessage(task, { author: 'system', name: 'Helm' }, on ? 'You marked it for review: it is reviewed before it lands.' : 'You took off its review: it lands without one.', 'state');
    return { ok: true };
  });

  /** The task page's tier picker (workrules.ts userTier): the user's tier, pinned; the agent on it takes it next turn. */
  app.post('/api/tasks/:id/tier', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task || task.kind !== 'task') return bad(reply, 'No such task', 404);
    const err = userTier(task, String((req.body as any)?.tier ?? ''));
    return err ? bad(reply, err) : { ok: true };
  });

  /** Reorder. Quiet: the director reads the queue when it next picks up work. */
  /**
   * The row's "Ask the director what it needs": a task says it needs the user but nothing is filed (tasks.ts
   * unfiledNeed). The director is told to file it as a request, or to correct the task if nothing is needed.
   */
  app.post('/api/tasks/:id/ask-needs', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const flag = unfiledNeed(task, Number(get("SELECT COUNT(*) AS n FROM inbox WHERE task_id = ? AND status = 'open'", task.id)?.n ?? 0));
    if (!flag.waiting_on_user_without_request) return bad(reply, 'This task has an open request, or no longer says it needs you.', 409);
    addTaskMessage(task, USER, 'Asked the director what this task needs from me: it says it needs me, but nothing was filed.', 'state');
    await tellDirector(
      task.project_id,
      `The user asked what ${taskRef(task)} needs from them. It says it needs the user ("${flag.unfiled_need}") but no request is open on it, so nothing shows under Needs response. ` +
        'If the user must do or decide something, file it now with ask_user on this task (kind "action" with exact steps for something to do outside Helm), or set needs_from_user with update_task. ' +
        'If nothing is needed, correct the status summary with update_task and say so in its thread with task_post.',
    );
    touchProject(task.project_id);
    return { ok: true };
  });

  // What a task waits for, set by the user from its menu (waits.ts).
  app.post('/api/tasks/:id/waits', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const ids = (req.body as any)?.ids;
    if (!Array.isArray(ids)) return bad(reply, 'Send ids: the tasks it waits for.');
    const err = setWaits(task.id, ids.map(String));
    return err ? bad(reply, err.replace(/\[\[[^\]|]+\]\]/g, (m) => `"${getTask(m.slice(2, -2))?.title ?? m}"`)) : { ok: true };
  });

  // The bell: tell the user once when this task finishes (bell.ts).
  app.post('/api/tasks/:id/bell', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    setBell(task.id, !!(req.body as any)?.on);
    return { ok: true };
  });

  app.post('/api/tasks/:id/move', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    if (isDiscussion(task)) return bad(reply, 'Discussions are not queued; only tasks can be reordered.');
    const b = (req.body ?? {}) as Record<string, any>;
    const move: Move | null = ['top', 'bottom', 'up', 'down'].includes(b.to) ? b.to : b.before ? { before: String(b.before) } : b.after ? { after: String(b.after) } : null;
    if (!move) return bad(reply, 'Say where: to top, bottom, up or down, or before/after a task id.');
    const err = moveTask(task, move, 'user');
    return err ? bad(reply, err) : { ok: true };
  });

  for (const action of Object.keys(ACTIONS)) {
    app.post(`/api/tasks/:id/${action}`, async (req, reply) => {
      const task = getTask((req.params as any).id);
      if (!task) return bad(reply, 'No such task', 404);
      const res = await taskAction(task, action, !!(req.body as any)?.anyway);
      if (res.needsConfirm) return reply.code(409).send({ error: res.error, needsConfirm: true });
      return res.error ? bad(reply, res.error) : { ok: true };
    });
  }

  // ---------- discussions ----------

  app.get('/api/projects/:id/discussions', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const q = req.query as { q?: string; state?: string };
    return { discussions: listDiscussions(project.id, { q: q.q, state: q.state }) };
  });

  /** Many discussions at once, or one from its page: mark stale, archive, close (with its proposed conclusion, else "Closed in bulk") or reopen. */
  app.post('/api/projects/:id/discussions/batch', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as { ids?: unknown; action?: string };
    if (!Array.isArray(b.ids) || !b.ids.length) return bad(reply, 'Give the discussions: ids.');
    const res = batchDiscussions(project.id, b.ids.map(String), b.action as 'stale', USER);
    return 'error' in res ? bad(reply, res.error) : res;
  });

  /** The user starts a discussion: a title and a first message, delivered to the director tagged with it. */
  app.post('/api/projects/:id/discussions', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const title = String(b.title ?? '').trim();
    const text = String(b.text ?? '').trim();
    if (!title) return bad(reply, 'Give it a title.');
    const files = pendingAttachments(project.id, b.attachments);
    if ('error' in files) return bad(reply, files.error);
    if (!text && !files.rows.length) return bad(reply, 'Say what you want to discuss.');
    const d = createDiscussion(project.id, { title, origin: 'user' }, USER);
    bindAttachments(files.rows, 'message', addTaskMessage(d, USER, text));
    const t = title.replace(/"/g, "'");
    await sendToAgent(rootAgent(project).id, `<discussion-message discussion="${d.id}" title="${t}" new="true">\n${text}\n</discussion-message>`, { kind: 'user', name: 'You' }, files.rows, false);
    return { id: d.id };
  });

  /** Settle a discussion. Without a conclusion, the director is asked to write one. */
  app.post('/api/tasks/:id/settle', async (req, reply) => {
    const d = getTask((req.params as any).id);
    if (!d) return bad(reply, 'No such discussion', 404);
    if (!isDiscussion(d)) return bad(reply, 'Only a discussion can be closed; a task is finished with Done or Drop.');
    if (d.state === 'settled') return bad(reply, 'It is already settled.');
    const conclusion = String((req.body as any)?.conclusion ?? '').trim();
    settleDiscussion(d, conclusion, USER);
    await tellDirector(
      d.project_id,
      conclusion
        ? `The user closed ${taskRef(d)} with this conclusion: ${conclusion}`
        : `The user closed ${taskRef(d)}. Write its conclusion from the thread with update_discussion (conclusion), in one to three sentences. Do not reply in the conversation.`,
    );
    return { ok: true };
  });

  /** Conclude: the director's proposed conclusion (task_post conclude) closes the discussion and it plans the work. */
  app.post('/api/tasks/:id/conclude', async (req, reply) => {
    const d = getTask((req.params as any).id);
    if (!d) return bad(reply, 'No such discussion', 404);
    const raw = (req.body as any)?.message;
    const res = concludeDiscussion(d, raw == null ? undefined : Number(raw), USER);
    if ('error' in res) return bad(reply, res.error);
    touchProject(d.project_id);
    await tellDirector(d.project_id, res.text);
    return { ok: true };
  });

  /** Make a task from a discussion's header: close it with its conclusion (or summary) and the director plans the work now. */
  app.post('/api/tasks/:id/make-task', async (req, reply) => {
    const d = getTask((req.params as any).id);
    if (!d) return bad(reply, 'No such discussion', 404);
    const m = (req.body as any)?.message;
    const res = makeTaskFromDiscussion(d, (req.body as any)?.line, USER, m == null ? undefined : Number(m));
    if ('error' in res) return bad(reply, res.error);
    touchProject(d.project_id);
    await tellDirector(d.project_id, res.text);
    return { ok: true };
  });

  /** "No Spec entry · Discuss" on a task: open (or reuse) the discussion about which entry it belongs to (specdiscuss.ts). */
  app.post('/api/tasks/:id/spec-discussion', async (req, reply) => {
    const t = getTask((req.params as any).id);
    if (!t) return bad(reply, 'No such task', 404);
    const res = startTaskSpecDiscussion(t);
    if ('error' in res) return bad(reply, res.error);
    if (res.directorNote) await tellDirector(t.project_id, res.directorNote);
    return { id: res.discussion.id, created: res.created };
  });

  app.post('/api/tasks/:id/reopen', async (req, reply) => {
    const d = getTask((req.params as any).id);
    if (!d) return bad(reply, 'No such discussion', 404);
    if (!isDiscussion(d)) return bad(reply, 'Only a discussion can be reopened.');
    if (d.state === 'open') return bad(reply, 'It is already open.');
    reopenDiscussion(d, USER);
    touchProject(d.project_id);
    return { ok: true };
  });

  /**
   * Discussion → task, in place: same id, the thread becomes the start of the task's history. Planning by
   * default, so nothing starts without the user's approval; title and description can be set in the same step.
   */
  app.post('/api/tasks/:id/to-task', async (req, reply) => {
    const d = getTask((req.params as any).id);
    if (!d) return bad(reply, 'No such discussion', 404);
    if (!isDiscussion(d)) return bad(reply, 'This is already a task.');
    const b = (req.body ?? {}) as Record<string, any>;
    const state = b.state === 'waiting' ? 'waiting' : 'planning';
    const task = discussionToTask(
      d,
      { state, title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : undefined, description: typeof b.description === 'string' ? b.description : undefined, origin: 'user' },
      USER,
    );
    await tellDirector(
      d.project_id,
      state === 'planning'
        ? `The user turned the discussion "${d.title}" into a task in place: it is now ${taskRef(task)}, in Planning, with the discussion as the start of its thread. Write a concrete plan into its description from the discussion, and talk it through in its thread (task_post); it starts only when the user approves it.`
        : `The user turned the discussion "${d.title}" into a task in place: it is now ${taskRef(task)}, Waiting (agreed, not lined up), with the discussion as the start of its thread. Make sure its description says what done looks like.`,
    );
    return { id: task.id };
  });

  /** One more task from a discussion that already became a task: a separate task that shows it inline. */
  app.post('/api/tasks/:id/another-task', async (req, reply) => {
    const o = getTask((req.params as any).id);
    if (!o) return bad(reply, 'No such task', 404);
    if (!canMakeAnotherTask(o)) return bad(reply, isDiscussion(o) ? 'Turn this discussion into a task first; further tasks can then be made from it.' : 'This task was never a discussion.');
    const b = (req.body ?? {}) as Record<string, any>;
    const title = String(b.title ?? '').trim();
    if (!title) return bad(reply, 'Give the new task a title.');
    const task = anotherTaskFrom(o, { state: b.state === 'waiting' ? 'waiting' : 'planning', title, description: typeof b.description === 'string' ? b.description : undefined, origin: 'user' }, USER);
    await tellDirector(
      o.project_id,
      `The user made another task from the discussion in ${taskRef(o)}: ${taskRef(task)}, in ${STATE_LABEL[task.state]}. It shows that discussion in its history.` +
        (task.state === 'planning' ? ' Write a concrete plan into its description and talk it through in its thread (task_post); it starts only when the user approves it.' : ''),
    );
    return { id: task.id };
  });

  /** A mis-filed task → a discussion, in place, only if no work has started. */
  app.post('/api/tasks/:id/to-discussion', async (req, reply) => {
    const t = getTask((req.params as any).id);
    if (!t) return bad(reply, 'No such task', 404);
    const why = cannotBecomeDiscussion(t);
    if (why) return bad(reply, why);
    taskToDiscussion(t, USER);
    await tellDirector(
      t.project_id,
      `The user moved ${taskRef(getTask(t.id)!)} from the tasks to the discussions: it is a topic to talk about, not work to do. Do not work on it. Write a one-line summary for it with update_discussion. Do not reply in the conversation.`,
    );
    return { ok: true };
  });

  /**
   * The user's own control of the pinned proposal (pins.ts): pin a preview or attachment from the thread to the top,
   * relabel, unpin (the item stays in the thread) and reorder. Quiet: the director sees the pins in list_tasks and
   * list_discussions.
   */
  app.post('/api/tasks/:id/pins', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const id = String(b.preview_id ?? b.attachment_id ?? b.id ?? '');
    if (!id) return bad(reply, 'Say what to pin: a preview_id or an attachment_id.');
    const res = pinItems(task, [{ id, label: typeof b.label === 'string' ? b.label : undefined }], USER, Number.isInteger(b.round) ? b.round : undefined);
    return 'error' in res ? bad(reply, res.error) : { ok: true, round: res.round };
  });
  app.patch('/api/tasks/:id/pins/:pin', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const err = relabel(task, String((req.params as any).pin), String(b.label ?? ''));
    return err ? bad(reply, err) : { ok: true };
  });
  app.delete('/api/tasks/:id/pins/:pin', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const res = unpin(task, [String((req.params as any).pin)], USER);
    return 'error' in res ? bad(reply, res.error) : { ok: true };
  });
  app.post('/api/tasks/:id/pins/order', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!Array.isArray(b.ids)) return bad(reply, 'Give ids: the pins in their new order.');
    const err = orderPins(task, b.ids.map(String), Number.isInteger(b.round) ? b.round : undefined);
    return err ? bad(reply, err) : { ok: true };
  });

  /** The user speaks in a task's thread; the director gets it tagged with the task. */
  app.post('/api/tasks/:id/message', async (req, reply) => {
    const task = getTask((req.params as any).id);
    if (!task) return bad(reply, 'No such task', 404);
    const text = String((req.body as any)?.text ?? '').trim();
    const files = pendingAttachments(task.project_id, (req.body as any)?.attachments);
    if ('error' in files) return bad(reply, files.error);
    // Interject (one control, in place of Interrupt and Interject): on an active task it stops the work (the task is
    // paused) and the director re-evaluates with the message; with no message it just stops. On any other task a
    // message is an ordinary reply, and Send beside Interject is a question that leaves the work running.
    const b = (req.body ?? {}) as Record<string, any>;
    const interject = !!b.interject && !isDiscussion(task) && task.state === 'active';
    if (interject && !text && !files.rows.length) {
      const res = await taskAction(task, 'interrupt');
      if (res.error) return bad(reply, res.error);
      return { ok: true, interject: true, paused: true };
    }
    if (!text && !files.rows.length) return bad(reply, 'Empty message');
    const pause = interject;
    if (pause) {
      setTaskState(task, 'paused', USER, 'paused with an interjection, to read before the work goes on');
      onTaskDecision(task, 'interrupt');
    }
    await sendThreadMessage(task, text, files.rows, interject ? { pause } : undefined, contextBlock(task.project_id, b.context));
    return { ok: true, interject, paused: pause };
  });
}

/**
 * The user's message in a task's or discussion's thread: kept there and delivered to the director tagged with it.
 * `interject`: sent on an active task as an interjection (and whether it also paused the task); the director is
 * to act on it ahead of what it was doing (structure.ts), so one message carries both the text and the pause.
 * `viewing`: what the user was looking at in the chat (chatcontext.ts), when it is more specific than the thread.
 */
export async function sendThreadMessage(task: Row, text: string, files: Row[], interject?: { pause: boolean }, viewing?: Viewing | null) {
  const messageId = addTaskMessage(task, USER, text);
  if (interject) run('UPDATE task_messages SET interject = 1 WHERE id = ?', messageId);
  bindAttachments(files, 'message', messageId);
  const project = getProject(task.project_id)!;
  const title = task.title.replace(/"/g, "'");
  const tag = isDiscussion(task) ? 'discussion-message' : 'task-message';
  const attr = isDiscussion(task) ? 'discussion' : 'task';
  // A discussion about a Spec entry names it, and its first message says what the discussion is for (specdiscuss.ts).
  // In a Spec Review, Revise or Create, a bare "stop" or "continue" stops or continues it (specwork.ts).
  onSpecWorkMessage(task, text);
  const spec = specMessageExtras(task);
  const flags = interject ? ` interjection="true"${interject.pause ? ' paused="true"' : ''}` : '';
  const note = interject?.pause ? `\n<helm-note>${ACTIONS.interrupt.note(getTask(task.id)!)}</helm-note>` : '';
  // Not an interjection on work that is under way: a question or remark beside it (the History's Send).
  const aside = !interject && !isDiscussion(task) && task.state === 'active' ? '\n<helm-note>Sent with Send, not Interject: answer it in the thread without changing the work, unless the exchange leads to a change.</helm-note>' : '';
  await sendToAgent(rootAgent(project).id, `<${tag} ${attr}="${task.id}" title="${title}"${flags}${spec.attrs}>\n${text}${spec.context}\n</${tag}>${note}${aside}`, { kind: 'user', name: 'You' }, files, false, viewing);
  touchProject(task.project_id);
}
