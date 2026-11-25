import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useLive } from './api';
import type { ProjectSummary } from './api';
import { Fold, jumpTo } from './fold';
import { PageHeader } from './ui';
import { HostsPage } from './hosts';
import { AccountsList } from './accounts';
import { DiskPage } from './disk';
import { lastProject } from './switcher';
import { lazyNamed, loadTelemetry, loadToolbox, loadWatches } from './lazy';
import { toolboxRefresh } from './toolboxsignal';

const Loading = <div className="loading">Loading…</div>;
const TelemetryPage = lazyNamed<object>(loadTelemetry, 'TelemetryPage', Loading);
const ToolboxPage = lazyNamed<object>(loadToolbox, 'ToolboxPage', Loading);
const WatchesPage = lazyNamed<{ pid: string }>(loadWatches, 'WatchesPage', Loading);

/** The System page's sections, in order; `#/system/<id>` opens one and scrolls to it. */
export const SYSTEM_SECTIONS = ['telemetry', 'hosts', 'disk', 'accounts', 'tools', 'watches'] as const;

/**
 * System (#/system): the install-wide pages as collapsible sections of one page. Each section is the old page as it
 * was (its own heading hidden: the section's title is it). Watches are a project's: the one in the link, else the last
 * project opened, else the first.
 */
export function SystemPage({ section, project }: { section?: string; project?: string }) {
  const { data } = useLive<{ projects: ProjectSummary[] }>('/api/projects', (m) => m.type === 'projects');
  const list = (data?.projects ?? []).filter((p) => !p.archived);
  const pid = [project, lastProject()].find((id) => id && list.some((p) => p.id === id)) ?? list[0]?.id;
  const name = list.find((p) => p.id === pid)?.name;
  useEffect(() => {
    if (section && (SYSTEM_SECTIONS as readonly string[]).includes(section)) jumpTo(`#system-${section}`, { fold: `system-${section}` });
  }, [section]);
  // Tools is the old Toolbox: install-wide, with a count of what waits for the user.
  const tools = useLive<{ proposed: number }>('/api/toolbox/count', toolboxRefresh).data?.proposed ?? 0;
  const part = (id: string, title: ReactNode, body: ReactNode, open = false) => (
    <div id={`system-${id}`} className="system-section">
      <Fold kind={`system-${id}`} title={title} openByDefault={open} className="flat-fold">
        {body}
      </Fold>
    </div>
  );
  return (
    <section className="system-page">
      <PageHeader title="System" />
      {part('telemetry', 'Telemetry', <TelemetryPage />, true)}
      {part('hosts', 'Hosts', <HostsPage />)}
      {part('disk', 'Disk', <DiskPage />)}
      {part('accounts', 'Claude accounts', <AccountsList />)}
      {part('tools', tools > 0 ? `Tools · ${tools} proposed` : 'Tools', <ToolboxPage />)}
      {pid && part('watches', name ? `Watches · ${name}` : 'Watches', <WatchesPage key={pid} pid={pid} />)}
    </section>
  );
}
