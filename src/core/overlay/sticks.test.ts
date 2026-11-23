import { describe, expect, it } from 'vitest';
import { centred, gimbals, rcCal, rcMap, unipolar } from './sticks';

const cal = { min: 988, trim: 1500, max: 2011, reversed: false };

describe('pilot sticks', () => {
  it('centred axes: trim → 0, ends → ±1, clamped, reversible', () => {
    expect(centred(1500, cal)).toBe(0);
    expect(centred(2011, cal)).toBe(1);
    expect(centred(988, cal)).toBe(-1);
    expect(centred(1755.5, cal)).toBeCloseTo(0.5, 6);
    expect(centred(2100, cal)).toBe(1);
    expect(centred(2011, { ...cal, reversed: true })).toBe(-1);
    expect(Number.isNaN(centred(NaN, cal))).toBe(true);
    // Off-centre trim still reaches both ends.
    expect(centred(1100, { min: 1100, trim: 1400, max: 1900, reversed: false })).toBe(-1);
  });
  it('throttle: min → 0, max → 1', () => {
    const t = { min: 988, trim: 988, max: 2011, reversed: false };
    expect(unipolar(988, t)).toBe(0);
    expect(unipolar(2011, t)).toBe(1);
    expect(unipolar(1499.5, t)).toBeCloseTo(0.5, 6);
    expect(unipolar(2011, { ...t, reversed: true })).toBe(0);
  });
  it('mode 2 puts throttle on the left, mode 1 on the right', () => {
    const s = { roll: 0.5, pitch: -0.25, throttle: 1, yaw: -1 };
    expect(gimbals(s, 2)).toEqual({ left: { x: -1, y: 1 }, right: { x: 0.5, y: -0.25 } });
    expect(gimbals(s, 1)).toEqual({ left: { x: -1, y: -0.25 }, right: { x: 0.5, y: 1 } });
  });
  it('reads RCMAP and RCn_* parameters, with defaults', () => {
    const p: Record<string, number> = { RCMAP_ROLL: 2, RCMAP_PITCH: 1, RC5_MIN: 1100, RC5_MAX: 1900, RC5_REVERSED: 1 };
    const get = (n: string) => p[n];
    expect(rcMap(get)).toEqual({ roll: 2, pitch: 1, throttle: 3, yaw: 4 });
    expect(rcCal(get, 5)).toEqual({ min: 1100, trim: 1500, max: 1900, reversed: true });
    expect(rcCal(() => undefined, 1)).toEqual({ min: 1000, trim: 1500, max: 2000, reversed: false });
  });
});
