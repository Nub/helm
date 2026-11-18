// Headless Chromium driven over the DevTools protocol, with no npm dependency (Node's own WebSocket).
// Phone emulation the way Helm is used: iPhone sizes, dark theme, home-screen mode (navigator.standalone and safe
// areas; the display-mode media query cannot be emulated),
// touch input, and a simulated iOS keyboard that shrinks visualViewport like Safari does.
//
//   import { launch, DEVICES } from './browser.mjs';
//   const b = await launch();
//   const p = await b.page({ device: 'phone', base: inst.url, cookie: inst.cookie });
//   await p.go('#/');  await p.shot('/path/out.png');  console.log(await p.audit(), p.errors);
//   await b.close();
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Sizes in CSS pixels; safe areas are what iOS reports in a home-screen web app, portrait. */
export const DEVICES = {
  phone: { width: 390, height: 844, dpr: 3, mobile: true, ua: IOS_UA, safe: { top: 47, bottom: 34, left: 0, right: 0 }, kb: 336 }, // iPhone 13/14
  iphone15: { width: 393, height: 852, dpr: 3, mobile: true, ua: IOS_UA, safe: { top: 59, bottom: 34, left: 0, right: 0 }, kb: 336 },
  promax: { width: 430, height: 932, dpr: 3, mobile: true, ua: IOS_UA, safe: { top: 59, bottom: 34, left: 0, right: 0 }, kb: 346 },
  se: { width: 375, height: 667, dpr: 2, mobile: true, ua: IOS_UA, safe: { top: 20, bottom: 0, left: 0, right: 0 }, kb: 260 },
  ipad: { width: 820, height: 1180, dpr: 2, mobile: true, ua: IPAD_UA, safe: { top: 24, bottom: 20, left: 0, right: 0 }, kb: 400 },
  desktop: { width: 1280, height: 900, dpr: 1, mobile: false },
};

export function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const c of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']) {
    try {
      return execFileSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).trim();
    } catch { /* next */ }
  }
  throw new Error('No Chromium on PATH. Set CHROMIUM=/path/to/chromium.');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Profiles (about 100 MB each) left by runs that were killed: anything older than six hours goes. */
function sweepProfiles() {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('huc-chrome-')) continue;
    const dir = join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
    } catch { /* gone, or not ours */ }
  }
}

export async function launch({ headless = true, chromium = findChromium() } = {}) {
  sweepProfiles();
  const profile = mkdtempSync(join(tmpdir(), 'huc-chrome-'));
  // Removed on close, and if the script exits without closing (a thrown error), on the way out.
  const dropProfile = () => rmSync(profile, { recursive: true, force: true });
  process.once('exit', dropProfile);
  // --no-sandbox: Chromium's sandbox needs user namespaces or a setuid helper, which a Nix-built Chromium run from an
  // agent's shell cannot assume. Acceptable because this browser only ever loads the local scratch server.
  const args = [
    headless ? '--headless=new' : '', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--no-sandbox', '--disable-gpu',
    // Headless Chromium has no pointing device, so (pointer: fine) and (hover: hover) would be false even at desktop
    // size and mouse-only features (drag handles) would never show. Report a mouse; phones get touch emulation on top,
    // which makes them coarse again.
    '--blink-settings=primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2',
    'about:blank',
  ].filter(Boolean);
  const proc = spawn(chromium, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error(`Chromium did not start: ${buf.slice(-500)}`)), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); res(m[1]); }
    });
    proc.once('exit', (c) => { clearTimeout(t); rej(new Error(`Chromium exited (${c}): ${buf.slice(-500)}`)); });
  });
  proc.stderr.resume();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej, method } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej, method });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const browser = {
    send,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    page: (opts) => newPage(browser, opts),
    /** Grant permissions without a prompt, e.g. grant(url, ['notifications']) before testing Web Push. */
    grant: (origin, permissions) => send('Browser.grantPermissions', { origin: new URL(origin).origin, permissions }),
    /**
     * The newest service worker of an origin, attached: { url, eval(fn, ...args) } running in the worker (show or
     * list notifications, dispatch a notificationclick, read its caches). Ask again after an update for the new one.
     */
    async worker(origin, timeout = 10000) {
      const o = new URL(origin).origin;
      const end = Date.now() + timeout;
      let t;
      while (!(t = (await send('Target.getTargets')).targetInfos.filter((i) => i.type === 'service_worker' && i.url.startsWith(o)).pop())) {
        if (Date.now() > end) throw new Error(`No service worker for ${o}`);
        await sleep(200);
      }
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      return {
        url: t.url,
        async eval(fn, ...args) {
          const r = await send('Runtime.evaluate', { expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, sessionId);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
      };
    },
    async close() {
      try { await send('Browser.close'); } catch { /* already gone */ }
      ws.close();
      await Promise.race([new Promise((r) => proc.once('exit', r)), sleep(3000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      dropProfile();
      process.off('exit', dropProfile);
    },
  };
  return browser;
}

/**
 * opts: device (name or object), base (server URL), cookie ("helm_session=..."), theme ('dark'|'light'),
 * standalone (home-screen mode with safe areas; default true on phones), keyboard (simulated iOS keyboard; default
 * true on phones).
 */
async function newPage(browser, opts = {}) {
  const d = typeof opts.device === 'object' ? opts.device : DEVICES[opts.device ?? 'phone'];
  if (!d) throw new Error(`Unknown device "${opts.device}". Known: ${Object.keys(DEVICES).join(', ')}`);
  const base = opts.base ?? '';
  const theme = opts.theme ?? 'dark';
  const standalone = opts.standalone ?? d.mobile;
  const kb = opts.keyboard ?? d.mobile;
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  const inflight = new Map();
  let lastNet = Date.now();
  let loaded = null;
  const off = browser.on((m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params;
    if (m.method === 'Runtime.exceptionThrown') errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text);
    else if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    else if (m.method === 'Network.requestWillBeSent' && p.type !== 'EventSource') { inflight.set(p.requestId, 1); lastNet = Date.now(); }
    else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight.delete(p.requestId); lastNet = Date.now(); }
    else if (m.method === 'Page.loadEventFired') loaded?.();
  });
  await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable'].map((m) => s(m)));
  await s('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: d.dpr, mobile: d.mobile, screenWidth: d.width, screenHeight: d.height });
  if (d.mobile) {
    await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await s('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  }
  if (d.ua) await s('Emulation.setUserAgentOverride', { userAgent: d.ua, platform: 'iPhone' });
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, ...(standalone ? [{ name: 'display-mode', value: 'standalone' }] : [])] });
  let safeAreas = false;
  if (standalone && d.safe) {
    try {
      await s('Emulation.setSafeAreaInsetsOverride', { insets: d.safe });
      safeAreas = true;
    } catch { /* older Chromium: env(safe-area-inset-*) stays 0 */ }
    await s('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'standalone', { value: true });" });
  }
  if (kb) await s('Page.addScriptToEvaluateOnNewDocument', { source: `(${fakeKeyboard})()` });
  if (opts.cookie) {
    const [name, ...v] = opts.cookie.split('=');
    await s('Network.setCookie', { name, value: v.join('='), url: base });
  }

  const evaluate = async (fn, ...args) => {
    const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const center = async (sel) => {
    const c = await evaluate((q) => {
      const el = document.querySelector(q);
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    if (!c) throw new Error(`No element matches ${sel}`);
    return c;
  };
  const touch = (type, pts) => s('Input.dispatchTouchEvent', { type, touchPoints: pts });

  const page = {
    device: d, sessionId, errors, safeAreas, send: s, eval: evaluate,
    /** Navigate to base + route ("#/p/..."), wait for load and for the network to settle (the SSE stream is ignored). */
    async go(route = '#/', { wait = 600, timeout = 15000 } = {}) {
      const done = new Promise((r) => { loaded = r; });
      const nav = await s('Page.navigate', { url: /^(https?|data|about):/.test(route) ? route : base + route });
      if (nav.errorText) throw new Error(`navigate ${route}: ${nav.errorText}`);
      // A hash change in the same document has no loaderId and fires no load event: only wait for the network.
      if (nav.loaderId) await Promise.race([done, sleep(timeout)]);
      lastNet = Math.max(lastNet, Date.now() - 300);
      const end = Date.now() + timeout;
      while (Date.now() < end && (inflight.size > 0 || Date.now() - lastNet < 400)) await sleep(50);
      await sleep(wait);
    },
    /** Wait until a selector matches (or the timeout passes; returns false then). */
    async waitFor(sel, timeout = 8000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await evaluate((q) => !!document.querySelector(q), sel)) return true;
        await sleep(100);
      }
      return false;
    },
    async shot(path, { full = false } = {}) {
      mkdirSync(dirname(path), { recursive: true });
      let params = { format: 'png' };
      if (full) {
        const m = await s('Page.getLayoutMetrics');
        const sz = m.cssContentSize ?? m.contentSize;
        params = { ...params, captureBeyondViewport: true, clip: { x: 0, y: 0, width: d.width, height: Math.ceil(sz.height), scale: 1 } };
      }
      const { data } = await s('Page.captureScreenshot', params);
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },
    /** A finger tap at the element's centre (touch events, then the synthetic click, as on a phone). */
    async tap(sel) {
      const { x, y } = await center(sel);
      await touch('touchStart', [{ x, y }]);
      await touch('touchEnd', []);
      await sleep(150);
    },
    async click(sel) {
      const { x, y } = await center(sel);
      for (const type of ['mousePressed', 'mouseReleased']) await s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    },
    /** Type into the focused element as the keyboard would (input events fire). */
    async type(text) { await s('Input.insertText', { text }); },
    async press(key) {
      const codes = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9 };
      for (const type of ['keyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: codes[key] ?? 0, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
    },
    /**
     * Drag a finger from (x, y0) to (x, y1). The page really scrolls (y1 < y0 scrolls down) and touchmove handlers
     * see it, as for pull-to-refresh or swipe-to-dismiss. (Input.synthesizeScrollGesture does nothing headless.)
     */
    async swipe(x, y0, y1, steps = 12) {
      await touch('touchStart', [{ x, y: y0 }]);
      for (let i = 1; i <= steps; i++) { await touch('touchMove', [{ x, y: y0 + ((y1 - y0) * i) / steps }]); await sleep(16); }
      await touch('touchEnd', []);
      await sleep(400);
    },
    /**
     * Focus a field with a tap, raise the simulated keyboard (visualViewport shrinks by height, the layout viewport
     * stays), scroll the field above it as iOS does, and report what is visible.
     */
    async keyboard(sel, height = d.kb ?? 336) {
      if (!kb) throw new Error('Open the page with keyboard: true to simulate the iOS keyboard');
      await page.tap(sel);
      await sleep(300);
      await evaluate((h) => window.__kb(h), height);
      await sleep(400);
      return evaluate(keyboardReport, height);
    },
    async hideKeyboard() { await evaluate(() => { window.__kb(0); document.activeElement?.blur(); }); await sleep(300); },
    /** Layout problems a phone shows: horizontal overflow, inputs under 16 px (iOS zooms), small tap targets, fixed layers. */
    audit: () => evaluate(audit),
    /** Bring this tab to the front: the others become hidden (visibilitychange), this one visible and focused. */
    async front() { await s('Page.bringToFront'); await sleep(300); },
    /** The browser's Back button (a page kept in the back/forward cache comes back with pageshow persisted). */
    async back(wait = 1200) {
      const h = await s('Page.getNavigationHistory');
      if (h.currentIndex > 0) await s('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
      await sleep(wait);
    },
    async close() { off(); await browser.send('Target.closeTarget', { targetId }).catch(() => {}); },
  };
  return page;
}

/** Runs in the page before its scripts: a visualViewport whose height shrinks like the iOS keyboard's. */
function fakeKeyboard() {
  const real = window.visualViewport;
  if (!real) return;
  const et = new EventTarget();
  let kbh = 0;
  const fake = {
    get height() { return real.height - kbh; }, get width() { return real.width; },
    get offsetTop() { return real.offsetTop; }, get offsetLeft() { return real.offsetLeft; },
    get pageTop() { return real.pageTop; }, get pageLeft() { return real.pageLeft; }, get scale() { return real.scale; },
    addEventListener: (...a) => et.addEventListener(...a), removeEventListener: (...a) => et.removeEventListener(...a),
    dispatchEvent: (e) => et.dispatchEvent(e),
  };
  real.addEventListener('resize', () => et.dispatchEvent(new Event('resize')));
  real.addEventListener('scroll', () => et.dispatchEvent(new Event('scroll')));
  Object.defineProperty(window, 'visualViewport', { get: () => fake });
  window.__kb = (h) => { kbh = h; et.dispatchEvent(new Event('resize')); };
}

function keyboardReport(h) {
  const el = document.activeElement;
  const band = innerHeight - h;
  let r = el.getBoundingClientRect();
  if (r.bottom > band - 8) scrollBy(0, r.bottom - band + 16);
  r = el.getBoundingClientRect();
  const form = el.closest('form') || el.parentElement;
  const send = [...(form?.querySelectorAll('button') ?? [])].pop();
  const sr = send?.getBoundingClientRect();
  const at = (x, y) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}` : null; };
  return {
    visibleBand: [0, band], scrollY, field: [Math.round(r.top), Math.round(r.bottom)], fieldVisible: r.bottom <= band && r.top >= 0,
    fieldFontPx: parseFloat(getComputedStyle(el).fontSize), sendButton: sr ? { top: Math.round(sr.top), bottom: Math.round(sr.bottom), visible: sr.bottom <= band, label: send.textContent.trim() || send.getAttribute('aria-label') } : null,
    coveredBy: at(r.left + 10, (r.top + r.bottom) / 2), active: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`,
  };
}

function audit() {
  const vw = innerWidth;
  const vis = (el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length; };
  const tag = (el) => `${el.tagName.toLowerCase()}${el.classList.length ? '.' + [...el.classList].join('.') : ''}`;
  const out = { viewport: [innerWidth, innerHeight], scrollWidth: document.documentElement.scrollWidth, docHeight: document.documentElement.scrollHeight };
  out.horizontalOverflow = out.scrollWidth > vw + 1;
  out.wide = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || (r.right <= vw + 1 && r.left >= -1) || !vis(el)) continue;
    let p = el.parentElement, clipped = false;
    while (p && p !== document.body) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) { const pr = p.getBoundingClientRect(); if (pr.right <= vw + 1 && pr.left >= -1) { clipped = true; break; } }
      p = p.parentElement;
    }
    if (!clipped) out.wide.push(`${tag(el)} [${Math.round(r.left)},${Math.round(r.right)}]`);
  }
  out.wide = out.wide.slice(0, 12);
  out.smallInputs = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=hidden]), textarea, select, [contenteditable=true]')]
    .filter(vis).map((el) => [el, parseFloat(getComputedStyle(el).fontSize)]).filter(([, f]) => f < 16).map(([el, f]) => `${tag(el)} ${f}px`);
  const taps = [...document.querySelectorAll('a[href], button, [role=button], input[type=checkbox], input[type=radio], select, summary, label[for]')].filter(vis);
  out.smallTaps = taps.map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.width > 0 && (r.height < 32 || r.width < 32))
    .map(([el, r]) => `${tag(el)} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`).slice(0, 30);
  out.tapTargets = taps.length;
  out.fixedLayers = [...document.querySelectorAll('body *')].filter((el) => { const p = getComputedStyle(el).position; return (p === 'fixed' || p === 'sticky') && vis(el); })
    .map((el) => { const r = el.getBoundingClientRect(); return `${getComputedStyle(el).position} ${tag(el)} y=${Math.round(r.top)}..${Math.round(r.bottom)}`; });
  return out;
}
