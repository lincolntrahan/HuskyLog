import { describe, expect, it } from 'vitest';
import { solve, toLocal, toMaster } from './solver';

// A video that started at log time 297.5 s with a clock running 300 ppm fast.
const A = 1.0003, B = 297.5;
const local = (master: number) => (master - B) / A;

describe('time-sync solver', () => {
  it('one marker → offset only', () => {
    const s = solve({ reference: 'log', streams: [
      { id: 'log', markers: [{ eventId: 'prop', t: 314.11 }] },
      { id: 'vid', markers: [{ eventId: 'prop', t: 16.61 }] },
    ] }).streams['vid']!;
    expect(s.status).toBe('synced');
    expect(s.a).toBe(1);
    expect(s.b).toBeCloseTo(297.5, 9);
    expect(s.usedDrift).toBe(false);
  });

  it('two markers > 60 s apart recover offset and drift exactly', () => {
    const s = solve({ reference: 'log', streams: [
      { id: 'log', markers: [{ eventId: 'prop', t: 314.11 }, { eventId: 'land', t: 517.4 }] },
      { id: 'vid', markers: [{ eventId: 'prop', t: local(314.11) }, { eventId: 'land', t: local(517.4) }] },
    ] }).streams['vid']!;
    expect(s.usedDrift).toBe(true);
    expect(s.a).toBeCloseTo(A, 9);
    expect(s.b).toBeCloseTo(B, 6);
    expect(s.driftPpm).toBeCloseTo(300, 3);
    expect(Math.abs(toMaster(s, local(400)) - 400)).toBeLessThan(1e-6);
    expect(toLocal(s, 400)).toBeCloseTo(local(400), 6);
  });

  it('markers closer than 60 s, or "offset only", do not solve drift', () => {
    const base = [{ id: 'log', markers: [{ eventId: 'a', t: 314 }, { eventId: 'b', t: 340 }] }];
    expect(solve({ reference: 'log', streams: [...base, { id: 'v', markers: [{ eventId: 'a', t: 10 }, { eventId: 'b', t: 36 }] }] }).streams['v']!.usedDrift).toBe(false);
    const far = [{ id: 'log', markers: [{ eventId: 'a', t: 314 }, { eventId: 'b', t: 500 }] }];
    expect(solve({ reference: 'log', streams: [...far, { id: 'v', offsetOnly: true, markers: [{ eventId: 'a', t: 10 }, { eventId: 'b', t: 196.1 }] }] }).streams['v']!.usedDrift).toBe(false);
  });

  it('chains a stream through another synced stream', () => {
    // Video B shares no event with the log but shares "touchdown" with video A.
    const r = solve({ reference: 'log', streams: [
      { id: 'log', markers: [{ eventId: 'prop', t: 314.11 }] },
      { id: 'A', markers: [{ eventId: 'prop', t: 16.61 }, { eventId: 'touchdown', t: 220 }] },
      { id: 'B', markers: [{ eventId: 'touchdown', t: 5 }] },
    ] });
    expect(r.streams['B']!.status).toBe('synced');
    expect(toMaster(r.streams['B']!, 5)).toBeCloseTo(297.5 + 220, 6);
  });

  it('flags unsynced streams', () => {
    const r = solve({ reference: 'log', streams: [{ id: 'log', markers: [] }, { id: 'v', markers: [{ eventId: 'x', t: 1 }] }] });
    expect(r.streams['v']!.status).toBe('unsynced');
  });

  it('residuals expose a misplaced marker; drift warning fires', () => {
    const r = solve({ reference: 'log', streams: [
      { id: 'log', markers: [{ eventId: 'a', t: 300 }, { eventId: 'b', t: 400 }, { eventId: 'c', t: 500 }] },
      { id: 'v', markers: [{ eventId: 'a', t: local(300) }, { eventId: 'b', t: local(400) + 0.5 }, { eventId: 'c', t: local(500) }] },
    ] }).streams['v']!;
    const worst = r.residuals.reduce((m, x) => (Math.abs(x.ms) > Math.abs(m.ms) ? x : m));
    expect(worst.eventId).toBe('b');
    expect(Math.abs(worst.ms)).toBeGreaterThan(200);
    const bad = solve({ reference: 'log', streams: [
      { id: 'log', markers: [{ eventId: 'a', t: 300 }, { eventId: 'b', t: 400 }] },
      { id: 'v', markers: [{ eventId: 'a', t: 0 }, { eventId: 'b', t: 99 }] }, // 1 % rate error
    ] }).streams['v']!;
    expect(bad.warning).toMatch(/Clock rate differs/);
  });

  it('applies nudges after solving', () => {
    const r = solve({ reference: 'log', streams: [
      { id: 'log', markers: [{ eventId: 'a', t: 300 }] },
      { id: 'v', nudge: 1 / 30, markers: [{ eventId: 'a', t: 2 }] },
    ] }).streams['v']!;
    expect(r.b).toBeCloseTo(298 + 1 / 30, 9);
  });
});

import { snapEdge, smooth } from './snap';

describe('snap to edge', () => {
  const t = Float64Array.from({ length: 1001 }, (_, i) => i * 0.01); // 0..10 s at 100 Hz
  it('finds the mid-rise of a step nearest the cursor', () => {
    const v = t.map((x) => (x >= 4.0 ? 1000 : 0));
    expect(snapEdge(t, v, 4.3)).toBeCloseTo(3.995, 3);
    expect(snapEdge(t, v, 8)).toBeNull(); // flat window
  });
  it('finds a sound onset with a low level on a smoothed envelope', () => {
    const env = Float32Array.from(t, (x) => (x >= 6.2 ? 0.8 : 0.02));
    const s = smooth(env, 3);
    const at = snapEdge(t, s, 6.0, 1.5, 0.25)!;
    expect(Math.abs(at - 6.2)).toBeLessThan(0.02);
  });
});
