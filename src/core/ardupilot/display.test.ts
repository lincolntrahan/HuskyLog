import { describe, expect, it } from 'vitest';
import { fieldDisplay } from './display';

describe('field display conversions', () => {
  it('AETR aileron/elevator/rudder/steer: ±4500 → 1000…2000 µs', () => {
    for (const f of ['Ail', 'Elev', 'Rudd', 'Steer']) {
      const d = fieldDisplay('AETR', f)!;
      expect(d.unit).toBe('us');
      expect(d.f(-4500)).toBe(1000);
      expect(d.f(0)).toBe(1500);
      expect(d.f(4500)).toBe(2000);
    }
  });
  it('AETR throttle: 0…100 % → 1000…2000 µs', () => {
    const d = fieldDisplay('AETR', 'Thr')!;
    expect([d.f(0), d.f(50), d.f(100)]).toEqual([1000, 1500, 2000]);
  });
  it('leaves everything else alone', () => {
    expect(fieldDisplay('AETR', 'Flap')).toBeNull();
    expect(fieldDisplay('ATT', 'Roll')).toBeNull();
  });
});
