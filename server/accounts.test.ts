import { SCRATCH } from './testenv.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Claude accounts (accounts.ts): which account a project runs on, failover while its primary is limited, and the return
 * once the limit resets. The end-to-end part runs real sessions through runtime.ts against a stand-in Claude Code that
 * answers a turn with a usage-limit rejection when the account it was started on (CLAUDE_CONFIG_DIR) is in LIMITED.
 */

const MAIN_CONFIG = join(SCRATCH, 'main-claude');
process.env.CLAUDE_CONFIG_DIR = MAIN_CONFIG;
const LOG = join(SCRATCH, 'fake-accounts.log');
const LIMITED = join(SCRATCH, 'fake-limited.txt');
writeFileSync(LIMITED, '');
const fake = join(SCRATCH, 'claude-accounts');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const dir = process.env.CLAUDE_CONFIG_DIR || '';
const account = dir.includes('/accounts/') ? dir.split('/accounts/')[1] : 'main';
const session = 'fake-' + process.pid;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const base = () => ({ parent_tool_use_id: null, session_id: session, uuid: crypto.randomUUID() });
const usage = { m: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, contextWindow: 200000 } };
createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'control_request') {
    const response = m.request?.subtype === 'initialize' ? { commands: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} } : {};
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    return;
  }
  if (m.type !== 'user') return;
  out({ type: 'system', subtype: 'init', session_id: session, cwd: process.cwd(), tools: [], mcp_servers: [], model: 'fake', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default', claude_code_version: 'fake', uuid: crypto.randomUUID() });
  const limited = readFileSync(${JSON.stringify(LIMITED)}, 'utf8').split('\\n').includes(account);
  appendFileSync(${JSON.stringify(LOG)}, account + ' ' + (limited ? 'limited' : 'ok') + '\\n');
  if (limited) {
    const text = "You've hit your session limit · resets 3am";
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }, ...base() });
    out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, error: 'rate_limit', ...base() });
    out({ type: 'result', subtype: 'success', is_error: true, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: text, session_id: session, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: crypto.randomUUID() });
    return;
  }
  out({ type: 'assistant', message: { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'Done on ' + account }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }, ...base() });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: 'Done on ' + account, session_id: session, total_cost_usd: 0, usage: {}, modelUsage: usage, permission_denials: [], uuid: crypto.randomUUID() });
});
`,
);
chmodSync(fake, 0o755);
process.env.HELM_CLAUDE_PATH = fake;

const db = await import('./db.ts');
const A = await import('./accounts.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');

after(async () => {
  await runtime.shutdownAll();
});

const HOUR = 3_600_000;
const projectPath = mkdtempSync(join(SCRATCH, 'proj-'));
function project(name = 'p') {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, projectPath, 'Build', 'full', JSON.stringify(defaultStructure()), db.now(), db.now());
  return id;
}
/** An extra account, signed in as Claude Code would leave it. */
function account(name: string, signIn = true) {
  assert.equal(A.addAccount(name), null);
  if (signIn) writeFileSync(join(A.accountDir(name)!, '.credentials.json'), '{}');
}
const setLimited = (...names: string[]) => writeFileSync(LIMITED, names.join('\n'));
const log = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

test('accounts: the main one always exists; extras get a folder whose transcripts are the main account\'s', () => {
  assert.deepEqual(A.accountNames(), ['main']);
  assert.match(A.addAccount('Bad Name') ?? '', /lowercase/);
  assert.match(A.addAccount('main') ?? '', /already/);
  account('alpha');
  const link = join(A.accountDir('alpha')!, 'projects');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), join(MAIN_CONFIG, 'projects'));
  assert.deepEqual(A.accountEnv('alpha'), { CLAUDE_CONFIG_DIR: A.accountDir('alpha') });
  assert.deepEqual(A.accountEnv('main'), {});
  // A projects folder Claude Code made before Helm linked it is kept aside, not deleted.
  A.addAccount('early');
  const early = A.accountDir('early')!;
  const own = join(early, 'projects');
  // Replace the link with a real folder, as a sign-in before Helm made the link would leave.
  rmSync(own);
  mkdirSync(join(own, 'x'), { recursive: true });
  A.ensureAccountDir('early');
  assert.ok(lstatSync(own).isSymbolicLink());
  assert.ok(readdirSync(early).some((f: string) => f.startsWith('projects.own-')));
  assert.equal(A.removeAccount('early'), null);
  assert.ok(!existsSync(early));
  assert.ok(existsSync(join(MAIN_CONFIG, 'projects')), 'removing an account leaves the shared transcripts');
});

test('account choice: the primary for every project that names it, the main account for the rest', () => {
  const p = project('on alpha');
  const q = project('on main');
  assert.equal(A.accountFor(p), 'main');
  assert.equal(A.setProjectAccounts(p, { primary: 'alpha' }), null);
  assert.match(A.setProjectAccounts(p, { primary: 'nope' }) ?? '', /No account/);
  assert.equal(A.accountFor(p), 'alpha');
  assert.equal(A.accountFor(q), 'main');
  // Fallbacks: ordered, deduplicated, never the primary.
  account('beta');
  assert.equal(A.setProjectAccounts(p, { fallbacks: ['beta', 'alpha', 'beta', 'main'] }), null);
  assert.deepEqual(A.projectAccounts(p), { primary: 'alpha', fallbacks: ['beta', 'main'] });
  const v = A.accountsView().find((a) => a.name === 'alpha')!;
  assert.deepEqual(v.primaryOf.map((x) => x.id), [p]);
  assert.match(v.command!, /^CLAUDE_CONFIG_DIR=.*accounts\/alpha claude$/);
  // Removing an account puts its projects back on main and drops it from fallbacks.
  account('gamma');
  A.setProjectAccounts(q, { primary: 'gamma', fallbacks: ['beta'] });
  A.setProjectAccounts(p, { fallbacks: ['gamma', 'beta'] });
  A.removeAccount('gamma');
  assert.deepEqual(A.projectAccounts(q), { primary: 'main', fallbacks: ['beta'] });
  assert.deepEqual(A.projectAccounts(p), { primary: 'alpha', fallbacks: ['beta'] });
});

test('failover: the first fallback with room while the primary is limited, back once it resets; none: it waits', () => {
  const t = db.now();
  account('one');
  account('two');
  account('three', false);
  const p = project();
  A.setProjectAccounts(p, { primary: 'one', fallbacks: ['three', 'two'] });
  const lone = project();
  A.setProjectAccounts(lone, { primary: 'one' });
  A.markLimited('one', t + 2 * HOUR, t);
  assert.equal(A.limitedUntil('one', t), t + 2 * HOUR);
  // 'three' never signed in: skipped.
  assert.equal(A.accountFor(p, t), 'two');
  assert.equal(A.accountFor(lone, t), 'one', 'no fallback: stays on its primary and waits');
  // The second is limited too: back to the primary (waiting).
  A.markLimited('two', null, t);
  assert.equal(A.limitedUntil('two', t), t + A.UNKNOWN_RESET_MS);
  assert.equal(A.accountFor(p, t), 'one');
  // After the primary's reset it is the primary again.
  assert.equal(A.accountFor(p, t + 2 * HOUR + 1), 'one');
  assert.equal(A.limitedUntil('one', t + 2 * HOUR + 1), null);
  A.markLimited('two', t - 1, t - HOUR);
  assert.equal(A.accountFor(p, t + HOUR), 'two');
});

test('token use is recorded per account', async () => {
  const { recordTurnUsage } = await import('./usage.ts');
  const p = project();
  const id = db.newId('ag');
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, created_at, updated_at) VALUES (?, ?, 'engineer', 'E', 'm', ?, ?)", id, p, db.now(), db.now());
  const before = A.accountTokens('alpha', 0);
  recordTurnUsage(db.get('SELECT * FROM agents WHERE id = ?', id)!, { m: { inputTokens: 500, outputTokens: 50 } }, null, 'agent', { account: 'alpha' });
  assert.equal(A.accountTokens('alpha', 0) - before, 550);
  const mainBefore = A.accountTokens('main', 0);
  recordTurnUsage(db.get('SELECT * FROM agents WHERE id = ?', id)!, { m: { inputTokens: 600, outputTokens: 50 } }, null, 'agent', { account: 'main' });
  assert.equal(A.accountTokens('main', 0) - mainBefore, 100);
});

test('end to end: a limit moves the project to its fallback with no error, and it returns after the reset', async () => {
  account('spare');
  const pid = project('failover');
  A.setProjectAccounts(pid, { primary: 'main', fallbacks: ['spare'] });
  const other = project('other');
  account('solo');
  A.setProjectAccounts(other, { primary: 'solo' });
  const proj = db.get('SELECT * FROM projects WHERE id = ?', pid)!;
  const director = runtime.rootAgent(proj);
  const structure = defaultStructure();
  const worker = runtime.createAgent(proj, director, structure.roles.find((r) => r.id !== structure.root)!, 'Engineer', 'Build it.');
  const agentOf = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
  const lastResult = (id: string) => JSON.parse(db.get("SELECT data FROM events WHERE agent_id = ? AND kind = 'result' ORDER BY id DESC LIMIT 1", id)?.data ?? '{}');

  setLimited('main');
  writeFileSync(LOG, '');
  await runtime.sendToAgent(worker.id, 'Start.', { kind: 'agent', name: 'Director' });
  await until(() => lastResult(worker.id).text === 'Done on spare' && agentOf(worker.id).status === 'idle');
  assert.deepEqual(log().slice(0, 2), ['main limited', 'spare ok']);
  assert.ok(A.limitedUntil('main'), 'the main account is marked limited');
  assert.equal(A.accountFor(pid), 'spare');
  assert.equal(db.all("SELECT 1 FROM inbox WHERE agent_id = ? AND kind = 'agent_error'", worker.id).length, 0, 'no error entry');
  assert.ok(db.get("SELECT 1 AS x FROM events WHERE agent_id = ? AND kind = 'note' AND data LIKE '%continuing on spare%'", worker.id));
  // Its next turn stays on the fallback; the tokens count there.
  await runtime.sendToAgent(worker.id, 'More.', { kind: 'agent', name: 'Director' });
  await until(() => log().filter((l) => l === 'spare ok').length >= 2 && agentOf(worker.id).status === 'idle');
  assert.ok(A.accountTokens('spare', 0) > 0);

  // The limit resets: the live session on the fallback is closed, and the next turn runs on main again.
  setLimited();
  db.run("UPDATE accounts SET limited_until = ? WHERE name = 'main'", db.now() - 1);
  assert.equal(A.accountFor(pid), 'main');
  runtime.rebalanceAccounts();
  await until(() => !runtime.liveAgentIds().has(worker.id));
  writeFileSync(LOG, '');
  await runtime.sendToAgent(worker.id, 'Back.', { kind: 'agent', name: 'Director' });
  await until(() => lastResult(worker.id).text === 'Done on main');
  assert.equal(log()[0], 'main ok');

  // A project with no fallback waits: its agent stops with the usage-limit error, and its account shows limited.
  const oproj = db.get('SELECT * FROM projects WHERE id = ?', other)!;
  const odir = runtime.rootAgent(oproj);
  setLimited('solo');
  await runtime.sendToAgent(odir.id, 'Go.', { kind: 'user', name: 'the user' });
  await until(() => agentOf(odir.id).status === 'error');
  const e = db.get("SELECT payload FROM inbox WHERE agent_id = ? AND kind = 'agent_error'", odir.id)!;
  assert.equal(JSON.parse(e.payload).error_kind, 'usage_limit');
  assert.ok(A.limitedUntil('solo'));
  assert.equal(A.accountFor(other), 'solo');
});

