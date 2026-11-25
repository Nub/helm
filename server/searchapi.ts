import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { all } from './db.ts';
import { FIND_KINDS, matchLine, searchItems, searchWords } from './search.ts';
import { markedLine } from './rankedsearch.ts';
import { requestSearchRebuild, searchIndexStatus } from './searchindex.ts';
import type { FindKind } from './search.ts';

// The search on a project's Home: GET /api/search?q=…&project=<id> (that project) or &all=1 (every project not
// archived), optionally &kind=<kind> for one group in full ("Show all"). Behind the same sign-in as the rest of /api
// (the guard in api.ts). The matching and ranking are search.ts's, shared with the agents' find tool. A ranked hit's
// title_hl and line carry U+E000/U+E001 around what matched (FTS's highlight, so other forms of a word are marked too);
// word matching gives no title_hl and a plain line, which the page marks with `terms`.

/** Shown per group before "Show all". */
const PER_GROUP = 5;
/** At most this many of one kind are looked at; a group that reaches it says "100+". */
const CAP = 100;

export type SearchItem = { kind: FindKind; id: string; project_id: string; project?: string; title: string; title_hl?: string; state: string; ts: number; line: string; inTitle: number };
export type SearchGroup = { kind: FindKind; total: number; capped: boolean; items: SearchItem[] };

/** The last searches' times in this process (the Home search runs in the web service): the Helm page's p95. */
const recent: number[] = [];
export function liveSearchP95(): { p95: number; n: number } | null {
  if (recent.length < 5) return null;
  const s = [...recent].sort((a, b) => a - b);
  return { p95: s[Math.min(s.length - 1, Math.floor(0.95 * s.length))], n: s.length };
}
/** The measurement at ten times today's data (server/checks/searchbench.check.ts --write), if there is one. */
function benchResult(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./searchbench.json', import.meta.url)), 'utf8'));
  } catch {
    return null;
  }
}

export function searchView(q: string, projectId: string | null, kind?: FindKind): { terms: string[]; ms: number; groups: SearchGroup[] } {
  const t0 = performance.now();
  const terms = searchWords(q);
  const hits = searchItems(projectId, q, { kind, cap: CAP, mark: kind ? CAP : PER_GROUP });
  const names = projectId ? null : new Map(all('SELECT id, name FROM projects').map((p) => [p.id as string, p.name as string]));
  const groups: SearchGroup[] = [];
  for (const k of FIND_KINDS) {
    const of = hits.filter((h) => h.kind === k);
    if (!of.length) continue;
    const shown = kind ? of : of.slice(0, PER_GROUP);
    groups.push({
      kind: k,
      total: of.length,
      capped: of.length >= CAP,
      items: shown.map((h) => ({
        kind: h.kind,
        id: h.id,
        project_id: h.project_id,
        ...(names ? { project: names.get(h.project_id) ?? h.project_id } : {}),
        title: h.title,
        ...(h.hl ? { title_hl: h.hl.title } : {}),
        state: h.state,
        ts: h.ts,
        line: h.hl ? markedLine(h.hl.text) : matchLine(h.text, h.title, terms),
        inTitle: h.inTitle,
      })),
    });
  }
  const ms = Math.round(performance.now() - t0);
  if (terms.length) {
    recent.push(ms);
    if (recent.length > 200) recent.shift();
  }
  return { terms, ms, groups };
}

export function registerSearchApi(app: FastifyInstance) {
  // The full-text index behind ranked search (searchindex.ts): its state on the Helm page, and the maintenance action
  // that rebuilds it if it is ever suspect (searches use word matching until the rebuild is done).
  app.get('/api/search/index', async () => ({ ...searchIndexStatus(), speed: { live: liveSearchP95(), bench: benchResult() } }));
  app.post('/api/search/index/rebuild', async () => {
    requestSearchRebuild();
    return searchIndexStatus();
  });
  app.get('/api/search', async (req, reply) => {
    const qs = (req.query ?? {}) as Record<string, string | undefined>;
    const q = String(qs.q ?? '').slice(0, 200);
    const everywhere = qs.all === '1';
    const projectId = String(qs.project ?? '');
    if (!everywhere && !all('SELECT 1 FROM projects WHERE id = ?', projectId).length) return reply.code(404).send({ error: 'No such project' });
    const kind = FIND_KINDS.find((k) => k === qs.kind);
    return searchView(q, everywhere ? null : projectId, kind);
  });
}
