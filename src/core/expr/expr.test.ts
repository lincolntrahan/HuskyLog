import { describe, expect, it } from 'vitest';
import { ExprError, parse } from './parser';
import { evaluate, requirements, resample, type Signal } from './evaluate';

const S = (t: number[], v: number[]): Signal => ({ t: Float64Array.from(t), v: Float64Array.from(v) });
const ev = (src: string, channels: Record<string, Signal>, named: Record<string, string> = {}) =>
  evaluate(src, { channels: new Map(Object.entries(channels)), named });
const err = (f: () => unknown) => {
  try { f(); } catch (e) { return e as ExprError; }
  throw new Error('expected an error');
};

describe('parser', () => {
  const show = (src: string): string => {
    const p = (n: ReturnType<typeof parse>): string => {
      switch (n.k) {
        case 'num': return String(n.value);
        case 'chan': return n.id;
        case 'name': return n.name;
        case 'call': return `${n.fn}(${n.args.map(p).join(',')})`;
        case 'unary': return `(${n.op}${p(n.arg)})`;
        case 'bin': return `(${p(n.a)}${n.op}${p(n.b)})`;
        case 'tern': return `(${p(n.cond)}?${p(n.a)}:${p(n.b)})`;
      }
    };
    return p(parse(src));
  };
  it('respects precedence and associativity', () => {
    expect(show('1 + 2 * 3')).toBe('(1+(2*3))');
    expect(show('-2^2')).toBe('(-(2^2))');
    expect(show('2^3^2')).toBe('(2^(3^2))');
    expect(show('a > 1 && b < 2 || c')).toBe('(((a>1)&&(b<2))||c)');
    expect(show('x ? 1 : y ? 2 : 3')).toBe('(x?1:(y?2:3))');
    expect(show('IMU[1].AccZ * 1.5e-3')).toBe('(IMU[1].AccZ*0.0015)');
    expect(show('atan2(ATT.Roll, -ATT.Pitch)')).toBe('atan2(ATT.Roll,(-ATT.Pitch))');
  });
  it('reports errors with positions', () => {
    let e = err(() => parse('ATT.Roll +'));
    expect(e.message).toMatch(/ends too early/);
    e = err(() => parse('(ATT.Roll'));
    expect(e.message).toMatch(/Missing "\)"/);
    e = err(() => parse('ATT.Roll $ 2'));
    expect([e.start, e.end]).toEqual([9, 10]);
    e = err(() => parse('IMU[1] + 2'));
    expect(e.message).toMatch(/needs a field/);
    e = err(() => parse('ATT.Roll 2'));
    expect(e.message).toMatch(/Expected an operator/);
  });
});

describe('evaluation', () => {
  const fast = S([0, 0.1, 0.2, 0.3, 0.4, 0.5], [0, 1, 2, 3, 4, 5]);   // 10 Hz
  const slow = S([0, 0.5], [10, 20]);                                 // 2 Hz
  it('uses the higher-rate input as the time base and interpolates the other', () => {
    const r = ev('A.x + B.y', { 'A.x': fast, 'B.y': slow });
    expect(Array.from(r.t)).toEqual(Array.from(fast.t));
    expect(Array.from(r.v).map((x) => +x.toFixed(6))).toEqual([10, 13, 16, 19, 22, 25]);
    const r2 = ev('B.y + A.x', { 'A.x': fast, 'B.y': slow });
    expect(r2.t).toBe(fast.t); // order does not matter
  });
  it('hold() uses sample-and-hold instead of interpolation', () => {
    const r = ev('A.x * 0 + hold(B.y)', { 'A.x': fast, 'B.y': slow });
    expect(Array.from(r.v)).toEqual([10, 10, 10, 10, 10, 20]);
  });
  it('gives NaN outside a signal\'s range and across long gaps', () => {
    const gappy = S([0, 0.1, 0.2, 2, 2.1], [1, 1, 1, 5, 5]);
    const bt = Array.from({ length: 61 }, (_, i) => +(i * 0.05).toFixed(2)); // 20 Hz, 0…3 s
    const base = S(bt, bt.map(() => 0));
    const r = ev('Base.x + Gap.y', { 'Base.x': base, 'Gap.y': gappy });
    expect(r.t).toBe(base.t);
    const at = (x: number) => r.v[bt.indexOf(x)];
    expect(at(0.05)).toBe(1);
    expect(at(1)).toBeNaN(); // inside a 1.8 s gap (median dt 0.1)
    expect(at(2.05)).toBeCloseTo(5);
    expect(at(3)).toBeNaN(); // after the end
  });
  it('supports comparisons, logic and the ternary operator', () => {
    const r = ev('A.x >= 2 && A.x < 4 ? 100 : -1', { 'A.x': fast });
    expect(Array.from(r.v)).toEqual([-1, -1, 100, 100, -1, -1]);
  });
  it('t gives master time once a channel provides timestamps', () => {
    expect(Array.from(ev('A.x - t * 10', { 'A.x': fast }).v).map((x) => Math.round(x))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(err(() => ev('t * 2', {})).message).toMatch(/timestamps/);
  });
  it('rejects constant-only expressions and unknown channels/functions with hints', () => {
    expect(err(() => ev('1 + 2', {})).message).toMatch(/at least one channel/);
    expect(err(() => ev('ATT.Rol * 2', {})).message).toMatch(/ATT\.Rol.*not in this log/);
    const e = err(() => ev('derv(A.x)', { 'A.x': fast }));
    expect(e.message).toMatch(/Did you mean deriv/);
    expect([e.start, e.end]).toEqual([0, 4]);
    expect(err(() => ev('lowpass(A.x)', { 'A.x': fast })).message).toMatch(/takes 2 argument/);
    expect(err(() => ev('lowpass(A.x, A.x)', { 'A.x': fast })).message).toMatch(/cutoff must be a constant/);
  });
});

describe('signal functions', () => {
  const n = 2001, dt = 0.01;
  const t = Float64Array.from({ length: n }, (_, i) => i * dt);
  const sine = { t, v: t.map((x) => Math.sin(2 * Math.PI * 1 * x)) };   // 1 Hz
  const ramp = { t, v: t.map((x) => 3 * x) };
  it('deriv of a ramp is its slope; deriv of sin is 2π·cos', () => {
    const d = ev('deriv(R.x)', { 'R.x': ramp }).v;
    expect(d[0]).toBeCloseTo(3, 9);
    expect(d[1000]).toBeCloseTo(3, 9);
    const ds = ev('deriv(S.x)', { 'S.x': sine }).v;
    expect(ds[500]).toBeCloseTo(2 * Math.PI * Math.cos(2 * Math.PI * 5), 2);
  });
  it('integrate of a constant is linear; of a ramp is quadratic', () => {
    const i = ev('integrate(R.x)', { 'R.x': ramp }).v;
    expect(i[n - 1]).toBeCloseTo(1.5 * 20 * 20, 6); // ∫3x dx from 0..20
  });
  it('lowpass attenuates far above cutoff and passes far below', () => {
    const fast = { t, v: t.map((x) => Math.sin(2 * Math.PI * 20 * x)) }; // 20 Hz
    const lpFast = ev('lowpass(F.x, 0.5)', { 'F.x': fast }).v;
    const lpSlow = ev('lowpass(S.x, 20)', { 'S.x': sine }).v;
    const amp = (a: Float64Array) => Math.max(...Array.from(a.subarray(1000)).map(Math.abs));
    expect(amp(lpFast)).toBeLessThan(0.05);
    expect(amp(lpSlow)).toBeGreaterThan(0.95);
    const hp = ev('highpass(S.x, 20)', { 'S.x': sine }).v;
    expect(amp(hp)).toBeLessThan(0.1);
  });
  it('movavg over one period of a sine is ~0; median removes a spike', () => {
    expect(ev('movavg(S.x, 1)', { 'S.x': sine }).v[1000]).toBeCloseTo(0, 2);
    const spiky = { t, v: t.map((_, i) => (i === 1000 ? 100 : 1)) };
    expect(ev('median(P.x, 0.05)', { 'P.x': spiky }).v[1000]).toBe(1);
  });
  it('delay shifts timestamps; wrap180 and deg/rad behave', () => {
    const r = ev('delay(R.x, 0.5)', { 'R.x': ramp });
    expect(r.t[0]).toBeCloseTo(0.5);
    const w = ev('wrap180(R.x * 100)', { 'R.x': ramp }).v;
    expect(Math.max(...w)).toBeLessThanOrEqual(180);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(-180);
    expect(ev('deg(rad(R.x))', { 'R.x': ramp }).v[700]).toBeCloseTo(21, 9);
  });
  it('resample keeps the original array when time bases are identical', () => {
    expect(resample(sine, sine.t)).toBe(sine.v);
  });
});

describe('named expressions', () => {
  const a = S([0, 1, 2], [1, 2, 3]);
  it('expand recursively and report the channels they need', () => {
    const named = { power: 'BAT.Volt * BAT.Curr', energy: 'integrate(power) / 3600' };
    expect(requirements('energy * 1000', named)).toEqual({ channels: ['BAT.Volt', 'BAT.Curr'], names: ['energy', 'power'] });
    const r = ev('double + 1', { 'A.x': a }, { double: 'A.x * 2' });
    expect(Array.from(r.v)).toEqual([3, 5, 7]);
  });
  it('detect cycles and unknown names', () => {
    expect(err(() => requirements('a', { a: 'b + 1', b: 'a * 2' })).message).toMatch(/refers to itself/);
    expect(err(() => requirements('powr', { power: 'X.y' })).message).toMatch(/Did you mean "power"/);
    expect(err(() => requirements('roll', {})).message).toMatch(/need a dot/);
  });
});

describe('static validation', () => {
  it('requirements() rejects unknown functions and wrong arity before evaluation', () => {
    expect(err(() => requirements('derv(A.x)', {})).message).toMatch(/Did you mean deriv/);
    expect(err(() => requirements('atan2(A.x)', {})).message).toMatch(/takes 2 argument/);
    expect(requirements('max(A.x, B.y, 3)', {}).channels).toEqual(['A.x', 'B.y']);
  });
});
