/**
 * The runner / web split (server/runner.ts), end to end on a scratch instance started with --split and the Claude
 * stand-in:
 *   1. an agent mid-turn keeps working while the web service restarts, and its whole transcript is there afterwards;
 *   2. a permission prompt asked while the web service is down is shown and answered once it is back;
 *   3. a message sent while the runner is down waits in the queue and is delivered when the runner is back;
 * and measures the delay from an event's creation in the runner to a browser's event stream, and the idle CPU of both
 * processes. Run: npm run check:split (about two minutes; IDLE_SECONDS=60 by default).
 */
import '../testenv.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = join(repo, '.claude', 'skills', 'helm-ui-check', 'scripts');
const name = `split-${process.pid}`;
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS ?? 60);
const node = (...args: string[]) => execFileSync(process.execPath, [join(scripts, 'scratch.mjs'), ...args, '--name', name], { cwd: repo, encoding: 'utf8', timeout: 120_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (s: string) => console.log(`ok   ${s}`);

type Inst = { url: string; cookie: string; project: string; pid: number; runnerPid: number; data: string; dir: string };
let inst: Inst;
const reload = () => (inst = JSON.parse(readFileSync(join(inst.dir, 'instance.json'), 'utf8')));
const api = async (path: string, body?: unknown) => {
  const go = () =>
    fetch(inst.url + path.replace(/^\//, ''), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: inst.cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // A pooled keep-alive connection to a web service that has since restarted fails once; a new one works.
  const r = await go().catch(() => go());
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
  return j as any;
};
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const agents = async () => (await api(`/api/projects/${inst.project}`)).agents as { id: string; name: string; status: string; parent_id: string | null }[];
const events = async (agentId: string) => (await api(`/api/agents/${agentId}/events?limit=500`)).events as { id: number; ts: number; kind: string; data: any }[];

/** Listen to /api/stream and record, for each transcript event, how long after its creation it arrived. */
function listen(delays: number[]) {
  const ac = new AbortController();
  void (async () => {
    try {
      const r = await fetch(inst.url + 'api/stream', { headers: { cookie: inst.cookie }, signal: ac.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const m = JSON.parse(line.slice(6));
          if (m.type === 'event') {
            const d = Date.now() - m.event.ts;
            delays.push(d);
            // Where a late one waited: before bus_log (the runner's write), or after (the web service's tail and the stream).
            if (d > 250) late.push({ ms: d, kind: m.event.kind, toLog: m.loggedAt ? m.loggedAt - m.event.ts : null, fromLog: m.loggedAt ? Date.now() - m.loggedAt : null, at: new Date(m.event.ts).toISOString().slice(11, 23) });
          }
        }
      }
    } catch {
      // Closed, or the web service went away.
    }
  })();
  return () => ac.abort();
}

const cpu = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return Number(f[11]) + Number(f[12]); // utime + stime, clock ticks (1/100 s)
};
const late: { ms: number; kind: string; toLog: number | null; fromLog: number | null; at: string }[] = [];
const marks: [string, number][] = [];
const mark = (what: string) => marks.push([what, Date.now()]);
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];

try {
  inst = JSON.parse(node('start', '--split', '--claude', 'fake', '--seed', 'demo', '--env', 'FAKE_SPEED=0.3'));
  assert.ok(inst.runnerPid && inst.pid && inst.runnerPid !== inst.pid, 'two processes');
  const health = await api('/api/health');
  assert.equal(health.runner.mode, 'web');
  assert.equal(health.runner.up, true);
  ok('split instance: web and runner are separate processes; health reports the runner up');
  const team = await api(`/api/projects/${inst.project}/team`);
  assert.equal(team.from, 'runner', 'Setup shows what the runner gives agents');
  assert.ok(team.roles.length > 0 && team.roles[0].systemPrompt.length > 100 && team.roles[0].tools.length > 5);
  ok(`Setup's prompts and tools come from the runner (${team.roles.length} roles)`);

  // ---- 1. a turn survives a web restart ----
  const delays: number[] = [];
  let unlisten = listen(delays);
  await api(`/api/projects/${inst.project}/message`, { text: 'DEMO: start the work.' });
  const eng = await until('the engineer working', async () => (await agents()).find((a) => a.parent_id && a.status === 'working'));
  await until('a few engineer events', async () => (await events(eng.id)).length >= 6);
  const runnerBefore = inst.runnerPid;
  // The browser stream stays open across the stop: the web service must end it, not wait it out.
  const downAt = Date.now();
  node('stop', '--part', 'web');
  const stopMs = Date.now() - downAt;
  unlisten();
  assert.ok(stopMs < 2000, `the web service stopped in ${stopMs} ms with a browser stream open`);
  await sleep(4000);
  node('restart', '--part', 'web');
  const upAt = Date.now();
  mark('web-up');
  reload();
  assert.equal(inst.runnerPid, runnerBefore, 'the runner was not restarted');
  unlisten = listen(delays);
  const done = await until('the engineer finishing', async () => (await agents()).find((a) => a.id === eng.id && ['done', 'closed'].includes(a.status)), 90_000);
  assert.ok(done);
  const evs = await events(eng.id);
  const during = evs.filter((e) => e.ts >= downAt && e.ts <= upAt).length;
  assert.ok(evs.some((e) => e.kind === 'result'), 'the turn ended with its result');
  assert.ok(during > 0, 'the agent wrote events while the web service was down');
  assert.ok(!(await agents()).some((a) => a.status === 'interrupted' || a.status === 'error'), 'no agent was interrupted');
  ok(`agent mid-turn kept working through a web restart (stopped in ${stopMs} ms with a stream open; ${upAt - downAt} ms down, ${during} events written meanwhile, finished done)`);

  // ---- every API route in split mode, under the runner-only asserts (server/role.ts) ----
  {
    mark('sweep-start');
    const routes = (await api('/api/test/routes')) as { method: string; url: string }[];
    const st = await api(`/api/projects/${inst.project}`);
    const director = st.agents.find((a: any) => !a.parent_id);
    const ids: Record<string, string> = {
      projects: inst.project,
      agents: director.id,
      tasks: st.tasks?.[0]?.id ?? 'task_none',
      requests: st.inbox?.[0]?.id ?? 'inbox_none',
      inbox: st.inbox?.[0]?.id ?? 'inbox_none',
      previews: st.previews?.[0]?.id ?? 'pv_none',
      docs: st.docs?.[0]?.id ?? 'doc_none',
    };
    // Not driven: ones that end the session, delete things the rest of this check needs, or start units.
    const skip = (m: string, u: string) =>
      m === 'DELETE' || /\/api\/(login|logout|session|stream|test\/)|\/close$|\/stop$|\/archive|\/version\/(update|rollback|restart-agents)|\/push\/test/.test(u);
    let driven = 0;
    const slow: string[] = [];
    const failures: string[] = [];
    for (const r of routes) {
      if (!r.url.startsWith('/api/') || skip(r.method, r.url)) continue;
      const url = r.url.replace(/\/([a-z-]+)\/:(\w+)/g, (_m, seg, name) => `/${seg}/${name === 'id' ? (ids[seg] ?? `${seg}_none`) : name === 'projectId' ? inst.project : `x`}`).replace(/:\w+/g, 'x');
      const t0 = Date.now();
      const res = await fetch(inst.url + url.slice(1), {
        method: r.method,
        headers: { cookie: inst.cookie, ...(r.method === 'GET' ? {} : { 'content-type': 'application/json' }) },
        body: r.method === 'GET' ? undefined : '{}',
      }).catch((e) => ({ status: 0, text: async () => String(e) }) as any);
      const text = await res.text();
      driven++;
      if (Date.now() - t0 > 300) slow.push(`${r.method} ${r.url} ${Date.now() - t0} ms`);
      if (/runner-only/.test(text)) failures.push(`${r.method} ${url}: ${text.slice(0, 200)}`);
    }
    const log = readFileSync(join(inst.dir, 'server.log'), 'utf8');
    for (const line of log.split('\n').filter((l) => /runner-only/.test(l))) failures.push(`web log: ${line.slice(0, 200)}`);
    assert.deepEqual(failures, [], 'no API route reaches runner-only state in the web service');
    mark('sweep-end');
    if (slow.length) console.log(`info slow routes (block the web service's event loop meanwhile): ${slow.join('; ')}`);
    ok(`${driven} API routes driven in split mode; none reached runner-only state`);
  }

  // ---- 2. a permission prompt while the web service is down ----
  // The user answers permission prompts here (the director's independent check would need a real model).
  const patched = await fetch(inst.url + `api/projects/${inst.project}`, { method: 'PATCH', headers: { cookie: inst.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ permission_answerer: 'user' }) });
  assert.ok(patched.ok);
  await api(`/api/projects/${inst.project}/message`, { text: 'ASK-PERMISSION please.' });
  node('stop', '--part', 'web');
  const db = new DatabaseSync(join(inst.data, 'helm.db'), { readOnly: true });
  const req = await until('the permission request (web down)', () => db.prepare("SELECT id, status FROM inbox WHERE kind = 'permission' AND status = 'open'").get() as { id: string } | undefined, 30_000);
  // The status is written just after the request row: wait for it rather than read it once.
  const dirRow = await until('the director waiting for the answer', () => db.prepare("SELECT id, status FROM agents WHERE parent_id IS NULL AND status = 'waiting'").get() as { id: string; status: string } | undefined, 10_000);
  assert.equal(dirRow.status, 'waiting', 'the director waits for the answer');
  node('restart', '--part', 'web');
  reload();
  const inbox = await api('/api/inbox');
  assert.ok(JSON.stringify(inbox).includes(req.id), 'the request is listed once the web service is back');
  await api(`/api/requests/${req.id}/answer`, { choice: 'Allow' });
  await until('the director to get the answer', async () => (await events(dirRow.id)).some((e) => e.kind === 'result' && /Permission answer: allow/.test(e.data.text ?? '')), 30_000);
  ok('a permission prompt asked while the web service was down was shown after it came back, answered, and reached the agent');

  // ---- 3. a message while the runner is down ----
  node('stop', '--part', 'runner');
  const down = await until('the runner reported down', async () => {
    const r = await api('/api/runner');
    return r.up === false ? r : null;
  }, 10_000);
  assert.equal(down.mode, 'web');
  const fallback = await api(`/api/projects/${inst.project}/team`);
  assert.equal(fallback.from, 'dashboard', 'with the runner down, Setup says it shows the dashboard build');
  assert.equal((await api('/api/runner')).pending, 0, 'a question nobody answered does not wait in the queue');
  const sentAt = Date.now();
  await api(`/api/agents/${dirRow.id}/message`, { text: 'Hello while the runner is away.' });
  assert.equal((await api('/api/runner')).pending, 1, 'the message waits in the queue');
  await sleep(1500);
  assert.ok(!(await events(dirRow.id)).some((e) => e.ts >= sentAt && e.kind === 'inbound'), 'nothing is delivered while the runner is down');
  node('restart', '--part', 'runner');
  reload();
  await until('the queued message delivered and answered', async () => {
    const e = await events(dirRow.id);
    const i = e.findIndex((x) => x.kind === 'inbound' && /Hello while the runner is away/.test(x.data.text ?? ''));
    return i >= 0 && e.slice(i).some((x) => x.kind === 'result');
  }, 30_000);
  assert.equal((await api('/api/runner')).pending, 0);
  ok('a message sent while the runner was down was queued, then delivered and answered when it came back');

  // ---- an agent that stopped with an error, resumed from the web service ----
  {
    await api(`/api/projects/${inst.project}/message`, { text: 'FAIL: try the loader.' });
    const failed = await until('the loader engineer stopped with an error', async () => (await agents()).find((a) => a.parent_id && a.status === 'error'), 60_000);
    const ro = new DatabaseSync(join(inst.data, 'helm.db'), { readOnly: true });
    const entry = await until('its Needs you entry', () => ro.prepare("SELECT id FROM inbox WHERE kind = 'agent_error' AND status = 'open' AND agent_id = ?").get(failed.id) as { id: string } | undefined, 30_000);
    ro.close();
    const before = (await events(failed.id)).length;
    // Answered in the web service: the resume must reach the agent in the runner (a command), not a no-op hook.
    await api(`/api/requests/${entry.id}/answer`, { choice: 'Resume' });
    await until('the engineer resumed', async () => (await events(failed.id)).slice(before).some((e) => e.kind === 'inbound' && /resumed you/.test(e.data.text ?? '')), 30_000);
    // It ran again: its process produced a turn after the resume (the stand-in's engineer may stop with an error again).
    await until('a turn after the resume', async () => {
      const e = (await events(failed.id)).slice(before);
      const i = e.findIndex((x) => x.kind === 'inbound' && /resumed you/.test(x.data.text ?? ''));
      return i >= 0 && e.slice(i + 1).some((x) => x.kind === 'result' || x.kind === 'tool' || x.kind === 'text' || x.kind === 'error');
    }, 60_000);
    ok('an agent that stopped with an error, resumed from Needs you in the web service, ran again in the runner');
  }

  // ---- Stop all from the web service stops the agents in the runner ----
  {
    await api(`/api/projects/${inst.project}/message`, { text: 'DEMO: work to stop.' });
    const busy = await until('an engineer working', async () => (await agents()).find((a) => a.parent_id && a.status === 'working'), 60_000);
    const res = await fetch(inst.url + `api/projects/${inst.project}/mode`, { method: 'POST', headers: { cookie: inst.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
    assert.ok(res.ok, `Stop all: ${res.status} ${await res.text()}`);
    await until('the engineer stopped by the runner', async () => (await agents()).find((a) => a.id === busy.id && a.status === 'interrupted'), 15_000);
    const back = await fetch(inst.url + `api/projects/${inst.project}/mode`, { method: 'POST', headers: { cookie: inst.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
    assert.ok(back.ok, `Resume: ${back.status}`);
    await until('the agents idle again', async () => !(await agents()).some((a) => a.status === 'working'), 90_000);
    ok('Stop all, pressed in the web service, stopped the agent mid-turn in the runner; resume let it go on');
  }

  // ---- one runner per data directory; what counts as work ----
  {
    const env = JSON.parse(readFileSync(join(inst.dir, 'instance.json'), 'utf8')).env;
    for (const mode of ['runner', 'all']) {
      const r = spawnSync(process.execPath, ['server/main.ts', mode], { cwd: repo, env: { ...env, HELM_PORT: '1' }, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 3, `a second ${mode} on the same data exits: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Another Helm runner \(pid \d+\) already runs agents/);
    }
    assert.equal((await api('/api/health')).runner.up, true, 'the first runner is untouched');
    ok('a second runner (or helm all) on the same data directory refuses to start');

    const rw = new DatabaseSync(join(inst.data, 'helm.db'));
    rw.exec('PRAGMA busy_timeout = 5000');
    rw.prepare("INSERT INTO runner_commands (op, args, created_at) VALUES ('from-the-future', '{}', ?)").run(Date.now());
    const engineer = (await agents()).find((a) => a.parent_id);
    rw.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(engineer!.id);
    await sleep(1000);
    const h = await api('/api/health');
    assert.equal(h.runner.working, 0, 'neither a command the runner does not know nor a working row without a process counts as work');
    const left = rw.prepare("SELECT done_at, claimed_by FROM runner_commands WHERE op = 'from-the-future'").get() as any;
    assert.ok(left.done_at === null && left.claimed_by === null, 'an unknown command stays queued, unclaimed, for a newer runner');
    rw.prepare("DELETE FROM runner_commands WHERE op = 'from-the-future'").run();
    rw.prepare("UPDATE agents SET status = 'done' WHERE id = ?").run(engineer!.id);
    rw.close();
    ok('work for a deferred restart: unknown queued ops and stale working rows do not count');
  }

  // ---- measurements ----
  unlisten();
  console.log(`info event latency runner -> browser stream: n=${delays.length} p50=${pct(delays, 50)} ms p95=${pct(delays, 95)} ms max=${Math.max(...delays)} ms`);
  for (const l of late) console.log(`info late event ${l.ms} ms (${l.kind} at ${l.at}): ${l.toLog ?? '?'} ms until bus_log, ${l.fromLog ?? '?'} ms from bus_log to the stream`);
  for (const [who, f] of [['web', 'server.log'], ['runner', 'runner.log']]) {
    for (const line of readFileSync(join(inst.dir, f), 'utf8').split('\n').filter((l) => l.includes('db: a write took'))) console.log(`info ${who} ${line}`);
  }
  console.log(`info marks ${marks.map(([w, t]) => `${w}=${new Date(t).toISOString().slice(11, 23)}`).join(' ')}`);
  await sleep(5000);
  const w0 = cpu(inst.pid);
  const r0 = cpu(inst.runnerPid);
  await sleep(IDLE_SECONDS * 1000);
  const w = (cpu(inst.pid) - w0) / IDLE_SECONDS;
  const r = (cpu(inst.runnerPid) - r0) / IDLE_SECONDS;
  console.log(`info idle CPU over ${IDLE_SECONDS} s: web ${w.toFixed(2)} %, runner ${r.toFixed(2)} % of one core`);
  // ---- optional: the write-ahead log with two long-lived connections and a busy agent ----
  const WAL_MINUTES = Number(process.env.WAL_MINUTES ?? 0);
  if (WAL_MINUTES > 0) {
    const wal = join(inst.data, 'helm.db-wal');
    const size = () => {
      try {
        return statSync(wal).size;
      } catch {
        return 0;
      }
    };
    const end = Date.now() + WAL_MINUTES * 60_000;
    const samples: number[] = [];
    let rounds = 0;
    let nextSample = Date.now();
    const firstEvent = Number((db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id ?? 0);
    while (Date.now() < end) {
      // Keep an engineer busy: a new round of the demo whenever none is working.
      const busy = (await agents()).some((a) => a.status === 'working' || a.status === 'waiting');
      if (!busy) {
        rounds++;
        await api(`/api/projects/${inst.project}/message`, { text: `DEMO: round ${rounds}.` });
      }
      if (Date.now() >= nextSample) {
        samples.push(size());
        nextSample += 30_000;
      }
      await sleep(2000);
    }
    const events = Number((db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id ?? 0) - firstEvent;
    const kb = (n: number) => `${Math.round(n / 1024)} KB`;
    console.log(`info WAL over ${WAL_MINUTES} min, ${rounds} demo rounds, ${events} transcript events: samples every 30 s ${samples.map(kb).join(' ')}; max ${kb(Math.max(...samples))}`);
    assert.ok(Math.max(...samples) < 64 * 1024 * 1024, 'the WAL stays bounded');
  }
  db.close();
} finally {
  if (inst!) node('stop', '--purge');
}
