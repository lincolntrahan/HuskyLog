import { describe, expect, it } from 'vitest';
import { adjustedSize, applyAdjust, cornerFreeCrop, isIdentity, NO_ADJUST, parseAdjust, rotateStep, type VideoAdjust } from './adjust';

/** A tiny 2D affine "context" to check where points land. */
class M {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  translate(x: number, y: number) { this.e += this.a * x + this.c * y; this.f += this.b * x + this.d * y; }
  scale(x: number, y: number) { this.a *= x; this.b *= x; this.c *= y; this.d *= y; }
  rotate(r: number) {
    const cs = Math.cos(r), sn = Math.sin(r);
    const { a, b, c, d } = this;
    this.a = a * cs + c * sn; this.b = b * cs + d * sn; this.c = -a * sn + c * cs; this.d = -b * sn + d * cs;
  }
  apply(x: number, y: number): [number, number] { return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f]; }
}
const A = (p: Partial<VideoAdjust>): VideoAdjust => ({ ...NO_ADJUST, ...p });
/** Where the source pixel (px, py) of a iw×ih frame lands in the output box (0,0,w,h). */
function land(iw: number, ih: number, a: VideoAdjust, w: number, h: number, px: number, py: number, fileRot = 0) {
  const m = new M();
  applyAdjust(m, iw, ih, fileRot, a, 0, 0, w, h);
  const [x, y] = m.apply(px - iw / 2, py - ih / 2);
  return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
}

describe('video adjust', () => {
  it('identity maps the frame onto the box', () => {
    expect(isIdentity(NO_ADJUST)).toBe(true);
    expect(land(200, 100, NO_ADJUST, 200, 100, 0, 0)).toEqual([0, 0]);
    expect(land(200, 100, NO_ADJUST, 400, 200, 200, 100)).toEqual([400, 200]);
  });
  it('rotates 90° clockwise: top-left goes to top-right, aspect swaps', () => {
    const a = A({ rot: 90 });
    expect(adjustedSize(200, 100, 0, a)).toEqual({ w: 100, h: 200 });
    expect(land(200, 100, a, 100, 200, 0, 0)).toEqual([100, 0]);
    expect(land(200, 100, a, 100, 200, 200, 0)).toEqual([100, 200]);
  });
  it('adds to the file rotation', () => {
    expect(adjustedSize(200, 100, 90, A({ rot: 90 }))).toEqual({ w: 200, h: 100 });
    expect(land(200, 100, A({ rot: 90 }), 200, 100, 0, 0, 90)).toEqual([200, 100]); // 180° in total
  });
  it('mirrors left/right as seen, after the rotation', () => {
    expect(land(200, 100, A({ flipH: true }), 200, 100, 0, 0)).toEqual([200, 0]);
    expect(land(200, 100, A({ flipV: true }), 200, 100, 0, 0)).toEqual([0, 100]);
    // Rotated 90° then mirrored: the top-left (which went to the top-right) comes back to the top-left.
    expect(land(200, 100, A({ rot: 90, flipH: true }), 100, 200, 0, 0)).toEqual([0, 0]);
  });
  it('crops: the crop rectangle fills the box', () => {
    const a = A({ crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } }); // top-right quarter
    expect(adjustedSize(200, 100, 0, a)).toEqual({ w: 100, h: 50 });
    expect(land(200, 100, a, 100, 50, 100, 0)).toEqual([0, 0]);
    expect(land(200, 100, a, 100, 50, 200, 50)).toEqual([100, 50]);
  });
  it('fine rotation turns about the centre, clockwise', () => {
    const [x, y] = land(200, 200, A({ fine: 90 }), 200, 200, 100, 0); // top centre → right centre
    expect([Math.round(x!), Math.round(y!)]).toEqual([200, 100]);
  });
  it('corner-free crop removes the black corners of a fine rotation', () => {
    const c = cornerFreeCrop(1600, 900, 10);
    // Every corner of the crop, turned back by −10°, must lie inside the 1600×900 picture (and one touches it).
    const t = (10 * Math.PI) / 180;
    const inside = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const x = (sx! * c.w * 1600) / 2, y = (sy! * c.h * 900) / 2;
      const u = x * Math.cos(t) + y * Math.sin(t), v = -x * Math.sin(t) + y * Math.cos(t);
      return Math.max(Math.abs(u) / 800, Math.abs(v) / 450);
    });
    expect(Math.max(...inside)).toBeCloseTo(1, 6);
    expect(c.x).toBeCloseTo((1 - c.w) / 2, 9);
    expect(cornerFreeCrop(1600, 900, 0).w).toBe(1);
  });
  it('steps and parses', () => {
    expect(rotateStep(0, -1)).toBe(270);
    expect(rotateStep(270, 1)).toBe(0);
    expect(parseAdjust({ rot: 90 })).toEqual(A({ rot: 90 }));
    expect(parseAdjust({ rot: 0 })).toBeUndefined();
    expect(parseAdjust({ rot: 45, fine: 99, crop: { x: 0.9, y: 0, w: 0.5, h: 1 } })).toEqual(A({ fine: 45, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }));
  });
});

describe('turnCrop', () => {
  it('keeps the same part of the picture when turning or mirroring', async () => {
    const { turnCrop } = await import('./adjust');
    const c = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    expect(turnCrop(c, 'cw')).toEqual({ x: 1 - 0.2 - 0.4, y: 0.1, w: 0.4, h: 0.3 });
    const back = turnCrop(turnCrop(c, 'cw'), 'ccw');
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(back[k]).toBeCloseTo(c[k], 12);
    expect(turnCrop(c, 'flipH').x).toBeCloseTo(0.6, 12);
    expect(turnCrop(c, 'flipV').y).toBeCloseTo(0.4, 12);
  });
});
