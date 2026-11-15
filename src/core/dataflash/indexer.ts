import {
  FMT_LENGTH, FMT_TYPE, HEAD1, HEAD2, cleanMultiplier, fieldOffsets, readNumber, readString,
} from './format';
import type { FormatDef, LogIndex, TypeStats } from './types';

const FMT_DEF: FormatDef = {
  type: FMT_TYPE, name: 'FMT', length: FMT_LENGTH, format: 'BBnNZ',
  columns: ['Type', 'Length', 'Name', 'Format', 'Columns'], offsets: fieldOffsets('BBnNZ'),
};

/**
 * Single streaming pass over a DataFlash log:
 *  - learns formats (FMT), units (UNIT), multipliers (MULT) and FMTU mappings
 *  - records the byte offset of every message, per type
 *  - resyncs over corrupt bytes and tolerates a truncated final message
 * Field values are decoded later, per type, on demand (see decoder.ts).
 */
export function indexLog(bytes: Uint8Array, onProgress?: (fraction: number) => void): LogIndex {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  const formats = new Map<number, FormatDef>([[FMT_TYPE, FMT_DEF]]);
  const lists = new Map<number, number[]>();
  const fmtu = new Map<number, { units: string; mults: string }>();
  const unitLabels = new Map<string, string>();
  const multValues = new Map<string, number>();
  let skipped = 0, tail = 0, outOfOrder = 0, lastT = -Infinity;
  let nextProgress = 0;

  const validHeaderAt = (j: number) =>
    j + 2 < n && bytes[j] === HEAD1 && bytes[j + 1] === HEAD2 && formats.has(bytes[j + 2]!);
  let junkFrom = Infinity; // memo: no valid header exists at or after this offset
  const onlyJunkAfter = (j: number) => {
    if (j >= junkFrom) return true;
    for (let k = j; k + 2 < n; k++) if (validHeaderAt(k)) return false;
    junkFrom = j;
    return true;
  };

  let i = 0;
  while (i + 3 <= n) {
    if (!validHeaderAt(i)) { i++; skipped++; continue; }
    const type = bytes[i + 2]!;
    const def = formats.get(type)!;
    const end = i + def.length;
    if (end > n) { tail = n - i; break; }
    // Corruption guard: the next message should start right after this one.
    // If it doesn't, accept this message only when no valid header follows at
    // all (trailing junk/padding at the end of the file); otherwise we are
    // probably misaligned on a false header, so resync.
    if (end + 3 <= n && !(bytes[end] === HEAD1 && bytes[end + 1] === HEAD2) && !onlyJunkAfter(end)) {
      i++; skipped++; continue;
    }
    const body = i + 3;

    if (type === FMT_TYPE) {
      const t = bytes[body]!;
      const fmt = readString(bytes, body + 6, 16);
      const def2: FormatDef = {
        type: t, name: readString(bytes, body + 2, 4), length: bytes[body + 1]!, format: fmt,
        columns: readString(bytes, body + 22, 64).split(','), offsets: fieldOffsets(fmt),
      };
      formats.set(t, def2);
    } else {
      let arr = lists.get(type);
      if (!arr) lists.set(type, (arr = []));
      arr.push(i);
      // Metadata messages, decoded immediately.
      if (def.name === 'FMTU') {
        const ft = readNumber(dv, body + def.offsets[1]!, def.format[1]!);
        fmtu.set(ft, { units: readString(bytes, body + def.offsets[2]!, 16), mults: readString(bytes, body + def.offsets[3]!, 16) });
      } else if (def.name === 'UNIT') {
        unitLabels.set(String.fromCharCode(bytes[body + def.offsets[1]!]!), readString(bytes, body + def.offsets[2]!, 64));
      } else if (def.name === 'MULT') {
        multValues.set(String.fromCharCode(bytes[body + def.offsets[1]!]!), readNumber(dv, body + def.offsets[2]!, 'd'));
      }
      if (def.format[0] === 'Q' && def.columns[0] === 'TimeUS') {
        const t = Number(dv.getBigUint64(body, true)) / 1e6;
        if (t < lastT) outOfOrder++; // behind the latest time seen so far
        else lastT = t;
      }
    }
    i = end;
    if (onProgress && i >= nextProgress) { onProgress(i / n); nextProgress = i + 4_000_000; }
  }

  // Attach FMTU info, instance and time columns.
  for (const def of formats.values()) {
    const u = fmtu.get(def.type);
    if (u) {
      def.unitIds = u.units;
      def.multIds = u.mults;
      const k = u.units.indexOf('#');
      if (k >= 0) def.instanceCol = k;
    }
    const tUs = def.columns.indexOf('TimeUS');
    const tMs = def.columns.indexOf('TimeMS');
    if (tUs >= 0) { def.timeCol = tUs; def.timeScale = 1e-6; }
    else if (tMs >= 0) { def.timeCol = tMs; def.timeScale = 1e-3; }
  }
  for (const [k, v] of multValues) multValues.set(k, cleanMultiplier(v));

  const offsets = new Map<number, Uint32Array>();
  const stats = new Map<number, TypeStats>();
  let t0 = Infinity, t1 = -Infinity;
  for (const [type, arr] of lists) {
    const def = formats.get(type)!;
    const off = Uint32Array.from(arr);
    offsets.set(type, off);
    const st: TypeStats = { count: off.length, firstTime: NaN, lastTime: NaN };
    if (def.timeCol !== undefined) {
      const tc = def.timeCol, ch = def.format[tc]!, fo = def.offsets[tc]!;
      st.firstTime = readNumber(dv, off[0]! + 3 + fo, ch) * def.timeScale!;
      st.lastTime = readNumber(dv, off[off.length - 1]! + 3 + fo, ch) * def.timeScale!;
      // FMTU/UNIT/MULT/PARM bursts at boot are not part of the flight timeline.
      if (!['FMTU', 'UNIT', 'MULT', 'FMT'].includes(def.name)) {
        t0 = Math.min(t0, st.firstTime);
        t1 = Math.max(t1, st.lastTime);
      }
    }
    if (def.instanceCol !== undefined) {
      const ic = def.instanceCol, ch = def.format[ic]!, fo = def.offsets[ic]!;
      const inst = new Map<number, number>();
      for (let k = 0; k < off.length; k++) {
        const v = readNumber(dv, off[k]! + 3 + fo, ch);
        inst.set(v, (inst.get(v) ?? 0) + 1);
      }
      st.instances = inst;
    }
    stats.set(type, st);
  }

  const byName = new Map<string, FormatDef>();
  for (const def of formats.values()) byName.set(def.name, def);
  onProgress?.(1);
  return {
    size: n, formats, byName, offsets, stats, unitLabels, multValues,
    skippedBytes: skipped, truncatedTail: tail, outOfOrder,
    timeRange: [Number.isFinite(t0) ? t0 : 0, Number.isFinite(t1) ? t1 : 0],
  };
}
