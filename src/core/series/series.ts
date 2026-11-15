/** Numeric helpers over (time, value) typed-array series. Time is seconds, ascending. */

export interface Series { t: Float64Array; v: Float64Array }

/** First index with t[i] >= x. */
export function lowerBound(t: Float64Array, x: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m]! < x) lo = m + 1; else hi = m;
  }
  return lo;
}

/** First index with t[i] > x. */
export function upperBound(t: Float64Array, x: number): number {
  let lo = 0, hi = t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (t[m]! <= x) lo = m + 1; else hi = m;
  }
  return lo;
}

export interface RangeStats {
  n: number; mean: number; std: number; min: number; max: number; tMin: number; tMax: number;
}

/** Stats over samples with t0 <= t <= t1 (NaN values ignored). std is the sample std dev. */
export function rangeStats(s: Series, t0: number, t1: number): RangeStats {
  const a = lowerBound(s.t, t0), b = upperBound(s.t, t1);
  let n = 0, mean = 0, m2 = 0, min = Infinity, max = -Infinity, tMin = NaN, tMax = NaN;
  for (let i = a; i < b; i++) {
    const x = s.v[i]!;
    if (Number.isNaN(x)) continue;
    n++;
    const d = x - mean; // Welford: numerically stable
    mean += d / n;
    m2 += d * (x - mean);
    if (x < min) { min = x; tMin = s.t[i]!; }
    if (x > max) { max = x; tMax = s.t[i]!; }
  }
  return n === 0
    ? { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN, tMin: NaN, tMax: NaN }
    : { n, mean, std: n > 1 ? Math.sqrt(m2 / (n - 1)) : 0, min, max, tMin, tMax };
}

/** Median sample interval (robust "nominal period"); 0 for < 2 samples. */
export function medianDt(t: Float64Array): number {
  if (t.length < 2) return 0;
  const step = Math.max(1, Math.floor((t.length - 1) / 2000));
  const d: number[] = [];
  for (let i = step; i < t.length; i += step) d.push((t[i]! - t[i - step]!) / step);
  d.sort((a, b) => a - b);
  return d[d.length >> 1]!;
}

/** Linear interpolation at tq. NaN outside the series or across a gap larger than maxGap. */
export function interpAt(s: Series, tq: number, maxGap = Infinity): number {
  const n = s.t.length;
  if (n === 0 || tq < s.t[0]! || tq > s.t[n - 1]!) return NaN;
  const i = lowerBound(s.t, tq);
  if (s.t[i] === tq) return s.v[i]!;
  const t0 = s.t[i - 1]!, t1 = s.t[i]!;
  if (t1 - t0 > maxGap) return NaN;
  return s.v[i - 1]! + ((s.v[i]! - s.v[i - 1]!) * (tq - t0)) / (t1 - t0);
}

/** Last sample at or before tq (sample-and-hold). */
export function holdAt(s: Series, tq: number): number {
  const i = upperBound(s.t, tq) - 1;
  return i >= 0 ? s.v[i]! : NaN;
}

export type TimeBase = { kind: 'fastest' } | { kind: 'fixed'; hz: number } | { kind: 'union' };

/** Builds the common time column for exporting several series over [t0, t1]. */
export function exportTimes(series: Series[], t0: number, t1: number, base: TimeBase): Float64Array {
  if (base.kind === 'fixed') {
    const n = Math.max(0, Math.floor((t1 - t0) * base.hz + 1e-9) + 1);
    return Float64Array.from({ length: n }, (_, i) => t0 + i / base.hz);
  }
  const slices = series.map((s) => s.t.subarray(lowerBound(s.t, t0), upperBound(s.t, t1)));
  if (base.kind === 'fastest') {
    let best = slices[0] ?? new Float64Array();
    for (const sl of slices) if (sl.length > best.length) best = sl;
    return Float64Array.from(best);
  }
  const all = new Float64Array(slices.reduce((a, s) => a + s.length, 0));
  let o = 0;
  for (const sl of slices) { all.set(sl, o); o += sl.length; }
  all.sort();
  let w = 0;
  for (let i = 0; i < all.length; i++) if (i === 0 || all[i] !== all[w - 1]) all[w++] = all[i]!;
  return all.slice(0, w);
}

export interface CsvColumn { name: string; series: Series }

/** CSV with a time column plus one column per series (linear interpolation onto the time base). */
export function toCsv(cols: CsvColumn[], t0: number, t1: number, base: TimeBase, timeOffset = 0): string {
  const times = exportTimes(cols.map((c) => c.series), t0, t1, base);
  const gaps = cols.map((c) => 5 * medianDt(c.series.t) || Infinity);
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [['time_s', ...cols.map((c) => esc(c.name))].join(',')];
  for (const tq of times) {
    const row = [(tq + timeOffset).toFixed(6)];
    cols.forEach((c, k) => {
      const v = interpAt(c.series, tq, gaps[k]);
      row.push(Number.isNaN(v) ? '' : String(+v.toPrecision(10)));
    });
    lines.push(row.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
