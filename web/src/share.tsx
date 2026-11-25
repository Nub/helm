import { useState } from 'react';
import { Icon } from './ui';

/** Copies text; falls back to a hidden textarea where the clipboard API needs a secure context (plain http on the LAN). */
export async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    // Not copied.
  }
  area.remove();
  return ok;
}

/** The address of a route made by `href(...)`, as a full link that lands on the item. */
export const shareUrl = (route: string) => `${location.origin}${location.pathname}${route}`;

/** A share icon for a card: the phone's share sheet where there is one, else copies the link ("Copied" for a moment). */
export function ShareButton({ route, title, className = '' }: { route: string; title: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const share = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const url = shareUrl(route);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    if (await copy(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <button type="button" className={`icon-btn share ${copied ? 'on' : ''} ${className}`} onClick={share} aria-label={copied ? 'Link copied' : `Share ${title}`} title={copied ? 'Copied' : 'Share'}>
      <Icon name={copied ? 'check' : 'share'} size={16} />
    </button>
  );
}
