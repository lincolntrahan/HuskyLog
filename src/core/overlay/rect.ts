/**
 * Normalized overlay rectangles (0–1 of the host window) and the drag/resize
 * maths for edit mode. Normalized, so overlays survive window resizes and
 * export resolutions (DESIGN §7.7).
 */
export interface NRect { x: number; y: number; w: number; h: number }
export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const MIN_SIZE = 0.03;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Applies a drag of (dx, dy) normalized units on a handle; keeps the rect inside 0–1. */
export function dragRect(r: NRect, h: Handle, dx: number, dy: number, min = MIN_SIZE): NRect {
  if (h === 'move') {
    return { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
  }
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  if (h.includes('w')) x0 = clamp(x0 + dx, 0, x1 - min);
  if (h.includes('e')) x1 = clamp(x1 + dx, x0 + min, 1);
  if (h.includes('n')) y0 = clamp(y0 + dy, 0, y1 - min);
  if (h.includes('s')) y1 = clamp(y1 + dy, y0 + min, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Normalized rect → pixel rect in a w×h host. */
export function toPx(r: NRect, w: number, h: number): NRect {
  return { x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h };
}

/** Snaps edges within `tol` of the host edges or the centre lines. */
export function snapRect(r: NRect, tol = 0.012): NRect {
  const s = (v: number, targets: number[]) => targets.find((t) => Math.abs(v - t) < tol) ?? v;
  let { x, y } = r;
  const xr = s(x + r.w, [1, 0.5]);
  x = s(x, [0, 0.5]);
  if (x === r.x && xr !== x + r.w) x = xr - r.w;
  const cx = s(x + r.w / 2, [0.5]);
  if (cx !== x + r.w / 2) x = cx - r.w / 2;
  const yb = s(y + r.h, [1, 0.5]);
  y = s(y, [0, 0.5]);
  if (y === r.y && yb !== y + r.h) y = yb - r.h;
  return { ...r, x: clamp(x, 0, 1 - r.w), y: clamp(y, 0, 1 - r.h) };
}
