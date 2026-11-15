import { lowerBound, medianDt, upperBound, type Series } from './series';

/**
 * Builds uPlot "aligned" data for several series over [x0, x1] at a given pixel
 * width. When a series has more samples than pixels, it is reduced to min/max
 * per pixel column (spikes are never hidden; LTTB would smooth them away).
 * Gaps longer than 5× a series' median period are broken with null.
 */
export function buildAligned(series: Series[], x0: number, x1: number, width: number): (number | null)[][] {
  const cols = Math.max(16, Math.floor(width));
  const dx = (x1 - x0) / cols;
  const visible = series.map((s) => {
    const a = Math.max(0, lowerBound(s.t, x0) - 1);
    const b = Math.min(s.t.length, upperBound(s.t, x1) + 1);
    return { s, a, b, gap: 5 * medianDt(s.t) || Infinity };
  });
  const dense = visible.some((v) => v.b - v.a > cols * 2);

  if (!dense) {
    // Raw points: union of visible timestamps (small), each series sampled exactly.
    const xs = new Set<number>();
    for (const v of visible) {
      for (let i = v.a; i < v.b; i++) {
        xs.add(v.s.t[i]!);
        // A point inside each real gap stays null, so uPlot breaks the line there.
        if (i > v.a && v.s.t[i]! - v.s.t[i - 1]! > v.gap) xs.add((v.s.t[i]! + v.s.t[i - 1]!) / 2);
      }
    }
    const x = Float64Array.from(xs).sort();
    const out: (number | null)[][] = [Array.from(x)];
    const xa = Array.from(x);
    for (const v of visible) {
      const y: (number | null)[] = new Array(x.length).fill(null);
      let j = 0;
      for (let i = v.a; i < v.b; i++) {
        const t = v.s.t[i]!;
        while (x[j]! < t) j++;
        y[j] = Number.isNaN(v.s.v[i]!) ? null : v.s.v[i]!;
      }
      // Other series' timestamps leave holes; bridge those, keep real gaps.
      fillShortGaps(y, xa, v.gap);
      out.push(y);
    }
    return out;
  }

  // Min/max per column on a shared grid: two slots per column.
  const x: number[] = new Array(cols * 2);
  for (let c = 0; c < cols; c++) { x[2 * c] = x0 + (c + 0.25) * dx; x[2 * c + 1] = x0 + (c + 0.75) * dx; }
  const out: (number | null)[][] = [x];
  for (const v of visible) {
    const y: (number | null)[] = new Array(cols * 2).fill(null);
    const sparse = v.gap > dx; // series coarser than a column: keep points, skip empties
    let i = v.a;
    for (let c = 0; c < cols; c++) {
      const cEnd = x0 + (c + 1) * dx;
      let mn = Infinity, mx = -Infinity, tmn = 0, tmx = 0;
      while (i < v.b && v.s.t[i]! < cEnd) {
        const t = v.s.t[i]!, val = v.s.v[i]!;
        if (t >= x0 + c * dx && !Number.isNaN(val)) {
          if (val < mn) { mn = val; tmn = t; }
          if (val > mx) { mx = val; tmx = t; }
        }
        i++;
      }
      if (mn === Infinity) continue;
      // Keep time order of the extremes inside the column.
      const [first, second] = tmn <= tmx ? [mn, mx] : [mx, mn];
      y[2 * c] = first;
      y[2 * c + 1] = second;
    }
    if (sparse) {
      // Columns without samples are not gaps unless the real gap is long.
      fillShortGaps(y, x, v.gap);
    }
    out.push(y);
  }
  return out;
}

/** Linear fill of null runs shorter than maxGap (seconds), so sparse series draw as lines. */
function fillShortGaps(y: (number | null)[], x: number[], maxGap: number) {
  let last = -1;
  for (let k = 0; k < y.length; k++) {
    if (y[k] === null) continue;
    if (last >= 0 && k - last > 1 && x[k]! - x[last]! <= maxGap) {
      const y0 = y[last]!, y1 = y[k]!;
      for (let m = last + 1; m < k; m++) y[m] = y0 + ((y1 - y0) * (x[m]! - x[last]!)) / (x[k]! - x[last]!);
    }
    last = k;
  }
}
