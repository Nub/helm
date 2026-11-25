import { sweepAttachments } from './attachments.ts';
import { startRevisitChecks } from './discrevisit.ts';
import { startTestBuildSweep } from './testbuilds.ts';
import { tellDirector } from './agents.ts';
import { resetEscalatedDeep } from './workrules.ts';
import { DATA_DIR } from './config.ts';
import { backfillTelemetry } from './telemetry.ts';
import { get } from './db.ts';
import { setGuardHooks, startDiskGuard, stopDiskGuard } from './disk.ts';
import { biggestUsers } from './diskusage.ts';
import { startHealthChecks, stopHealthChecks } from './hosts.ts';
import { setReportNotifier, startReportPolling, stopReportPolling } from './reports.ts';
import { recordPlannedRestart, resumeAfterUpdate } from './liveupdate.ts';
import { recoverOnBoot, sendToAgent, shutdownAll } from './runtime.ts';
import { createRequest, homeRequests, settleIdleHolders } from './requests.ts';
import { startRunnerLink } from './runner.ts';
import { survive, sweepTemporaries } from './safefs.ts';
import { KEEP_AUTO_DAYS, pruneAutoDecisions } from './triage.ts';
import { foldSpecKinds, startSpecTimer, stopSpecTimer } from './spec.ts';
import { migrateStructures } from './team.ts';
import { backfillSessions, setSessionNotifier, startSessionTimer, stopSessionTimer } from './sessions.ts';
import { backfillTaskTiming } from './tasks.ts';
import { notify, startNotifications, stopNotifications } from './notify.ts';
import { startSearchIndex, stopSearchIndex } from './searchindex.ts';
import { startHistoryReduce, stopHistoryReduce } from './historyreduce.ts';
import { seedWatches, setWatchHooks, startWatches, stopWatches } from './watches.ts';
import { startFindingStats, stopFindingStats } from './findingstats.ts';
import { startActivity, stopActivity } from './activitystats.ts';
import { startLinkCleanup } from './dllinks.ts';
import { startWorkspaceSweep } from './hostwork.ts';
import { startReminders } from './reminders.ts';
import { startTaskTimeBackfill } from './tasktime.ts';
import { startFocusNotes, stopFocusNotes } from './focus.ts';
import { bringDashboardsInLine } from './dashrules.ts';
import { startProgressChecks, stopProgressChecks } from './progress.ts';
import { startWatchdog, stopWatchdog } from './watchdog.ts';
import { startDispatch, stopDispatch } from './dispatch.ts';

/**
 * The runner's half of Helm (server/runner.ts): the agents (runtime.ts), boot upkeep and every timer, the disk guard's
 * actions included. The entry of the runner's module closure: nix/package.nix hashes what this file imports, and an
 * update that leaves that hash alone does not restart the runner. So nothing here may import the API (api.ts, the
 * *api.ts route files, web.ts).
 */

// Boot-time upkeep writes to the database; on a full disk it is skipped (and done at the next start) so Helm still
// comes up to say what is wrong.
const boot = (what: string, fn: () => void) => survive(what, fn, undefined);

export function bootRunner() {
  // Temporary files of writes a crash cut short (server/safefs.ts names them .<name>.<pid>.<random>.tmp).
  const swept = sweepTemporaries(DATA_DIR);
  if (swept) console.log(`Removed ${swept} leftover temporary file(s) from interrupted writes.`);
  boot('recovering agents', () => recoverOnBoot());
  boot('boot upkeep', () => {
    // Every request has a task or discussion to live on (idempotent; after recoverOnBoot dismissed stale permissions).
    const homed = homeRequests();
    // Standing request holders with nothing pending are settled (idempotent; later changes settle them as they happen).
    const settledHolders = settleIdleHolders();
    if (settledHolders) console.log(`Requests: settled ${settledHolders} standing request holder(s) with nothing pending.`);
    if (homed.open || homed.handled || homed.moved) console.log(`Requests: gave a home to ${homed.open} open and ${homed.handled} answered or dismissed request(s) (${homed.discussions} new discussion(s)); ${homed.moved} moved off old task ids.`);
    sweepAttachments();
    const pruned = pruneAutoDecisions();
    if (pruned) console.log(`Permissions: dropped the record of ${pruned} automatic allow(s) older than ${KEEP_AUTO_DAYS} days.`);
    migrateStructures();
    // Tasks that reached Deep only by escalation go back to Skilled (workrules.ts): Fable is for directing.
    const undeep = resetEscalatedDeep();
    if (undeep) console.log(`Tiers: ${undeep} task(s) escalated to Deep set back to Skilled.`);
    // One kind of Spec entry: decisions and notes become history items or settled discussions (idempotent).
    const folded = foldSpecKinds();
    if (folded.history || folded.discussions || folded.entries) console.log(`Spec: ${folded.entries} goals/designs became entries; ${folded.history} decisions/notes moved into entry history, ${folded.discussions} into settled discussions.`);
    // Task timing and sessions from data kept before they existed (each idempotent).
    const timed = backfillTaskTiming();
    if (timed) console.log(`Tasks: derived timing for ${timed} task(s) from their state history.`);
    for (const b of backfillSessions()) console.log(`Sessions: found ${b.sessions} past session(s) in ${b.project}.`);
    // Telemetry rows for tasks finished before it existed (idempotent; after the task timing above).
    const tel = backfillTelemetry();
    if (tel.rows || tel.attributed) console.log(`Telemetry: recorded ${tel.rows} finished task(s); ${tel.attributed} earlier director turn(s) given their task.`);
  });
}

/**
 * Start the timers (after the web side listens, in one process). Returns the stop for SIGTERM.
 * `split`: the web service is a separate process, reached through the database (startRunnerLink).
 */
export function startRunner(split: boolean): () => Promise<void> {
  const link = split ? startRunnerLink() : null;
  boot('starting host checks', () => startHealthChecks());
  setReportNotifier(tellDirector);
  boot('starting report polling', () => startReportPolling());
  // Owner edits to the Spec become planning tasks after a quiet period; pending ones survive restarts in the database.
  boot('starting the Spec timer', () => startSpecTimer(tellDirector));
  // Sessions end after the owner's idle period; at boot, ones whose period passed while Helm was down are closed.
  setSessionNotifier(tellDirector);
  boot('starting the session timer', () => startSessionTimer());
  // Quiet discussions: a reminder to revisit, then Stale (server/discrevisit.ts).
  boot('starting discussion reminders', () => startRevisitChecks());
  // Phone notifications: stalled agents, update results, the away summary and the end of quiet hours (server/notify.ts).
  boot('starting notifications', () => startNotifications());
  // The ranked search's index: built in the background for data from before it, a batch at a time (server/searchindex.ts).
  // Only the runner builds it; the web service's API only asks for a rebuild (it empties the index, the runner refills it).
  boot('starting the search index', () => startSearchIndex());
  // Agents' history older than each project's keep period is reduced once a day (server/historyreduce.ts).
  boot('starting history reduction', () => startHistoryReduce());
  // Watches: standing conditions checked on their schedule; a trip wakes the director (server/watches.ts).
  setWatchHooks({
    tell: (projectId, text) => tellDirector(projectId, text),
    ask: (projectId, title, body) => void createRequest({ projectId, agentId: null, kind: 'question', title, body, importance: 4, blocking: false }),
  });
  // Finding code per project, this week and last, kept every six hours (server/findingstats.ts).
  boot('starting the finding-code measure', () => startFindingStats());
  // What agents spend their time on, per project and day (server/activitystats.ts): backfilled once, then kept current.
  boot('starting the activity measure', () => startActivity());
  // Expired and revoked release download links are removed daily (server/dllinks.ts).
  boot('starting download link cleanup', () => startLinkCleanup());
  boot('starting test build cleanup', () => startTestBuildSweep());
  // Hosts' job workspaces: failed ones after a day and leftovers are removed daily (server/hostwork.ts).
  boot('starting the workspace sweep', () => startWorkspaceSweep());
  boot('starting watches', () => {
    const seeded = seedWatches();
    if (seeded) console.log(`Watches: added "Time finding code" to ${seeded} project(s).`);
    startWatches();
  });
  // Disk guard: free space every minute; at warning a to-do for the user, at critical no new agents or builds and a note
  // to the directors (server/disk.ts). The actions are the runner's; the web service samples on its own for its banner
  // and its refusals (web-main.ts), with no hooks, so nothing is filed or sent twice.
  setGuardHooks({
    tellDirector,
    fileRequest: (projectId, title, body, steps, silent) =>
      createRequest({ projectId, agentId: null, kind: 'action', title, body, payload: { steps, after: '' }, importance: 4, blocking: false, silent }).id,
    requestOpen: (id) => get('SELECT status FROM inbox WHERE id = ?', id)?.status === 'open',
    notify: (title, body) => notify({ kind: 'disk', title, body, url: '#/helm', blocking: true }),
    biggest: biggestUsers,
  });
  startDiskGuard();
  // Progress checks: Active tasks weighed against their time and tokens; a first flag stops the work for a re-plan, a second pauses it.
  boot('starting progress checks', () => startProgressChecks());
  // The watchdog: an Active task idle with nothing pending wakes its driver, then the director, then is marked Stalled (watchdog.ts).
  boot('starting the watchdog', () => startWatchdog());
  // Deferred requests asked again when due (reminders.ts).
  boot('starting request reminders', () => startReminders());
  // Finished tasks' time breakdowns filled from their history, a few a minute (tasktime.ts).
  boot('filling task time breakdowns', () => startTaskTimeBackfill());
  // Focus: once a week per project, a note to the director naming the biggest drag on time to ship (focus.ts).
  boot('starting the weekly Focus note', () => startFocusNotes());
  // Dashboards brought in line with the shared rules once (dashrules.ts): safe conversions, then one note to each director.
  boot('checking dashboards against the rules', () => void bringDashboardsInLine((id, text) => sendToAgent(id, text, { kind: 'system', name: 'Helm' })).catch((err) => console.error('Dashboard rules:', err)));
  // After a planned update or rollback, resume the agents it interrupted once the update script reports this server healthy.
  boot('resuming agents after an update', () => resumeAfterUpdate((id, text) => sendToAgent(id, text, { kind: 'system', name: 'Helm' })));
  // One fresh builder per Scheduled task (dispatch.ts): now, then every half minute; the standing Builder and area
  // agents of before are closed once they finish what they have.
  boot('starting builders', () => startDispatch());

  return async () => {
    // Messages that arrive from now on wait for the next runner instead of starting a process this stop would kill.
    link?.stopDrain();
    recordPlannedRestart();
    stopHealthChecks();
    await stopReportPolling();
    stopSpecTimer();
    stopSessionTimer();
    stopNotifications();
    stopSearchIndex();
    stopHistoryReduce();
    stopWatches();
    stopFindingStats();
    stopActivity();
    stopDiskGuard();
    stopProgressChecks();
    stopWatchdog();
    stopDispatch();
    stopFocusNotes();
    await shutdownAll();
    await link?.stop();
  };
}
