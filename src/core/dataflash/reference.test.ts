/**
 * Golden checks against the team's reference log (DESIGN §12.1). The log is not
 * committed; put it at test-data/logs/reference.bin or set HUSKYLOG_REF_LOG.
 * Expected values were cross-checked with an independent throwaway decoder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexLog } from './indexer';
import { decodeRows, decodeType, extractFiles } from './decoder';
import { paramChanges, paramsAt, summarize } from './summary';

const path = process.env['HUSKYLOG_REF_LOG'] ?? resolve(__dirname, '../../../test-data/logs/reference.bin');
const have = existsSync(path);

describe.skipIf(!have)('reference log (ArduPlane 4.7.2)', () => {
  const bytes = have ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const t = performance.now();
  const idx = indexLog(bytes);
  const indexMs = performance.now() - t;
  const sum = summarize(bytes, idx);
  const val = (type: string, field: string, i = 0, inst = 0) => {
    const s = decodeType(bytes, idx, type).find((x) => x.instance === null || x.instance === inst)!;
    return s.fields[field]![i]!;
  };

  it('indexes the whole file quickly with no corruption', () => {
    expect(idx.formats.size).toBe(184);
    expect(idx.stats.size).toBe(64);
    expect(idx.skippedBytes).toBe(0);
    expect(idx.truncatedTail).toBe(24);
    expect(idx.outOfOrder).toBeGreaterThan(100_000); // messages are not globally time-ordered
    expect(indexMs).toBeLessThan(3000);
  });

  it('identifies the vehicle, firmware and board', () => {
    expect(sum.vehicle).toBe('plane');
    expect(sum.firmware).toContain('ArduPlane V4.7.2');
    expect(sum.board).toBe('MatekH743-bdshot');
  });

  it('decodes GPS with correct scaling', () => {
    expect(val('GPS', 'Lat')).toBeCloseTo(47.6605652, 7);
    expect(val('GPS', 'Lng')).toBeCloseTo(-122.1053396, 7);
    expect(val('GPS', 'Alt')).toBeCloseTo(2.27, 2);
    expect(val('GPS', 'HDop')).toBeCloseTo(0.71, 2); // H × 0.01 from FMTU
    expect(val('GPS', 'GMS')).toBeCloseTo(509411.6, 1); // I × 0.001 → seconds
    expect(val('GPS', 'NSats')).toBe(18);
  });

  it('never double-scales implied-scale fields (CTUN.Roll ≈ ATT.Roll)', () => {
    const ctun = decodeType(bytes, idx, 'CTUN')[0]!;
    const att = decodeType(bytes, idx, 'ATT')[0]!;
    const i = ctun.time.findIndex((x) => x > 450); // in flight
    const j = att.time.findIndex((x) => x >= ctun.time[i]!);
    expect(Math.abs(ctun.fields['Roll']![i]!)).toBeGreaterThan(1);
    // Different estimators sampled at slightly different times: within a few
    // degrees. A double-scaling bug would be off by 100×.
    expect(Math.abs(ctun.fields['Roll']![i]! - att.fields['Roll']![j]!)).toBeLessThan(3);
  });

  it('finds instances from FMTU (including easy-to-miss ones)', () => {
    const inst = (name: string) => [...(idx.stats.get(idx.byName.get(name)!.type)!.instances?.keys() ?? [])].sort();
    expect(inst('IMU')).toEqual([0, 1]);
    expect(inst('BAT')).toEqual([0, 1]);
    expect(inst('XKF1')).toEqual([0, 1]);
    expect(idx.byName.get('XKFM')!.instanceCol).toBeDefined();
    expect(idx.byName.get('STAK')!.instanceCol).toBeDefined();
    expect(sum.channels.some((c) => c.id === 'IMU[1].AccZ')).toBe(true);
    expect(sum.channels.some((c) => c.id === 'ATT.Roll' && c.unit === '°')).toBe(true);
  });

  it('per-series time is monotonic once split by instance', () => {
    for (const name of ['IMU', 'XKFM', 'XKT', 'ATT', 'BAT']) {
      for (const s of decodeType(bytes, idx, name)) {
        for (let k = 1; k < s.time.length; k++) expect(s.time[k]! >= s.time[k - 1]!).toBe(true);
      }
    }
  });

  it('extracts modes, arming and events with correct times', () => {
    expect(sum.modes.map((m) => [m.name, +m.t0.toFixed(2)])).toEqual([['MANUAL', 4.37], ['RTL', 417.95], ['MANUAL', 484.39]]);
    expect(sum.armed.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)])).toEqual([[309.55, 520.93]]);
    expect(sum.events.find((e) => e.kind === 'MSG')!.text).toContain('ArduPlane V4.7.2');
  });

  it('labels RCOU channels from SERVOn_FUNCTION (throttle is C1)', () => {
    expect(sum.channels.find((c) => c.id === 'RCOU.C1')!.label).toBe('Throttle');
    const p = paramsAt(sum.params, 400);
    expect(p.get('SERVO1_FUNCTION')!.value).toBe(70);
  });

  it('tracks parameter changes and hides housekeeping ones', () => {
    expect(new Set(sum.params.map((p) => p.name)).size).toBe(1248);
    expect(paramChanges(sum.params, true).length).toBe(98);
    expect(paramChanges(sum.params).every((c) => !c.name.startsWith('STAT_') && !c.name.includes('GND_PRESS'))).toBe(true);
  });

  it('decodes the motor spin-up (sync-relevant timings)', () => {
    const esc = decodeType(bytes, idx, 'ESC')[0]!;
    const first = esc.fields['RPM']!.findIndex((r, i) => r > 0 && esc.time[i]! > 300);
    expect(esc.time[first]).toBeCloseTo(313.99, 1); // first non-zero reading
    const k = esc.fields['RPM']!.findIndex((r, i) => r > 500 && esc.time[i]! > 300);
    expect(esc.time[k]).toBeCloseTo(314.11, 1);
    expect(esc.fields['RPM']![k]).toBeCloseTo(814, -1);
  });

  it('extracts embedded files', () => {
    const files = extractFiles(bytes, idx);
    expect([...files.keys()]).toContain('@ROMFS/hwdef.dat');
    expect(new TextDecoder().decode(files.get('@SYS/uarts.txt')!).startsWith('UARTV1')).toBe(true);
  });

  it('decodes rows with strings (PARM)', () => {
    const parm = decodeRows(bytes, idx, 'PARM');
    expect(parm.find((r) => r['Name'] === 'SERVO1_FUNCTION')!['Value']).toBe(70);
  });
});
