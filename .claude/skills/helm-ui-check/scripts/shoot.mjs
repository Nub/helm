#!/usr/bin/env node
// Screenshot routes of a scratch Helm, logged in, at several device sizes, and audit each for phone layout problems.
//
//   node shoot.mjs [--name N] [--routes '#/,#/p/{project}/tasks'] [--devices phone,desktop] [--out DIR]
//                  [--full] [--theme dark|light] [--wait MS] [--no-audit] [--url URL --token T]
//
// {project} in a route is replaced by the first project's id. Prints one JSON line per shot:
// {"route", "device", "file", "errors", "audit"} and exits 1 if any page threw a script error.
import { join, resolve } from 'node:path';
import { launch, DEVICES } from './browser.mjs';
import { parseArgs, defaultName, readInstance, login } from './scratch.mjs';

const o = parseArgs(process.argv.slice(2));
let url = o.url, cookie;
let inst = null;
if (url) {
  url = String(url).replace(/\/?$/, '/');
  cookie = o.token ? await login(url, String(o.token)) : undefined;
} else {
  const name = String(o.name ?? defaultName());
  inst = readInstance(name);
  if (!inst) { console.error(`No scratch server "${name}". Start one: node scratch.mjs start`); process.exit(1); }
  url = inst.url;
  cookie = inst.cookie;
}
const out = resolve(String(o.out ?? (inst ? join(inst.dir, 'shots') : 'shots')));
const devices = String(o.devices ?? 'phone,desktop').split(',').map((s) => s.trim()).filter(Boolean);
for (const d of devices) if (!DEVICES[d]) { console.error(`Unknown device ${d}. Known: ${Object.keys(DEVICES).join(', ')}`); process.exit(2); }
let routes = String(o.routes ?? '#/').split(',').map((s) => s.trim()).filter(Boolean);
if (routes.some((r) => r.includes('{project}'))) {
  const r = await fetch(`${url}api/projects`, { headers: cookie ? { cookie } : {} });
  const id = r.ok ? (await r.json()).projects?.[0]?.id : null;
  if (!id) { console.error('A route uses {project} but the server has no project (start with --seed demo, or --copy-db)'); process.exit(1); }
  routes = routes.map((x) => x.replaceAll('{project}', id));
}

const slug = (s) => s.replace(/^#\/?/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_|_$/g, '') || 'home';
const browser = await launch();
let failed = false;
try {
  for (const device of devices) {
    const page = await browser.page({ device, base: url, cookie, theme: String(o.theme ?? 'dark') });
    for (const route of routes) {
      page.errors.length = 0;
      await page.go(route, { wait: Number(o.wait ?? 700) });
      const file = await page.shot(join(out, `${slug(route)}-${device}.png`), { full: Boolean(o.full) });
      const row = { route, device, file, errors: [...page.errors] };
      if (!o['no-audit']) row.audit = await page.audit();
      if (row.errors.length) failed = true;
      console.log(JSON.stringify(row));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
