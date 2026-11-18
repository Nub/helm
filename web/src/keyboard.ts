import { useEffect } from 'react';

/**
 * While the phone's on-screen keyboard is up, publish it to CSS so docked things stay usable:
 * - `html.kb-open`: the bottom tab bar hides (it would sit just above the keyboard, over any composer docked there,
 *   and is no use while typing);
 * - `--vvh`: the visible height, for panels sized to the screen;
 * - `--chrome-bottom: 0px`: the hidden tab bar no longer takes room;
 * - `--kb`: how far the keyboard's top edge is above the layout viewport's bottom, for things docked at the bottom
 *   (fixed or sticky) to sit just above it. It is measured from the visual viewport including how far iOS has panned
 *   it (offsetTop), so it is 0 when iOS has already scrolled the docked field into view and never counts twice.
 * Mounted once by the app shell.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const html = document.documentElement;
    const root = html.style;
    const clear = () => {
      html.classList.remove('kb-open');
      root.removeProperty('--vvh');
      root.removeProperty('--kb');
      root.removeProperty('--chrome-bottom');
    };
    const update = () => {
      // Pinch zoom also shrinks the visual viewport; only an unzoomed one that lost 120 px or more is the keyboard.
      if (vv.scale < 1.05 && vv.height < window.innerHeight - 120) {
        html.classList.add('kb-open');
        root.setProperty('--vvh', `${Math.round(vv.height)}px`);
        root.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.offsetTop - vv.height))}px`);
        root.setProperty('--chrome-bottom', '0px');
      } else clear();
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      clear();
    };
  }, []);
}
