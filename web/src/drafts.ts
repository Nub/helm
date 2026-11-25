import { useCallback, useState, useSyncExternalStore } from 'react';
import type { Attachment } from './api';

/**
 * Drafts: what the user has typed and not sent is kept on this device, per place (a task's thread, a request, a
 * project's chat, a form), so closing a sheet, leaving the page or reloading loses nothing. It is cleared when the
 * message is sent or the box is emptied; a draft untouched for 14 days is dropped. Local storage only: never sent.
 *
 * A draft is its text, the files already uploaded for it, and `extra` (what a place needs to come back as it was: the
 * chat's context). `extra` alone is not a draft.
 */

const PREFIX = 'helm-draft:';
export const DRAFT_DAYS = 14;
const TTL = DRAFT_DAYS * 24 * 3600 * 1000;
/** Uploads never sent are swept by the server after a day (server/attachments.ts): older files are not restored. */
const FILE_TTL = 20 * 3600 * 1000;

export type Draft = { text: string; files: Attachment[]; extra?: unknown; at: number };
type Stored = Partial<Draft>;

const hasContent = (d: Stored | null | undefined) => !!d && (!!d.text?.trim() || !!d.files?.length);
const store = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') addEventListener('storage', (e) => e.key?.startsWith(PREFIX) && changed());

function parse(raw: string | null): Draft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Stored;
    if (typeof d?.at !== 'number' || Date.now() - d.at > TTL) return null;
    return { text: typeof d.text === 'string' ? d.text : '', files: Array.isArray(d.files) ? d.files : [], extra: d.extra, at: d.at };
  } catch {
    return null;
  }
}

/** The stored draft for a place, or null (a stale or empty one is removed). */
export function readDraft(key: string): Draft | null {
  const s = store();
  const raw = s?.getItem(PREFIX + key) ?? null;
  const d = parse(raw);
  if (raw && (!d || (!hasContent(d) && Date.now() - d.at > 3600_000))) s?.removeItem(PREFIX + key);
  return d && hasContent(d) ? d : null;
}

/** The files of a draft that can still be sent. */
export const usableFiles = (d: Draft | null) => (d?.files ?? []).filter((a) => Date.now() - (a.created_at ?? 0) < FILE_TTL);

/** Change part of a place's draft. A draft with no text and no files is removed (only `extra` is not kept alone). */
export function patchDraft(key: string, patch: Partial<Pick<Draft, 'text' | 'files' | 'extra'>>) {
  const s = store();
  if (!s) return;
  const cur = parse(s.getItem(PREFIX + key)) ?? { text: '', files: [], extra: undefined, at: Date.now() };
  const next: Stored = { ...cur, ...patch };
  try {
    if (hasContent(next)) {
      // Only a change of the words or files renews it: re-writing the context of an old draft does not.
      const renew = patch.text !== undefined || patch.files !== undefined;
      s.setItem(PREFIX + key, JSON.stringify({ ...next, at: renew ? Date.now() : cur.at }));
    } else if (patch.extra !== undefined && patch.text === undefined && patch.files === undefined) {
      // The place's context, waiting for words: not a draft yet, and dropped by the next read after an hour.
      s.setItem(PREFIX + key, JSON.stringify({ ...next, at: cur.at }));
    } else s.removeItem(PREFIX + key);
  } catch {
    // Storage full or blocked: the box still works, it just does not keep.
  }
  changed();
}

export function clearDraft(key: string) {
  store()?.removeItem(PREFIX + key);
  changed();
}

/** At load: drafts untouched for 14 days are dropped, whatever place they were for. */
function sweep() {
  const s = store();
  if (!s) return;
  try {
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX) && !parse(s.getItem(k))) s.removeItem(k);
    }
  } catch {
    // Nothing to sweep.
  }
}
if (typeof window !== 'undefined') sweep();

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** The draft of a place as it changes (null: none), for showing that one is waiting. */
export function useDraft(key: string | null): Draft | null {
  const raw = useSyncExternalStore(subscribe, () => (key ? store()?.getItem(PREFIX + key) ?? '' : ''), () => '');
  return key && raw ? (() => { const d = parse(raw); return d && hasContent(d) ? d : null; })() : null;
}

/** The first words of a draft, for "Draft: …". */
export function draftGist(d: Draft | null, n = 40): string {
  const t = (d?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return d?.files.length ? `${d.files.length} attached` : '';
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

/**
 * A text box that keeps what is typed: like useState(''), restored from this place's draft and written back on every
 * change (emptying it removes the draft). `key` null: a plain state (nowhere to keep it).
 */
export function useStoredText(key: string | null, initial = ''): [string, (v: string) => void] {
  const [text, setText] = useState(() => (key ? readDraft(key)?.text : undefined) ?? initial);
  const set = useCallback(
    (v: string) => {
      setText(v);
      if (key) patchDraft(key, { text: v });
    },
    [key],
  );
  return [text, set];
}

/**
 * A form of several fields kept as one draft: restored from this place's draft, written back on every change, removed
 * when it holds nothing but the starting values or `clear()` is called (after it was sent).
 */
export function useStoredForm<T extends Record<string, unknown>>(key: string | null, initial: T): [T, (v: T) => void, () => void] {
  const [form, setForm] = useState<T>(() => {
    const d = key ? readDraft(key) : null;
    if (!d) return initial;
    try {
      return { ...initial, ...(JSON.parse(d.text) as Partial<T>) };
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setForm(v);
      if (!key) return;
      // The words of every text field, anything else stays as the starting values.
      const typed = Object.keys(v).some((k) => typeof v[k] === 'string' && (v[k] as string).trim() && v[k] !== initial[k]);
      if (typed) patchDraft(key, { text: JSON.stringify(v) });
      else clearDraft(key);
    },
    [key],
  );
  return [form, set, () => key && clearDraft(key)];
}
