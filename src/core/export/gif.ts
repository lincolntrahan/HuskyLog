/**
 * Small animated-GIF encoder for export (DESIGN §10). No dependency.
 *  - One global 256-colour palette (median cut over pixels sampled from all
 *    frames: the "two pass" palette), so colours don't flicker between frames.
 *  - Nearest-colour mapping through a 32×32×32 lookup cache.
 *  - Each frame stores only the rectangle that changed since the previous
 *    frame (graphs and HUDs change in small areas), LZW-compressed.
 *  - Frame delays in 1/100 s, with the rounding error carried forward so the
 *    average rate is exact (15 fps → 7, 7, 6, 7, 7, 6 …).
 */

export type Palette = Uint8Array; // 256 × RGB

/** Median-cut palette from RGBA samples (alpha ignored). */
export function buildPalette(samples: Uint8Array | Uint8ClampedArray, maxColors = 256): Palette {
  const n = Math.floor(samples.length / 4);
  const px = new Uint32Array(n);
  for (let i = 0; i < n; i++) px[i] = (samples[i * 4]! << 16) | (samples[i * 4 + 1]! << 8) | samples[i * 4 + 2]!;
  // Few distinct colours (UI, graphs, HUDs): keep them exactly.
  const distinct = new Set<number>();
  for (let i = 0; i < n && distinct.size <= maxColors; i++) distinct.add(px[i]!);
  if (distinct.size <= maxColors) {
    const pal = new Uint8Array(256 * 3);
    [...distinct].forEach((v, k) => { pal[k * 3] = v >> 16; pal[k * 3 + 1] = (v >> 8) & 255; pal[k * 3 + 2] = v & 255; });
    return pal;
  }
  type Box = { lo: number; hi: number };
  const boxes: Box[] = [{ lo: 0, hi: n }];
  const ch = (v: number, c: number) => (v >> (16 - 8 * c)) & 255;
  const range = (b: Box) => {
    let best = 0, bestR = -1;
    for (let c = 0; c < 3; c++) {
      let mn = 255, mx = 0;
      for (let i = b.lo; i < b.hi; i++) { const v = ch(px[i]!, c); if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mx - mn > bestR) { bestR = mx - mn; best = c; }
    }
    return { c: best, r: bestR };
  };
  while (boxes.length < maxColors) {
    // Split the box with the widest channel range (weighted by population).
    let bi = -1, score = 0, axis = 0;
    for (let k = 0; k < boxes.length; k++) {
      const b = boxes[k]!;
      if (b.hi - b.lo < 2) continue;
      const r = range(b);
      const s = r.r * Math.sqrt(b.hi - b.lo);
      if (r.r > 0 && s > score) { score = s; bi = k; axis = r.c; }
    }
    if (bi < 0) break;
    const b = boxes[bi]!;
    const sub = px.subarray(b.lo, b.hi).sort((x, y) => ch(x, axis) - ch(y, axis));
    void sub;
    const mid = b.lo + ((b.hi - b.lo) >> 1);
    boxes.splice(bi, 1, { lo: b.lo, hi: mid }, { lo: mid, hi: b.hi });
  }
  const pal = new Uint8Array(256 * 3);
  boxes.forEach((b, k) => {
    let r = 0, g = 0, bl = 0;
    for (let i = b.lo; i < b.hi; i++) { r += ch(px[i]!, 0); g += ch(px[i]!, 1); bl += ch(px[i]!, 2); }
    const m = Math.max(1, b.hi - b.lo);
    pal[k * 3] = Math.round(r / m); pal[k * 3 + 1] = Math.round(g / m); pal[k * 3 + 2] = Math.round(bl / m);
  });
  return pal;
}

/** Maps RGBA pixels to palette indices (nearest colour, cached per exact colour). */
export class ColorMapper {
  private cache = new Map<number, number>();
  constructor(private pal: Palette, private count = 256) {}
  index(r: number, g: number, b: number): number {
    const key = (r << 16) | (g << 8) | b;
    let v = this.cache.get(key);
    if (v !== undefined) return v;
    let best = 0, bd = Infinity;
    for (let k = 0; k < this.count; k++) {
      const dr = r - this.pal[k * 3]!, dg = g - this.pal[k * 3 + 1]!, db = b - this.pal[k * 3 + 2]!;
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = k; }
    }
    v = best;
    if (this.cache.size < 1 << 20) this.cache.set(key, v);
    return v;
  }
  map(rgba: Uint8Array | Uint8ClampedArray, out: Uint8Array): void {
    for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = this.index(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
  }
}

class Bytes {
  buf = new Uint8Array(1 << 16);
  len = 0;
  push(b: number) { if (this.len === this.buf.length) this.grow(); this.buf[this.len++] = b; }
  u16(v: number) { this.push(v & 255); this.push((v >> 8) & 255); }
  str(s: string) { for (let i = 0; i < s.length; i++) this.push(s.charCodeAt(i)); }
  grow() { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; }
  bytes() { return this.buf.slice(0, this.len); }
}

/** GIF LZW: variable code size, clear at 4096 codes, emitted in ≤255-byte sub-blocks. */
export function lzwEncode(indices: Uint8Array, out: Bytes, minCodeSize = 8): void {
  out.push(minCodeSize);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1, next = eoi + 1;
  const dict = new Map<number, number>();
  let block: number[] = [];
  let acc = 0, bits = 0;
  const emit = (code: number) => {
    acc |= code << bits; bits += codeSize;
    while (bits >= 8) {
      block.push(acc & 255); acc >>>= 8; bits -= 8;
      if (block.length === 255) { out.push(255); for (const b of block) out.push(b); block = []; }
    }
  };
  emit(clear);
  let prefix = indices.length ? indices[0]! : -1;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict.clear(); codeSize = minCodeSize + 1; next = eoi + 1;
    }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(acc & 255);
  if (block.length) { out.push(block.length); for (const b of block) out.push(b); }
  out.push(0);
}

export class GifEncoder {
  private out = new Bytes();
  private prev: Uint8Array | null = null;
  private cur: Uint8Array;
  private mapper: ColorMapper;
  private carry = 0;
  frames = 0;

  constructor(readonly width: number, readonly height: number, private palette: Palette, private fps: number, loop = true) {
    this.cur = new Uint8Array(width * height);
    this.mapper = new ColorMapper(palette);
    const o = this.out;
    o.str('GIF89a');
    o.u16(width); o.u16(height);
    o.push(0xf7);            // global colour table, 8 bits/channel, 256 entries
    o.push(0); o.push(0);
    for (let i = 0; i < 768; i++) o.push(palette[i]!);
    if (loop) { o.push(0x21); o.push(0xff); o.push(11); o.str('NETSCAPE2.0'); o.push(3); o.push(1); o.u16(0); o.push(0); }
  }

  addFrame(rgba: Uint8Array | Uint8ClampedArray): void {
    const { width: w, height: h } = this;
    this.mapper.map(rgba, this.cur);
    // Changed rectangle versus the previous frame.
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    if (this.prev) {
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (this.cur[row + x] !== this.prev[row + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; } // unchanged: a 1-pixel frame keeps the timing
    }
    const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
    const sub = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) sub.set(this.cur.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + rw), y * rw);
    // Delay with carried rounding error.
    const exact = 100 / this.fps + this.carry;
    const delay = Math.max(2, Math.round(exact));
    this.carry = exact - delay;
    const o = this.out;
    o.push(0x21); o.push(0xf9); o.push(4); o.push(0x04); // disposal 1: leave in place
    o.u16(delay); o.push(0); o.push(0);
    o.push(0x2c); o.u16(x0); o.u16(y0); o.u16(rw); o.u16(rh); o.push(0);
    lzwEncode(sub, o);
    const t = this.prev ?? new Uint8Array(w * h);
    t.set(this.cur);
    this.prev = t;
    this.frames++;
  }

  finish(): Uint8Array {
    this.out.push(0x3b);
    return this.out.bytes();
  }
}

/** Reduces RGBA frames to a sample for the palette (every k-th pixel of every frame). */
export function samplePixels(frames: (Uint8Array | Uint8ClampedArray)[], target = 200_000): Uint8Array {
  const total = frames.reduce((s, f) => s + f.length / 4, 0);
  const step = Math.max(1, Math.floor(total / target));
  const out = new Uint8Array(Math.ceil(total / step) * 4 + 4);
  let o = 0, skip = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4) {
      if (skip-- > 0) continue;
      skip = step - 1;
      out[o++] = f[i]!; out[o++] = f[i + 1]!; out[o++] = f[i + 2]!; out[o++] = 255;
    }
  }
  return out.subarray(0, o);
}
