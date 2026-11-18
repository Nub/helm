/**
 * Zoom and pan arithmetic shared by the image viewer (viewer.tsx) and the annotation editor (annotate.tsx).
 * A view draws content of natural size W×H at scale k with its top-left corner at (px, py) in stage coordinates.
 */
export type View = { k: number; px: number; py: number };
export type Box = { w: number; h: number };

/**
 * Keeps a view within bounds: the scale within [minK, maxK]; content smaller than the stage is centred on that axis;
 * larger content may leave at most `slack` of empty stage at either edge (0: the image always covers the stage;
 * half the stage: an edge may come to the middle, as the editor allows so a corner can be drawn on comfortably).
 */
export function clampView(v: View, W: number, H: number, stage: Box, minK: number, maxK: number, slack: Box = { w: 0, h: 0 }): View {
  const k = Math.min(maxK, Math.max(minK, v.k));
  const w = W * k;
  const h = H * k;
  const px = Math.min(slack.w, Math.max(stage.w - slack.w - w, v.px));
  const py = Math.min(slack.h, Math.max(stage.h - slack.h - h, v.py));
  return { k, px: w <= stage.w ? (stage.w - w) / 2 : px, py: h <= stage.h ? (stage.h - h) / 2 : py };
}

/** The view at scale k that keeps the stage point (sx, sy) over the same spot of the content. */
export function zoomAround(v: View, k: number, sx: number, sy: number): View {
  return { k, px: sx - (sx - v.px) * (k / v.k), py: sy - (sy - v.py) * (k / v.k) };
}

/** Where a pinch began: the view then, the midpoint of the two fingers and their distance. */
export type PinchStart = { k0: number; p0x: number; p0y: number; m0x: number; m0y: number; d0: number };

export function pinchStart(v: View, a: { x: number; y: number }, b: { x: number; y: number }): PinchStart {
  return { k0: v.k, p0x: v.px, p0y: v.py, m0x: (a.x + b.x) / 2, m0y: (a.y + b.y) / 2, d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)) };
}

/** The view now that the fingers are at a and b: scaled by how far they spread, moved with their midpoint. */
export function pinchView(g: PinchStart, a: { x: number; y: number }, b: { x: number; y: number }, minK: number, maxK: number): View {
  const k = Math.min(maxK, Math.max(minK, (g.k0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0));
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return { k, px: mx - (g.m0x - g.p0x) * (k / g.k0), py: my - (g.m0y - g.p0y) * (k / g.k0) };
}
