#!/usr/bin/env node
// A stand-in for the Claude Code CLI for Helm scratch servers: speaks the SDK's stream-json protocol and plays a
// scripted director or engineer, calling Helm's MCP tools for real and emitting tool calls as a real agent would.
import { createInterface } from 'node:readline';
//
// The director never starts agents: it schedules or starts tasks whose description carries a FAKE-* marker, and Helm
// starts a fresh builder (Builder A, B, …) for each with a brief holding that description (server/dispatch.ts); the
// builder plays the part the marker names and finishes with complete_task, and Helm settles the task and closes it.
// What it plays, by the text of the message it gets:
//   director: "DEMO ..."  creates an active task for a builder (the engineer below), logs a decision.
//             "PLAN ..."  creates a planning task and asks the user a question.
//             "FAIL ..."  creates a task whose builder stops with an error after one step: a usage limit,
//                         or with "FAIL crash" its process exits with code 1 (agents that stop with an error).
//             "ASK-PERMISSION ..."  asks to run a Bash command and waits for the permission answer.
//             an interjection on a task is relayed to the engineer; anything else is answered "Noted."
//             a dashboard the user described (the <helm-note> from New dashboard, on a dash-repo.mjs repository): builds
//                         a bar chart, a three-picture gallery and an expensive number, runs the recipes for their first
//                         data, marks it ready and finishes the task.
//             "DASHWORK forest|cave|desert|readme|profile": a task whose builder changes that one input in a worktree,
//                         merges it, and at complete_task refreshes exactly the tiles Helm names.
//             "RELEASE-RECIPE": proposes a release recipe (one bundle, published to the project's published/ folder), a
//                         card in the Release recipe discussion the user applies; a test build the user starts (Helm's
//                         brief): builds the bundle from a clean checkout and reports it (report_test_build).
//             a release the user cut (Helm's brief): writes the change log; Helm's builder builds and attaches the bundle
//                         (clean checkout, build, add_release_artifact); told it is done, finish_release and settles the
//                         task; a confirmed publish runs the steps. Test builds and Rebuilds are a builder's too.
//             "TIERS": a Routine task and a Skilled one, each with its own builder; each turn logs the model and effort
//                         it ran on (turn-model in the log), as Helm set them per task tier.
//             "FANOUT": four scheduled tasks touching separate files, a builder each (up to "builders at once"). The one
//                         in three parts fans them out to three subagents (Setup: subagents per builder); off, it works
//                         serially.
//             "WAITS": two scheduled tasks, a builder each: a two-minute build in the background (under a heavy claim on
//                         this machine) with light work filling the wait, then two heavy jobs at once on two hosts (this
//                         machine and the project's host "buildbox": add it first).
//             "CONTEXT": a turn whose context is 85% full; Helm's save note gets note_knowledge and log_journal, then the
//                         context is summarised (the PreCompact hook, compact_boundary), and Helm's two-line note follows.
//             "QUEUE5": five small scheduled tasks; Helm starts a builder for each, "builders at once" at a time.
//   engineer: (the builder of DEMO's task) works a five-step worklist with transcript tool calls, posts a preview,
//             completes the task; honours interjections and PAUSE between steps.
// Tasks it schedules or starts pass quick_fix (Spec adherence Loose, the default, needs a Spec link otherwise).
// FAKE_SPEED=0.2 makes it five times faster. Log and state: $HELM_FAKE_DIR (scratch.mjs sets it per instance).
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
const DIR = process.env.HELM_FAKE_DIR || join(tmpdir(), `helm-fake-${process.ppid}`);
mkdirSync(DIR, { recursive: true });
const LOG = join(DIR, 'log.txt');
const STATE = join(DIR, 'state.json');
const SPEED = Number(process.env.FAKE_SPEED || 1);
// The model and effort Helm started this process with, and any switch it asked for since (set_model, effort settings).
const argOf = (flag) => { const eq = process.argv.find((a) => a.startsWith(`${flag}=`)); if (eq) return eq.slice(flag.length + 1); const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : ''; };
let model = argOf('--model') || 'fake';
let effort = argOf('--effort') || '';
const log = (...a) => appendFileSync(LOG, `[${process.pid}] ${a.join(' ')}\n`);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const session = `fake-${process.pid}-${Date.now()}`;
const uuid = () => crypto.randomUUID();
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const save = (s) => writeFileSync(STATE, JSON.stringify({ ...state(), ...s }));
log('start', process.argv.slice(2).filter((a) => a.startsWith('--')).join(' '));

let n = 0;
const pending = new Map();
function ask(request) {
  const id = `fk${++n}`;
  out({ type: 'control_request', request_id: id, request });
  return new Promise((res) => pending.set(id, res));
}
let mcpReady = null;
let rpc = 100;
async function mcp(name, args) {
  if (!mcpReady) mcpReady = ask({ subtype: 'mcp_message', server_name: 'helm', message: { jsonrpc: '2.0', id: ++rpc, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } } } });
  await mcpReady;
  const r = await ask({ subtype: 'mcp_message', server_name: 'helm', message: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } } });
  const text = (r?.response?.mcp_response?.result?.content ?? []).map((c) => c.text).join('\n') || JSON.stringify(r);
  log('mcp', name, '->', text.slice(0, 200));
  return text;
}
const msgBase = () => ({ parent_tool_use_id: null, session_id: session, uuid: uuid() });
/** One tool call as the transcript sees it; helm tools really run. */
async function tool(name, input, result = 'ok') {
  const id = `toolu_${uuid().slice(0, 12)}`;
  out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name, input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...msgBase() });
  const text = name.startsWith('mcp__helm__') ? await mcp(name.slice('mcp__helm__'.length), input) : result;
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...msgBase() });
  return text;
}
/** A builder's brief (its first message): its "## Done when" items are ticked before complete_task, as the gates ask. */
let briefText = '';
const doneWhen = (text) => {
  const m = /## Done when\n([\s\S]*?)(?:\n\n|$)/.exec(text);
  return m ? m[1].split('\n').filter((l) => /^\s*(\d+\.|[-*])\s/.test(l)).length : 0;
};
const H = async (name, input) => {
  const n = name === 'complete_task' ? doneWhen(briefText) : 0;
  if (n) await tool('mcp__helm__report_status', { status: 'Checked what done means', done_when: Array.from({ length: n }, (_, i) => i + 1) });
  return tool(`mcp__helm__${name}`, input);
};
function say(text) {
  out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, ...(ctxFull ? { cache_read_input_tokens: 170000 } : {}) } }, ...msgBase() });
}
// Token use as a running session total (as Claude Code reports modelUsage) and the plan windows (rate_limit_event).
let used = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
let calls = 0;
function result(text, t0, isError = false) {
  calls++;
  used = { inputTokens: used.inputTokens + 900 * calls, outputTokens: used.outputTokens + 1400, cacheReadInputTokens: used.cacheReadInputTokens + 60000, cacheCreationInputTokens: used.cacheCreationInputTokens + 9000 };
  const hour = 3_600_000;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: Math.floor((Math.ceil(Date.now() / hour) * hour + 2 * hour) / 1000) }, uuid: uuid(), session_id: session });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.18, resetsAt: Math.floor((Date.now() + 3 * 24 * hour) / 1000) }, uuid: uuid(), session_id: session });
  out({ type: 'result', subtype: 'success', is_error: isError, duration_ms: Date.now() - t0, duration_api_ms: 1, num_turns: 1, result: text, session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [model]: { ...used, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 32000 } }, permission_denials: [], uuid: uuid() });
}

// ---------- roles ----------
const inbox = [];
let busy = false;
let note = null; // a message that arrived mid-turn (an interjection relayed by the director)
let stopped = false;

/** Runs a command for real in the project folder (dashboard scenarios), shown in the transcript as a Bash call. */
async function sh(command, cwd = process.cwd()) {
  let out = '';
  try {
    out = execSync(command, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Scratch', GIT_AUTHOR_EMAIL: 'scratch@example.com', GIT_COMMITTER_NAME: 'Scratch', GIT_COMMITTER_EMAIL: 'scratch@example.com' } });
  } catch (e) {
    out = `failed: ${e.message}`;
  }
  await tool('Bash', { command, description: command.slice(0, 60) }, out.trim() || 'ok');
  return out.trim();
}
const LEVELS = ['forest', 'cave', 'desert'];

/** The director builds the dashboard the user described: tiles, recipes, first data, ready. */
async function buildDashboard(text) {
  const dash = /\[(dash_[0-9a-f]+)\]/.exec(text)?.[1];
  const task = /\[\[(task_[0-9a-f]+)\]\]/.exec(text)?.[1];
  await H('update_task', { task, state: 'active', quick_fix: true, driver: 'me', status_summary: 'Designing the tiles: a draw-call chart, a gallery of the three levels, and the profiled frame time.' });
  await H('task_post', { task, message: 'Starting. Three things from your description: draw calls per level as a bar chart, a picture of each level, and the profiled frame time (expensive, so refreshed only when I ask).' });
  const tile = async (input) => /\[(tile_[0-9a-f]+)\]/.exec(await H('set_tile', { dashboard: dash, ...input }))?.[1];
  const chart = await tile({ kind: 'chart', title: 'Draw calls per level', caption: 'From chart/draw-calls.json', depends_on: { paths: ['chart/**', 'scripts/chart.mjs'] }, recipe: { command: 'node scripts/chart.mjs', cwd: '.', duration: '1 s', notes: 'Prints the chart JSON: send it as data.' } });
  const pics = {};
  for (const lv of LEVELS) pics[lv] = await tile({ kind: 'image', title: lv[0].toUpperCase() + lv.slice(1), group: 'Levels', depends_on: { paths: [`levels/${lv}/**`, 'scripts/render.mjs'] }, recipe: { command: `node scripts/render.mjs ${lv}`, cwd: '.', duration: '1 s', notes: `Send out/${lv}.svg as the path.` } });
  const cost = await tile({ kind: 'number', title: 'Frame time, high quality', caption: 'p95 over a 2-minute profiled run', depends_on: { paths: ['profile/**'] }, recipe: { command: 'bash scripts/profile.sh --minutes 2', cwd: '.', duration: '20 min', notes: 'Report the p95 frame time in ms.' }, expensive: true });
  await H('update_tile', { tile: chart, data: JSON.parse(await sh('node scripts/chart.mjs')) });
  for (const lv of LEVELS) {
    await sh(`node scripts/render.mjs ${lv}`);
    await H('update_tile', { tile: pics[lv], path: join(process.cwd(), 'out', `${lv}.svg`) });
  }
  await H('update_tile', { tile: cost, data: { value: 14.2, unit: 'ms', target: 16.7, better: 'lower', min: 0, max: 33, label: 'p95 frame time' } });
  await H('set_dashboard', { dashboard: dash, title: 'Game at a glance', state: 'ready' });
  await H('update_task', { task, state: 'done', why: 'built and checked against the description', status_summary: 'The dashboard is ready: a draw-call chart, a picture of each level and the profiled frame time, each with its dependencies and recipe.' });
  return `Built the dashboard ${dash}.`;
}

/** The CONTEXT run: a full context, the save turn, the summary. */
async function contextRun(text) {
  if (/kind="context">Your context was just summarised/.test(text)) {
    log('context-after', text.replace(/\n/g, ' ').slice(0, 300));
    return 'Noted: earlier history is searchable.';
  }
  if (/kind="context">Your context is/.test(text)) {
    log('context-save', text.slice(0, 120).replace(/\n/g, ' '));
    await H('note_knowledge', { topic: 'Pitfalls', title: 'The exporter needs UTF-8 input', text: 'Feed it UTF-8; Latin-1 files come out garbled.' });
    await H('log_journal', { kind: 'decision', title: 'Keep the old export flag one more release', body: 'Scripts still use it.' });
    // Claude summarises: the PreCompact hook first, then the boundary.
    for (const m of initHooks.PreCompact ?? []) for (const cb of m.hookCallbackIds ?? []) await ask({ subtype: 'hook_callback', callback_id: cb, input: { hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null, session_id: session, cwd: process.cwd(), transcript_path: '' } });
    out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 176000, post_tokens: 18000 }, uuid: uuid(), session_id: session });
    ctxFull = false;
    return 'Saved what must survive.';
  }
  ctxFull = true;
  say('Working through a long exporter port.');
  return 'Long turn done.';
}
let ctxFull = false;

/** The task id a builder's brief is for ("Helm started you for the task "…" [[task_…]]"), or a marker's task=. */
const briefTask = (text) => /task=(task_[0-9a-f]+)/.exec(text)?.[1] ?? /\[\[((?:task|disc)_[0-9a-f]+)\]\]/.exec(text)?.[1];
/** Create a task for a builder: its description carries the marker the builder plays by (Helm's brief quotes it). */
async function queueWork(input, marker) {
  const made = await H('create_task', { quick_fix: true, check: 'npm test', ...input, description: `${input.description}\n\n${marker}` });
  const task = /(?:id |\[\[)(task_[a-z0-9]+)/.exec(made)?.[1];
  if (!task) throw Object.assign(new Error(`Could not create the task: ${made.slice(0, 200)}`), { isError: true });
  return task;
}
async function director(text) {
  if (/CONTEXT/.test(text) || /kind="context"/.test(text)) return contextRun(text);
  const released = await releaseDirector(text);
  if (released !== null) return released;
  if (/described a dashboard/.test(text)) return buildDashboard(text);
  const work = /DASHWORK (\w+)/.exec(text);
  if (work && !/<agent-report/.test(text)) {
    const what = work[1];
    const title = LEVELS.includes(what) ? `Rework the ${what} level` : what === 'profile' ? 'Turn on soft shadows' : 'Fix a typo in the README';
    const task = await queueWork({ title, description: `Change ${what} and finish.`, state: 'active', check: 'its tile refreshes', parallel_reason: 'One input each; no shared files.', touches: [what === 'readme' ? 'README.md' : what === 'profile' ? 'profile/' : `levels/${what}/`] }, `FAKE-ENGINEER-DASH what=${what}`);
    return `Started ${task}; Helm starts its builder.`;
  }
  if (/<helm-note kind="dashboards">/.test(text)) return 'Noted: I will batch the expensive refresh.';
  if (/interjection="true"/.test(text)) {
    const task = /task="([^"]+)"/.exec(text)?.[1];
    const body = text.replace(/^[\s\S]*?<task-message[^>]*>\n?/, '').replace(/\n?<\/task-message>[\s\S]*$/, '').trim();
    const paused = /paused="true"/.test(text);
    const drv = state().engineer;
    if (drv) await H('message_agent', { agent: drv, message: paused ? `PAUSE. The user paused the task to read; stop where you are. Their note: ${body}` : `The user interjected on your task; do this first: ${body}` });
    await H('task_post', { task, message: paused ? `Paused ${drv ?? 'the work'} as you asked; nothing more happens until you resume. On your note (“${body}”): I'll fold it in when you resume.` : `Passed to ${drv ?? 'the driver'} at once: “${body}”. It switches to that now, before the rest of the worklist.` });
    return 'Relayed the interjection.';
  }
  if (/ASK-PERMISSION/.test(text) && !/<agent-report/.test(text)) {
    // A permission prompt as Claude Code raises one: Helm turns it into a request and waits for the answer.
    await sleep(5000);
    const id = `toolu_${uuid().slice(0, 12)}`;
    const input = { command: 'rm -rf build', description: 'Clean the build folder' };
    out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name: 'Bash', input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...msgBase() });
    const r = await ask({ subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: id });
    const behavior = r?.response?.behavior ?? 'unknown';
    log('permission', behavior);
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: behavior === 'allow' ? '(removed build/)' : 'Permission denied', is_error: behavior !== 'allow' }] }, ...msgBase() });
    return `Permission answer: ${behavior}.`;
  }
  if (/PLAN/.test(text) && !/<agent-report/.test(text)) {
    const made = await H('create_task', { title: 'Remember the last project opened on each device', description: '## Plan\n\n1. Store the last project id per device in local storage when a project page opens.\n2. On launch, open it instead of the project list, unless the link names another page.\n3. A "All projects" link stays one tap away.\n\n**Done when:** reopening the app on the phone lands on the project used last, checked at 390 px.\n\nRelated past work: none found.', state: 'planning' });
    const task = /(?:id |\[\[)(task_[a-z0-9]+)/.exec(made)?.[1];
    await H('update_task', { task, status_summary: 'A plan for you to approve: three small steps in the web app, no server change.' });
    await H('ask_user', { title: 'Per device or per account?', question: 'Should the last project be remembered per device (phone and desktop each their own), or shared across devices?', options: [{ label: 'Per device' }, { label: 'Shared' }], recommendation: 'Per device: the phone and the desk are used for different things.', task });
    return `Planned ${task}.`;
  }
  if (/FAIL/.test(text) && !/<agent-report/.test(text)) {
    const task = await queueWork({ title: 'Speed up the level loader', description: 'Load levels in the background so the menu stays responsive.', state: 'active', check: 'npm run profile', parallel_reason: 'Separate from other work.', touches: ['src/loader.ts'] }, `FAKE-ENGINEER-FAIL${/crash/i.test(text) ? '-CRASH' : ''}`);
    return `Started ${task}; Helm starts its builder.`;
  }
  if (/WAITS/.test(text) && !/<agent-report/.test(text)) {
    const specs = [
      { title: 'Build the bundle and tidy the docs', description: 'LONGBUILD: run the two-minute build; tidy the docs pages meanwhile.', touches: ['dist/', 'docs/'] },
      { title: 'Unit suite and level renders', description: 'HEAVY2: run the unit suite and render the level pictures.', touches: ['levels/'] },
    ];
    for (const sp of specs) await queueWork({ title: sp.title, description: sp.description, state: 'scheduled', check: 'ls dist', touches: sp.touches }, 'FAKE-BUILDER WAITS');
    return 'Queued two; Helm starts their builders.';
  }
  if (/FANOUT/.test(text) && !/<agent-report/.test(text)) {
    const specs = [
      { title: 'Docs in three parts', description: 'PARTS3: docs/a.md, docs/b.md and docs/c.md.', file: 'docs' },
      { title: 'Change the exporter', description: 'Edit src/export.ts.', file: 'src/export.ts' },
      { title: 'Change the importer', description: 'Edit src/import.ts.', file: 'src/import.ts' },
      { title: 'Change the logger', description: 'Edit src/log.ts.', file: 'src/log.ts' },
    ];
    for (const sp of specs) await queueWork({ title: sp.title, description: sp.description, state: 'scheduled', touches: [sp.file] }, `FAKE-BUILDER FANOUT file=${sp.file}`);
    return 'Queued four; Helm starts their builders.';
  }
  if (/QUEUE5/.test(text) && !/<agent-report/.test(text)) {
    for (let i = 1; i <= 5; i++) await queueWork({ title: `Small change ${i}`, description: `Change line ${i} of the notes file.`, state: 'scheduled', check: `grep line${i} notes.txt`, touches: [`notes-line${i}.txt`] }, 'FAKE-BUILDER');
    return 'Queued five; Helm starts their builders.';
  }
  if (/<helm-note kind="batch">/.test(text)) return 'Read the batch; all good.';
  if (/TIERS/.test(text) && !/<agent-report/.test(text)) {
    const a = await queueWork({ title: 'Rename the export flag', description: 'Rename --fmt to --format in the exporter.', state: 'scheduled', check: 'npm test -- export', tier: 'routine', tier_reason: 'Mechanical rename with a named test.', touches: ['src/export.ts'] }, 'FAKE-ENGINEER-TIER n=1');
    const b = await queueWork({ title: 'Design the export retry policy', description: 'Decide when the export retries after a network failure. Related past work: none found.', state: 'scheduled', check: 'a test with the network cut', touches: ['src/retry.ts'] }, 'FAKE-ENGINEER-TIER n=2');
    return `Scheduled ${a} and ${b}; Helm starts a builder for each.`;
  }
  if (/DEMO/.test(text) && !/<agent-report/.test(text)) {
    const task = await queueWork({ title: 'Show a clear error when sign-in fails', description: 'When the passphrase is wrong, say so under the field instead of reloading.\n\nDone when: the message shows, tests pass, and a screenshot is posted.', state: 'active', check: 'npm test -- login and a 390 px screenshot', parallel_reason: 'Separate from other work.', touches: ['web/src/login.tsx'] }, 'FAKE-ENGINEER');
    await H('update_task', { task, status_summary: 'Starting: Helm starts a builder on it. First the failing test, then the form change.' });
    save({ task });
    await H('log_journal', { kind: 'decision', title: 'Show sign-in errors inline, not as a reload', body: 'Keeps the typed passphrase.', task });
    return `Started ${task}.`;
  }
  return 'Noted.';
}

/** An engineer that stops with an error after one step: a usage limit as Claude Code reports it, or a crash. */
// ---------- releases ----------
const RELEASE_LOG = '## New\n- Each level now has a picture on the project dashboard.\n\n## Improved\n- The forest has more trees and a warmer sky.\n\n## Fixed\n- A typo in the README.';

/** The director's part of a release: the recipe (asked for), the change log and a builder (Helm's brief), publishing (confirmed). */
async function releaseDirector(text) {
  if (/RELEASE-RECIPE/.test(text) && !/started (release|a test build)/.test(text)) {
    await H('set_release_recipe', {
      artifacts: [{ name: 'Game bundle', command: 'mkdir -p dist && tar czf dist/game.tgz README.md levels', cwd: '.', files: ['dist/game.tgz'], duration: '2 s' }],
      scheme: 'semver',
      publish: '1. Copy `dist/game.tgz` into the project\'s `published/` folder as `game-<version>.tgz`.\n2. Record the path with mark_published.',
      rationale: 'One bundle of the levels and README, kept in the project\'s published/ folder.',
    });
    return 'I proposed a release recipe: one bundle, published to the project\'s published/ folder. Apply it on its card.';
  }
  // A test build for the user to try (testbuilds.ts): "TEST-BUILD task=<id>", or a Rebuild the user asked for.
  const forTask = /TEST-BUILD task=(task_[0-9a-f]+)/.exec(text);
  const rebuild = /asked to rebuild .*?\[(tb_[0-9a-f]+)\] on the task "[^"]*" \[\[(task_[0-9a-f]+)\]\]/s.exec(text);
  if (forTask || rebuild) {
    const task = forTask ? forTask[1] : rebuild[2];
    const commit = rebuild ? /--detach <folder> ([0-9a-f]{40})/.exec(text)?.[1] ?? 'HEAD' : 'HEAD';
    const root = process.cwd();
    const wt = `${root}-wt/tb-${Date.now()}`;
    await H('report_status', { status: 'Making a test build' });
    await sh(`git worktree add -q --detach ${wt} ${commit}`);
    await sleep(1000);
    await sh('mkdir -p dist && tar czf dist/game.tgz README.md levels', wt);
    const made = await H('make_test_build', { task, artifacts: [{ name: 'Game bundle', path: join(wt, 'dist/game.tgz') }], ...(rebuild ? { rebuild_of: rebuild[1], commit } : {}) });
    await sh(`git worktree remove --force ${wt}`, root);
    const id = /\[(tb_[0-9a-f]+)\]/.exec(made)?.[1];
    if (id && forTask) await H('ask_user', { kind: 'action', title: 'Try the new level pack', question: 'The bundle has the levels as they are now: play the forest level once.', steps: '1. Download the bundle below\n2. Unpack it and open the forest level\n3. Answer Done with how it felt', task, test_build: id });
    return id ? `Test build ${id} made.` : `Could not make it: ${made}`;
  }
  const testBuild = /started a test build \[(rt_[0-9a-f]+)\] of "(.+?)" from/.exec(text);
  if (testBuild) {
    const [, id] = testBuild;
    const commit = /--detach <folder> ([0-9a-f]{40})/.exec(text)?.[1] ?? 'HEAD';
    const root = process.cwd();
    const wt = `${root}-wt/test-${id}`;
    await H('report_status', { status: `Test build ${id}` });
    await sh(`git worktree add -q --detach ${wt} ${commit}`);
    await sleep(1500);
    await sh('mkdir -p dist && tar czf dist/game.tgz README.md levels', wt);
    await H('report_test_build', { test: id, path: join(wt, 'dist/game.tgz') });
    await sh(`git worktree remove --force ${wt}`, root);
    return 'Test build reported.';
  }
  const started = /started release (\S+) \[(rel_[0-9a-f]+)\] from commit (\w+); its task is \[\[(task_[0-9a-f]+)\]\]/.exec(text);
  if (started) {
    const [, version, rel, , task] = started;
    const commit = /clean checkout of ([0-9a-f]{40})/.exec(text)?.[1] ?? '';
    await H('list_releases', {});
    await H('set_release_notes', { release: rel, notes: RELEASE_LOG });
    void commit;
    await H('task_post', { task, message: `Change log written for ${version}; a builder is making the bundle.` });
    save({ releaseTask: task });
    return `Release ${version}: log written; Helm's builder makes the bundle.`;
  }
  // The builder attached the artifacts (Helm's done note): the director finishes the release.
  const builtRel = /finished building release (\S+) \[(rel_[0-9a-f]+)\]/.exec(text);
  if (builtRel) {
    await H('finish_release', { release: builtRel[2] });
    const task = state().releaseTask;
    if (task) await H('update_task', { task, state: 'done', status_summary: 'Released: change log, bundle and tag.' });
    return `Release ${builtRel[1]} finished.`;
  }
  const publish = /confirmed publishing release (\S+) \[(rel_[0-9a-f]+)\]/.exec(text);
  if (publish) {
    const [, version, rel] = publish;
    await sh(`mkdir -p published && git archive --format=tar.gz -o published/game-${version}.tgz v${version} README.md levels`);
    await H('mark_published', { release: rel, how: `Copied to \`published/game-${version}.tgz\` in the project folder.` });
    return `Published ${version}.`;
  }
  return null;
}

/** A fresh builder given a release's artifacts (Helm's brief): builds and attaches them; the director finishes. */
async function releaseBuilder(text) {
  const rel = /release \S+ \[(rel_[0-9a-f]+)\]/.exec(text)?.[1];
  const commit = /clean checkout of ([0-9a-f]{40})/.exec(text)?.[1];
  await releaseBuild(rel, commit, false);
  const r = await H('complete_task', { summary: 'Built and attached the game bundle.', nothing_to_record: true, check_not_run: 'the check is the attached artifact' });
  log('relbuild-complete', r.slice(0, 60));
  return 'Built and attached the bundle.';
}
/** A fresh builder given a test build or a Rebuild (Helm's brief): the director's old steps, then complete_task. */
async function testBuilder(text) {
  const res = await releaseDirector(text);
  const r = await H('complete_task', { summary: res ?? 'Done.', nothing_to_record: true, check_not_run: 'the check is the reported build' });
  log('testbuild-complete', r.slice(0, 60));
  return res ?? 'Done.';
}
/** A release's build: a clean checkout of the release commit, the recipe's command, the file attached; `finish`: and the release finished. */
async function releaseBuild(rel, commit, finish = true) {
  const root = process.cwd();
  const wt = `${root}-wt/release-${commit.slice(0, 7)}`;
  await H('worklist_set', { items: [{ text: 'Clean checkout of the release commit', state: 'doing' }, { text: 'Build the game bundle' }, { text: 'Attach it and finish the release' }] });
  await H('report_status', { status: `Checking out ${commit.slice(0, 7)}` });
  await sh(`git worktree add -q --detach ${wt} ${commit}`);
  await H('worklist_update', { updates: [{ item: 1, state: 'done' }, { item: 2, state: 'doing' }] });
  await sleep(1500);
  await sh('mkdir -p dist && tar czf dist/game.tgz README.md levels', wt);
  await H('worklist_update', { updates: [{ item: 2, state: 'done' }, { item: 3, state: 'doing' }] });
  await H('add_release_artifact', { release: rel, name: 'Game bundle', path: join(wt, 'dist/game.tgz') });
  if (finish) await H('finish_release', { release: rel });
  await sh(`git worktree remove --force ${wt}`, root);
  await H('worklist_update', { updates: [{ item: 3, state: 'done' }] });
}

async function failing(text) {
  await H('worklist_set', { items: [{ text: 'Profile the loader', state: 'doing' }, { text: 'Move parsing off the main thread' }, { text: 'Check the menu at 390 px' }] });
  await H('report_status', { status: 'Profiling the level loader' });
  await sleep(1500);
  await tool('Bash', { command: 'npm run profile -- levels', description: 'Profile loading' }, 'parse: 812 ms of 940 ms');
  if (/CRASH/.test(text)) {
    log('crash on purpose');
    process.exit(1);
  }
  const limit = "You've hit your weekly limit · resets Nov 21, 12pm (UTC)";
  out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: limit }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, error: 'rate_limit', ...msgBase() });
  throw Object.assign(new Error(limit), { isError: true });
}

/** A worker that changes one input in a worktree, merges it, and answers complete_task's dashboard ask. */
async function dashEngineer(text) {
  const task = briefTask(text);
  const what = /what=(\w+)/.exec(text)?.[1];
  const me = /You are (Builder \w+)/.exec(text)?.[1] ?? 'builder';
  const root = process.cwd();
  const file = LEVELS.includes(what) ? `levels/${what}/scene.txt` : what === 'profile' ? 'profile/settings.txt' : 'README.md';
  await H('worklist_set', { items: [{ text: `Change ${file}`, state: 'doing' }, { text: 'Merge' }, { text: 'Refresh the dashboard tiles Helm names' }] });
  const wt = `${root}-wt/${what}-${Date.now() % 100000}`;
  const branch = `${what}-${Date.now() % 100000}`;
  await sh(`git worktree add -q ${wt} -b ${branch}`);
  await H('register_artifacts', { path: wt, kind: 'worktree', disposable: false, branch });
  const change = LEVELS.includes(what) ? `sed -i 's/trees=[0-9]*/trees=5/; s/sky=#[0-9a-f]*/sky=#ffb38a/' ${file}` : what === 'profile' ? `sed -i 's/shadows=on/shadows=soft/' ${file}` : `sed -i 's/tiny/small/' ${file}`;
  await sh(`${change} && git commit -qam "Change ${what}"`, wt);
  await H('worklist_update', { updates: [{ item: 1, state: 'done' }, { item: 2, state: 'doing' }] });
  await sh(`git merge -q --ff-only ${branch} && git worktree remove ${wt}`, root);
  await H('worklist_update', { updates: [{ item: 2, state: 'done' }, { item: 3, state: 'doing' }] });
  let r = await H('complete_task', { summary: `Changed ${what}.`, nothing_to_record: true });
  for (let round = 0; round < 3 && /^Not completed yet/.test(r); round++) {
    for (const line of r.split('\n')) {
      const m = /\[(tile_[0-9a-f]+)\] \((\w+),.*Recipe in ([^:]+?)(?: on host [^:]+)?(?: \(about [^)]+\))?: (.*)$/.exec(line);
      if (!m) continue;
      const [, tileId, kind, cwd, command] = m;
      const out = await sh(command, join(root, cwd));
      if (kind === 'image') await H('update_tile', { tile: tileId, path: join(root, cwd, out.split('\n').pop()) });
      else if (kind === 'chart') await H('update_tile', { tile: tileId, data: JSON.parse(out) });
      else await H('update_tile', { tile: tileId, unaffected: 'not something this change alters' });
    }
    r = await H('complete_task', { summary: `Changed ${what}; refreshed the tiles it affected.`, nothing_to_record: true });
  }
  await H('worklist_update', { updates: [{ item: 3, state: 'done' }] });
  return `Done (${task}, ${me}).`;
}

/** One small queued task: a step, the check, complete_task. Helm's own brief ("Your next task: …") works too. */
async function queueBuilder(text) {
  if (/FAKE-BUILDER WAITS/.test(text)) return waitsBuilder(text);
  if (/FAKE-BUILDER FANOUT/.test(text)) return fanBuilder(text);
  const task = briefTask(text);
  await H('worklist_set', { items: [{ text: 'Make the change and run its check', state: 'doing' }] });
  await tool('Bash', { command: 'sed -i s/x/y/ notes.txt && grep y notes.txt', description: 'Change and check' }, 'y');
  await H('worklist_update', { updates: [{ item: 1, state: 'done' }] });
  await H('complete_task', { summary: `Changed it; check passed (${task}).`, nothing_to_record: true });
  return `Done (${task}).`;
}

/** One short task for the tiers run: a step, then complete_task; says which task and run it was. */
async function tierEngineer(text) {
  const task = briefTask(text);
  const n = /n=(\d)/.exec(text)?.[1] ?? '1';
  await H('worklist_set', { items: [{ text: `Do the work (${model})`, state: 'doing' }] });
  await tool('Bash', { command: 'npm test -- export', description: 'Run the check' }, 'All tests passed.');
  await H('worklist_update', { updates: [{ item: 1, state: 'done' }] });
  const done = await H('complete_task', { summary: `Done on ${model}.`, nothing_to_record: true });
  log('tier-complete', task, done.slice(0, 80));
  return `Done (${task}, n=${n}).`;
}

async function engineer(text) {
  const task = briefTask(text) ?? state().task;
  if (/FAKE-ENGINEER/.test(text)) save({ engineer: /You are (Builder \w+)/.exec(text)?.[1] ?? 'builder', task });
  if (!/FAKE-ENGINEER/.test(text)) {
    // A follow-up from the director outside a run.
    await H('report_status', { status: /PAUSE/.test(text) ? 'Paused by the user' : 'Read the director’s note' });
    return /PAUSE/.test(text) ? 'Stopped as asked.' : 'Noted the change.';
  }
  const steps = ['Write a failing test for the wrong passphrase', 'Show the error under the field', 'Keep the typed passphrase', 'Screenshot at 390 px', 'Run typecheck and build'];
  await H('worklist_set', { items: steps.map((t) => ({ text: t })) });
  const script = [
    [['Read', { file_path: '/srv/demo/web/src/login.tsx' }], ['Grep', { pattern: 'passphrase', path: 'web/src' }], ['Write', { file_path: '/srv/demo/web/src/login.test.tsx' }], ['Bash', { command: 'npm test -- login', description: 'Run the login tests' }]],
    [['Edit', { file_path: '/srv/demo/web/src/login.tsx' }], ['Edit', { file_path: '/srv/demo/web/src/styles.css' }], ['Bash', { command: 'npm test -- login' }]],
    [['Read', { file_path: '/srv/demo/server/auth.ts' }], ['Edit', { file_path: '/srv/demo/web/src/login.tsx' }]],
    [['Bash', { command: 'chromium --headless --window-size=390,844 --screenshot=login.png http://localhost:9000' }], ['preview']],
    [['Bash', { command: 'npm run typecheck' }], ['Bash', { command: 'npm run build' }]],
  ];
  for (let i = 0; i < steps.length; i++) {
    if (stopped) break;
    await H('worklist_update', { updates: [{ item: i + 1, state: 'doing' }] });
    await H('report_status', { status: `${steps[i]}…` });
    for (const [name, input] of script[i]) {
      if (note) {
        const m = note;
        note = null;
        if (/PAUSE/.test(m)) {
          stopped = true;
          await H('report_status', { status: 'Paused by the user; waiting to resume' });
          break;
        }
        say(`The user interjected: ${m.slice(0, 200)}. Switching to that first.`);
        await H('report_status', { status: 'Handling the user’s interjection first' });
        await H('worklist_update', { add: [{ text: 'Do what the user asked in their interjection', state: 'doing' }] });
        await sleep(4000);
        await tool('Edit', { file_path: '/srv/demo/web/src/login.tsx' });
        await sleep(3000);
        await H('worklist_update', { updates: [{ item: steps.length + 1, state: 'done' }] });
      }
      await sleep(3500);
      if (name === 'preview') {
        await H('post_preview', { title: 'Sign-in error state', kind: 'markdown', content: '### Wrong passphrase\n\n> **That passphrase is not right.** Try again; what you typed is kept.\n\nShown under the field at 390 px; nothing reloads.' });
      } else await tool(name, input, name === 'Bash' ? 'All 14 tests passed.' : 'ok');
    }
    if (stopped) break;
    await H('worklist_update', { updates: [{ item: i + 1, state: 'done' }] });
  }
  if (stopped) return 'Stopped where I was, as the user asked.';
  // complete_task asks once for a project knowledge note first (server/knowledge.ts): this stand-in has none to record.
  const done = await H('complete_task', { summary: 'Sign-in errors show inline; tests and build pass.' });
  if (!/Marked complete/.test(done)) await H('complete_task', { summary: 'Sign-in errors show inline; tests and build pass.', nothing_to_record: true });
  return `Done (${task}).`;
}

// ---------- builder fan-out (FANOUT) ----------
let initHooks = {};
/** Ask the SDK's PreToolUse hooks (Helm's checks) about a tool call, as the CLI does; returns the deny reason or null. */
async function preToolUse(name, input, id) {
  for (const m of initHooks.PreToolUse ?? []) {
    for (const cb of m.hookCallbackIds ?? []) {
      const r = await ask({ subtype: 'hook_callback', callback_id: cb, input: { hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id, session_id: session, cwd: process.cwd(), transcript_path: '' }, tool_use_id: id });
      const out_ = r?.response?.hookSpecificOutput;
      if (out_?.permissionDecision === 'deny') return out_.permissionDecisionReason ?? 'denied';
    }
  }
  return null;
}
const SUB_TOKENS = 6000;
/**
 * The Agent tool as the CLI runs a background subagent: the call (through Helm's hook), task_started, the launch result,
 * then the subagent's own tool calls (parent_tool_use_id) with their usage and task_progress, and task_notification.
 * Returns null when Helm refused it, else { done }: a promise of its end (wrapped, so awaiting the call does not wait for it).
 */
async function agentCall(input, steps) {
  const id = `toolu_${uuid().slice(0, 12)}`;
  out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name: 'Agent', input }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...msgBase() });
  const denied = await preToolUse('Agent', input, id);
  if (denied) {
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: denied }] }, ...msgBase() });
    log('agent-denied', denied.slice(0, 120));
    return null;
  }
  const taskId = `t${uuid().slice(0, 8)}`;
  out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, subagent_type: input.subagent_type, is_backgrounded: true, uuid: uuid(), session_id: session });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched.' }] }, ...msgBase() });
  const done = (async () => {
    const t0 = Date.now();
    for (const [name, inp] of steps) {
      await sleep(3500);
      const sid = `toolu_${uuid().slice(0, 12)}`;
      out({ type: 'assistant', parent_tool_use_id: id, message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id: sid, name, input: inp }], stop_reason: null, stop_sequence: null, usage: { input_tokens: SUB_TOKENS, output_tokens: 0 } }, session_id: session, uuid: uuid() });
      used = { ...used, inputTokens: used.inputTokens + SUB_TOKENS };
      out({ type: 'user', parent_tool_use_id: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: sid, content: 'ok' }] }, session_id: session, uuid: uuid() });
      out({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: id, description: input.description, last_tool_name: name, usage: { total_tokens: 0, tool_uses: 1, duration_ms: Date.now() - t0 }, uuid: uuid(), session_id: session });
    }
    out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: id, status: 'completed', output_file: '', summary: `Done: ${input.description}.`, usage: { total_tokens: steps.length * SUB_TOKENS, tool_uses: steps.length, duration_ms: Date.now() - t0 }, uuid: uuid(), session_id: session });
    log('subagent-done', input.description);
  })();
  return { done };
}
const part = (f) => [['Read', { file_path: f }], ['Edit', { file_path: f }], ['Bash', { command: `grep -c done ${f}`, description: `Check ${f}` }]];
/** Do one part oneself: the same three calls, one after another. */
async function doPart(f) {
  for (const [name, inp] of part(f)) {
    await sleep(3500);
    await tool(name, inp);
  }
}

/**
 * A shell command in the background as the CLI runs it: the call (through Helm's hook), the launch result, and
 * task_notification when it ends after `ms`. Returns null when Helm refused it, else { done }.
 */
async function bashBackground(input, ms) {
  const id = `toolu_${uuid().slice(0, 12)}`;
  out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'tool_use', id, name: 'Bash', input: { ...input, run_in_background: true } }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...msgBase() });
  const denied = await preToolUse('Bash', { ...input, run_in_background: true }, id);
  if (denied) {
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: denied }] }, ...msgBase() });
    log('bash-denied', denied.slice(0, 120));
    return null;
  }
  const taskId = `b${uuid().slice(0, 8)}`;
  out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, task_type: 'local_bash', is_backgrounded: true, uuid: uuid(), session_id: session });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Command running in background.' }] }, ...msgBase() });
  log('bash-start', input.description, Date.now());
  const done = (async () => {
    await sleep(ms);
    out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: id, status: 'completed', output_file: '', summary: `${input.description}: exit 0`, uuid: uuid(), session_id: session });
    log('bash-end', input.description, Date.now());
  })();
  return { done };
}

/** The builder in the WAITS run: a long build with light work in its wait, then two heavy jobs on two hosts. */
async function waitsBuilder(text) {
  const task = /\[\[(task_[0-9a-f]+)\]\]/.exec(text)?.[1] ?? /task=(task_[0-9a-f]+)/.exec(text)?.[1];
  log('waits-task', task, Date.now());
  const hosts = await H('list_hosts', {});
  const local = /^## (.+?) \(local/m.exec(hosts)?.[1] ?? 'This machine';
  if (/HEAVY2/.test(text)) {
    await H('claim_host', { host: local, activity: 'Running the unit suite', heavy: true });
    const a = await bashBackground({ command: 'npm run test:unit', description: 'Unit suite' }, 40000);
    // A second heavy job on the same host is refused: it goes to the other host.
    const again = await H('claim_host', { host: local, activity: 'Rendering the level pictures', heavy: true });
    log('second-claim', again.slice(0, 160));
    await H('claim_host', { host: 'buildbox', activity: 'Rendering the level pictures', heavy: true });
    const b = await bashBackground({ command: 'ssh buildbox make render', description: 'Render the level pictures' }, 40000);
    await Promise.all([a, b].filter(Boolean).map((r) => r.done));
  } else {
    await H('claim_host', { host: local, activity: 'Building the release bundle', heavy: true });
    const build = await bashBackground({ command: 'make build', description: 'Build the release bundle' }, 120000);
    // Light work that does not need the build fills the wait.
    for (let i = 1; i <= 30; i++) {
      await sleep(3500);
      await tool(i % 3 ? 'Read' : 'Edit', { file_path: `/srv/demo/docs/page${i}.md` });
    }
    if (build) await build.done;
  }
  await tool('Bash', { command: 'ls dist | wc -l', description: 'Check the output' }, '4');
  const done = await H('complete_task', { summary: `Done (${task}); check passed.`, nothing_to_record: true });
  log('waits-complete', task, Date.now(), done.slice(0, 60));
  return `Done (${task}).`;
}

/** The builder in the FANOUT run. */
async function fanBuilder(text) {
  const task = /\[\[(task_[0-9a-f]+)\]\]/.exec(text)?.[1] ?? /task=(task_[0-9a-f]+)/.exec(text)?.[1];
  log('fan-task', task, Date.now());
  const parts = /PARTS3: (\S+), (\S+) and (\S+)\./.exec(text);
  if (parts) {
    const files = parts.slice(1, 4);
    const tiers = ['light', 'routine', 'skilled'];
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await agentCall({ description: `Part ${i + 1}: ${files[i]}`, prompt: `Update ${files[i]} as the task says; do not commit.`, subagent_type: tiers[i], run_in_background: true }, part(files[i])));
    for (let i = 0; i < 3; i++) if (!runs[i]) await doPart(files[i]);
    await Promise.all(runs.filter(Boolean).map((r) => r.done));
  } else {
    await doPart(/FANOUT file=(\S+)/.exec(text)?.[1] ?? 'notes.txt');
  }
  await tool('Bash', { command: 'npm test', description: 'Run the task check' }, 'All tests passed.');
  const done = await H('complete_task', { summary: `Done (${task}); check passed.`, nothing_to_record: true });
  log('fan-complete', task, Date.now(), done.slice(0, 60));
  return `Done (${task}).`;
}

let who = null;
async function drain() {
  if (busy) return;
  busy = true;
  while (inbox.length) {
    const text = inbox.shift();
    // A builder's first message is Helm's brief ("You are Builder A. Helm started you for …"), quoting the task's
    // description with its marker; the director's messages never start that way.
    const brief = /^You are Builder \w+\. Helm started you for /.test(text);
    const marked = !brief ? null : /Build the artifacts of release/.test(text) ? 'relbuild' : /started a test build \[rt_|asked to rebuild/.test(text) ? 'testbuild' : /FAKE-BUILDER/.test(text) ? 'queue' : /FAKE-ENGINEER-TIER/.test(text) ? 'tier' : /FAKE-ENGINEER-FAIL/.test(text) ? 'failing' : /FAKE-ENGINEER-DASH/.test(text) ? 'dash' : /FAKE-ENGINEER/.test(text) ? 'engineer' : 'queue';
    if (marked && who !== 'director') who = marked;
    if (brief) briefText = text;
    who ??= 'director';
    const t0 = Date.now();
    log('turn', who, text.slice(0, 120).replace(/\n/g, ' '));
    log('turn-model', who, model, effort || '(default effort)');
    out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), tools: [], mcp_servers: [{ name: 'helm', status: 'connected' }], model: 'fake', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', claude_code_version: 'fake', uuid: uuid() });
    try {
      result(await (who === 'relbuild' ? releaseBuilder(text) : who === 'testbuild' ? testBuilder(text) : who === 'queue' ? queueBuilder(text) : who === 'tier' ? tierEngineer(text) : who === 'failing' ? failing(text) : who === 'dash' ? dashEngineer(text) : who === 'engineer' ? engineer(text) : director(text)), t0);
    } catch (e) {
      log('error', e.stack);
      result(e.isError ? e.message : `Fake failed: ${e.message}`, t0, !!e.isError);
    }
  }
  busy = false;
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_response') {
    const r = pending.get(m.response?.request_id);
    if (r) { pending.delete(m.response.request_id); r(m.response); }
    return;
  }
  if (m.type === 'control_request') {
    log('control', m.request?.subtype);
    if (m.request?.subtype === 'interrupt') stopped = true;
    if (m.request?.subtype === 'initialize') {
      initHooks = m.request.hooks ?? {};
      log('agents-option', Object.keys(m.request.agents ?? {}).join(',') || '(none)');
    }
    if (m.request?.subtype === 'set_model') model = m.request.model ?? model;
    if (m.request?.subtype === 'apply_flag_settings' && m.request.settings && 'effortLevel' in m.request.settings) effort = m.request.settings.effortLevel ?? '';
    const response = m.request?.subtype === 'initialize' ? { commands: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  if (m.type === 'user') {
    const c = m.message?.content;
    const text = typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join('\n');
    // A message for an engineer mid-run is read at its next step, the way a real agent sees it between tool calls.
    if (busy && who === 'engineer') { note = text; inbox.push(text); }
    else inbox.push(text);
    void drain();
  }
});
rl.on('close', () => setTimeout(() => process.exit(0), 200));
