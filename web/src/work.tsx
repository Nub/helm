import type { ProjectState } from './api';
import { DiscussionsPage } from './discussions';
import { needsResponse } from './needs';
import { TasksSection } from './tasks';
import { Chips, go } from './ui';

/**
 * Work: the project's tasks and discussions on one page, with a filter. The old Tasks and Discussions pages are
 * filters of it (their routes still land here); a task's or discussion's own page is unchanged.
 */
export type WorkFilter = 'all' | 'tasks' | 'discussions' | 'needs';

export function workFilter(tab: string, sub?: string): WorkFilter {
  if (tab === 'tasks') return sub === 'needs' ? 'needs' : 'tasks';
  if (tab === 'discussions') return 'discussions';
  return sub === 'tasks' || sub === 'discussions' || sub === 'needs' ? sub : 'all';
}

export function WorkPage({ s, filter, recent = false }: { s: ProjectState; filter: WorkFilter; recent?: boolean }) {
  const pid = s.project.id;
  const discussions = s.discussions.filter((d) => d.kind !== 'task');
  const needs = [...s.tasks, ...discussions].filter(needsResponse).length;
  return (
    <section className="work-page">
      <h1 className="sr-only">Work</h1>
      <div className="work-filter">
        <Chips
          value={filter}
          onChange={(f) => go('p', pid, 'work', f)}
          options={[
            { id: 'all', label: 'All' },
            { id: 'tasks', label: 'Tasks' },
            { id: 'discussions', label: 'Discussions' },
            { id: 'needs', label: 'Needs response', count: needs },
          ]}
        />
      </div>
      {(filter === 'all' || filter === 'tasks') && <TasksSection key={`t-${filter}-${recent}`} s={s} page initialSort={recent ? 'updated' : 'queue'} embedded />}
      {filter === 'needs' && <TasksSection key="needs" s={s} page initialSort="needs" embedded />}
      {(filter === 'all' || filter === 'discussions') && <DiscussionsPage s={s} embedded />}
    </section>
  );
}
