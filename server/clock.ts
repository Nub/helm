import { db, get, now, run } from './db.ts';

// The user's time zone and every time Helm writes into text: tool results, presence tags and notes to agents,
// session headings and prompts, notifications. A 12-hour clock with lower-case am/pm in the user's zone (an
// install-wide setting the browser reports), never the server's clock: "9:22 pm" today, "Wed 9:22 pm" within the
// week, "Nov 12, 9:22 pm" before that. Stored timestamps stay epoch milliseconds; only the text changes.
//
// The setting: the first zone a signed-in browser reports becomes it. A different zone reported later is only
// proposed (the Helm page asks "Use America/Los_Angeles for times?"), so a laptop on a trip does not silently move
// every time agents see; Setup can change it at any time.

db.exec(`CREATE TABLE IF NOT EXISTS clock_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
function readState<T>(key: string, fallback: T): T {
  const r = get('SELECT value FROM clock_state WHERE key = ?', key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch {
    return fallback;
  }
}
function writeState(key: string, value: unknown) {
  if (value === null) run('DELETE FROM clock_state WHERE key = ?', key);
  else run('INSERT INTO clock_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// ---------- the setting ----------

/** The server process's own zone: what times fall back to before any browser has reported one. */
export const serverZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const knownZones = new Set<string>();
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  if (knownZones.has(tz)) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    knownZones.add(tz);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone set for this install, or null when no browser has reported one yet. Read from the database every time,
 * not cached in the process: another Helm process sharing the database (the web server) may change it.
 */
export function configuredZone(): string | null {
  const v = readState<string | null>('timeZone', null);
  return validZone(v) ? v : null;
}
/** The zone every time in text is written in. */
export const userZone = () => configuredZone() ?? serverZone();

export type ZoneState = { timeZone: string | null; effective: string; proposed: string | null; declined: string[] };
export function zoneState(): ZoneState {
  return { timeZone: configuredZone(), effective: userZone(), proposed: readState<string | null>('proposed', null), declined: readState<string[]>('declined', []) };
}

/** Set the zone (from Setup, or confirming a proposal). Returns an error message for an unknown zone. */
export function setZone(tz: unknown): string | null {
  if (!validZone(tz)) return `Unknown time zone ${String(tz)}`;
  writeState('timeZone', tz);
  writeState('proposed', null);
  writeState('declined', readState<string[]>('declined', []).filter((z) => z !== tz));
  return null;
}

/** "Keep the current zone": the proposal goes, and that zone is not proposed again until set by hand. */
export function declineZone(tz: unknown) {
  if (!validZone(tz)) return;
  writeState('declined', [...new Set([...readState<string[]>('declined', []), tz])].slice(-20));
  if (readState<string | null>('proposed', null) === tz) writeState('proposed', null);
}

/** A browser's zone on load: the first one sets the setting; a different one later becomes a proposal. */
export function reportZone(tz: unknown): ZoneState {
  if (!validZone(tz)) return zoneState();
  const cur = configuredZone();
  if (!cur) setZone(tz);
  else if (cur === tz) writeState('proposed', null);
  else if (!readState<string[]>('declined', []).includes(tz)) writeState('proposed', tz);
  return zoneState();
}

// ---------- formatting ----------

type Parts = { weekday: string; month: string; day: string; year: string; hour: string; minute: string; period: string; zone: string };
const fmts = new Map<string, Intl.DateTimeFormat>();
function parts(ts: number, tz: string): Parts {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
    fmts.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(ts)) p[x.type] = x.value;
  return { weekday: p.weekday, month: p.month, day: p.day, year: p.year, hour: p.hour, minute: p.minute, period: (p.dayPeriod ?? '').toLowerCase(), zone: p.timeZoneName ?? tz };
}
const hm = (p: Parts) => `${p.hour}:${p.minute} ${p.period}`;
const dayKey = (p: Parts) => `${p.year} ${p.month} ${p.day}`;

export type ClockOpts = { tz?: string; now?: number };
const zoneOf = (o?: ClockOpts) => o?.tz ?? userZone();

export const sameDayIn = (a: number, b: number, o?: ClockOpts) => dayKey(parts(a, zoneOf(o))) === dayKey(parts(b, zoneOf(o)));

/** "9:22 pm" */
export const timeText = (ts: number, o?: ClockOpts) => hm(parts(ts, zoneOf(o)));

/** "Nov 18, 9:22 pm", with the year when it is not this year: always dated, for listings. */
export function dateTimeText(ts: number, o?: ClockOpts): string {
  const tz = zoneOf(o);
  const p = parts(ts, tz);
  const year = p.year !== parts(o?.now ?? now(), tz).year ? `, ${p.year}` : '';
  return `${p.month} ${p.day}${year}, ${hm(p)}`;
}

/** "9:22 pm" today, "Wed 9:22 pm" within six days either way, "Nov 12, 9:22 pm" otherwise. */
export function clockText(ts: number, o?: ClockOpts): string {
  const tz = zoneOf(o);
  const at = o?.now ?? now();
  const p = parts(ts, tz);
  if (dayKey(p) === dayKey(parts(at, tz))) return hm(p);
  if (Math.abs(at - ts) < 6 * 86_400_000) return `${p.weekday} ${hm(p)}`;
  return dateTimeText(ts, { tz, now: at });
}

/** "Wed 7:10–9:40 pm" on one day, else both ends in full. */
export function spanText(a: number, b: number, o?: ClockOpts): string {
  const tz = zoneOf(o);
  if (!sameDayIn(a, b, { tz })) return `${clockText(a, o)} – ${clockText(b, o)}`;
  const pa = parts(a, tz);
  const pb = parts(b, tz);
  const start = clockText(a, o).replace(/ (am|pm)$/, pa.period === pb.period ? '' : ' $1');
  return `${start}–${hm(pb)}`;
}

/** "2026-11-18", the calendar day in the user's zone. */
export function dateText(ts: number, o?: ClockOpts): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zoneOf(o), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ts);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** The zone's short name at that moment ("PST", "PDT"; "GMT+1" where there is no common abbreviation). */
export const zoneAbbr = (ts: number, o?: ClockOpts) => parts(ts, zoneOf(o)).zone;
