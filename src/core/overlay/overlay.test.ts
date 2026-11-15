import { describe, expect, it } from 'vitest';
import { formatValue, isValidFormat } from './format';
import { dragRect, snapRect, toPx } from './rect';

describe('formatValue', () => {
  it('handles the common conversions', () => {
    expect(formatValue(3.14159, '%.1f')).toBe('3.1');
    expect(formatValue(3.6, '%d')).toBe('4');
    expect(formatValue(-2.5, '%+.2f')).toBe('-2.50');
    expect(formatValue(2.5, '%+.2f')).toBe('+2.50');
    expect(formatValue(7.25, '%06.2f')).toBe('007.25');
    expect(formatValue(-7.25, '%07.2f')).toBe('-007.25');
    expect(formatValue(1234567.8, '%,.1f')).toBe('1,234,567.8');
    expect(formatValue(12345, '%.2e')).toBe('1.23e+4');
    expect(formatValue(0.000123456, '%.3g')).toBe('0.000123');
    expect(formatValue(255, '%x')).toBe('ff');
    expect(formatValue(5, '%5d')).toBe('    5');
    expect(formatValue(5, '%-3d|')).toBe('5  |');
  });
  it('keeps literal text and %%', () => {
    expect(formatValue(42.123, 'Alt %.0f m')).toBe('Alt 42 m');
    expect(formatValue(80, '%.0f%%')).toBe('80%');
  });
  it('shows a dash for missing values', () => {
    expect(formatValue(NaN, '%.1f')).toBe('–');
    expect(formatValue(Infinity, '%.1f')).toBe('∞');
  });
  it('validates formats', () => {
    expect(isValidFormat('%.1f')).toBe(true);
    expect(isValidFormat('100%%')).toBe(false);
    expect(isValidFormat('abc')).toBe(false);
  });
});

describe('overlay rects', () => {
  const r = { x: 0.1, y: 0.1, w: 0.3, h: 0.2 };
  it('moves inside the host', () => {
    expect(dragRect(r, 'move', 0.05, 0.05)).toEqual({ x: 0.15000000000000002, y: 0.15000000000000002, w: 0.3, h: 0.2 });
    const far = dragRect(r, 'move', 5, -5);
    expect(far.x).toBeCloseTo(0.7); expect(far.y).toBe(0);
  });
  it('resizes from corners and edges with a minimum size', () => {
    const se = dragRect(r, 'se', 0.1, 0.1);
    expect(se.w).toBeCloseTo(0.4); expect(se.h).toBeCloseTo(0.3); expect(se.x).toBeCloseTo(0.1);
    const nw = dragRect(r, 'nw', -0.05, -0.05);
    expect(nw.x).toBeCloseTo(0.05); expect(nw.w).toBeCloseTo(0.35);
    const tiny = dragRect(r, 'w', 1, 0);
    expect(tiny.w).toBeCloseTo(0.03); expect(tiny.x + tiny.w).toBeCloseTo(0.4);
    const out = dragRect(r, 'e', 5, 0);
    expect(out.x + out.w).toBe(1);
  });
  it('maps to pixels and snaps to edges and centre', () => {
    expect(toPx(r, 1000, 500)).toEqual({ x: 100, y: 50, w: 300, h: 100 });
    expect(snapRect({ x: 0.005, y: 0.4, w: 0.2, h: 0.2 }).x).toBe(0);
    expect(snapRect({ x: 0.795, y: 0.4, w: 0.2, h: 0.2 }).x).toBeCloseTo(0.8);
    expect(snapRect({ x: 0.395, y: 0.1, w: 0.2, h: 0.2 }).x).toBeCloseTo(0.4); // centred
  });
});

import { NO_ZOOM, cropRect, panBy, zoomAt } from './zoom';
describe('video zoom', () => {
  it('keeps the point under the cursor fixed', () => {
    const z = zoomAt(NO_ZOOM, 0.25, 0.75, 2);
    expect(z.s).toBe(2);
    // frame point under the cursor before: (0.25, 0.75); after: x + cx / s
    expect(z.x + 0.25 / z.s).toBeCloseTo(0.25);
    expect(z.y + 0.75 / z.s).toBeCloseTo(0.75);
  });
  it('clamps zoom and pan to the frame', () => {
    expect(zoomAt(NO_ZOOM, 0.5, 0.5, 0.5)).toEqual(NO_ZOOM);
    expect(zoomAt(NO_ZOOM, 0.5, 0.5, 100).s).toBe(8);
    const z = panBy({ s: 2, x: 0.25, y: 0.25 }, 10, -10);
    expect(z).toEqual({ s: 2, x: 0.5, y: 0 });
  });
  it('gives the export crop rect', () => {
    expect(cropRect({ s: 4, x: 0.5, y: 0.25 }, 1920, 1080)).toEqual({ x: 960, y: 270, w: 480, h: 270 });
  });
});
