/**
 * Digital zoom/crop of a video window. The visible part of the frame is the
 * normalized rect [x, x + 1/s] × [y, y + 1/s]; export (Phase 7) crops the
 * same rect, so what you frame is what exports.
 */
export interface VideoZoom { s: number; x: number; y: number }

export const NO_ZOOM: VideoZoom = { s: 1, x: 0, y: 0 };
export const MAX_ZOOM = 8;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const fit = (z: VideoZoom): VideoZoom => {
  const s = clamp(z.s, 1, MAX_ZOOM);
  return { s, x: clamp(z.x, 0, 1 - 1 / s), y: clamp(z.y, 0, 1 - 1 / s) };
};

/** Zooms by `factor` keeping the frame point under (cx, cy) (0–1 of the view) fixed. */
export function zoomAt(z: VideoZoom, cx: number, cy: number, factor: number): VideoZoom {
  const px = z.x + cx / z.s, py = z.y + cy / z.s;   // frame point under the cursor
  const s = clamp(z.s * factor, 1, MAX_ZOOM);
  return fit({ s, x: px - cx / s, y: py - cy / s });
}

/** Pans by (dx, dy) in view units (1 = one view width). */
export function panBy(z: VideoZoom, dx: number, dy: number): VideoZoom {
  return fit({ s: z.s, x: z.x + dx / z.s, y: z.y + dy / z.s });
}

/** Source crop rect in frame pixels for a w×h frame. */
export function cropRect(z: VideoZoom, w: number, h: number): { x: number; y: number; w: number; h: number } {
  return { x: z.x * w, y: z.y * h, w: w / z.s, h: h / z.s };
}

/** CSS transform for a full-size element with transform-origin 0 0. */
export const zoomTransform = (z: VideoZoom): string | undefined =>
  z.s === 1 ? undefined : `translate(${-z.x * z.s * 100}%, ${-z.y * z.s * 100}%) scale(${z.s})`;
