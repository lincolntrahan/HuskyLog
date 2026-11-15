import { CHAR_SIZE, FMT_LENGTH, FMT_TYPE, HEAD1, HEAD2 } from '../format';

/** Builds small synthetic DataFlash logs for unit tests. */
export interface TypeSpec { type: number; name: string; format: string; columns: string[] }

const enc = (s: string, len: number) => {
  const b = new Uint8Array(len);
  for (let i = 0; i < Math.min(len, s.length); i++) b[i] = s.charCodeAt(i);
  return b;
};

export class LogBuilder {
  private chunks: Uint8Array[] = [];
  private specs = new Map<number, TypeSpec>();

  fmt(spec: TypeSpec): this {
    this.specs.set(spec.type, spec);
    const len = 3 + [...spec.format].reduce((a, c) => a + CHAR_SIZE[c]!, 0);
    const m = new Uint8Array(FMT_LENGTH);
    m.set([HEAD1, HEAD2, FMT_TYPE, spec.type, len]);
    m.set(enc(spec.name, 4), 5);
    m.set(enc(spec.format, 16), 9);
    m.set(enc(spec.columns.join(','), 64), 25);
    this.chunks.push(m);
    return this;
  }

  msg(type: number, values: (number | bigint | string)[]): this {
    const spec = this.specs.get(type)!;
    const len = 3 + [...spec.format].reduce((a, c) => a + CHAR_SIZE[c]!, 0);
    const m = new Uint8Array(len);
    const dv = new DataView(m.buffer);
    m.set([HEAD1, HEAD2, type]);
    let o = 3;
    [...spec.format].forEach((ch, i) => {
      const v = values[i]!;
      switch (ch) {
        case 'b': dv.setInt8(o, Number(v)); break;
        case 'B': case 'M': dv.setUint8(o, Number(v)); break;
        case 'h': case 'c': dv.setInt16(o, Number(v), true); break;
        case 'H': case 'C': dv.setUint16(o, Number(v), true); break;
        case 'i': case 'e': case 'L': dv.setInt32(o, Number(v), true); break;
        case 'I': case 'E': dv.setUint32(o, Number(v), true); break;
        case 'f': dv.setFloat32(o, Number(v), true); break;
        case 'd': dv.setFloat64(o, Number(v), true); break;
        case 'q': dv.setBigInt64(o, BigInt(v), true); break;
        case 'Q': dv.setBigUint64(o, BigInt(v), true); break;
        case 'n': m.set(enc(String(v), 4), o); break;
        case 'N': m.set(enc(String(v), 16), o); break;
        case 'Z': m.set(enc(String(v), 64), o); break;
      }
      o += CHAR_SIZE[ch]!;
    });
    this.chunks.push(m);
    return this;
  }

  raw(bytes: number[]): this {
    this.chunks.push(Uint8Array.from(bytes));
    return this;
  }

  build(): Uint8Array {
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

/** Standard metadata types used by modern ArduPilot logs. */
export const META = {
  UNIT: { type: 177, name: 'UNIT', format: 'QbZ', columns: ['TimeUS', 'Id', 'Label'] },
  MULT: { type: 178, name: 'MULT', format: 'Qbd', columns: ['TimeUS', 'Id', 'Mult'] },
  FMTU: { type: 179, name: 'FMTU', format: 'QBNN', columns: ['TimeUS', 'FmtType', 'UnitIds', 'MultIds'] },
} satisfies Record<string, TypeSpec>;
