/**
 * Smoke check for the helm-ui-check skill (.claude/skills/helm-ui-check): start a scratch server with the Claude
 * stand-in, take one phone screenshot of a project, stop it with --purge. Catches a server or skill change that
 * breaks the scripts every agent uses to check UI work. Run: npm run check:ui-skill (needs Chromium on PATH, or
 * CHROMIUM=/path).
 */
import '../testenv.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = join(repo, '.claude', 'skills', 'helm-ui-check', 'scripts');
const name = `check-${process.pid}`;
const out = mkdtempSync(join(tmpdir(), 'helm-ui-check-shots-'));
const node = (script: string, args: string[]) =>
  execFileSync(process.execPath, [join(scripts, script), ...args], { cwd: repo, encoding: 'utf8', timeout: 120_000 });

let inst: { pid: number; dir: string; project?: string } | null = null;
try {
  inst = JSON.parse(node('scratch.mjs', ['start', '--name', name, '--repo', repo, '--claude', 'fake', '--seed', 'demo']));
  assert.ok(inst!.pid > 0 && inst!.project, 'the scratch server started with a demo project');
  const env = readFileSync(`/proc/${inst!.pid}/environ`, 'utf8').split('\0');
  assert.ok(!env.some((v) => /^HELM_(LAN_NO_LOGIN|TRUST_PROXY_SIGNIN|LIVE_UPDATE_)/.test(v)), 'no live-service variable reaches the scratch server');
  console.log('ok   scratch server starts with a safe environment');

  const rows = node('shoot.mjs', ['--name', name, '--routes', '#/p/{project}', '--devices', 'phone', '--out', out])
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].errors, [], 'the page threw no script errors');
  assert.ok(statSync(rows[0].file).size > 10_000, 'the screenshot has content');
  assert.equal(rows[0].audit.viewport[0], 390, 'phone width is 390 px');
  console.log('ok   phone screenshot of the project, no page errors');
} finally {
  node('scratch.mjs', ['stop', '--name', name, '--purge']);
  rmSync(out, { recursive: true, force: true });
}
assert.ok(inst && !existsSync(inst.dir), 'stop --purge removed the instance');
let alive = true;
try { process.kill(inst!.pid, 0); } catch { alive = false; }
assert.ok(!alive, 'the server process is gone');
console.log('ok   stop --purge leaves nothing behind');
