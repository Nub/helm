#!/usr/bin/env node
// A stand-in for the Claude Code CLI for Helm scratch servers: speaks the SDK's stream-json protocol and plays a
// scripted director or engineer, calling Helm's MCP tools for real and emitting tool calls as a real agent would.
import { createInterface } from 'node:readline';
//
// What it plays, by the text of the message it gets:
//   director: "DEMO ..."  creates a task, spawns an engineer, logs a decision.
//             "PLAN ..."  creates a planning task and asks the user a question.
//             an interjection on a task is relayed to the engineer; anything else is answered "Noted."
//   engineer: (spawned by the director's DEMO) works a five-step worklist with transcript tool calls, posts a preview,
//             completes the task; honours interjections and PAUSE between steps.
// FAKE_SPEED=0.2 makes it five times faster. Log and state: $HELM_FAKE_DIR (scratch.mjs sets it per instance).
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const DIR = process.env.HELM_FAKE_DIR || join(tmpdir(), `helm-fake-${process.ppid}`);
mkdirSync(DIR, { recursive: true });
const LOG = join(DIR, 'log.txt');
const STATE = join(DIR, 'state.json');
const SPEED = Number(process.env.FAKE_SPEED || 1);
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
const H = (name, input) => tool(`mcp__helm__${name}`, input);
function say(text) {
  out({ type: 'assistant', message: { id: `msg_${uuid()}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, ...msgBase() });
}
function result(text, t0) {
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - t0, duration_api_ms: 1, num_turns: 1, result: text, session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: uuid() });
}

// ---------- roles ----------
const inbox = [];
let busy = false;
let note = null; // a message that arrived mid-turn (an interjection relayed by the director)
let stopped = false;

async function director(text) {
  if (/interjection="true"/.test(text)) {
    const task = /task="([^"]+)"/.exec(text)?.[1];
    const body = text.replace(/^[\s\S]*?<task-message[^>]*>\n?/, '').replace(/\n?<\/task-message>[\s\S]*$/, '').trim();
    const paused = /paused="true"/.test(text);
    const drv = state().engineer;
    if (drv) await H('message_agent', { agent: drv, message: paused ? `PAUSE. The user paused the task to read; stop where you are. Their note: ${body}` : `The user interjected on your task; do this first: ${body}` });
    await H('task_post', { task, message: paused ? `Paused ${drv ?? 'the work'} as you asked; nothing more happens until you resume. On your note (“${body}”): I'll fold it in when you resume.` : `Passed to ${drv ?? 'the driver'} at once: “${body}”. It switches to that now, before the rest of the worklist.` });
    return 'Relayed the interjection.';
  }
  const done = /FAKE-DONE task=(\S+)/.exec(text);
  if (done) {
    await H('update_task', { task: done[1], state: 'done', why: 'finished and verified', status_summary: 'Finished: the login form validates, tests pass, and the screenshot shows the new error state. Nothing is needed from you.' });
    return 'Closed the task.';
  }
  if (/PLAN/.test(text) && !/<agent-report/.test(text)) {
    const made = await H('create_task', { title: 'Remember the last project opened on each device', description: '## Plan\n\n1. Store the last project id per device in local storage when a project page opens.\n2. On launch, open it instead of the project list, unless the link names another page.\n3. A "All projects" link stays one tap away.\n\n**Done when:** reopening the app on the phone lands on the project used last, checked at 390 px.', state: 'planning' });
    const task = /(?:id |\[\[)(task_[a-z0-9]+)/.exec(made)?.[1];
    await H('update_task', { task, status_summary: 'A plan for you to approve: three small steps in the web app, no server change.' });
    await H('ask_user', { title: 'Per device or per account?', question: 'Should the last project be remembered per device (phone and desktop each their own), or shared across devices?', options: [{ label: 'Per device' }, { label: 'Shared' }], recommendation: 'Per device: the phone and the desk are used for different things.', task });
    return `Planned ${task}.`;
  }
  if (/DEMO/.test(text) && !/<agent-report/.test(text)) {
    const made = await H('create_task', { title: 'Show a clear error when sign-in fails', description: 'When the passphrase is wrong, say so under the field instead of reloading.\n\nDone when: the message shows, tests pass, and a screenshot is posted.', state: 'active' });
    const task = /(?:id |\[\[)(task_[a-z0-9]+)/.exec(made)?.[1];
    await H('update_task', { task, status_summary: 'Starting: an engineer is on it. First the failing test, then the form change.' });
    const name = 'Login engineer';
    const spawned = await H('spawn_agent', { role: 'engineer', name, task: `FAKE-ENGINEER task=${task}`, for_task: task });
    save({ engineer: /Started "([^"]+)"/.exec(spawned)?.[1] ?? name, task });
    await H('log_journal', { kind: 'decision', title: 'Show sign-in errors inline, not as a reload', body: 'Keeps the typed passphrase.', task });
    return `Started ${task}.`;
  }
  return 'Noted.';
}

async function engineer(text) {
  const task = /task=(\S+)/.exec(text)?.[1] ?? state().task;
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
  await H('complete_task', { summary: 'Sign-in errors show inline; tests and build pass.' });
  return `Done. FAKE-DONE task=${task}`;
}

let who = null;
async function drain() {
  if (busy) return;
  busy = true;
  while (inbox.length) {
    const text = inbox.shift();
    who ??= /FAKE-ENGINEER/.test(text) ? 'engineer' : 'director';
    const t0 = Date.now();
    log('turn', who, text.slice(0, 120).replace(/\n/g, ' '));
    out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), tools: [], mcp_servers: [{ name: 'helm', status: 'connected' }], model: 'fake', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', claude_code_version: 'fake', uuid: uuid() });
    try {
      result(await (who === 'engineer' ? engineer(text) : director(text)), t0);
    } catch (e) {
      log('error', e.stack);
      result(`Fake failed: ${e.message}`, t0);
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
