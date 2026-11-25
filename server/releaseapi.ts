import type { FastifyInstance, FastifyReply } from 'fastify';
import { getProject } from './store.ts';
import { createReadStream } from 'node:fs';
import { DEFAULT_DURATION, DURATIONS, createLink, createTestLink, linksView, releaseDownload, revokeLink, tarLength, tarStream } from './dllinks.ts';
import { askRebuild, buildView, getBuild, keepDays, listBuilds, removeBuildFiles } from './testbuilds.ts';
import { OFF_TEXT, getRelease, proposal, releaseView, releasesOn, releasesView, removeFiles, requestPublish, saveRecipe, setNotes, startRelease } from './releases.ts';
import type { RecipeInput } from './releases.ts';
import { applyRecipeProposal, declineRecipeProposal, getRecipeProposal, openProposal, recipeDiscussion, recipeProposalView, startTestBuild, testsView } from './recipework.ts';

/**
 * The Releases page (web/src/releases.tsx). Everything here is the user's own action: cutting a release, editing its
 * change log, asking to publish (which files the confirmation they answer), removing an old release's files.
 */
function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

export function registerReleaseApi(app: FastifyInstance) {
  app.get('/api/projects/:id/releases', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { ...releasesView(project.id), proposal: releasesOn(project.id) ? await proposal(project.id) : null, tests: testsView(project.id), recipe_proposal: openProposal(project.id) };
  });

  // ---------- the recipe (recipework.ts): the user's edit, the discussion, the director's proposals, test builds ----------

  const recipeInput = (b: Record<string, any>): RecipeInput => ({
    artifacts: Array.isArray(b.artifacts) ? b.artifacts : undefined,
    scheme: typeof b.scheme === 'string' ? b.scheme : undefined,
    publish: typeof b.publish === 'string' ? b.publish : undefined,
  });
  app.put('/api/projects/:id/release-recipe', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    if (!releasesOn(project.id)) return bad(reply, OFF_TEXT);
    const res = saveRecipe(project.id, recipeInput((req.body ?? {}) as Record<string, any>), 'the user');
    return 'error' in res ? bad(reply, res.error) : res;
  });
  /** Set this up with the director: the project's Release recipe discussion, for the chat to open on. */
  app.post('/api/projects/:id/release-recipe/discuss', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { discussion_id: recipeDiscussion(project.id).id };
  });
  app.get('/api/recipe-proposals/:id', async (req, reply) => {
    const p = getRecipeProposal((req.params as any).id);
    return p ? recipeProposalView(p) : bad(reply, 'No such proposal', 404);
  });
  app.post('/api/recipe-proposals/:id/apply', async (req, reply) => {
    const p = getRecipeProposal((req.params as any).id);
    if (!p) return bad(reply, 'No such proposal', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    const res = await applyRecipeProposal(p, b.recipe && typeof b.recipe === 'object' ? recipeInput(b.recipe) : undefined);
    return 'error' in res ? bad(reply, res.error, res.code) : res;
  });
  app.post('/api/recipe-proposals/:id/decline', async (req, reply) => {
    const p = getRecipeProposal((req.params as any).id);
    if (!p) return bad(reply, 'No such proposal', 404);
    const note = (req.body as any)?.note;
    const e = await declineRecipeProposal(p, typeof note === 'string' ? note : '');
    return e ? bad(reply, e.error, e.code) : { ok: true };
  });
  /** Test build: the user's tap only; an agent builds it and reports (recipework.ts). */
  app.post('/api/projects/:id/release-recipe/test', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const artifact = (req.body as any)?.artifact;
    if (typeof artifact !== 'string') return bad(reply, 'Say which artifact.');
    const res = await startTestBuild(project.id, artifact);
    return 'error' in res ? bad(reply, res.error) : { id: res.test.id, existing: !!res.existing };
  });

  /** Cut release: the user's button. Version and commit default to Helm's proposal. */
  app.post('/api/projects/:id/releases', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const res = await startRelease(project.id, { version: typeof b.version === 'string' ? b.version : undefined });
    return 'error' in res ? bad(reply, res.error) : releaseView(res.release);
  });

  app.put('/api/releases/:id/notes', async (req, reply) => {
    const r = getRelease((req.params as any).id);
    if (!r) return bad(reply, 'No such release', 404);
    const notes = (req.body as any)?.notes;
    if (typeof notes !== 'string') return bad(reply, 'notes is text.');
    const e = setNotes(r, notes);
    return e ? bad(reply, e) : releaseView(getRelease(r.id)!);
  });

  app.post('/api/releases/:id/publish', async (req, reply) => {
    const r = getRelease((req.params as any).id);
    if (!r) return bad(reply, 'No such release', 404);
    const res = requestPublish(r);
    return 'error' in res ? bad(reply, res.error) : res;
  });

  // Download on the release's page: through the signed-in session (the /api/ guard), no link made. One file by its
  // artifact id, or all of them as one tar (the same stream /dl/ uses), each under its real name.
  app.get('/api/releases/:id/download', async (req, reply) => {
    const artifact = (req.query as any)?.artifact;
    const got = releaseDownload((req.params as any).id, typeof artifact === 'string' && artifact ? artifact : null);
    if (!got) return bad(reply, 'Nothing to download: the release is not ready, or its files were removed.', 404);
    const one = typeof artifact === 'string' && artifact;
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${got.name.replace(/["\\\r\n]/g, '_')}"`)
      .header('content-length', String(one ? got.files[0].bytes : tarLength(got.files)));
    return reply.send(one ? createReadStream(got.files[0].path) : tarStream(got.files));
  });

  // Expiring download links (dllinks.ts): only the user makes or revokes one, here, behind the session; anyone with a
  // link downloads it from /dl/<token> without signing in. The token is in this answer only.
  app.get('/api/releases/:id/links', async (req, reply) => {
    const r = getRelease((req.params as any).id);
    if (!r) return bad(reply, 'No such release', 404);
    return { links: linksView(r.id), durations: Object.keys(DURATIONS), default: DEFAULT_DURATION };
  });
  app.post('/api/releases/:id/links', async (req, reply) => {
    const r = getRelease((req.params as any).id);
    if (!r) return bad(reply, 'No such release', 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const res = createLink(r.id, typeof b.artifact === 'string' ? b.artifact : null, typeof b.duration === 'string' ? b.duration : DEFAULT_DURATION);
    if ('error' in res) return bad(reply, res.error);
    return { path: `/dl/${res.token}`, id: res.link.id, expires_at: res.link.expires_at };
  });
  app.delete('/api/links/:id', async (req, reply) => {
    const err = revokeLink((req.params as any).id);
    return err ? bad(reply, err, 404) : { ok: true };
  });

  // ---------- test builds (testbuilds.ts): the user lists, downloads, links, deletes and rebuilds them ----------

  app.get('/api/projects/:id/test-builds', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { builds: listBuilds(project.id), keep_days: keepDays(project.id) };
  });
  app.get('/api/test-builds/:id', async (req, reply) => {
    const b = getBuild((req.params as any).id);
    return b ? buildView(b) : bad(reply, 'No such test build', 404);
  });
  app.delete('/api/test-builds/:id/files', async (req, reply) => {
    const b = getBuild((req.params as any).id);
    if (!b) return bad(reply, 'No such test build', 404);
    return { removed: removeBuildFiles(b, 'deleted by you') };
  });
  app.post('/api/test-builds/:id/rebuild', async (req, reply) => {
    const b = getBuild((req.params as any).id);
    if (!b) return bad(reply, 'No such test build', 404);
    const e = await askRebuild(b);
    return e ? bad(reply, e) : { ok: true };
  });
  app.get('/api/test-builds/:id/links', async (req, reply) => {
    const b = getBuild((req.params as any).id);
    if (!b) return bad(reply, 'No such test build', 404);
    return { links: linksView(b.id), durations: Object.keys(DURATIONS), default: DEFAULT_DURATION };
  });
  app.post('/api/test-builds/:id/links', async (req, reply) => {
    const b = getBuild((req.params as any).id);
    if (!b) return bad(reply, 'No such test build', 404);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const res = createTestLink(b.id, String(body.file ?? ''), typeof body.duration === 'string' ? body.duration : DEFAULT_DURATION);
    if ('error' in res) return bad(reply, res.error);
    return { path: `/dl/${res.token}`, id: res.link.id, expires_at: res.link.expires_at };
  });

  /** From the Disk page: an old release's files go; its record and change log stay. */
  app.delete('/api/releases/:id/files', async (req, reply) => {
    const r = getRelease((req.params as any).id);
    if (!r) return bad(reply, 'No such release', 404);
    if (['drafting', 'building'].includes(r.state)) return bad(reply, 'This release is still being made.');
    return { removed: removeFiles(r) };
  });
}
