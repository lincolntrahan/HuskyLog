import { IMPLIED_SCALE, STRING_CHARS, isNumericChar, readNumber, readString } from './format';
import { displayUnit } from './units';
import type { DecodedSeries, FormatDef, LogIndex, Row } from './types';

/** Scale applied to a raw column value (DESIGN §12.1 rules 2–3). */
export function columnScale(index: LogIndex, def: FormatDef, col: number): number {
  const ch = def.format[col]!;
  if (ch in IMPLIED_SCALE) return IMPLIED_SCALE[ch]!;
  const id = def.multIds?.[col];
  if (!id || id === '-' || id === '?') return 1;
  return index.multValues.get(id) ?? 1;
}

export function columnUnit(index: LogIndex, def: FormatDef, col: number): string {
  const id = def.unitIds?.[col];
  if (!id || id === '-' || id === '#') return '';
  return displayUnit(index.unitLabels.get(id) ?? '');
}

/**
 * Decodes every numeric field of one message type into typed arrays, split by
 * instance (IMU[0], IMU[1], …). Time is seconds. Values are fully scaled.
 */
export function decodeType(bytes: Uint8Array, index: LogIndex, typeName: string): DecodedSeries[] {
  const def = index.byName.get(typeName);
  if (!def) return [];
  const offs = index.offsets.get(def.type);
  if (!offs || offs.length === 0) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const cols: number[] = [];
  for (let c = 0; c < def.format.length; c++) {
    if (c === def.timeCol || c === def.instanceCol) continue;
    if (isNumericChar(def.format[c]!)) cols.push(c);
  }

  // Group rows by instance.
  const n = offs.length;
  const instOf = new Float64Array(n);
  const groups = new Map<number, number>(); // instance → count
  if (def.instanceCol !== undefined) {
    const ic = def.instanceCol, ch = def.format[ic]!, fo = def.offsets[ic]!;
    for (let k = 0; k < n; k++) {
      const v = readNumber(dv, offs[k]! + 3 + fo, ch);
      instOf[k] = v;
      groups.set(v, (groups.get(v) ?? 0) + 1);
    }
  } else {
    groups.set(0, n);
  }

  const out = new Map<number, { s: DecodedSeries; fill: number }>();
  const units: Record<string, string> = {};
  for (const c of cols) units[def.columns[c]!] = columnUnit(index, def, c);
  for (const [inst, count] of [...groups].sort((a, b) => a[0] - b[0])) {
    const fields: Record<string, Float64Array> = {};
    for (const c of cols) fields[def.columns[c]!] = new Float64Array(count);
    out.set(inst, {
      s: { type: def.name, instance: def.instanceCol !== undefined ? inst : null, time: new Float64Array(count), fields, units },
      fill: 0,
    });
  }

  const scales = cols.map((c) => columnScale(index, def, c));
  const tc = def.timeCol, tch = tc !== undefined ? def.format[tc]! : '', tfo = tc !== undefined ? def.offsets[tc]! : 0;
  const tscale = def.timeScale ?? 1;
  for (let k = 0; k < n; k++) {
    const g = out.get(def.instanceCol !== undefined ? instOf[k]! : 0)!;
    const body = offs[k]! + 3;
    const r = g.fill++;
    g.s.time[r] = tc !== undefined ? readNumber(dv, body + tfo, tch) * tscale : k;
    for (let j = 0; j < cols.length; j++) {
      const c = cols[j]!;
      g.s.fields[def.columns[c]!]![r] = readNumber(dv, body + def.offsets[c]!, def.format[c]!) * scales[j]!;
    }
  }
  return [...out.values()].map((g) => g.s);
}

/** Decodes a (small) message type into row objects, including strings.
 *  Used for PARM, MSG, MODE, EV, ARM, VER, CMD, FILE … */
export function decodeRows(bytes: Uint8Array, index: LogIndex, typeName: string): Row[] {
  const def = index.byName.get(typeName);
  const offs = def && index.offsets.get(def.type);
  if (!def || !offs) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scales = def.columns.map((_, c) => columnScale(index, def, c));
  const rows: Row[] = new Array(offs.length);
  for (let k = 0; k < offs.length; k++) {
    const body = offs[k]! + 3;
    const row: Row = { _t: NaN };
    for (let c = 0; c < def.format.length; c++) {
      const ch = def.format[c]!;
      const o = body + def.offsets[c]!;
      if (STRING_CHARS.has(ch)) row[def.columns[c]!] = readString(bytes, o, ch === 'n' ? 4 : ch === 'N' ? 16 : 64);
      else if (ch === 'a') continue;
      else row[def.columns[c]!] = readNumber(dv, o, ch) * (c === def.timeCol ? 1 : scales[c]!);
    }
    if (def.timeCol !== undefined) row._t = (row[def.columns[def.timeCol]!] as number) * def.timeScale!;
    rows[k] = row;
  }
  return rows;
}

/** Raw bytes of a FILE message's data (no TimeUS; offsets within the file). */
export function extractFiles(bytes: Uint8Array, index: LogIndex): Map<string, Uint8Array> {
  const def = index.byName.get('FILE');
  const offs = def && index.offsets.get(def.type);
  const files = new Map<string, { size: number; parts: [number, Uint8Array][] }>();
  if (!def || !offs) return new Map();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ci = (n: string) => def.columns.indexOf(n);
  const [cName, cOff, cLen, cData] = [ci('FileName'), ci('Offset'), ci('Length'), ci('Data')];
  for (const o of offs) {
    const body = o + 3;
    const name = readString(bytes, body + def.offsets[cName]!, 16);
    const off = readNumber(dv, body + def.offsets[cOff]!, def.format[cOff]!);
    const len = readNumber(dv, body + def.offsets[cLen]!, def.format[cLen]!);
    const start = body + def.offsets[cData]!;
    const f = files.get(name) ?? { size: 0, parts: [] };
    f.parts.push([off, bytes.slice(start, start + len)]);
    f.size = Math.max(f.size, off + len);
    files.set(name, f);
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, f] of files) {
    const buf = new Uint8Array(f.size);
    for (const [off, d] of f.parts) buf.set(d, off);
    out.set(name, buf);
  }
  return out;
}
