import { describe, expect, it } from 'vitest';
import { exportTimes, holdAt, interpAt, rangeStats, toCsv, type Series } from './series';
import { buildAligned } from './decimate';

const mk = (t: number[], v: number[]): Series => ({ t: Float64Array.from(t), v: Float64Array.from(v) });

describe('rangeStats', () => {
  it('computes mean, sample std, min/max with times, inclusive range', () => {
    const s = mk([0, 1, 2, 3, 4], [2, 4, 4, 4, 5]);
    const r = rangeStats(s, 0, 4);
    expect(r.n).toBe(5);
    expect(r.mean).toBeCloseTo(3.8);
    expect(r.std).toBeCloseTo(Math.sqrt(1.2)); // sample std
    expect([r.min, r.tMin, r.max, r.tMax]).toEqual([2, 0, 5, 4]);
    expect(rangeStats(s, 1, 3).n).toBe(3);
    expect(rangeStats(s, 10, 20).n).toBe(0);
  });
});

describe('interpolation', () => {
  const s = mk([0, 1, 2, 10], [0, 10, 20, 100]);
  it('interpolates linearly and returns NaN outside or across long gaps', () => {
    expect(interpAt(s, 0.5)).toBe(5);
    expect(interpAt(s, 2)).toBe(20);
    expect(interpAt(s, -1)).toBeNaN();
    expect(interpAt(s, 5, 2)).toBeNaN();
    expect(holdAt(s, 1.9)).toBe(10);
  });
});

describe('CSV export', () => {
  const fast = mk([0, 0.5, 1, 1.5, 2], [0, 1, 2, 3, 4]);
  const slow = mk([0, 1, 2], [10, 20, 30]);
  it('uses the fastest series timestamps and interpolates the others', () => {
    const csv = toCsv([{ name: 'A [m]', series: fast }, { name: 'B', series: slow }], 0, 2, { kind: 'fastest' });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('time_s,A [m],B');
    expect(lines[2]).toBe('0.500000,1,15');
    expect(lines.length).toBe(6);
  });
  it('supports fixed-rate and union time bases', () => {
    expect(Array.from(exportTimes([fast], 0, 1, { kind: 'fixed', hz: 4 }))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(exportTimes([fast, mk([0.25], [1])], 0, 2, { kind: 'union' }).length).toBe(6);
  });
});

describe('buildAligned', () => {
  it('keeps spikes when decimating (min/max per column)', () => {
    const n = 100_000;
    const t = Float64Array.from({ length: n }, (_, i) => i / 1000);
    const v = new Float64Array(n);
    v[54321] = 99; // single-sample spike
    const [x, y] = buildAligned([{ t, v }], 0, 100, 500);
    expect(x!.length).toBe(1000);
    expect(Math.max(...(y as number[]).filter((a) => a !== null))).toBe(99);
  });
  it('breaks lines at real gaps but bridges holes from other series', () => {
    const a = mk([0, 1, 2, 10, 11, 12], [1, 1, 1, 1, 1, 1]); // gap 2→10
    const b = mk([0.5, 1.5], [5, 5]);
    const [x, ya] = buildAligned([a, b], 0, 12, 800);
    const at = (tx: number) => ya![(x as number[]).indexOf(tx)];
    expect(at(0.5)).toBe(1); // bridged
    expect(at(6)).toBeNull(); // break inside the real gap
    expect(at(11)).toBe(1);
  });
});
