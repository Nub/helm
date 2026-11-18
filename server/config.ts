import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './safefs.ts';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(process.env.HELM_DATA ?? join(homedir(), '.helm'));
export const ARTIFACT_DIR = join(DATA_DIR, 'artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

type FileConfig = {
  /** Passphrase for the web UI. Generated on first run. */
  token: string;
  /** Where new and cloned projects are created. */
  projectsRoot: string;
  port: number;
  /** Seconds an agent's Claude process stays alive after its turn ends. */
  idleSeconds: number;
};

const CONFIG_PATH = join(DATA_DIR, 'config.json');

function load(): FileConfig {
  const defaults: FileConfig = {
    token: randomBytes(9).toString('base64url'),
    projectsRoot: join(homedir(), 'helm-projects'),
    port: 4400,
    idleSeconds: 300,
  };
  let cfg = defaults;
  const before = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : undefined;
  if (before?.trim()) {
    try {
      cfg = { ...defaults, ...JSON.parse(before) };
    } catch (err) {
      // Damage from before writes were atomic: keep the file for inspection and start rather than crash-loop.
      // Numbered, so an earlier damaged copy is never overwritten.
      let kept = `${CONFIG_PATH}.corrupt`;
      for (let i = 1; existsSync(kept); i++) kept = `${CONFIG_PATH}.corrupt.${i}`;
      console.error(`${CONFIG_PATH} is not valid JSON (${(err as Error).message}); kept as ${kept}, starting with defaults (a new passphrase).`);
      try {
        renameSync(CONFIG_PATH, kept);
      } catch {}
    }
  }
  // Never rewritten in place (a start on a full disk once truncated it to nothing, and every start after that failed
  // to parse it): written only when something changed, whole or not at all (server/safefs.ts). If that fails on a full
  // disk, Helm still starts with what it read; only a first start's new passphrase would not be kept.
  try {
    writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error(`Could not save ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  return cfg;
}

const file = load();

/**
 * The SDK ships its own Claude Code binary, but a generic prebuilt binary does
 * not run on NixOS, so there we use the one already installed on the host.
 */
function findClaude(): string | undefined {
  if (process.env.HELM_CLAUDE_PATH) return process.env.HELM_CLAUDE_PATH;
  if (process.platform === 'linux' && existsSync('/etc/NIXOS')) {
    try {
      return execFileSync('sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const config = {
  token: process.env.HELM_TOKEN ?? file.token,
  projectsRoot: resolve(process.env.HELM_PROJECTS ?? file.projectsRoot),
  port: Number(process.env.HELM_PORT ?? file.port),
  host: process.env.HELM_HOST ?? '0.0.0.0',
  idleSeconds: Number(process.env.HELM_IDLE_SECONDS ?? file.idleSeconds),
  claudePath: findClaude(),
  /**
   * Trust X-Helm-Signed-In from the loopback proxy (see decideProxySignIn in server/lan.ts). The value is the gate's
   * name shown in the UI ("docs.example.com"); "1" for none. Unset or empty: off.
   */
  trustProxySignIn: (process.env.HELM_TRUST_PROXY_SIGNIN ?? '').trim(),
  /** Let clients on the local network in without the passphrase (see server/lan.ts). */
  lanNoLogin: /^(1|true|yes|on)$/i.test(process.env.HELM_LAN_NO_LOGIN ?? ''),
  /** Extra Host header values (e.g. "helm.example.com" or "box.lan:8080") accepted for that, besides this machine's own. */
  lanAllowedHosts: (process.env.HELM_LAN_ALLOWED_HOSTS ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

/** The GitHub CLI used by GitHub issue report sources; its own login is used, Helm stores no token. */
export const GH_PATH = process.env.HELM_GH_PATH || 'gh';
