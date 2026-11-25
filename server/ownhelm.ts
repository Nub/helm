import { realpathSync } from 'node:fs';

/**
 * Helm's own project: the one whose folder is the live-update repository (HELM_LIVE_UPDATE_REPO, as liveupdate.ts
 * reads it). Read on every call, from the environment only, so settings.ts can use it without the live-update module.
 */
export function isOwnHelm(path: string | null | undefined): boolean {
  const repo = process.env.HELM_LIVE_UPDATE_REPO ?? '';
  if (!repo || !path) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p.replace(/\/+$/, '');
    }
  };
  return real(repo) === real(path);
}

/** The branch an update of Helm builds (HELM_LIVE_UPDATE_REF, default release). */
export const liveRef = () => process.env.HELM_LIVE_UPDATE_REF || 'release';
