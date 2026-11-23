import type { VideoZoom } from '@core/overlay/zoom';
import { mediaSource, useMedia } from '../data/media';
import { masterToLocal, streamSolution } from '../data/sync';
import { fmtTime } from '../data/timeline';
import { FrameReader } from '../video/FrameReader';
import { shrink } from '../video/scale';
import { adjustedSize, applyAdjust, fitBox, isIdentity, NO_ADJUST, type VideoAdjust } from '@core/video/adjust';
import { drawMessage } from './registry';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** How video frames are scaled: 'chain' (video/scale.ts) by default; 'high' and 'low' for comparison in scripts/bench-export.mjs. */
export const videoDrawOpts = { mode: 'chain' as 'chain' | 'high' | 'low' };

/** Sequential readers for the streams being exported (empty otherwise). */
const readers = new Map<string, FrameReader>();

/**
 * Starts one sequential reader per video stream for an export of master
 * time t0..t1. Streams that don't overlap the range get none.
 */
export function startExportReaders(streams: Iterable<string>, t0: number, t1: number): void {
  stopExportReaders();
  for (const stream of new Set(streams)) {
    const v = useMedia.getState().videos[stream]?.video, src = mediaSource(stream);
    const sol = streamSolution(stream);
    if (!v || !src || !sol || sol.status === 'unsynced') continue;
    const a = Math.max(v.startS, masterToLocal(stream, t0)), b = Math.min(v.endS, masterToLocal(stream, t1));
    if (a > b) continue;
    readers.set(stream, new FrameReader(src, a, b));
  }
}
export function stopExportReaders(): void {
  for (const r of readers.values()) r.close();
  readers.clear();
}

/**
 * The exact video frame at master time t, drawn like the Video window shows
 * it: letterboxed, rotated, then the digital zoom crop. Decodes with
 * WebCodecs (frame-accurate), never screen capture. During an export the
 * frame comes from the stream's sequential reader; otherwise from the scrub
 * cache.
 */
export async function drawVideoAt(ctx: Ctx, stream: string | undefined, zoom: VideoZoom | undefined, t: number, w: number, h: number): Promise<void> {
  const v = stream ? useMedia.getState().videos[stream] : undefined;
  const src = stream ? mediaSource(stream) : undefined;
  if (!stream || !v?.video || !src) { drawMessage(ctx, w, h, 'No video'); return; }
  const sol = streamSolution(stream);
  if (!sol || sol.status === 'unsynced') { drawMessage(ctx, w, h, 'Not synced'); return; }
  const vi = v.video;
  const fps = vi.fpsAvg || 30;
  const local = masterToLocal(stream, t);
  if (local < vi.startS - 0.5 / fps) { drawMessage(ctx, w, h, `Video starts in ${fmtTime(vi.startS - local)}`); return; }
  if (local > vi.endS + 1 / fps) { drawMessage(ctx, w, h, `Video ended ${fmtTime(local - vi.endS)} ago`); return; }

  const reader = readers.get(stream);
  const img: VideoFrame | ImageBitmap | null = reader ? await reader.frameAt(local) : await src.frame(src.indexAt(local));
  if (!img) { drawMessage(ctx, w, h, 'No frame'); return; }
  const iw = 'displayWidth' in img ? img.displayWidth : img.width, ih = 'displayHeight' in img ? img.displayHeight : img.height;

  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.save();
  // Digital zoom: the crop (zoom.x·w, zoom.y·h, w/s, h/s) of the letterboxed stage, scaled to fill.
  if (zoom && zoom.s > 1) { ctx.scale(zoom.s, zoom.s); ctx.translate(-zoom.x * w, -zoom.y * h); }
  drawPicture(ctx, `draw:${stream}`, img, iw, ih, vi.rotation, v.adjust, w, h, zoom && zoom.s > 1 ? zoom.s : 1);
  ctx.restore();
}

/**
 * Draws a decoded frame letterboxed into (0, 0, W, H): the file rotation and
 * the video's adjustments (rotate, mirror, straighten, crop) applied, scaled
 * with the halving chain. `zoomS`: extra magnification applied by the caller
 * (so the chain keeps enough detail). Used by export, the Video window and the
 * Sync preview, so they always agree.
 */
export function drawPicture(ctx: Ctx, key: string, img: CanvasImageSource, iw: number, ih: number, fileRot: number, adjust: VideoAdjust | undefined, W: number, H: number, zoomS = 1): void {
  const a = adjust ?? NO_ADJUST;
  const size = adjustedSize(iw, ih, fileRot, a);
  const box = fitBox(size.w / size.h, W, H);
  ctx.save();
  if (!isIdentity(a)) { ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip(); }
  const k = applyAdjust(ctx, iw, ih, fileRot, a, box.x, box.y, box.w, box.h);
  ctx.imageSmoothingEnabled = true;
  if (videoDrawOpts.mode === 'high') {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
  } else {
    const sm = videoDrawOpts.mode === 'chain' ? shrink(key, img, iw, ih, iw * k * zoomS, ih * k * zoomS) : { src: img };
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(sm.src, -iw / 2, -ih / 2, iw, ih);
  }
  ctx.restore();
}
