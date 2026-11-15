/**
 * ArduPilot DataFlash binary format primitives.
 * Every message: 0xA3 0x95 <type:uint8> <body…>. FMT (type 128) messages describe
 * every other type's name, length, field layout and column names.
 */

export const HEAD1 = 0xa3;
export const HEAD2 = 0x95;
export const FMT_TYPE = 128;
export const FMT_LENGTH = 89;

/** Byte size of each format character. */
export const CHAR_SIZE: Record<string, number> = {
  a: 64, b: 1, B: 1, h: 2, H: 2, i: 4, I: 4, f: 4, d: 8, n: 4, N: 16, Z: 64,
  c: 2, C: 2, e: 4, E: 4, L: 4, M: 1, q: 8, Q: 8,
};

/** Characters whose type already implies a fixed scale. For these the format
 *  character wins over any FMTU multiplier (DESIGN §12.1 rule 2). */
export const IMPLIED_SCALE: Record<string, number> = { c: 0.01, C: 0.01, e: 0.01, E: 0.01, L: 1e-7 };

export const STRING_CHARS = new Set(['n', 'N', 'Z']);
export const isNumericChar = (ch: string) => ch in CHAR_SIZE && !STRING_CHARS.has(ch) && ch !== 'a';

/** Reads one raw (unscaled) numeric field. */
export function readNumber(dv: DataView, off: number, ch: string): number {
  switch (ch) {
    case 'b': return dv.getInt8(off);
    case 'B': case 'M': return dv.getUint8(off);
    case 'h': case 'c': return dv.getInt16(off, true);
    case 'H': case 'C': return dv.getUint16(off, true);
    case 'i': case 'e': case 'L': return dv.getInt32(off, true);
    case 'I': case 'E': return dv.getUint32(off, true);
    case 'f': return dv.getFloat32(off, true);
    case 'd': return dv.getFloat64(off, true);
    case 'q': return Number(dv.getBigInt64(off, true));
    case 'Q': return Number(dv.getBigUint64(off, true));
    default: return NaN;
  }
}

export function readString(bytes: Uint8Array, off: number, len: number): string {
  let end = off;
  const stop = off + len;
  while (end < stop && bytes[end] !== 0) end++;
  let s = '';
  for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Field byte offsets within a message body (after the 3-byte header). */
export function fieldOffsets(format: string): number[] {
  const out: number[] = [];
  let o = 0;
  for (const ch of format) {
    out.push(o);
    o += CHAR_SIZE[ch] ?? 0;
  }
  return out;
}

/** MULT values are stored as float32 (0.1 → 0.10000000149). Snap them to the
 *  nearest power of ten, or to 6 significant figures for odd ones (3.6, 3600). */
export function cleanMultiplier(m: number): number {
  if (!Number.isFinite(m) || m === 0) return 1; // '-' is stored as 0 and means "none"
  const p = Math.round(Math.log10(Math.abs(m)));
  const decade = Math.sign(m) * 10 ** p;
  if (Math.abs(m - decade) <= Math.abs(decade) * 1e-6) return decade;
  return Number(m.toPrecision(6));
}
