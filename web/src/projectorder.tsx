import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from './api';
import { useDragReorder } from './drag';

/**
 * The project list in the user's own order. Activity never moves a project: the server lists them by a
 * position only the user changes, here by dragging (the grip, or press and hold on touch) or, from the
 * keyboard, the arrow keys on the grip.
 */
export function ProjectReorder<T extends { id: string; name: string }>({
  items,
  gap,
  className,
  disabled,
  render,
}: {
  items: T[];
  /** The space between rows in px, so the rows that make room move by exactly one slot. */
  gap: number;
  className: string;
  /** Show the list as it is, without grips (where another list does the reordering). */
  disabled?: boolean;
  render: (p: T, handle: ReactNode, dragging: boolean) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The order just chosen, shown until the server's list catches up.
  const [mine, setMine] = useState<string[] | null>(null);
  const serverKey = items.map((p) => p.id).join(',');
  useEffect(() => setMine(null), [serverKey]);
  const byId = new Map(items.map((p) => [p.id, p]));
  const ordered = mine ? [...mine.map((id) => byId.get(id)).filter((p): p is T => !!p), ...items.filter((p) => !mine.includes(p.id))] : items;
  const ids = ordered.map((p) => p.id);

  const save = (id: string, to: number) => {
    const next = ids.filter((x) => x !== id);
    next.splice(to, 0, id);
    setMine(next);
    void api('/api/projects/order', { body: { ids: next } }).catch(() => setMine(null));
  };

  const toRef = useRef<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const { drag, gripProps, rowProps } = useDragReorder({
    // Where the dragged row would land: the number of other rows whose middle is above the pointer.
    onMove: (id, y) => {
      const rows = [...(box.current?.children ?? [])] as HTMLElement[];
      toRef.current = rows.filter((r, i) => ids[i] !== id && r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2 < y).length;
      setTo(toRef.current);
    },
    onDrop: (id) => {
      const dest = toRef.current;
      toRef.current = null;
      setTo(null);
      if (dest !== null && dest !== ids.indexOf(id)) save(id, dest);
    },
  });
  const from = drag ? ids.indexOf(drag.id) : -1;

  return (
    <div className={`${className} ${disabled ? '' : 'reorder'} ${drag ? 'is-dragging' : ''}`} ref={box}>
      {ordered.map((p, i) => {
        if (disabled) return <div key={p.id}>{render(p, null, false)}</div>;
        const shift = drag && to !== null && drag.id !== p.id ? (from < i && i <= to ? -1 : to <= i && i < from ? 1 : 0) : 0;
        const handle = (
          <button
            className="drag-handle project-grip"
            aria-label={`Move ${p.name}: drag, or use the arrow keys`}
            title="Drag to reorder"
            {...gripProps(p.id)}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
              if (!d) return;
              e.preventDefault();
              if (i + d >= 0 && i + d < ids.length) save(p.id, i + d);
            }}
          >
            <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
              {[4, 10, 16].map((y) => [5, 11].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />))}
            </svg>
          </button>
        );
        return (
          <div
            key={p.id}
            className={`reorder-item ${drag?.id === p.id ? 'project-dragging' : ''}`}
            {...rowProps(p.id)}
            style={{ transform: drag?.id === p.id ? `translateY(${drag.dy}px)` : shift ? `translateY(calc(${shift} * (100% + ${gap}px)))` : undefined }}
          >
            {render(p, handle, drag?.id === p.id)}
          </div>
        );
      })}
    </div>
  );
}
