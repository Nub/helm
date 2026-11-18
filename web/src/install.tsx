import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, Sheet } from './ui';

/**
 * "Add to Home Screen". iOS has no API to start it, so there the entry opens a short guide; Chromium
 * on Android and desktop offers a real install prompt (beforeinstallprompt), which the entry calls.
 * The entry shows only where it can help: never once Helm already runs as an installed app.
 */

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

// Chromium fires this once, early: catch it at load, before any component is mounted.
let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    changed();
  });
}

export type IosBrowser = { kind: 'safari' } | { kind: 'inapp'; name: string } | { kind: 'other'; name: string; canAdd: boolean };

export function standalone(): boolean {
  return (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** iPhone, iPod or iPad, including iPadOS, which reports itself as a Mac with a touch screen. */
export function isIos(ua = navigator.userAgent): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isIpad(ua = navigator.userAgent): boolean {
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** iOS major and minor version, or null when the user agent does not say (iPadOS in desktop mode). */
function iosVersion(ua: string): number | null {
  const m = ua.match(/OS (\d+)_(\d+)/);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}

const IN_APP: [RegExp, string][] = [
  [/FBAN|FBAV|FB_IAB/, 'Facebook'],
  [/Instagram/, 'Instagram'],
  [/\bLine\//, 'LINE'],
  [/Twitter|TwitterAndroid/, 'X'],
  [/LinkedInApp/, 'LinkedIn'],
  [/Snapchat/, 'Snapchat'],
  [/MicroMessenger/, 'WeChat'],
  [/Slack/, 'Slack'],
  [/Discord/, 'Discord'],
  [/GSA\//, 'the Google app'],
  [/DuckDuckGo/, 'DuckDuckGo'],
];
const OTHER: [RegExp, string][] = [
  [/CriOS/, 'Chrome'],
  [/FxiOS/, 'Firefox'],
  [/EdgiOS/, 'Edge'],
  [/OPiOS|OPT\//, 'Opera'],
];

/**
 * Which browser this is on iOS. Apps that show web pages in their own view cannot add them to the
 * Home Screen. Other browsers can from iOS 16.4; before that only Safari could.
 */
export function iosBrowser(ua = navigator.userAgent): IosBrowser {
  for (const [re, name] of IN_APP) if (re.test(ua)) return { kind: 'inapp', name };
  for (const [re, name] of OTHER) if (re.test(ua)) return { kind: 'other', name, canAdd: (iosVersion(ua) ?? 0) >= 16.4 };
  // Safari's own token, without another browser's; anything else showing pages is an embedded view.
  if (/Safari\//.test(ua)) return { kind: 'safari' };
  return { kind: 'inapp', name: 'this app' };
}

/** 'ios' (show the guide), 'prompt' (Chromium's install prompt is ready) or null (nothing to offer). */
export function useInstall(): { mode: 'ios' | 'prompt' | null; install: () => void } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    listeners.add(f);
    const mq = matchMedia('(display-mode: standalone)');
    mq.addEventListener('change', f);
    return () => {
      listeners.delete(f);
      mq.removeEventListener('change', f);
    };
  }, []);
  if (standalone()) return { mode: null, install: () => {} };
  if (isIos()) return { mode: 'ios', install: () => {} };
  if (deferred) {
    return {
      mode: 'prompt',
      install: () => {
        const e = deferred;
        if (!e) return;
        void e.prompt();
        void e.userChoice.finally(() => {
          deferred = null;
          changed();
        });
      },
    };
  }
  return { mode: null, install: () => {} };
}

const DISMISSED = 'helm-install-dismissed';

/**
 * The entry. On the project list it is a small card the user can dismiss for good (remembered on this
 * device); in Setup it is a plain row that stays, so a dismissed card can be found again.
 */
export function InstallEntry({ place }: { place: 'home' | 'setup' }) {
  const { mode, install } = useInstall();
  const [guide, setGuide] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });
  if (!mode || (place === 'home' && dismissed)) return null;
  const open = () => (mode === 'ios' ? setGuide(true) : install());
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {}
    setDismissed(true);
  };
  return (
    <>
      {place === 'setup' && <h2>This device</h2>}
      <div className={`card install-entry install-${place}`}>
        <HomeScreenGlyph />
        <span className="install-text">
          <strong>Add Helm to your Home Screen</strong>
          <span className="muted small">It opens full screen, like an app, one tap from your Home Screen{mode === 'ios' ? ', and it can send you notifications' : ''}.</span>
        </span>
        <button className="btn small" onClick={open}>
          {mode === 'ios' ? 'Show me how' : 'Install'}
        </button>
        {place === 'home' && (
          <button className="icon-btn install-dismiss" onClick={dismiss} aria-label="Hide this for good" title="Hide this">
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      {guide && <InstallGuide onClose={() => setGuide(false)} />}
    </>
  );
}

/** The illustrated steps for iOS, adapted to the device and browser. */
export function InstallGuide({ onClose, ua = navigator.userAgent }: { onClose: () => void; ua?: string }) {
  const browser = iosBrowser(ua);
  const ipad = isIpad(ua);
  if (browser.kind === 'inapp' || (browser.kind === 'other' && !browser.canAdd)) {
    const where = browser.kind === 'inapp' ? `${browser.name}'s built-in browser` : `${browser.name} on this version of iOS`;
    return (
      <Sheet title="Open Helm in Safari first" onClose={onClose}>
        <div className="install-guide">
          <p>
            Apps can be added to the Home Screen from Safari. Helm is open in {where}, which cannot do it.
          </p>
          <ol className="install-steps">
            <Step n={1} glyph={<MoreGlyph />}>
              {browser.kind === 'inapp' ? (
                <>
                  Tap the <strong>•••</strong> or <strong>Share</strong> button of {browser.name} and choose <strong>Open in Safari</strong> (or <strong>Open in browser</strong>).
                </>
              ) : (
                <>
                  Copy this page’s address, then open <strong>Safari</strong> and paste it in the address bar.
                </>
              )}
            </Step>
            <Step n={2} glyph={<ShareGlyph />}>
              In Safari, sign in if asked, then tap <strong>Show me how</strong> again for the steps.
            </Step>
          </ol>
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(location.href).catch(() => {})}>
            Copy this page’s address
          </button>
        </div>
      </Sheet>
    );
  }
  const shareWhere =
    browser.kind === 'other'
      ? `In ${browser.name}, tap the Share button (in or next to the address bar, or in the ••• menu).`
      : ipad
        ? 'Tap the Share button at the top of the screen, next to the address bar.'
        : 'Tap the Share button in the toolbar at the bottom of the screen.';
  return (
    <Sheet title="Add Helm to your Home Screen" onClose={onClose}>
      <div className="install-guide">
        <ol className="install-steps">
          <Step n={1} glyph={<ShareGlyph />}>
            {shareWhere} <span className="muted">If you do not see it, tap <strong>•••</strong> first; it is in that menu.</span>
          </Step>
          <Step n={2} glyph={<AddRowGlyph />}>
            Scroll the list down and tap <strong>Add to Home Screen</strong>.
          </Step>
          <Step n={3} glyph={<AddButtonGlyph />}>
            Leave <strong>Open as Web App</strong> on if it is shown, and tap <strong>Add</strong> in the top corner.
          </Step>
        </ol>
        <p className="muted small">Helm then opens from its icon full screen, without Safari’s address bar. The first time, you may be asked to sign in again: the app keeps its own sign-in, separate from Safari’s.</p>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

function Step({ n, glyph, children }: { n: number; glyph: ReactNode; children: ReactNode }) {
  return (
    <li className="install-step">
      <span className="install-num" aria-hidden="true">
        {n}
      </span>
      <span className="install-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{children}</span>
    </li>
  );
}

// ---------- the iOS glyphs, drawn to match what the user will see ----------

/** iOS Share: a square open at the top with an arrow out of it. */
function ShareGlyph() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="var(--ios-blue)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 11H7.5a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 7.5 24h13a1.5 1.5 0 0 0 1.5-1.5v-10a1.5 1.5 0 0 0-1.5-1.5h-2" />
      <path d="M14 3.5v13M9.8 7.5 14 3.3l4.2 4.2" />
    </svg>
  );
}

/** The "Add to Home Screen" row of the share sheet: its label and the plus-in-a-square icon. */
function AddRowGlyph() {
  return (
    <span className="ios-row">
      <span>Add to Home Screen</span>
      <svg viewBox="0 0 22 22" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <rect x="2.5" y="2.5" width="17" height="17" rx="4" />
        <path d="M11 7v8M7 11h8" />
      </svg>
    </span>
  );
}

/** The blue "Add" button at the top of the confirmation screen. */
function AddButtonGlyph() {
  return <span className="ios-add">Add</span>;
}

/** Safari's ••• button, and the menu of an app's built-in browser. */
function MoreGlyph() {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28" fill="var(--ios-blue)">
      <circle cx="7" cy="14" r="2.2" />
      <circle cx="14" cy="14" r="2.2" />
      <circle cx="21" cy="14" r="2.2" />
    </svg>
  );
}

/** A phone Home Screen with Helm's icon, for the entry. */
function HomeScreenGlyph() {
  return (
    <svg className="install-icon" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <rect x="0" y="0" width="40" height="40" rx="9" fill="#0e1417" />
      <g fill="none" stroke="#e0a83a" strokeWidth="2" strokeLinecap="round">
        <circle cx="20" cy="20" r="8" />
        <path d="M20 6v6M20 28v6M6 20h6M28 20h6M11.2 11.2l4.3 4.3M24.5 24.5l4.3 4.3M28.8 11.2l-4.3 4.3M15.5 24.5l-4.3 4.3" />
      </g>
      <circle cx="20" cy="20" r="2.2" fill="#e0a83a" />
    </svg>
  );
}
