/**
 * Passphrase-free access from the local network (HELM_LAN_NO_LOGIN).
 *
 * The decision is a pure function of the TCP peer address, the request headers, the method and the settings, so it
 * can be checked case by case without a network. Anything it refuses falls back to the normal passphrase cookie,
 * so turning this on never breaks a client that works without it.
 *
 * What each check is for:
 *
 * 1. Peer address is loopback or private. Only machines on this host or the local network qualify; a visitor from
 *    the internet reaching the port (a forwarded router port, an IPv6 address with no firewall in front) does not.
 *
 * 2. Proxy headers. nginx (the public host name) connects from loopback, so on its own the peer address would make every
 *    internet visitor look local. A loopback request carrying any forwarding header is therefore judged on the client
 *    address the proxy reports in X-Real-IP, which nginx sets from the real client (it overwrites whatever the client
 *    sent). A loopback request with forwarding headers but no usable X-Real-IP is refused: we cannot tell who it is.
 *    A request from any other peer that carries forwarding headers is refused outright: those headers are either
 *    forged (to pass as someone else) or come from some other proxy on the LAN that may be relaying internet
 *    traffic, and in neither case do we know the real client. X-Real-IP is never believed from a non-loopback peer.
 *
 * 3. Host header in an allowed set. Defeats DNS rebinding: a web page at evil.example whose DNS name is re-pointed at
 *    this machine's LAN address gets the browser to send requests that are "same-origin" to the page, but they carry
 *    Host: evil.example (with the browser's port), which is not in the set. The set is this machine's own names and
 *    addresses with the configured port, plus HELM_LAN_ALLOWED_HOSTS.
 *
 * 4. Origin / Sec-Fetch-Site consistent with same-origin. Defeats cross-site request forgery: any page open in a
 *    browser on a LAN device can make that browser send requests to http://helm.local:8080, and with no cookie
 *    needed they would otherwise be authorised. Browsers send Origin on every cross-origin request that matters
 *    (all POST/PUT/PATCH/DELETE, fetch/XHR and EventSource in CORS mode), so:
 *      - a state-changing method must carry an Origin equal to this request's own scheme://Host;
 *      - any request that carries an Origin must match it (cross-site fetch, or EventSource on /api/stream);
 *      - a GET/HEAD without Origin is refused if Sec-Fetch-Site says it came from another origin (cross-site or
 *        same-site, e.g. another service on this host on a different port: script/img tags, link prefetch).
 *        A GET with neither header is a non-browser client (curl) or an old browser; it is allowed, since a
 *        cross-origin page cannot read the response (no CORS headers are ever sent) and GETs change nothing.
 *
 * Not decided here: release download links, GET /dl/<token> (dllinks.ts). They are outside the auth guard on purpose
 * (the user shares them with people who cannot sign in) and need neither the LAN nor a cookie; the token is the
 * credential. Making or revoking one is an /api call, and goes through the checks above like any other.
 */
import { networkInterfaces, hostname } from 'node:os';
import { isIP } from 'node:net';

export type LanSettings = {
  enabled: boolean;
  /** Exact Host header values (lower case) accepted for cookie-less access. */
  allowedHosts: Set<string>;
};

export type LanRequest = {
  peer: string | undefined;
  method: string;
  headers: Record<string, string | string[] | undefined>;
};

export type LanDecision = { ok: true; client: string } | { ok: false; reason: string };

const FORWARDING_HEADERS = ['x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function header(h: LanRequest['headers'], name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Strips a zone id and unwraps IPv4-mapped IPv6 (::ffff:1.2.3.4). */
export function normalizeAddress(addr: string): string {
  let a = addr.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const pct = a.indexOf('%');
  if (pct >= 0) a = a.slice(0, pct);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped ? mapped[1] : a;
}

function v4(a: string): number[] | null {
  if (isIP(a) !== 4) return null;
  return a.split('.').map(Number);
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function v6(a: string): number[] | null {
  if (isIP(a) !== 6) return null;
  let s = a;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [p, q, r, t] = tail[1].split('.').map(Number);
    s = s.slice(0, -tail[1].length) + `${((p << 8) | q).toString(16)}:${((r << 8) | t).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const hs = head ? head.split(':') : [];
  const rs = rest !== undefined && rest ? rest.split(':') : [];
  const fill = rest !== undefined ? 8 - hs.length - rs.length : 0;
  const groups = [...hs, ...Array(fill).fill('0'), ...rs].map((g) => parseInt(g, 16));
  return groups.length === 8 ? groups : null;
}

export function isLoopback(addr: string): boolean {
  const a = normalizeAddress(addr);
  const b = v4(a);
  if (b) return b[0] === 127;
  const g = v6(a);
  return !!g && g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
}

/** Loopback, RFC 1918, link-local, IPv6 unique-local and link-local. */
export function isPrivate(addr: string): boolean {
  const a = normalizeAddress(addr);
  const b = v4(a);
  if (b) {
    return b[0] === 127 || b[0] === 10 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254);
  }
  const g = v6(a);
  if (!g) return false;
  return isLoopback(a) || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
}

export function decideLan(req: LanRequest, s: LanSettings): LanDecision {
  if (!s.enabled) return { ok: false, reason: 'off' };
  if (!req.peer) return { ok: false, reason: 'no peer address' };
  const peer = normalizeAddress(req.peer);
  const h = req.headers;

  // 1 and 2: who is the client?
  const forwarded = FORWARDING_HEADERS.some((n) => h[n] !== undefined);
  let client = peer;
  let scheme = 'http';
  if (forwarded) {
    if (!isLoopback(peer)) return { ok: false, reason: 'forwarding headers from a non-loopback peer' };
    const real = header(h, 'x-real-ip');
    if (!real || isIP(normalizeAddress(real)) === 0) return { ok: false, reason: 'proxied without a usable X-Real-IP' };
    client = normalizeAddress(real);
    scheme = (header(h, 'x-forwarded-proto') ?? 'http').split(',')[0].trim().toLowerCase();
  }
  if (!isPrivate(client)) return { ok: false, reason: `client ${client} is not on the local network` };

  // 3: DNS rebinding.
  const host = (header(h, 'host') ?? '').trim().toLowerCase();
  if (!host || !s.allowedHosts.has(host)) return { ok: false, reason: `Host "${host}" is not allowed` };

  // 4: cross-site requests.
  const crossSite = crossSiteReason(h, req.method, scheme, host);
  if (crossSite) return { ok: false, reason: crossSite };
  return { ok: true, client };
}

/** Check 4 above: why the request looks like it came from another origin's page, or null if it doesn't. */
function crossSiteReason(h: LanRequest['headers'], method: string, scheme: string, host: string): string | null {
  const origin = header(h, 'origin');
  const m = method.toUpperCase();
  if (origin !== undefined) {
    if (origin.toLowerCase() !== `${scheme}://${host}`) return `cross-origin request from ${origin}`;
  } else if (!SAFE_METHODS.has(m)) {
    return `${m} without Origin`;
  } else {
    const site = header(h, 'sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return `Sec-Fetch-Site: ${site}`;
  }
  return null;
}

/**
 * Signed in at the reverse proxy (HELM_TRUST_PROXY_SIGNIN, services.helm.nginx.signedInBy): nginx sends
 * X-Helm-Signed-In: 1 only on locations whose auth_request gate passed, and clears it on every other location it
 * proxies to Helm, so a client can never supply it through nginx.
 *
 * - The peer must be loopback (nginx). Helm may also listen on the LAN (0.0.0.0), where any client could send the
 *   header itself; from any non-loopback peer it is ignored. (Any local process can also send it, as it can reach
 *   Helm on loopback anyway; with lanNoLogin that is already allowed, see the module's assertion note.)
 * - Check 4 (Origin / Sec-Fetch-Site) applies too: the gate's own sign-in is a cookie of the whole parent domain,
 *   which browsers attach to requests started by pages on sibling subdomains or, depending on its SameSite, other
 *   sites, so without this any such page could drive Helm through the proxy.
 */
export function decideProxySignIn(req: LanRequest, enabled: boolean): LanDecision {
  if (!enabled) return { ok: false, reason: 'off' };
  if (header(req.headers, 'x-helm-signed-in') !== '1') return { ok: false, reason: 'no X-Helm-Signed-In' };
  if (!req.peer || !isLoopback(req.peer)) return { ok: false, reason: 'X-Helm-Signed-In from a non-loopback peer' };
  const h = req.headers;
  const scheme = (header(h, 'x-forwarded-proto') ?? 'http').split(',')[0].trim().toLowerCase();
  const host = (header(h, 'host') ?? '').trim().toLowerCase();
  const crossSite = crossSiteReason(h, req.method, scheme, host);
  if (crossSite) return { ok: false, reason: crossSite };
  return { ok: true, client: normalizeAddress(header(h, 'x-real-ip') ?? req.peer) };
}

/** The Host values this machine answers to directly: its names and own private addresses, with the port. */
export function defaultAllowedHosts(port: number): string[] {
  const names = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  const name = hostname().toLowerCase();
  if (name) {
    names.add(name);
    names.add(`${name.split('.')[0]}.local`);
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (!isPrivate(i.address)) continue;
      // A link-local IPv6 literal needs a zone id to be reachable, and browsers don't put one in a URL or Host.
      if (i.family === 'IPv6' && i.address.toLowerCase().startsWith('fe80')) continue;
      names.add(i.family === 'IPv6' ? `[${i.address.toLowerCase()}]` : i.address);
    }
  }
  const out: string[] = [];
  for (const n of names) {
    out.push(`${n}:${port}`);
    if (port === 80) out.push(n);
  }
  return out;
}
