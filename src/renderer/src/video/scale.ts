/**
 * Fast, good-looking downscaling of video frames on the GPU.
 *
 * Chrome's 'high'/'medium' imageSmoothingQuality builds a mipmap chain of the
 * whole source on every draw: for 4K frames that cost ~30 ms each on a laptop
 * GPU (three 4K feeds exported at 6 frames/s instead of 21). Plain 'low'
 * (bilinear) is fast but aliases badly when shrinking 4K to a small tile.
 * Halving with bilinear steps until within 2x of the target, then one final
 * bilinear draw, is as fast as 'low' and within ~50 dB PSNR of 'high'.
 */
const scratch = new Map<string, OffscreenCanvas>();

/**
 * Halves img until the next halving would go below tw x th. Returns the
 * (possibly unchanged) source to draw from. `key` names the scratch canvases
 * (one set per caller, so concurrent users don't share them).
 */
export function shrink(key: string, img: CanvasImageSource, iw: number, ih: number, tw: number, th: number): { src: CanvasImageSource; w: number; h: number } {
  let src = img, w = iw, h = ih, level = 0;
  while (w / 2 >= tw && h / 2 >= th && w > 2 && h > 2) {
    const nw = Math.round(w / 2), nh = Math.round(h / 2);
    const k = `${key}:${level}`;
    let c = scratch.get(k);
    if (!c || c.width !== nw || c.height !== nh) { c = new OffscreenCanvas(nw, nh); scratch.set(k, c); }
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'low';
    g.drawImage(src, 0, 0, nw, nh);
    src = c; w = nw; h = nh; level++;
  }
  return { src, w, h };
}

/** Draws img scaled into (x, y, w, h) of ctx with shrink() quality. */
export function drawScaled(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, key: string, img: CanvasImageSource, iw: number, ih: number, x: number, y: number, w: number, h: number, effW = w, effH = h): void {
  const sm = shrink(key, img, iw, ih, Math.abs(effW), Math.abs(effH));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(sm.src, x, y, w, h);
}

/** Drops scratch canvases for a key (a closed video). */
export function releaseScratch(key: string): void {
  for (const k of [...scratch.keys()]) if (k.startsWith(`${key}:`)) scratch.delete(k);
}
