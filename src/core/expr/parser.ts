/**
 * Expression language (DESIGN §8): a small Pratt parser producing an AST with
 * source positions, so errors can point at the offending text.
 *
 *   ATT.Roll - ATT.DesRoll
 *   sqrt(IMU[1].AccX^2 + IMU[1].AccY^2)
 *   ARSP.Airspeed > 15 ? CTUN.ThO : 0
 */

export type Node =
  | { k: 'num'; value: number; start: number; end: number }
  | { k: 'chan'; id: string; start: number; end: number }         // ATT.Roll, IMU[1].AccZ
  | { k: 'name'; name: string; start: number; end: number }       // named expression / constant / t
  | { k: 'call'; fn: string; args: Node[]; start: number; end: number }
  | { k: 'unary'; op: '-' | '+' | '!'; arg: Node; start: number; end: number }
  | { k: 'bin'; op: BinOp; a: Node; b: Node; start: number; end: number }
  | { k: 'tern'; cond: Node; a: Node; b: Node; start: number; end: number };

export type BinOp = '+' | '-' | '*' | '/' | '%' | '^' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||';

export class ExprError extends Error {
  constructor(message: string, readonly start: number, readonly end: number) {
    super(message);
    this.name = 'ExprError';
  }
}

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'id'; v: string; s: number; e: number }   // identifier or channel path
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'eof'; s: number; e: number };

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '^', '<', '>', '!', '?', ':', '(', ')', ','];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const s = i;
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}"`, i, i + 1);
      i += m[0].length;
      out.push({ t: 'num', v: Number(m[0]), s, e: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      // identifier, optional [instance], optional .field  → channel path
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (/\[/.test(m[0]) && !m[0].includes('.')) throw new ExprError(`"${m[0]}" needs a field, e.g. ${m[0]}.AccZ`, s, i);
      out.push({ t: 'id', v: m[0], s, e: i });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`Unexpected "${c}"`, i, i + 1);
    i += op.length;
    out.push({ t: 'op', v: op, s, e: i });
  }
  out.push({ t: 'eof', s: src.length, e: src.length });
  return out;
}

// Binding powers (higher binds tighter). ^ is right-associative and binds
// tighter than unary minus, so -2^2 = -4 as in maths.
const INFIX: Record<string, [number, number]> = {
  '||': [2, 3], '&&': [4, 5],
  '==': [6, 7], '!=': [6, 7],
  '<': [8, 9], '<=': [8, 9], '>': [8, 9], '>=': [8, 9],
  '+': [10, 11], '-': [10, 11],
  '*': [12, 13], '/': [12, 13], '%': [12, 13],
  '^': [17, 16],
};
const PREFIX_BP = 14;
const TERNARY_BP = 1;

export function parse(src: string): Node {
  if (!src.trim()) throw new ExprError('Empty expression', 0, src.length);
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const expectOp = (v: string) => {
    const tk = next();
    if (tk.t !== 'op' || tk.v !== v) throw new ExprError(tk.t === 'eof' ? `Missing "${v}"` : `Expected "${v}"`, tk.s, Math.max(tk.e, tk.s + 1));
    return tk;
  };

  const primary = (): Node => {
    const tk = next();
    if (tk.t === 'num') return { k: 'num', value: tk.v, start: tk.s, end: tk.e };
    if (tk.t === 'id') {
      const nx = peek();
      if (nx.t === 'op' && nx.v === '(') {
        if (tk.v.includes('.')) throw new ExprError(`"${tk.v}" is a channel, not a function`, tk.s, tk.e);
        next();
        const args: Node[] = [];
        if (!(peek().t === 'op' && (peek() as { v: string }).v === ')')) {
          for (;;) {
            args.push(expr(0));
            const sep = peek();
            if (sep.t === 'op' && sep.v === ',') { next(); continue; }
            break;
          }
        }
        const close = expectOp(')');
        return { k: 'call', fn: tk.v, args, start: tk.s, end: close.e };
      }
      return tk.v.includes('.') ? { k: 'chan', id: tk.v, start: tk.s, end: tk.e } : { k: 'name', name: tk.v, start: tk.s, end: tk.e };
    }
    if (tk.t === 'op' && (tk.v === '-' || tk.v === '+' || tk.v === '!')) {
      const arg = expr(PREFIX_BP);
      return { k: 'unary', op: tk.v, arg, start: tk.s, end: arg.end };
    }
    if (tk.t === 'op' && tk.v === '(') {
      const inner = expr(0);
      expectOp(')');
      return inner;
    }
    if (tk.t === 'eof') throw new ExprError('Expression ends too early', tk.s, tk.s);
    throw new ExprError(`Unexpected "${tk.v}"`, tk.s, tk.e);
  };

  const expr = (minBp: number): Node => {
    let lhs = primary();
    for (;;) {
      const op = peek();
      if (op.t !== 'op') {
        if (op.t === 'eof') break;
        throw new ExprError(`Expected an operator before "${(op as { v: unknown }).v}"`, op.s, op.e);
      }
      if (op.v === '?') {
        if (TERNARY_BP < minBp) break;
        next();
        const a = expr(0);
        expectOp(':');
        const b = expr(TERNARY_BP); // right-associative
        lhs = { k: 'tern', cond: lhs, a, b, start: lhs.start, end: b.end };
        continue;
      }
      const bp = INFIX[op.v];
      if (!bp) break; // ) , : handled by callers
      const [l, r] = bp;
      if (l < minBp) break;
      next();
      const rhs = expr(r);
      lhs = { k: 'bin', op: op.v as BinOp, a: lhs, b: rhs, start: lhs.start, end: rhs.end };
    }
    return lhs;
  };

  const root = expr(0);
  const rest = peek();
  if (rest.t !== 'eof') throw new ExprError(`Unexpected "${(rest as { v: unknown }).v}"`, rest.s, rest.e);
  return root;
}

/** Channel ids and names referenced by an AST. */
export function references(n: Node, chans = new Set<string>(), names = new Set<string>()): { chans: Set<string>; names: Set<string> } {
  switch (n.k) {
    case 'chan': chans.add(n.id); break;
    case 'name': names.add(n.name); break;
    case 'call': n.args.forEach((a) => references(a, chans, names)); break;
    case 'unary': references(n.arg, chans, names); break;
    case 'bin': references(n.a, chans, names); references(n.b, chans, names); break;
    case 'tern': references(n.cond, chans, names); references(n.a, chans, names); references(n.b, chans, names); break;
  }
  return { chans, names };
}
