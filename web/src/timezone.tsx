import { useEffect, useState } from 'react';
import { api } from './api';
import { useAction } from './ui';
import { browserZone, timeOfDay } from './time';

/**
 * The user's time zone (server/clock.ts): the zone every time agents see and write is in. The page reports the
 * browser's zone on load; the first report sets it, a different one later is asked about here ("Use … for times?"),
 * shown on the Helm page and in each project's Setup.
 */

export type ZoneState = { timeZone: string | null; effective: string; proposed: string | null; declined: string[] };

/**
 * On load, with the zone state from /api/session: tell Helm this browser's zone only when it differs from the
 * configured one and is neither already proposed nor declined (the first report sets it; a later one is asked about).
 */
export function reportZone(st: ZoneState | undefined) {
  const zone = browserZone();
  if (!st || st.timeZone === zone || st.proposed === zone || st.declined.includes(zone)) return;
  void api('/api/timezone/report', { body: { zone } }).catch(() => {});
}

const zoneList = (): string[] => {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

const pretty = (tz: string) => tz.replace(/_/g, ' ');
/** The time of day in a zone: "9:22 pm". */
const nowIn = (tz: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(Date.now()).toLowerCase();
  } catch {
    return timeOfDay(Date.now());
  }
};

export function TimeZoneSetup() {
  const [st, setSt] = useState<ZoneState | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<ZoneState>('/api/timezone').then(setSt, () => {});
  }, []);
  if (!st) return null;
  const zones = zoneList();
  const cur = st.timeZone ?? st.effective;
  const options = zones.includes(cur) ? zones : [cur, ...zones];
  const set = (zone: string) => run(async () => setSt(await api<ZoneState>('/api/timezone', { method: 'PUT', body: { zone } })));
  const decline = (zone: string) => run(async () => setSt(await api<ZoneState>('/api/timezone/decline', { body: { zone } })));
  return (
    <>
      <h2 id="timezone">Time zone</h2>
      {st.proposed && st.proposed !== cur && (
        <div className="card tz-proposal" role="status">
          <p>
            This device is in <b>{pretty(st.proposed)}</b> ({nowIn(st.proposed)} there). Use {pretty(st.proposed)} for times?
          </p>
          <p className="muted small">Agents write times in the zone set here; it is {pretty(cur)} now.</p>
          <div className="row wrap">
            <button className="btn primary" disabled={busy} onClick={() => set(st.proposed!)}>
              Use {pretty(st.proposed)}
            </button>
            <button className="btn" disabled={busy} onClick={() => decline(st.proposed!)}>
              Keep {pretty(cur)}
            </button>
          </div>
        </div>
      )}
      <div className="card">
        <label className="tz-pick">
          <span className="muted small">Time zone</span>
          <select value={cur} disabled={busy} onChange={(e) => set(e.target.value)}>
            {options.map((z) => (
              <option key={z} value={z}>
                {pretty(z)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          {st.timeZone ? `${nowIn(cur)} there now.` : `The server's zone.`}
        </p>
        {error && <p className="error-text small">{error}</p>}
      </div>
    </>
  );
}
