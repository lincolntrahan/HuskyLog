import { describe, expect, it } from 'vitest';
import { indexLog } from './indexer';
import { decodeRows, decodeType } from './decoder';
import { cleanMultiplier } from './format';
import { LogBuilder, META } from './testing/buildLog';

const CTUN = { type: 60, name: 'CTUN', format: 'QccH', columns: ['TimeUS', 'Roll', 'Pitch', 'HDop'] };
const IMU = { type: 61, name: 'IMU', format: 'QBf', columns: ['TimeUS', 'I', 'AccZ'] };
const MSG = { type: 62, name: 'MSG', format: 'QZ', columns: ['TimeUS', 'Message'] };

function baseLog() {
  return new LogBuilder()
    .fmt(META.UNIT).fmt(META.MULT).fmt(META.FMTU).fmt(CTUN).fmt(IMU).fmt(MSG)
    .msg(177, [0, 'd'.charCodeAt(0), 'deg']).msg(177, [0, 'o'.charCodeAt(0), 'm/s/s']).msg(177, [0, '#'.charCodeAt(0), 'instance'])
    .msg(178, [0, 'B'.charCodeAt(0), 0.009999999776482582]).msg(178, [0, '-'.charCodeAt(0), 0]).msg(178, [0, 'F'.charCodeAt(0), 1e-6])
    // CTUN: Roll/Pitch are 'c' AND FMTU says ×0.01 → must scale once. HDop 'H' × 0.01 via FMTU.
    .msg(179, [0, 60, 'sdd-', 'FBBB'])
    .msg(179, [0, 61, 's#o', 'F--']);
}

describe('DataFlash indexer + decoder (synthetic)', () => {
  it('scales implied-scale chars once and applies FMTU multipliers to plain ints', () => {
    const b = baseLog().msg(60, [1_000_000n, 1234, -500, 71]).msg(60, [2_000_000n, 1300, -400, 80]).build();
    const idx = indexLog(b);
    const [s] = decodeType(b, idx, 'CTUN');
    expect(Array.from(s!.time)).toEqual([1, 2]);
    expect(s!.fields['Roll']![0]).toBeCloseTo(12.34, 6); // not 0.1234
    expect(s!.fields['Pitch']![1]).toBeCloseTo(-4.0, 6);
    expect(s!.fields['HDop']![0]).toBeCloseTo(0.71, 6);
    expect(s!.units['Roll']).toBe('°');
  });

  it('splits instanced types by the FMTU "#" field', () => {
    const b = baseLog()
      .msg(61, [1_000_000n, 0, -9.8]).msg(61, [1_000_000n, 1, -9.7]).msg(61, [1_010_000n, 0, -9.9])
      .build();
    const idx = indexLog(b);
    const series = decodeType(b, idx, 'IMU');
    expect(series.map((s) => s.instance)).toEqual([0, 1]);
    expect(series[0]!.time.length).toBe(2);
    expect(series[1]!.fields['AccZ']![0]).toBeCloseTo(-9.7, 5);
    expect(series[0]!.units['AccZ']).toBe('m/s²');
    expect(idx.stats.get(61)!.instances!.get(0)).toBe(2);
  });

  it('resyncs over junk bytes and tolerates a truncated tail', () => {
    const good = baseLog().msg(62, [5_000_000n, 'hello']).build();
    const bad = new LogBuilder().raw([...good, 0x00, 0xa3, 0x13, 0x37]).build();
    const withMore = new Uint8Array([...bad, ...new LogBuilder().fmt(MSG).build().slice(0, 0)]);
    const idx = indexLog(withMore);
    expect(decodeRows(withMore, idx, 'MSG')[0]!['Message']).toBe('hello');
    // A half-written final message:
    const msg = new LogBuilder().fmt(MSG).msg(62, [6_000_000n, 'world']).build().slice(89);
    const trunc = new Uint8Array([...good, ...msg.slice(0, 20)]);
    const idx2 = indexLog(trunc);
    expect(idx2.truncatedTail).toBe(20);
    expect(decodeRows(trunc, idx2, 'MSG').length).toBe(1);
  });

  it('cleans float32 multipliers and treats "-" (0) as no multiplier', () => {
    expect(cleanMultiplier(0.10000000149011612)).toBe(0.1);
    expect(cleanMultiplier(1.0000000116860974e-7)).toBe(1e-7);
    expect(cleanMultiplier(3.5999999046325684)).toBe(3.6);
    expect(cleanMultiplier(0)).toBe(1);
  });
});
