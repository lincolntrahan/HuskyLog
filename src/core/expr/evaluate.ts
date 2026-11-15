import { lowerBound, medianDt } from '../series/series';
import { ExprError, parse, references, type Node } from './parser';
import { FUNCTIONS, CONSTANTS, type FnSpec } from './functions';

/**
 * Vectorised evaluation over typed arrays (DESIGN §8).
 *
 * Every sub-expression keeps its own natural time base: a channel uses its own
 * timestamps, deriv(BARO.Alt) is computed on BARO's samples. When two signals
 * meet (a + b, atan2(a, b), cond ? a : b) the lower-rate one is resampled onto
 * the higher-rate one's timestamps — linear interpolation by default, sample-and-
 * hold for hold(x) — returning NaN outside its range and across gaps longer than
 * 5× its median sample period.
 */

export interface Signal { t: Float64Array; v: Float64Array; hold?: boolean }
/** 'time' is a deferred function of the timestamps (t, t * 10, sin(t)…), evaluated once a channel supplies them. */
export type Value = { k: 'scalar'; v: number } | { k: 'signal'; s: Signal } | { k: 'time'; f: (t: Float64Array) => Float64Array };

export interface EvalEnv {
  /** Loaded channel data by id (all ids from `requirements()` must be present). */
  channels: Map<string, Signal>;
  /** Named expressions: name → source. */
  named: Record<string, string>;
}

export interface Requirements { channels: string[]; names: string[] }

/** Channels needed by an expression, expanding named expressions (cycle-checked). */
export function requirements(src: string, named: Record<string, string>): Requirements {
  const chans = new Set<string>(), names = new Set<string>();
  const visit = (s: string, stack: string[], pos?: { start: number; end: number }) => {
    let ast: Node;
    try {
      ast = parse(s);
    } catch (e) {
      if (e instanceof ExprError && stack.length) {
        throw new ExprError(`In "${stack[stack.length - 1]}": ${e.message}`, pos?.start ?? 0, pos?.end ?? 0);
      }
      throw e;
    }
    if (!stack.length) checkCalls(ast);
    walkNames(ast, (n) => {
      if (n.name in CONSTANTS || n.name === 't') return;
      const def = named[n.name];
      if (def === undefined) throw new ExprError(unknownName(n.name, Object.keys(named)), n.start, n.end);
      if (stack.includes(n.name)) throw new ExprError(`"${n.name}" refers to itself (${[...stack, n.name].join(' → ')})`, n.start, n.end);
      names.add(n.name);
      visit(def, [...stack, n.name], stack.length ? pos : n);
    });
    for (const c of references(ast).chans) chans.add(c);
  };
  visit(src, []);
  return { channels: [...chans], names: [...names] };
}

/** Static check: every function exists and gets a valid number of arguments. */
function checkCalls(n: Node): void {
  switch (n.k) {
    case 'call': {
      const spec = FUNCTIONS[n.fn];
      if (!spec) {
        const c = closest(n.fn, Object.keys(FUNCTIONS));
        throw new ExprError(`Unknown function "${n.fn}"${c ? `. Did you mean ${c}(…)?` : ''}`, n.start, n.start + n.fn.length);
      }
      const [lo, hi] = spec.arity;
      if (n.args.length < lo || n.args.length > hi) {
        throw new ExprError(`${n.fn}(${spec.signature}) takes ${lo === hi ? lo : `${lo}–${hi === Infinity ? 'many' : hi}`} argument(s), got ${n.args.length}`, n.start, n.end);
      }
      n.args.forEach(checkCalls);
      break;
    }
    case 'unary': checkCalls(n.arg); break;
    case 'bin': checkCalls(n.a); checkCalls(n.b); break;
    case 'tern': checkCalls(n.cond); checkCalls(n.a); checkCalls(n.b); break;
  }
}

function walkNames(n: Node, f: (n: Node & { k: 'name' }) => void) {
  switch (n.k) {
    case 'name': f(n); break;
    case 'call': n.args.forEach((a) => walkNames(a, f)); break;
    case 'unary': walkNames(n.arg, f); break;
    case 'bin': walkNames(n.a, f); walkNames(n.b, f); break;
    case 'tern': walkNames(n.cond, f); walkNames(n.a, f); walkNames(n.b, f); break;
  }
}

function unknownName(name: string, named: string[]): string {
  const fn = closest(name, Object.keys(FUNCTIONS));
  const nm = closest(name, [...named, ...Object.keys(CONSTANTS), 't']);
  const hint = nm ? ` Did you mean "${nm}"?` : fn ? ` Did you mean ${fn}(…)?` : ' Channels need a dot, e.g. ATT.Roll.';
  return `Unknown name "${name}".${hint}`;
}

export function closest(word: string, options: string[]): string | null {
  let best: string | null = null, bestD = Infinity;
  const w = word.toLowerCase();
  for (const o of options) {
    const d = levenshtein(w, o.toLowerCase());
    if (d < bestD) { bestD = d; best = o; }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

// ---------------------------------------------------------------------------

const rateOf = (s: Signal) => {
  const n = s.t.length;
  return n > 1 ? (n - 1) / (s.t[n - 1]! - s.t[0]! || 1) : 0;
};

/** Resample `src` onto times `tq`. */
export function resample(src: Signal, tq: Float64Array): Float64Array {
  if (src.t === tq) return src.v;
  const out = new Float64Array(tq.length);
  const n = src.t.length;
  if (n === 0) return out.fill(NaN);
  const gap = 5 * medianDt(src.t) || Infinity;
  const t0 = src.t[0]!, tn = src.t[n - 1]!;
  let j = Math.max(1, lowerBound(src.t, tq[0] ?? 0));
  for (let i = 0; i < tq.length; i++) {
    const x = tq[i]!;
    if (x < t0 || x > tn) { out[i] = NaN; continue; }
    while (j < n - 1 && src.t[j]! < x) j++;
    const ta = src.t[j - 1]!, tb = src.t[j]!;
    if (n === 1 || x === tb) { out[i] = src.v[n === 1 ? 0 : j]!; continue; }
    if (x <= ta) { out[i] = src.v[j - 1]!; continue; }
    if (tb - ta > gap) { out[i] = NaN; continue; }
    out[i] = src.hold ? src.v[j - 1]! : src.v[j - 1]! + ((src.v[j]! - src.v[j - 1]!) * (x - ta)) / (tb - ta);
  }
  return out;
}

/** Brings several values onto one common time base (highest-rate signal wins). */
export function align(vals: Value[]): { t: Float64Array | null; arrays: (Float64Array | number)[] } {
  let base: Signal | null = null;
  for (const v of vals) if (v.k === 'signal' && (!base || rateOf(v.s) > rateOf(base))) base = v.s;
  if (!base) return { t: null, arrays: vals.map((v) => (v.k === 'scalar' ? v.v : NaN)) };
  const t = base.t;
  return {
    t,
    arrays: vals.map((v) => (v.k === 'scalar' ? v.v : v.k === 'time' ? v.f(t) : resample(v.s, t))),
  };
}

const sig = (t: Float64Array, v: Float64Array): Value => ({ k: 'signal', s: { t, v } });

/** Applies f element-wise across aligned operands. */
export function elementwise(vals: Value[], f: (...x: number[]) => number): Value {
  if (vals.some((v) => v.k === 'time') && !vals.some((v) => v.k === 'signal')) {
    // No timestamps yet: compose a deferred function of time.
    return { k: 'time', f: (tt) => {
      const { arrays } = align(vals.map((v) => (v.k === 'time' ? { k: 'signal', s: { t: tt, v: v.f(tt) } } : v)) as Value[]);
      const out = new Float64Array(tt.length);
      const args = new Array<number>(arrays.length);
      for (let i = 0; i < tt.length; i++) {
        for (let k = 0; k < arrays.length; k++) { const a = arrays[k]!; args[k] = typeof a === 'number' ? a : a[i]!; }
        out[i] = f(...args);
      }
      return out;
    } };
  }
  const { t, arrays } = align(vals);
  if (!t) return { k: 'scalar', v: f(...(arrays as number[])) };
  const n = t.length;
  const out = new Float64Array(n);
  const args = new Array<number>(arrays.length);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < arrays.length; k++) {
      const a = arrays[k]!;
      args[k] = typeof a === 'number' ? a : a[i]!;
    }
    out[i] = f(...args);
  }
  return sig(t, out);
}

const BIN: Record<string, (a: number, b: number) => number> = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
  '%': (a, b) => a % b, '^': (a, b) => a ** b,
  '==': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(a === b)),
  '!=': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(a !== b)),
  '<': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(a < b)),
  '<=': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(a <= b)),
  '>': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(a > b)),
  '>=': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(a >= b)),
  '&&': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(!!a && !!b)),
  '||': (a, b) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : +(!!a || !!b)),
};

export function evalNode(n: Node, env: EvalEnv, stack: string[] = []): Value {
  const wrap = <T>(f: () => T): T => {
    try { return f(); } catch (e) {
      if (e instanceof ExprError) throw e;
      throw new ExprError(e instanceof Error ? e.message : String(e), n.start, n.end);
    }
  };
  switch (n.k) {
    case 'num': return { k: 'scalar', v: n.value };
    case 'chan': {
      const s = env.channels.get(n.id);
      if (!s) throw new ExprError(`Channel "${n.id}" is not in this log`, n.start, n.end);
      return { k: 'signal', s };
    }
    case 'name': {
      if (n.name === 't') return { k: 'time', f: (tt) => tt };
      if (n.name in CONSTANTS) return { k: 'scalar', v: CONSTANTS[n.name]! };
      const def = env.named[n.name];
      if (def === undefined) throw new ExprError(unknownName(n.name, Object.keys(env.named)), n.start, n.end);
      if (stack.includes(n.name)) throw new ExprError(`"${n.name}" refers to itself`, n.start, n.end);
      try {
        return evalNode(parse(def), env, [...stack, n.name]);
      } catch (e) {
        throw new ExprError(`In "${n.name}": ${e instanceof Error ? e.message : e}`, n.start, n.end);
      }
    }
    case 'unary': {
      const a = evalNode(n.arg, env, stack);
      return wrap(() => elementwise([a], n.op === '-' ? (x) => -x : n.op === '+' ? (x) => x : (x) => (Number.isNaN(x) ? NaN : +!x)));
    }
    case 'bin': {
      const a = evalNode(n.a, env, stack), b = evalNode(n.b, env, stack);
      return wrap(() => elementwise([a, b], BIN[n.op]!));
    }
    case 'tern': {
      const c = evalNode(n.cond, env, stack), a = evalNode(n.a, env, stack), b = evalNode(n.b, env, stack);
      return wrap(() => elementwise([c, a, b], (cc, aa, bb) => (Number.isNaN(cc) ? NaN : cc ? aa : bb)));
    }
    case 'call': {
      const spec: FnSpec | undefined = FUNCTIONS[n.fn];
      if (!spec) {
        const c = closest(n.fn, Object.keys(FUNCTIONS));
        throw new ExprError(`Unknown function "${n.fn}"${c ? `. Did you mean ${c}(…)?` : ''}`, n.start, n.start + n.fn.length);
      }
      const [lo, hi] = spec.arity;
      if (n.args.length < lo || n.args.length > hi) {
        throw new ExprError(`${n.fn}(${spec.signature}) takes ${lo === hi ? lo : `${lo}–${hi === Infinity ? 'many' : hi}`} argument(s), got ${n.args.length}`, n.start, n.end);
      }
      const args = n.args.map((a) => evalNode(a, env, stack));
      return wrap(() => spec.apply(args, n.args));
    }
  }
}

export interface EvalResult { t: Float64Array; v: Float64Array }

/** Parses and evaluates; the result must be a signal (a channel must appear). */
export function evaluate(src: string, env: EvalEnv): EvalResult {
  const v = evalNode(parse(src), env);
  if (v.k === 'signal') return { t: v.s.t, v: v.s.v };
  throw new ExprError(v.k === 'time' ? '"t" alone has no timestamps; combine it with a channel' : 'The expression is a constant; it needs at least one channel', 0, src.length);
}

export { sig };
