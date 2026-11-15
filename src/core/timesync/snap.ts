import { lowerBound, upperBound } from '../series/series';

/**
 * Snap-to-edge (DESIGN §5.5): the crossing of a level between the window's min
 * and max that lies nearest the cursor. level = 0.5 gives the mid-rise of a
 * step (throttle, RPM); a lower level (0.25) finds the onset of a sound.
 * Returns null when the window is flat.
 */
export function snapEdge(t: Float64Array, v: Float64Array, cursor: number, halfWindow = 1.5, level = 0.5): number | null {
  const a = Math.max(0, lowerBound(t, cursor - halfWindow)), b = Math.min(t.length, upperBound(t, cursor + halfWindow));
  if (b - a < 3) return null;
  let min = Infinity, max = -Infinity;
  for (let i = a; i < b; i++) { const x = v[i]!; if (x < min) min = x; if (x > max) max = x; }
  if (!(max - min > 1e-9 * Math.max(1, Math.abs(max)))) return null;
  const th = min + level * (max - min);
  let best: number | null = null;
  for (let i = a + 1; i < b; i++) {
    const y0 = v[i - 1]! - th, y1 = v[i]! - th;
    if (y0 === y1 || (y0 > 0) === (y1 > 0) && y1 !== 0) continue;
    const tc = t[i - 1]! + ((t[i]! - t[i - 1]!) * (0 - y0)) / (y1 - y0);
    if (best === null || Math.abs(tc - cursor) < Math.abs(best - cursor)) best = tc;
  }
  return best;
}

/** Moving average over `n` samples (centred), for smoothing an RMS envelope. */
export function smooth(v: Float32Array | Float64Array, n: number): Float64Array {
  const out = new Float64Array(v.length);
  const h = Math.max(0, Math.floor(n / 2));
  let acc = 0, cnt = 0;
  for (let i = 0; i < Math.min(v.length, h); i++) { acc += v[i]!; cnt++; }
  for (let i = 0; i < v.length; i++) {
    const add = i + h, drop = i - h - 1;
    if (add < v.length) { acc += v[add]!; cnt++; }
    if (drop >= 0) { acc -= v[drop]!; cnt--; }
    out[i] = acc / cnt;
  }
  return out;
}
