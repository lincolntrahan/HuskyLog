/** Physical sanity checks of the expression engine on the reference log. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexLog } from '../dataflash/indexer';
import { decodeType } from '../dataflash/decoder';
import { rangeStats } from '../series/series';
import { evaluate, requirements, type Signal } from './evaluate';

const path = process.env['HUSKYLOG_REF_LOG'] ?? resolve(__dirname, '../../../test-data/logs/reference.bin');
const have = existsSync(path);

describe.skipIf(!have)('expressions on the reference log', () => {
  const bytes = have ? new Uint8Array(readFileSync(path)) : new Uint8Array();
  const idx = indexLog(bytes);
  const chan = (id: string): Signal => {
    const m = /^(\w+)(?:\[(\d+)\])?\.(\w+)$/.exec(id)!;
    const s = decodeType(bytes, idx, m[1]!).find((x) => x.instance === null || x.instance === Number(m[2] ?? 0))!;
    return { t: s.time, v: s.fields[m[3]!]! };
  };
  const run = (src: string, named: Record<string, string> = {}) => {
    const req = requirements(src, named);
    return evaluate(src, { channels: new Map(req.channels.map((c) => [c, chan(c)])), named });
  };

  it('integrate(BAT.Curr)/3600 matches the FC\'s own consumed-Ah counter', () => {
    const ah = run('integrate(BAT.Curr) / 3600');
    const tot = chan('BAT.CurrTot');
    const ours = ah.v[ah.v.length - 1]!;
    const fc = tot.v[tot.v.length - 1]! - tot.v[0]!;
    expect(fc).toBeGreaterThan(0.1);
    expect(Math.abs(ours - fc) / fc).toBeLessThan(0.02);
  });

  it('acceleration magnitude is 1 g at rest (mixed instance syntax)', () => {
    const g = run('sqrt(IMU[1].AccX^2 + IMU[1].AccY^2 + IMU[1].AccZ^2) / g');
    const s = rangeStats({ t: g.t, v: g.v }, 100, 200); // on the ground, disarmed
    expect(s.mean).toBeCloseTo(1, 1);
    expect(s.std).toBeLessThan(0.02);
  });

  it('deriv(BARO.Alt) tracks the logged climb rate BARO.CRt', () => {
    // CRt is filtered inside ArduPilot, so compare at low bandwidth: same sign,
    // same scale, strongly correlated (measured: r = 0.94, slope 0.93).
    const d = run('lowpass(deriv(BARO.Alt), 0.2)');
    const c = run('lowpass(BARO.CRt, 0.2)');
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < d.t.length; i++) {
      if (d.t[i]! < 330 || d.t[i]! > 500) continue; // in flight
      sxy += d.v[i]! * c.v[i]!; sxx += d.v[i]! ** 2; syy += c.v[i]! ** 2;
    }
    expect(sxy / Math.sqrt(sxx * syy)).toBeGreaterThan(0.9);
    expect(sxy / sxx).toBeGreaterThan(0.8);
    expect(sxy / sxx).toBeLessThan(1.2);
  });

  it('mixed-rate arithmetic uses the fastest channel (IMU 100 Hz vs ATT 25 Hz)', () => {
    const r = run('ATT.Roll + IMU.GyrX * 0');
    expect(r.t.length).toBe(chan('IMU.GyrX').t.length);
  });

  it('named expressions compose (power → energy)', () => {
    const named = { power: 'BAT.Volt * BAT.Curr', energy_Wh: 'integrate(power) / 3600' };
    const e = run('energy_Wh', named);
    const enr = chan('BAT.EnrgTot');
    const fc = enr.v[enr.v.length - 1]! - enr.v[0]!;
    expect(Math.abs(e.v[e.v.length - 1]! - fc) / fc).toBeLessThan(0.03);
  });
});
