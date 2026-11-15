/**
 * Time-sync solver (DESIGN §5.2–5.3).
 *
 * Each stream maps its local time to master time: master = a · local + b.
 * The reference stream has a = 1, b = 0. A marker places a named event on a
 * stream at a local time. Streams are solved outward from the reference:
 *   - with one usable marker (or "offset only"): a = 1, b = mean(T − t)
 *   - with ≥ 2 markers spanning ≥ MIN_DRIFT_SPAN seconds: least-squares a, b
 * Events placed on a solved stream become known and can solve further streams
 * (chaining: video B → video A → log). A few refinement passes then average
 * each event's master time over every stream that has it (except events pinned
 * by the reference) and refit, so redundant markers share the error.
 */

export interface SyncMarker { eventId: string; t: number }
export interface SyncStreamInput {
  id: string;
  markers: SyncMarker[];
  offsetOnly?: boolean;
  /** Extra seconds added to b after solving (± frame / ± ms buttons). */
  nudge?: number;
}
export interface SyncInput { reference: string; streams: SyncStreamInput[] }

export interface Residual { eventId: string; ms: number }
export interface StreamSolution {
  id: string;
  status: 'reference' | 'synced' | 'unsynced';
  a: number;
  b: number;
  usedDrift: boolean;
  driftPpm: number;
  residuals: Residual[];
  warning?: string;
}
export interface SyncSolution {
  streams: Record<string, StreamSolution>;
  eventTimes: Record<string, number>;
}

export const MIN_DRIFT_SPAN = 60; // s of marker spread before solving clock drift
export const DRIFT_WARN = 0.002;  // |a − 1| above this is suspicious (0.2 %)

export const toMaster = (s: Pick<StreamSolution, 'a' | 'b'>, local: number) => s.a * local + s.b;
export const toLocal = (s: Pick<StreamSolution, 'a' | 'b'>, master: number) => (master - s.b) / s.a;

function fit(pairs: [number, number][], allowDrift: boolean): { a: number; b: number; usedDrift: boolean } {
  const n = pairs.length;
  const span = n ? Math.max(...pairs.map((p) => p[0])) - Math.min(...pairs.map((p) => p[0])) : 0;
  if (allowDrift && n >= 2 && span >= MIN_DRIFT_SPAN) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx;
    if (Math.abs(den) > 1e-12) {
      const a = (n * sxy - sx * sy) / den;
      return { a, b: (sy - a * sx) / n, usedDrift: true };
    }
  }
  return { a: 1, b: n ? pairs.reduce((s, [x, y]) => s + (y - x), 0) / n : 0, usedDrift: false };
}

export function solve(input: SyncInput): SyncSolution {
  const byId = new Map(input.streams.map((s) => [s.id, s]));
  const sol: Record<string, StreamSolution> = {};
  const eventTimes: Record<string, number> = {};
  const pinned = new Set<string>(); // events whose time comes from the reference

  const ref = byId.get(input.reference);
  sol[input.reference] = { id: input.reference, status: 'reference', a: 1, b: 0, usedDrift: false, driftPpm: 0, residuals: [] };
  for (const m of ref?.markers ?? []) {
    if (!(m.eventId in eventTimes)) { eventTimes[m.eventId] = m.t; pinned.add(m.eventId); }
  }

  // Propagate outward from the reference.
  const solveStream = (s: SyncStreamInput) => {
    const pairs = s.markers.filter((m) => m.eventId in eventTimes).map((m) => [m.t, eventTimes[m.eventId]!] as [number, number]);
    if (!pairs.length) return false;
    const f = fit(pairs, !s.offsetOnly);
    sol[s.id] = { id: s.id, status: 'synced', a: f.a, b: f.b, usedDrift: f.usedDrift, driftPpm: (f.a - 1) * 1e6, residuals: [] };
    return true;
  };
  for (let progress = true; progress;) {
    progress = false;
    for (const s of input.streams) {
      if (sol[s.id]) continue;
      if (solveStream(s)) {
        progress = true;
        for (const m of s.markers) if (!(m.eventId in eventTimes)) eventTimes[m.eventId] = toMaster(sol[s.id]!, m.t);
      }
    }
  }

  // Refinement: average non-pinned event times across streams, then refit.
  for (let iter = 0; iter < 5; iter++) {
    const acc: Record<string, [number, number]> = {};
    for (const s of input.streams) {
      const ss = sol[s.id];
      if (!ss || ss.status === 'reference') continue;
      for (const m of s.markers) {
        if (pinned.has(m.eventId)) continue;
        const v = toMaster(ss, m.t);
        const a = (acc[m.eventId] ??= [0, 0]);
        a[0] += v; a[1] += 1;
      }
    }
    for (const [e, [sum, n]] of Object.entries(acc)) eventTimes[e] = sum / n;
    for (const s of input.streams) if (sol[s.id]?.status === 'synced') solveStream(s);
  }

  // Residuals, nudges, warnings, unsynced streams.
  for (const s of input.streams) {
    const ss = sol[s.id];
    if (!ss) {
      sol[s.id] = { id: s.id, status: 'unsynced', a: 1, b: 0, usedDrift: false, driftPpm: 0, residuals: [] };
      continue;
    }
    if (ss.status === 'synced') {
      ss.residuals = s.markers.filter((m) => m.eventId in eventTimes).map((m) => ({ eventId: m.eventId, ms: (toMaster(ss, m.t) - eventTimes[m.eventId]!) * 1000 }));
      if (Math.abs(ss.a - 1) > DRIFT_WARN) ss.warning = `Clock rate differs by ${(Math.abs(ss.a - 1) * 100).toFixed(2)} % — check for a misplaced marker or variable-frame-rate video.`;
      ss.b += s.nudge ?? 0;
    }
  }
  return { streams: sol, eventTimes };
}
