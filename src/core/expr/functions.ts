import { lowerBound, upperBound } from '../series/series';
import type { Node } from './parser';
import { elementwise, sig, type Value } from './evaluate';

export interface FnSpec {
  arity: [number, number];
  signature: string;
  doc: string;
  apply: (args: Value[], nodes: Node[]) => Value;
}

export const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, g: 9.80665 };

const D2R = Math.PI / 180;
const math1 = (f: (x: number) => number, doc: string): FnSpec => ({ arity: [1, 1], signature: 'x', doc, apply: (a) => elementwise(a, f) });

/** A signal argument (functions that work on a series' own samples). */
function signalArg(v: Value, fn: string) {
  if (v.k !== 'signal') throw new Error(`${fn}() needs a channel or signal, not a ${v.k === 'time' ? 'time' : 'constant'}`);
  return v.s;
}
function scalarArg(v: Value, fn: string, what: string): number {
  if (v.k !== 'scalar') throw new Error(`${fn}(): ${what} must be a constant number`);
  return v.v;
}

const wrap180 = (x: number) => { const y = ((((x + 180) % 360) + 360) % 360) - 180; return y === -180 && x > 0 ? 180 : y; };
const wrap360 = (x: number) => ((x % 360) + 360) % 360;

/** First-order low-pass with per-sample dt (handles irregular sampling). */
function lowpass(t: Float64Array, v: Float64Array, fc: number): Float64Array {
  const out = new Float64Array(v.length);
  const rc = 1 / (2 * Math.PI * fc);
  let y = NaN;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (Number.isNaN(x)) { out[i] = NaN; continue; }
    if (Number.isNaN(y)) y = x;
    else {
      const dt = t[i]! - t[i - 1]!;
      const a = dt / (rc + dt);
      y += a * (x - y);
    }
    out[i] = y;
  }
  return out;
}

export const FUNCTIONS: Record<string, FnSpec> = {
  abs: math1(Math.abs, 'Absolute value'),
  sqrt: math1(Math.sqrt, 'Square root'),
  exp: math1(Math.exp, 'e^x'),
  log: math1(Math.log, 'Natural logarithm'),
  log10: math1(Math.log10, 'Base-10 logarithm'),
  sin: math1(Math.sin, 'Sine (radians)'),
  cos: math1(Math.cos, 'Cosine (radians)'),
  tan: math1(Math.tan, 'Tangent (radians)'),
  asin: math1(Math.asin, 'Arcsine → radians'),
  acos: math1(Math.acos, 'Arccosine → radians'),
  atan: math1(Math.atan, 'Arctangent → radians'),
  round: math1(Math.round, 'Round to nearest integer'),
  floor: math1(Math.floor, 'Round down'),
  ceil: math1(Math.ceil, 'Round up'),
  sign: math1(Math.sign, '-1, 0 or 1'),
  deg: math1((x) => x / D2R, 'Radians → degrees'),
  rad: math1((x) => x * D2R, 'Degrees → radians'),
  wrap180: math1(wrap180, 'Wrap an angle in degrees to −180…180'),
  wrap360: math1(wrap360, 'Wrap an angle in degrees to 0…360'),

  atan2: { arity: [2, 2], signature: 'y, x', doc: 'Angle of (x, y) → radians', apply: (a) => elementwise(a, Math.atan2) },
  pow: { arity: [2, 2], signature: 'x, p', doc: 'x to the power p', apply: (a) => elementwise(a, (x, p) => x ** p) },
  hypot: { arity: [2, Infinity], signature: 'a, b, …', doc: 'sqrt(a² + b² + …)', apply: (a) => elementwise(a, Math.hypot) },
  min: { arity: [2, Infinity], signature: 'a, b, …', doc: 'Smallest value at each time', apply: (a) => elementwise(a, Math.min) },
  max: { arity: [2, Infinity], signature: 'a, b, …', doc: 'Largest value at each time', apply: (a) => elementwise(a, Math.max) },
  clamp: { arity: [3, 3], signature: 'x, lo, hi', doc: 'Limit x to lo…hi', apply: (a) => elementwise(a, (x, lo, hi) => Math.min(hi, Math.max(lo, x))) },

  deriv: {
    arity: [1, 1], signature: 'x', doc: 'Rate of change per second (central difference on x\'s own samples)',
    apply: ([a]) => {
      const s = signalArg(a!, 'deriv');
      const { t, v } = s, n = v.length, out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        out[i] = i1 > i0 ? (v[i1]! - v[i0]!) / (t[i1]! - t[i0]!) : NaN;
      }
      return sig(t, out);
    },
  },
  integrate: {
    arity: [1, 1], signature: 'x', doc: 'Running integral over time from the first sample (trapezoid); e.g. integrate(BAT.Curr)/3600 → Ah',
    apply: ([a]) => {
      const s = signalArg(a!, 'integrate');
      const { t, v } = s, out = new Float64Array(v.length);
      let acc = 0;
      for (let i = 1; i < v.length; i++) {
        const y0 = v[i - 1]!, y1 = v[i]!;
        if (!Number.isNaN(y0) && !Number.isNaN(y1)) acc += 0.5 * (y0 + y1) * (t[i]! - t[i - 1]!);
        out[i] = acc;
      }
      return sig(t, out);
    },
  },
  lowpass: {
    arity: [2, 2], signature: 'x, hz', doc: 'First-order low-pass filter with cutoff hz (causal, like a flight controller filter)',
    apply: ([a, f]) => {
      const s = signalArg(a!, 'lowpass');
      const fc = scalarArg(f!, 'lowpass', 'the cutoff');
      if (!(fc > 0)) throw new Error('lowpass(): the cutoff must be > 0 Hz');
      return sig(s.t, lowpass(s.t, s.v, fc));
    },
  },
  highpass: {
    arity: [2, 2], signature: 'x, hz', doc: 'x minus lowpass(x, hz)',
    apply: ([a, f]) => {
      const s = signalArg(a!, 'highpass');
      const fc = scalarArg(f!, 'highpass', 'the cutoff');
      if (!(fc > 0)) throw new Error('highpass(): the cutoff must be > 0 Hz');
      const lp = lowpass(s.t, s.v, fc);
      return sig(s.t, s.v.map((x, i) => x - lp[i]!));
    },
  },
  movavg: {
    arity: [2, 2], signature: 'x, seconds', doc: 'Centred moving average over a time window',
    apply: ([a, w]) => {
      const s = signalArg(a!, 'movavg');
      const half = scalarArg(w!, 'movavg', 'the window') / 2;
      const { t, v } = s, n = v.length, out = new Float64Array(n);
      // prefix sums ignoring NaN
      const sum = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        const ok = !Number.isNaN(v[i]!);
        sum[i + 1] = sum[i]! + (ok ? v[i]! : 0);
        cnt[i + 1] = cnt[i]! + (ok ? 1 : 0);
      }
      for (let i = 0; i < n; i++) {
        const lo = lowerBound(t, t[i]! - half), hi = upperBound(t, t[i]! + half);
        const c = cnt[hi]! - cnt[lo]!;
        out[i] = c ? (sum[hi]! - sum[lo]!) / c : NaN;
      }
      return sig(t, out);
    },
  },
  median: {
    arity: [2, 2], signature: 'x, seconds', doc: 'Centred rolling median over a time window (removes spikes)',
    apply: ([a, w]) => {
      const s = signalArg(a!, 'median');
      const half = scalarArg(w!, 'median', 'the window') / 2;
      const { t, v } = s, n = v.length, out = new Float64Array(n);
      if (n > 2_000_000) throw new Error('median(): series too long; use movavg() or lowpass()');
      for (let i = 0; i < n; i++) {
        const lo = lowerBound(t, t[i]! - half), hi = upperBound(t, t[i]! + half);
        const win: number[] = [];
        for (let k = lo; k < hi; k++) if (!Number.isNaN(v[k]!)) win.push(v[k]!);
        if (!win.length) { out[i] = NaN; continue; }
        win.sort((x, y) => x - y);
        const m = win.length >> 1;
        out[i] = win.length % 2 ? win[m]! : (win[m - 1]! + win[m]!) / 2;
      }
      return sig(t, out);
    },
  },
  delay: {
    arity: [2, 2], signature: 'x, seconds', doc: 'Shift x later in time (negative = earlier)',
    apply: ([a, d]) => {
      const s = signalArg(a!, 'delay');
      const dt = scalarArg(d!, 'delay', 'the delay');
      return { k: 'signal', s: { t: s.t.map((x) => x + dt), v: s.v, hold: s.hold } };
    },
  },
  hold: {
    arity: [1, 1], signature: 'x', doc: 'When resampled onto a faster signal, hold the last value instead of interpolating (for modes, states, switches)',
    apply: ([a]) => {
      const s = signalArg(a!, 'hold');
      return { k: 'signal', s: { t: s.t, v: s.v, hold: true } };
    },
  },
  dt: {
    arity: [1, 1], signature: 'x', doc: 'Time between consecutive samples of x (seconds)',
    apply: ([a]) => {
      const s = signalArg(a!, 'dt');
      return sig(s.t, s.t.map((x, i) => (i ? x - s.t[i - 1]! : NaN)));
    },
  },
};

