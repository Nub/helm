import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, ReactNode } from 'react';
import { api } from './api';
import type { Attachment } from './api';
import { Icon } from './ui';
import { clearDraft, patchDraft, readDraft, usableFiles } from './drafts';
import { closeViewer, openViewer } from './viewer';
import { AnnotateButton, FeedbackCard, openAnnotator, projectFromHash } from './annotate';

/**
 * Files the user attaches as references (server/attachments.ts): upload with progress, the pending tray of a
 * composer, how attachments render under a message, and the self-contained References block for a Spec entry,
 * task or discussion. Keyed only on the owner ("doc:<id>" or "task:<id>"), so it drops into any page.
 */

/** What the file picker offers. On iOS this gives Photo Library, Take Photo and Choose File. */
export const ACCEPT = 'image/*,video/*,audio/*,application/pdf,*/*';

export const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

let limits: Promise<{ fileBytes: number; files: number }> | null = null;
const getLimits = () => (limits ??= api<{ fileBytes: number; files: number }>('/api/attachments/limits').catch(() => ({ fileBytes: 50 * 1024 * 1024, files: 10 })));

/**
 * iPhone photos may be HEIC. Where the browser can decode it (Safari: iPhone, iPad, Mac) it is turned into a JPEG
 * here, so every browser can show it and agents can open it (Claude reads JPEG, PNG, GIF and WebP, not HEIC).
 * Where it cannot (Chrome, Firefox) it is uploaded as it is and shown as a download tile.
 */
export async function toJpegIfHeic(f: File): Promise<File> {
  const heic = /^image\/hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
  if (!heic) return f;
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) return f;
    return new File([blob], `${f.name.replace(/\.(heic|heif)$/i, '') || 'photo'}.jpg`, { type: 'image/jpeg' });
  } catch {
    return f;
  }
}

/** One request; `owner` makes the files references at once, without it they wait for the message they are sent with. */
export function uploadFiles(projectId: string, files: File[], owner: string | null, onProgress?: (fraction: number) => void): Promise<Attachment[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/attachments${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.attachments) return resolve(data.attachments);
      if (data?.error) return reject(new Error(data.error));
      // Not Helm's answer: the web proxy in front of it refused the body before Helm saw it.
      if (xhr.status === 413) return reject(new Error('Too large for the web proxy in front of Helm, which turned the upload away before it arrived. Upload it from the home network (Helm on port 8080), or try a smaller file.'));
      reject(new Error(`Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () =>
      reject(new Error('Upload failed: the connection was cut. If the file is large, the web proxy in front of Helm may have refused it; upload it from the home network (Helm on port 8080), or try a smaller file.'));
    xhr.send(form);
  });
}

// ---------- a composer's pending attachments ----------

export type Pending = { key: string; name: string; size: number; thumb: string | null; progress: number; att: Attachment | null; error: string };

let seq = 0;

/**
 * `owner`: "request:<id>" for files answering a request (the server takes them only while it is open).
 * `draftKey`: the place's draft (drafts.ts): files already uploaded are kept with the typed text and come back.
 */
export function useAttachDraft(projectId: string | undefined, owner: string | null = null, draftKey: string | null = null) {
  const [items, setItems] = useState<Pending[]>(() =>
    usableFiles(draftKey ? readDraft(draftKey) : null).map((att, i) => ({ key: `r${i}-${att.id}`, name: att.name, size: att.size, thumb: att.kind === 'image' ? att.url : null, progress: 1, att, error: '' })),
  );
  // What is uploaded is kept in the place's draft, so closing or reloading does not lose it.
  useEffect(() => {
    if (!draftKey) return;
    const ids = items.filter((i) => i.att).map((i) => i.att!.id);
    const stored = (readDraft(draftKey)?.files ?? []).map((a) => a.id);
    if (ids.join() !== stored.join()) patchDraft(draftKey, { files: items.filter((i) => i.att).map((i) => i.att!) });
  }, [items, draftKey]);
  const patch = (key: string, p: Partial<Pending>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i)));

  // Object URLs of thumbnails are released when they leave the tray.
  const thumbs = useRef(new Map<string, string>());
  useEffect(() => () => thumbs.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const add = async (raw: File[]) => {
    if (!projectId || !raw.length) return;
    const lim = await getLimits();
    for (const original of raw) {
      const key = `p${++seq}`;
      setItems((cur) => [...cur, { key, name: original.name || 'pasted image', size: original.size, thumb: null, progress: 0, att: null, error: '' }]);
      void (async () => {
        const f = await toJpegIfHeic(original);
        if (f.type.startsWith('image/') && !/hei[cf]/i.test(f.type)) {
          const u = URL.createObjectURL(f);
          thumbs.current.set(key, u);
          patch(key, { thumb: u, name: f.name || 'pasted image', size: f.size });
        }
        if (f.size > lim.fileBytes) return patch(key, { error: `Larger than the ${Math.round(lim.fileBytes / 1024 / 1024)} MB limit` });
        try {
          const [att] = await uploadFiles(projectId, [f], owner, (p) => patch(key, { progress: p }));
          patch(key, { att, progress: 1 });
        } catch (err: any) {
          patch(key, { error: err.message });
        }
      })();
    }
  };

  const drop = (key: string) => {
    const it = items.find((i) => i.key === key);
    if (it?.att) void api(`/api/attachments/${it.att.id}`, { method: 'DELETE' }).catch(() => {});
    const u = thumbs.current.get(key);
    if (u) URL.revokeObjectURL(u);
    thumbs.current.delete(key);
    setItems((cur) => cur.filter((i) => i.key !== key));
  };

  /** After sending: the files now belong to the message. */
  const clear = () => {
    thumbs.current.forEach((u) => URL.revokeObjectURL(u));
    thumbs.current.clear();
    setItems([]);
    // What was typed went with it: the place's draft is done.
    if (draftKey) clearDraft(draftKey);
  };

  const uploading = items.some((i) => !i.att && !i.error);
  const ready = items.filter((i) => i.att).map((i) => i.att!);
  return { items, add, drop, clear, uploading, ready, enabled: !!projectId };
}

export function AttachTray({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="att-tray" aria-label="Attachments to send">
      {items.map((i) => (
        <li key={i.key} className={`att-pending ${i.error ? 'failed' : ''}`} title={i.error || i.name}>
          {i.thumb ? <img src={i.thumb} alt="" /> : <span className="att-pending-file"><Icon name="file" size={20} /><span className="one-line">{i.name}</span></span>}
          {!i.att && !i.error && (
            <span className="att-progress" role="progressbar" aria-valuenow={Math.round(i.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.round(i.progress * 100)}%` }} />
            </span>
          )}
          {i.error && <span className="att-pending-error">{i.error}</span>}
          <button type="button" className="att-pending-remove" onClick={() => onRemove(i.key)} aria-label={`Remove ${i.name}`}>
            <Icon name="close" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export type AttachDraft = ReturnType<typeof useAttachDraft>;

/**
 * The paperclip (or, with `children`, a labelled button) that opens the picker and adds the chosen files to a draft.
 * Shared by the composer and the answer controls of requests.
 */
export function AttachButton({ draft, className = 'icon-btn', label = 'Attach files', children }: { draft: AttachDraft; className?: string; label?: string; children?: ReactNode }) {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => picker.current?.click()} aria-label={children ? undefined : label} title={label}>
        {children ?? <Icon name="clip" size={20} />}
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          void draft.add([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Props that make an element take dropped files into a draft, with `over` set while something is dragged over it. */
export function dropTarget(draft: AttachDraft, setOver: (v: boolean) => void) {
  return {
    onDragOver: (e: DragEvent) => {
      if (![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      void draft.add(filesFromDrop(e));
    },
  };
}

/** A paste handler for a text box: pasted images join the draft, pasted text stays text. */
export const pasteInto = (draft: AttachDraft) => (e: ClipboardEvent) => {
  const files = filesFromPaste(e);
  if (!files.length) return;
  e.preventDefault();
  void draft.add(files);
};

/** Files pasted or dropped: only real files, and from a paste only images (pasted text stays text). */
export function filesFromPaste(e: ClipboardEvent): File[] {
  return [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
}
export function filesFromDrop(e: DragEvent): File[] {
  return [...(e.dataTransfer?.files ?? [])];
}

// ---------- showing attachments ----------

/** action: an extra control under each image or file (Pin to top in a task's thread). */
export function AttachmentList({ items, onRemove, className = '', compactFeedback = false, action }: { items: Attachment[]; onRemove?: (a: Attachment) => void; className?: string; compactFeedback?: boolean; action?: (a: Attachment) => ReactNode }) {
  const setZoom = (i: number) =>
    openViewer(
      images.map((a) => ({
        src: a.url,
        label: a.name,
        actions: (
          <>
            <AnnotateButton onClick={() => (closeViewer(), openAnnotator({ projectId: a.project_id ?? projectFromHash(), source: { kind: 'attachment', id: a.id }, url: a.url, title: a.name }))} />
            <a className="icon-btn" href={a.url} target="_blank" rel="noopener" aria-label="Open the original" title="Open the original">
              <Icon name="external" />
            </a>
          </>
        ),
      })),
      i,
    );
  const [broken, setBroken] = useState<Set<string>>(new Set());
  if (!items.length) return null;
  // An image the browser cannot show (HEIC outside Safari) falls back to a download row.
  // Image feedback shows as one card (its marked-up PNG); the original sent beside it opens from that card.
  const feedback = items.filter((a) => a.annotation?.role === 'marked');
  const shown = items.filter((a) => !a.annotation || (a.annotation.role === 'original' && !feedback.some((f) => f.annotation!.id === a.annotation!.id)));
  const images = shown.filter((a) => a.kind === 'image' && !broken.has(a.id));
  const others = shown.filter((a) => !(a.kind === 'image' && !broken.has(a.id)));
  const remove = (a: Attachment) =>
    onRemove && a.removable !== false ? (
      <button type="button" className="icon-btn att-remove" onClick={() => onRemove(a)} aria-label={`Remove ${a.name}`} title="Remove">
        <Icon name="trash" size={16} />
      </button>
    ) : null;
  return (
    <div className={`att-list ${className}`}>
      {feedback.length > 0 &&
        (compactFeedback ? (
          // In References: every round of image feedback under one row, closed until asked for.
          <details className="ann-group">
            <summary>
              <Icon name="chevron" size={16} /> Feedback ({feedback.length})
            </summary>
            <div className="ann-cards compact">
              {feedback.map((a) => (
                <FeedbackCard key={a.id} att={a} compact />
              ))}
            </div>
          </details>
        ) : (
          <div className="ann-cards">
            {feedback.map((a) => (
              <FeedbackCard key={a.id} att={a} />
            ))}
          </div>
        ))}
      {images.length > 0 && (
        <div className={`att-images n${Math.min(images.length, 3)}`}>
          {images.map((a, i) => (
            <figure key={a.id} className="att-image">
              <button type="button" className="att-open" onClick={() => setZoom(i)} aria-label={`Open ${a.name}`}>
                <img src={a.url} alt={a.name} loading="lazy" onError={() => setBroken((b) => new Set(b).add(a.id))} />
              </button>
              {remove(a)}
              <AddedBy a={a} />
              {action?.(a)}
            </figure>
          ))}
        </div>
      )}
      {others.map((a) =>
        a.kind === 'video' ? (
          <figure key={a.id} className="att-media">
            <video src={a.url} controls preload="metadata" playsInline />
            <figcaption>
              <span className="one-line">{a.name}</span>
              <span className="muted">{sizeLabel(a.size)}</span>
              {remove(a)}
            </figcaption>
          </figure>
        ) : a.kind === 'audio' ? (
          <figure key={a.id} className="att-media att-audio">
            <figcaption>
              <span className="one-line">{a.name}</span>
              <span className="muted">{sizeLabel(a.size)}</span>
              {remove(a)}
            </figcaption>
            <audio src={a.url} controls preload="metadata" />
          </figure>
        ) : (
          <div key={a.id} className="att-file">
            <a href={a.kind === 'pdf' || a.kind === 'text' ? a.url : `${a.url}?download=1`} target={a.kind === 'pdf' || a.kind === 'text' ? '_blank' : undefined} rel="noopener" download={a.kind === 'pdf' || a.kind === 'text' ? undefined : a.name}>
              <span className={`att-file-icon ${a.kind}`}>{a.kind === 'pdf' ? 'PDF' : <Icon name={a.kind === 'text' ? 'file' : 'download'} size={20} />}</span>
              <span className="att-file-name one-line">{a.name}</span>
              <span className="muted small">{sizeLabel(a.size)}</span>
            </a>
            {remove(a)}
            <AddedBy a={a} />
            {action?.(a)}
          </div>
        ),
      )}
    </div>
  );
}

/** Who added a reference, when an agent did, and what it says it shows. */
function AddedBy({ a }: { a: Attachment }) {
  if (!a.added_by && !a.caption) return null;
  return (
    <figcaption className="att-added">
      {a.caption && <span>{a.caption}</span>}
      {a.added_by && <span className="muted small">Added by {a.added_by}</span>}
    </figcaption>
  );
}


/** Small paperclip and count, for collapsed Spec entries and task rows. */
export function ClipCount({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <span className="clip-count" title={`${n} ${n === 1 ? 'attachment' : 'attachments'}`} aria-label={`${n} ${n === 1 ? 'attachment' : 'attachments'}`}>
      <Icon name="clip" size={16} />
      {n}
    </span>
  );
}

// ---------- References: a Spec entry's, task's or discussion's own files ----------

/**
 * The references of one owner ("doc:<id>" or "task:<id>"), with add and remove. `version` is anything that changes
 * when they may have (the owner's attachment count): the list is fetched again then.
 */
export function References({ projectId, owner, version, title = 'References', hint }: { projectId: string; owner: string; version?: unknown; title?: string; hint?: string }) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = () =>
    api<{ attachments: Attachment[] }>(`/api/projects/${projectId}/attachments?owner=${encodeURIComponent(owner)}`)
      .then((r) => setItems(r.attachments))
      .catch((err) => setError(err.message));
  useEffect(() => {
    void load();
  }, [projectId, owner, version]);

  const add = async (raw: File[]) => {
    if (!raw.length) return;
    setError('');
    const lim = await getLimits();
    const files = await Promise.all(raw.map(toJpegIfHeic));
    const big = files.find((f) => f.size > lim.fileBytes);
    if (big) return setError(`${big.name} is larger than the ${Math.round(lim.fileBytes / 1024 / 1024)} MB limit.`);
    setProgress(0);
    try {
      // One file per request: the web proxy's body limit is one file's worth (nix/module.nix).
      for (let i = 0; i < files.length; i++) {
        await uploadFiles(projectId, [files[i]], owner, (p) => setProgress((i + p) / files.length));
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProgress(null);
      void load();
    }
  };
  const remove = async (a: Attachment) => {
    if (!confirm(`Remove ${a.name}?`)) return;
    try {
      await api(`/api/attachments/${a.id}`, { method: 'DELETE' });
      setItems((cur) => cur?.filter((x) => x.id !== a.id) ?? null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div
      className={`refs ${over ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void add(filesFromDrop(e));
      }}
    >
      <div className="refs-head">
        <span className="label">
          <Icon name="clip" size={16} /> {title}
          {items && items.length > 0 ? ` · ${items.length}` : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="btn small quiet" disabled={progress !== null} onClick={() => input.current?.click()}>
          <Icon name="plus" size={16} /> {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'Add'}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {progress !== null && (
        <span className="att-progress wide" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      {items && <AttachmentList items={items} onRemove={remove} compactFeedback />}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
