import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';

/**
 * A named export of a page module, loaded on first use (its own chunk, so the first load is smaller). `fallback` shows
 * only while the chunk loads for the first time; prefetchPages fetches the chunks once the app is idle, so switching to
 * one of these pages is instant after that.
 */
export function lazyNamed<P extends object>(load: () => Promise<Record<string, unknown>>, key: string, fallback: ReactNode = null): ComponentType<P> {
  const C = lazy(async () => ({ default: (await load())[key] as ComponentType<P> }));
  return function Lazy(props: P) {
    return (
      <Suspense fallback={fallback}>
        <C {...props} />
      </Suspense>
    );
  };
}

export const loadTelemetry = () => import('./telemetry');
export const loadToolbox = () => import('./toolbox');
export const loadReleases = () => import('./releases');
export const loadReports = () => import('./reports');
export const loadDashboards = () => import('./dashboards');
export const loadIdeas = () => import('./ideas');
export const loadWatches = () => import('./watches');

/** Once the first page has painted and the app is idle: fetch the lazy pages' chunks, so later switches are instant. */
export function prefetchPages() {
  const go = () => [loadDashboards, loadReports, loadReleases, loadTelemetry, loadToolbox, loadWatches].forEach((l) => void l().catch(() => {}));
  const idle = (window as unknown as { requestIdleCallback?: (fn: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}
