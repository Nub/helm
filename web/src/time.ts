// Every date and time the app shows goes through here: a 12-hour clock with lower-case am/pm, in the browser's
// time zone. "11:49 am" today, "Wed 9:22 pm" within the week, "Nov 18, 12:52 pm" further back (with the year when
// it is not this year). Relative times ("2 h ago") and durations live in ui.tsx and sessions.tsx and are unchanged.

const NBSP = '\u00a0'; // between the time and am/pm, so "9:22 pm" never wraps in the middle

type Parts = { weekday: string; month: string; day: string; year: string; hour: string; minute: string; period: string };

let fmt: Intl.DateTimeFormat | null = null; // made on first use, so it picks up the zone the page runs in
const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true };

function parts(ts: number): Parts {
  const p: Record<string, string> = {};
  fmt ??= new Intl.DateTimeFormat('en-US', opts);
  for (const x of fmt.formatToParts(ts)) p[x.type] = x.value;
  return { weekday: p.weekday, month: p.month, day: p.day, year: p.year, hour: p.hour, minute: p.minute, period: (p.dayPeriod ?? '').toLowerCase() };
}

const dayKey = (p: Parts) => `${p.year}-${p.month}-${p.day}`;
const hm = (p: Parts) => `${p.hour}:${p.minute}${NBSP}${p.period}`;

export const sameDay = (a: number, b: number) => dayKey(parts(a)) === dayKey(parts(b));

/** "11:49 am" */
export const timeOfDay = (ts: number) => hm(parts(ts));

/** "Nov 18" (or "Nov 18, 2025" in another year) */
export function dateOnly(ts: number, withYear = false): string {
  const p = parts(ts);
  return withYear || p.year !== parts(Date.now()).year ? `${p.month} ${p.day}, ${p.year}` : `${p.month} ${p.day}`;
}

/** "Nov 18, 12:52 pm": always with the date. */
export const dateTime = (ts: number) => `${dateOnly(ts)}, ${timeOfDay(ts)}`;

/** "Wed 9:22 pm": always with the weekday. */
export function dayTime(ts: number): string {
  const p = parts(ts);
  return `${p.weekday} ${hm(p)}`;
}

/** The short form: "11:49 am" today, "Wed 9:22 pm" in the last six days, "Nov 12, 9:22 pm" before that. */
export function when(ts: number, now = Date.now()): string {
  if (sameDay(ts, now)) return timeOfDay(ts);
  if (Math.abs(now - ts) < 6 * 86_400_000) return dayTime(ts);
  return dateTime(ts);
}

/** Time of day today, the date otherwise ("Nov 12"): for rows that stay one glance wide. */
export const shortWhen = (ts: number) => (sameDay(ts, Date.now()) ? timeOfDay(ts) : dateOnly(ts));

/** Full, for tooltips: "Wed, Nov 18, 2026, 12:52 pm". */
export function fullDateTime(ts: number): string {
  const p = parts(ts);
  return `${p.weekday}, ${p.month} ${p.day}, ${p.year}, ${hm(p)}`;
}

/** "Wed 7:10–9:40 pm", "Wed 7:10 pm – Thu 1:20 am" across midnight; an open end is "now". */
export function span(start: number, end: number | null): string {
  if (end == null) return `${dayTime(start)} – now`;
  if (!sameDay(start, end)) return `${dayTime(start)} – ${dayTime(end)}`;
  const a = parts(start);
  const b = parts(end);
  return a.period === b.period ? `${a.weekday} ${a.hour}:${a.minute}–${hm(b)}` : `${a.weekday} ${hm(a)}–${hm(b)}`;
}

/** A stored "HH:MM" (quiet hours) as "10:00 pm". */
export function hhmm(t: string): string {
  const [h, m] = t.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return t;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')}${NBSP}${h < 12 ? 'am' : 'pm'}`;
}

/** The browser's IANA time zone. */
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Local midnight (the browser's zone) of the day `ts` falls in, moved by `days`. */
export function midnight(ts: number, days = 0): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * Ticks for a time axis from `from` to `to`: every local midnight ("Nov 23"), or every hour counted from local midnight
 * ("1 am", with the date at midnight). `major` marks the day breaks.
 */
export function axisTicks(from: number, to: number, step: 'hour' | 'day'): { t: number; label: string; major: boolean }[] {
  const out: { t: number; label: string; major: boolean }[] = [];
  for (let t = midnight(from); t <= to; t = step === 'day' ? midnight(t, 1) : t + 3600_000) {
    if (t < from) continue;
    const major = midnight(t) === t;
    out.push({ t, major, label: major || step === 'day' ? dateOnly(t) : timeOfDay(t).replace(':00', '') });
  }
  return out;
}
