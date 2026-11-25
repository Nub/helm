import { all, get, now } from './db.ts';
import type { Row } from './db.ts';
import { clockText, serverZone, validZone } from './clock.ts';

/**
 * The text side of agents that stop with an error (agenterrors.ts), kept free of the store so store.ts can use it:
 * when a usage limit resets, in the user's zone through clock.ts ("Fri 4:00 am", never Claude Code's own "(UTC)"),
 * and what an agent_error request and an agent row show, recomputed each time they are read so "today" and the
 * weekday stay right.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The zone's offset from UTC at that moment, in ms. */
function offset(zone: string, ts: number): number {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ts)) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
/** A wall-clock time in a zone, as epoch ms. */
function wall(zone: string, y: number, m: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, m, d, h, mi);
  const first = guess - offset(zone, guess);
  return guess - offset(zone, first);
}

/**
 * When a usage limit resets, read from what Claude Code said: "resets Nov 21, 12pm (UTC)", "resets 3am
 * (America/Los_Angeles)", "resets at 4:30pm". The zone in brackets, else the server's (where Claude Code runs). A
 * time with no date is the next one to come. Null when there is none.
 */
export function parseResetText(text: string, at = now()): number | null {
  const m = /resets\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!m) return null;
  const zone = m[6] && validZone(m[6].trim()) ? m[6].trim() : m[6]?.trim().toUpperCase() === 'UTC' ? 'UTC' : serverZone();
  const h = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const mi = Number(m[4] ?? 0);
  const today: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(at)) today[x.type] = Number(x.value);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    let ts = wall(zone, today.year, month, Number(m[2]), h, mi);
    // "Jan 2" seen on Dec 30 is next year's.
    if (ts < at - 180 * 86_400_000) ts = wall(zone, today.year + 1, month, Number(m[2]), h, mi);
    return ts;
  }
  let ts = wall(zone, today.year, today.month - 1, today.day, h, mi);
  if (ts <= at) ts = wall(zone, today.year, today.month - 1, today.day + 1, h, mi);
  return ts;
}

/** The usage limit's words for the user: when it resets, in their zone. */
export function usagePlain(resetsAt: number | null | undefined): string {
  return `It hit the Claude usage limit${resetsAt ? `, which resets ${clockText(resetsAt)}` : ''}. Resume it once the limit has reset${resetsAt ? ', or have Helm resume it then' : ''}.`;
}

/** A minute after the reset: when "Resume when the limit resets" resumes the agent. */
export const resumeAfter = (resetsAt: number) => resetsAt + 60_000;

/** The minute a limit resets, the key for "stopped by the same limit". */
const limitKey = (p: Row) => (p.resets_at ? Math.round(p.resets_at / 60_000) : null);

/** Open entries stopped by the same usage limit as this one in its project (itself included). */
export function limitPeers(item: Row): Row[] {
  const p = JSON.parse(item.payload);
  if (p.error_kind !== 'usage_limit') return [];
  return all("SELECT * FROM inbox WHERE project_id = ? AND kind = 'agent_error' AND status = 'open'", item.project_id).filter((r) => {
    const q = JSON.parse(r.payload);
    return q.error_kind === 'usage_limit' && limitKey(q) === limitKey(p);
  });
}

/**
 * "Resumes Fri 4:01 am", for an agent with a resume scheduled; "Resume held (…)" while its project is not running
 * (projectmode.ts holds scheduled resumes until the user resumes the project).
 */
export function resumesText(resumeAt: number | null | undefined, projectId?: string): string | null {
  if (!resumeAt) return null;
  const mode = projectId ? get('SELECT mode FROM projects WHERE id = ?', projectId)?.mode : null;
  if (mode && mode !== 'running' && mode !== 'queue_only') return `Resume held: the project is ${mode === 'winding_down' ? 'finishing up' : mode === 'at_rest' ? 'at rest' : 'stopped'}`;
  return `Resumes ${clockText(resumeAt)}`;
}

/**
 * What an agent_error request's payload shows, recomputed on read: the usage limit's words in the user's zone,
 * whether "Resume when the limit resets" is on offer (the reset is ahead), how many open entries share the limit,
 * and the scheduled resume of its agent, if any (on the newest entry of that agent only).
 */
export function errorPayload(r: Row, payload: Row): Row {
  const out: Row = { ...payload };
  if (payload.error_kind === 'usage_limit') {
    out.plain = usagePlain(payload.resets_at);
    out.can_wait = !!payload.resets_at && payload.resets_at > now() - 60_000;
    if (r.status === 'open') out.limit_peers = limitPeers(r).length;
  }
  const agent = r.agent_id ? get('SELECT resume_at, project_id FROM agents WHERE id = ?', r.agent_id) : undefined;
  if (agent?.resume_at) {
    const newest = get("SELECT id FROM inbox WHERE agent_id = ? AND kind = 'agent_error' ORDER BY created_at DESC LIMIT 1", r.agent_id);
    if (newest?.id === r.id) out.resumes_text = resumesText(agent.resume_at, agent.project_id);
  }
  return out;
}
