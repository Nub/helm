import { useEffect, useState } from 'react';
import { api, useLive } from './api';
import { InstallGuide, isIos, standalone } from './install';
import { Icon, ago, useAction } from './ui';
import { hhmm } from './time';

/**
 * Phone notifications (server/notify.ts sends them; web/public/sw.js shows them).
 *
 * iOS delivers Web Push only to the app added to the Home Screen (16.4 and later), and asks for permission only from a
 * tap inside it. So on iOS in a Safari tab this explains that and links to the Add to Home Screen guide; in the
 * installed app, or a desktop or Android browser with push, it offers Enable, which asks, subscribes and sends a test.
 */

export type NotifyKind = 'needs' | 'done' | 'away' | 'update' | 'agent' | 'disk';
export type NotifySettings = {
  muted: boolean;
  quiet: { start: string; end: string; tz: string } | null;
  kinds: Record<NotifyKind, boolean>;
  doneMode: 'every' | 'result';
  projects: Record<string, { off?: boolean; kinds?: Partial<Record<NotifyKind, boolean>> }>;
};
export type Device = {
  id: string;
  label: string;
  origin: string;
  enabled: boolean;
  service: string;
  created_at: number;
  last_success_at: number | null;
  last_error: string;
  last_error_at: number | null;
};
type PushInfo = { publicKey: string; devices: Device[]; settings: NotifySettings };

const KINDS: { id: NotifyKind; label: string; detail: string }[] = [
  { id: 'needs', label: 'Something needs you', detail: 'Blocking ones come even in quiet hours.' },
  { id: 'done', label: 'A task finished', detail: '' },
  { id: 'away', label: 'Work stopped while you were away', detail: '' },
  { id: 'agent', label: 'An agent failed or stalled', detail: '' },
  { id: 'update', label: 'Helm updated or rolled back', detail: '' },
  { id: 'disk', label: 'The disk is nearly full', detail: '' },
];

// ---------- this device ----------

const ID_KEY = 'helm-push-device';
let deviceId: string | null = (() => {
  try {
    return localStorage.getItem(ID_KEY);
  } catch {
    return null;
  }
})();
const idListeners = new Set<() => void>();
function setDeviceId(id: string | null) {
  deviceId = id;
  try {
    if (id) localStorage.setItem(ID_KEY, id);
    else localStorage.removeItem(ID_KEY);
  } catch {}
  idListeners.forEach((f) => f());
}

export type PushSupport = 'needs-install' | 'unsupported' | 'denied' | 'ok';

export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !standalone()) return 'needs-install';
  if (!capable) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * At load: register the service worker (it handles only push and notification taps, never fetches), follow taps
 * that land on an open window, and bring this device's subscription up to date. Only an existing row is refreshed:
 * a device removed from the list is not added back without the user enabling it again.
 */
export function startPush() {
  if (!('serviceWorker' in navigator)) return;
  startPendingOpen();
  void navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then(async (reg) => {
      // An app that is only ever resumed, never reloaded, would keep an old worker (and its tap handling) for up to a
      // day: look for a changed sw.js whenever it comes back to the front, at most every ten minutes.
      let checked = Date.now();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || Date.now() - checked < 10 * 60_000) return;
        checked = Date.now();
        reg.update().catch(() => {});
      });
      if (!('PushManager' in window) || Notification.permission !== 'granted') return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return setDeviceId(null);
      const r = await api<{ id: string | null }>('/api/push/subscriptions', { body: { subscription: sub.toJSON(), origin: location.origin, refresh: true } });
      // Unknown: removed from the list, or a replacement the service worker could not report (signed out at the
      // time). Either way this device shows Enable again; the browser's subscription is reused by it.
      setDeviceId(r.id);
    })
    .catch(() => {});
}

// ---------- where a notification tap lands ----------

/**
 * The service worker writes a tap's target into the Cache API before doing anything else (web/public/sw.js; same
 * cache name, key and shape), because on an iOS Home Screen app none of its ways to move a page can be relied on:
 * matchAll may find no window, openWindow may open start_url, navigate may do nothing. The page takes the target
 * whenever it may just have been brought forward (startup, the worker's message, becoming visible, pageshow from the
 * back/forward cache, focus), routes there and deletes it. It is read only once signed in (startPush runs in the
 * shell), so a sign-in on the way keeps it for afterwards.
 */
const PENDING_CACHE = 'helm-pending-open';
const PENDING_KEY = '/__helm/pending-open';
/** Older than this, a target is left over from a tap that was handled some other way (or not at all): dropped. */
const PENDING_TTL = 5 * 60_000;
type PendingOpen = { id: string; route: string; ts: number };

/** Taps already routed by this page: each lands once, however many triggers see it. */
const handledTaps = new Set<string>();
let consuming: Promise<void> = Promise.resolve();

function routeTo(route: string) {
  // Only an in-app route, never anything else a stored value might hold.
  if (!/^#\/[^\s]*$/.test(route)) route = '#/';
  if (location.hash !== route) location.hash = route;
}

async function takePending(): Promise<PendingOpen | null> {
  if (!('caches' in window)) return null;
  const cache = await caches.open(PENDING_CACHE);
  const res = await cache.match(PENDING_KEY);
  if (!res) return null;
  let p: PendingOpen | null = null;
  try {
    p = (await res.json()) as PendingOpen;
  } catch {}
  await cache.delete(PENDING_KEY);
  return p && typeof p.id === 'string' && typeof p.route === 'string' && typeof p.ts === 'number' ? p : null;
}

/**
 * Route to a stored tap target if there is a fresh one this page has not handled. Calls run one after another (a
 * call made while one is reading still reads again afterwards, so a target written meanwhile is not missed).
 */
export function consumePendingOpen(): Promise<void> {
  if (document.visibilityState !== 'visible') return consuming;
  consuming = consuming
    .then(takePending)
    .then((p) => {
      if (!p || handledTaps.has(p.id) || Date.now() - p.ts > PENDING_TTL || p.ts > Date.now() + 60_000) return;
      handledTaps.add(p.id);
      routeTo(p.route);
    })
    .catch(() => {});
  return consuming;
}

let pendingStarted = false;
function startPendingOpen() {
  if (pendingStarted) return;
  pendingStarted = true;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open') return;
    // From a worker before the stored target (no id): follow its URL as before.
    if (typeof e.data.id !== 'string') {
      if (typeof e.data.url === 'string') location.href = e.data.url;
      return;
    }
    // A page in the background waits until it is brought forward (visibilitychange or focus consume it then).
    // Where the worker could not store it (no Cache API), the message is the only copy: follow it.
    if (!('caches' in window) && !handledTaps.has(e.data.id) && typeof e.data.route === 'string') {
      handledTaps.add(e.data.id);
      routeTo(e.data.route);
      return;
    }
    void consumePendingOpen();
  });
  const wake = () => void consumePendingOpen();
  document.addEventListener('visibilitychange', wake);
  addEventListener('pageshow', wake);
  addEventListener('focus', wake);
  wake();
}

/**
 * From a tap: ask permission first (iOS allows the prompt only directly from a user gesture), then subscribe,
 * save, and send a test. Returns an error message, or null.
 */
export async function enablePush(publicKey: string): Promise<string | null> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'Notifications were not allowed.';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (an old data directory) cannot be used: start again.
  const key = fromB64u(publicKey);
  const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && current && (current.length !== key.length || current.some((b, i) => b !== key[i]))) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const r = await api<{ id: string }>('/api/push/subscriptions', { body: { subscription: sub.toJSON(), origin: location.origin } });
  setDeviceId(r.id);
  await api(`/api/push/subscriptions/${r.id}/test`, { method: 'POST' });
  return null;
}

function useDeviceId() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    idListeners.add(f);
    return () => {
      idListeners.delete(f);
    };
  }, []);
  return deviceId;
}

// ---------- presence and badge (used by the shell) ----------

const CLIENT = (() => {
  try {
    const have = sessionStorage.getItem('helm-client');
    if (have) return have;
    const id = Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem('helm-client', id);
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 12);
  }
})();

/** Tell the server what this page shows while it is visible, so it does not notify about it (server/notify.ts). */
export function usePresence() {
  useEffect(() => {
    const report = () => {
      const visible = document.visibilityState === 'visible';
      void fetch('/api/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client: CLIENT, hash: location.hash || '#/', visible }),
        credentials: 'same-origin',
        keepalive: true,
      }).catch(() => {});
    };
    report();
    const every = setInterval(() => document.visibilityState === 'visible' && report(), 30_000);
    addEventListener('hashchange', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      clearInterval(every);
      removeEventListener('hashchange', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, []);
}

/** The app icon's badge: requests waiting on the user, cleared when none. */
export function useAppBadge(count: number) {
  useEffect(() => {
    const n = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (count > 0) void n.setAppBadge?.(count).catch(() => {});
    else void n.clearAppBadge?.().catch(() => {});
  }, [count]);
}

// ---------- UI ----------

const DISMISSED = 'helm-notify-card-dismissed';

/** On the project list, once: offer notifications where they can be turned on right here. */
export function NotificationsCard() {
  const id = useDeviceId();
  const { data } = useLive<PushInfo>('/api/push', () => false);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });
  const { busy, error, run } = useAction();
  const [denied, setDenied] = useState(false);
  const support = pushSupport();
  const on = !!id && !!data?.devices.some((d) => d.id === id);
  if (hidden || on || support !== 'ok' || !data) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {}
    setHidden(true);
  };
  return (
    <div className="card install-entry install-home notify-card">
      <span className="notify-glyph" aria-hidden="true">
        <Icon name="bell" size={20} />
      </span>
      <span className="install-text">
        <strong>Get notified on this device</strong>
        <span className="muted small">{denied ? 'Notifications are blocked for Helm here. Allow them in the browser’s or the system’s settings, then try again.' : 'When something needs you or a task finishes.'}</span>
        {error && <span className="error-text small">{error}</span>}
      </span>
      <button
        className="btn small primary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const e = await enablePush(data.publicKey);
            if (e === 'denied') setDenied(true);
            else if (e) throw new Error(e);
          })
        }
      >
        Enable notifications
      </button>
      <button className="icon-btn install-dismiss" onClick={dismiss} aria-label="Hide this for good" title="Hide this">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

/** Setup → Notifications: this device, every device, what is sent, and (inside a project) this project's switches. */
export function NotificationsSetup({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  const { data, reload } = useLive<PushInfo>('/api/push', () => false);
  const id = useDeviceId();
  const [guide, setGuide] = useState(false);
  const [settings, setSettings] = useState<NotifySettings | null>(null);
  const { busy, error, run } = useAction();
  const [note, setNote] = useState('');
  useEffect(() => {
    if (data) setSettings(data.settings);
  }, [data]);
  if (!data || !settings) return null;
  const support = pushSupport();
  const mine = data.devices.find((d) => d.id === id);

  const save = (next: NotifySettings) => {
    setSettings(next);
    void run(async () => {
      const r = await api<{ settings: NotifySettings }>('/api/push/settings', { method: 'PUT', body: next });
      setSettings(r.settings);
    });
  };
  const project = projectId ? settings.projects[projectId] ?? {} : null;
  const setProject = (p: { off?: boolean; kinds?: Partial<Record<NotifyKind, boolean>> }) => save({ ...settings, projects: { ...settings.projects, [projectId!]: p } });
  const kindValue = (k: NotifyKind) => project?.kinds?.[k] ?? settings.kinds[k];
  const enable = () =>
    run(async () => {
      setNote('');
      const e = await enablePush(data.publicKey);
      if (e === 'denied') setNote('denied');
      else if (e) throw new Error(e);
      else setNote('A test notification is on its way.');
      await reload();
    });

  return (
    <>
      <h2 id="notifications">Notifications</h2>
      <div className="card notify-device">
        {support === 'needs-install' ? (
          <>
            <p>
              <strong>Notifications need the Helm app on your Home Screen.</strong>
            </p>
            <p className="muted small">On iPhone and iPad, only a web app added to the Home Screen can receive notifications (iOS 16.4 or later). Add Helm, open it from its icon, and come back here to turn them on.</p>
            <div>
              <button className="btn small" onClick={() => setGuide(true)}>
                Show me how
              </button>
            </div>
          </>
        ) : support === 'unsupported' ? (
          <p className="muted">This browser cannot receive notifications from Helm.</p>
        ) : support === 'denied' || note === 'denied' ? (
          <>
            <p>
              <strong>Notifications are blocked for Helm on this device.</strong>
            </p>
            <p className="muted small">{isIos() ? 'Turn them on in Settings → Notifications → Helm, then come back here.' : 'Allow them in the site settings of this browser (the icon by the address), then come back here.'}</p>
          </>
        ) : mine ? (
          <div className="row wrap">
            <span className="grow">
              <strong>On for this device</strong> <span className="muted small">({mine.label})</span>
            </span>
            <button className="btn small" disabled={busy} onClick={() => run(async () => { await api(`/api/push/subscriptions/${mine.id}/test`, { method: 'POST' }); setNote('A test notification is on its way.'); await reload(); })}>
              Send test
            </button>
          </div>
        ) : (
          <div className="row wrap">
            <span className="grow notify-intro">Get a notification on this device when something needs you or a task finishes.</span>
            <button className="btn small primary" disabled={busy} onClick={enable}>
              Enable notifications
            </button>
          </div>
        )}
        {note && note !== 'denied' && <p className="muted small">{note}</p>}
        {error && <p className="error-text small">{error}</p>}
      </div>

      {data.devices.length > 0 && (
        <>
          <h3>Devices</h3>
          <ul className="card notify-devices">
            {data.devices.map((d) => (
              <DeviceRow key={d.id} d={d} mine={d.id === id} onChange={reload} />
            ))}
          </ul>
        </>
      )}

      <h3>What to send</h3>
      <div className="card notify-kinds">
        <Switch label="Mute all notifications" checked={settings.muted} onChange={(muted) => save({ ...settings, muted })} />
        {KINDS.map((k) => (
          <div key={k.id} className={settings.muted ? 'notify-muted' : ''}>
            <Switch label={k.label} detail={k.detail} checked={settings.kinds[k.id]} onChange={(v) => save({ ...settings, kinds: { ...settings.kinds, [k.id]: v } })} />
            {k.id === 'done' && settings.kinds.done && (
              <label className="notify-sub">
                <span className="muted small">Tell me</span>
                <select value={settings.doneMode} onChange={(e) => save({ ...settings, doneMode: e.target.value as NotifySettings['doneMode'] })}>
                  <option value="every">every time</option>
                  <option value="result">only when there is a result to look at</option>
                </select>
              </label>
            )}
          </div>
        ))}
        <QuietHours value={settings.quiet} onChange={(quiet) => save({ ...settings, quiet })} />
      </div>

      {projectId && project && (
        <>
          <h3>{projectName ? `For ${projectName}` : 'For this project'}</h3>
          <div className="card notify-kinds">
            <Switch label="Notifications from this project" checked={!project.off} onChange={(v) => setProject({ ...project, off: !v })} />
            {!project.off &&
              KINDS.filter((k) => k.id !== 'update').map((k) => (
                <Switch
                  key={k.id}
                  label={k.label}
                  detail={project.kinds?.[k.id] === undefined ? undefined : 'Set for this project'}
                  checked={kindValue(k.id)}
                  onChange={(v) => setProject({ ...project, kinds: { ...(project.kinds ?? {}), [k.id]: v } })}
                />
              ))}
          </div>
        </>
      )}
      {guide && <InstallGuide onClose={() => setGuide(false)} />}
    </>
  );
}

function DeviceRow({ d, mine, onChange }: { d: Device; mine: boolean; onChange: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(d.label);
  const [sent, setSent] = useState(false);
  const patch = (body: Partial<Device>) => run(async () => { await api(`/api/push/subscriptions/${d.id}`, { method: 'PATCH', body }); await onChange(); });
  const status = d.last_error && (d.last_error_at ?? 0) >= (d.last_success_at ?? 0) ? <span className="error-text">Last attempt failed {ago(d.last_error_at!)}: {d.last_error}</span> : d.last_success_at ? <>Last delivered {ago(d.last_success_at)}</> : <>Nothing sent yet</>;
  return (
    <li className="notify-device-row">
      <div className="notify-device-main">
        {renaming ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void patch({ label }).then(() => setRenaming(false));
            }}
          >
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} autoFocus aria-label="Device name" />
            <button className="btn small" disabled={busy || !label.trim()}>
              Save
            </button>
          </form>
        ) : (
          <button className="link-btn notify-device-name" onClick={() => setRenaming(true)} title="Rename">
            <strong>{d.label}</strong> {mine && <span className="tag">this device</span>}
          </button>
        )}
        <span className="muted small">{status}</span>
        <span className="muted small">
          Added {ago(d.created_at)} · {d.service}
        </span>
        {sent && <span className="muted small">Test sent.</span>}
        {error && <span className="error-text small">{error}</span>}
      </div>
      <div className="notify-device-actions">
        <Switch label="" aria={`Notifications to ${d.label}`} checked={d.enabled} onChange={(enabled) => void patch({ enabled })} />
        <button className="btn small" disabled={busy || !d.enabled} onClick={() => run(async () => { setSent(false); await api(`/api/push/subscriptions/${d.id}/test`, { method: 'POST' }); setSent(true); await onChange(); })}>
          Send test
        </button>
        <button
          className="icon-btn"
          aria-label={`Remove ${d.label}`}
          title="Remove"
          disabled={busy}
          onClick={() => {
            if (confirm(`Stop sending notifications to ${d.label} and remove it from the list?`)) void run(async () => { await api(`/api/push/subscriptions/${d.id}`, { method: 'DELETE' }); if (mine) setDeviceId(null); await onChange(); });
          }}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </li>
  );
}

export function Switch({ label, detail, checked, onChange, aria }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void; aria?: string }) {
  return (
    <label className={`switch-row ${label ? '' : 'bare'}`}>
      {label && (
        <span className="switch-text">
          <span>{label}</span>
          {detail && <span className="muted small">{detail}</span>}
        </span>
      )}
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={aria} />
    </label>
  );
}

function QuietHours({ value, onChange }: { value: NotifySettings['quiet']; onChange: (q: NotifySettings['quiet']) => void }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [start, setStart] = useState(value?.start ?? '22:00');
  const [end, setEnd] = useState(value?.end ?? '07:00');
  useEffect(() => {
    if (value) {
      setStart(value.start);
      setEnd(value.end);
    }
  }, [value?.start, value?.end]);
  const commit = (s: string, e: string) => s && e && onChange({ start: s, end: e, tz });
  return (
    <div>
      <Switch label="Quiet hours" detail={value ? `Held from ${hhmm(value.start)} until ${hhmm(value.end)} (${value.tz}), then sent as one summary. Blocking requests still come.` : 'Hold notifications overnight; blocking requests still come.'} checked={!!value} onChange={(on) => onChange(on ? { start, end, tz } : null)} />
      {value && (
        <div className="row notify-sub">
          <label>
            <span className="muted small">From</span>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} onBlur={() => commit(start, end)} />
          </label>
          <label>
            <span className="muted small">To</span>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={() => commit(start, end)} />
          </label>
        </div>
      )}
    </div>
  );
}
