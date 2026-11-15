import { describe, expect, it } from 'vitest';
import { buildPalette, ColorMapper, GifEncoder, samplePixels } from './gif';

/** Minimal GIF decoder (test only): returns the composited index frames and delays. */
function decode(gif: Uint8Array) {
  let p = 0;
  const u8 = () => gif[p++]!;
  const u16 = () => { const v = gif[p]! | (gif[p + 1]! << 8); p += 2; return v; };
  const sig = String.fromCharCode(...gif.subarray(0, 6)); p = 6;
  const w = u16(), h = u16(), flags = u8(); u8(); u8();
  const pal = gif.subarray(p, p + 3 * (1 << ((flags & 7) + 1))); p += pal.length;
  const canvas = new Uint8Array(w * h);
  const frames: Uint8Array[] = [], delays: number[] = [];
  let loop = false, delay = 0;
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = u8();
      if (label === 0xf9) { u8(); u8(); delay = u16(); u8(); u8(); continue; }
      if (label === 0xff) loop = true;
      for (let n = u8(); n; n = u8()) p += n;
      continue;
    }
    if (b !== 0x2c) throw new Error(`bad block ${b}`);
    const x0 = u16(), y0 = u16(), fw = u16(), fh = u16(); u8();
    const min = u8();
    const data: number[] = [];
    for (let n = u8(); n; n = u8()) { for (let i = 0; i < n; i++) data.push(u8()); }
    // LZW decode
    const clear = 1 << min, eoi = clear + 1;
    let size = min + 1, dict: number[][] = [], prev: number[] | null = null;
    const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; size = min + 1; prev = null; };
    reset();
    const out: number[] = [];
    let acc = 0, bits = 0, k = 0;
    for (;;) {
      while (bits < size) { acc |= (data[k++] ?? 0) << bits; bits += 8; }
      const code = acc & ((1 << size) - 1); acc >>>= size; bits -= size;
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else if (prev) entry = [...prev, prev[0]!];
      else throw new Error('bad code');
      out.push(...entry);
      if (prev) { dict.push([...prev, entry[0]!]); if (dict.length === 1 << size && size < 12) size++; }
      prev = entry;
    }
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) canvas[(y0 + y) * w + x0 + x] = out[y * fw + x]!;
    frames.push(canvas.slice()); delays.push(delay);
  }
  return { sig, w, h, pal, frames, delays, loop };
}

const solid = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return d;
};

describe('gif encoder', () => {
  it('round-trips frames through LZW (incl. dictionary resets) with exact colours', () => {
    const w = 97, h = 61;
    // Noisy image: forces the dictionary past 4096 codes and a clear.
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const colours: [number, number, number][] = Array.from({ length: 200 }, (_, i) => [i, (i * 7) % 256, 255 - i]);
    const f1 = solid(w, h, () => colours[Math.floor(rnd() * colours.length)]!);
    const f2 = f1.slice();
    for (let y = 10; y < 20; y++) for (let x = 30; x < 45; x++) { const i = (y * w + x) * 4; f2[i] = 0; f2[i + 1] = 0; f2[i + 2] = 255; }
    const pal = buildPalette(samplePixels([f1, f2]));
    const enc = new GifEncoder(w, h, pal, 15);
    enc.addFrame(f1); enc.addFrame(f2); enc.addFrame(f2);
    const gif = enc.finish();
    const d = decode(gif);
    expect(d.sig).toBe('GIF89a');
    expect([d.w, d.h, d.frames.length, d.loop]).toEqual([w, h, 3, true]);
    const m = new ColorMapper(pal);
    const want = (rgba: Uint8Array) => { const o = new Uint8Array(w * h); m.map(rgba, o); return o; };
    expect(Buffer.compare(Buffer.from(d.frames[0]!), Buffer.from(want(f1)))).toBe(0);
    expect(Buffer.compare(Buffer.from(d.frames[1]!), Buffer.from(want(f2)))).toBe(0);
    expect(Buffer.compare(Buffer.from(d.frames[2]!), Buffer.from(want(f2)))).toBe(0);
    // 200 distinct colours fit the palette exactly.
    const c = colours[17]!, k = m.index(...c);
    expect([d.pal[k * 3], d.pal[k * 3 + 1], d.pal[k * 3 + 2]]).toEqual(c);
  });

  it('stores only the changed rectangle and keeps the average frame rate', () => {
    const w = 200, h = 100;
    const frames = Array.from({ length: 30 }, (_, i) => solid(w, h, (x) => (x === 50 + i ? [255, 255, 255] : [20, 30, 40])));
    const enc = new GifEncoder(w, h, buildPalette(samplePixels(frames)), 15);
    for (const f of frames) enc.addFrame(f);
    const gif = enc.finish();
    const d = decode(gif);
    expect(d.frames.length).toBe(30);
    expect(d.delays.reduce((a, b) => a + b, 0)).toBe(200);          // 30 frames at 15 fps = 2.00 s
    expect(gif.length).toBeLessThan(6000);                            // small: only a 2-column strip changes
  });

  it('builds a palette that separates distinct colours', () => {
    const pal = buildPalette(samplePixels([solid(10, 10, (x) => (x < 5 ? [255, 0, 0] : [0, 0, 255]))]), 4);
    const cols = [0, 1, 2, 3].map((k) => [pal[k * 3], pal[k * 3 + 1], pal[k * 3 + 2]].join(','));
    expect(cols).toContain('255,0,0');
    expect(cols).toContain('0,0,255');
  });
});
