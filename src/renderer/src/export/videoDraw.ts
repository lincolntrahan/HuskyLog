import type { VideoZoom } from '@core/overlay/zoom';
import { mediaSource, useMedia } from '../data/media';
import { masterToLocal, streamSolution } from '../data/sync';
import { fmtTime } from '../data/timeline';
import { drawMessage } from './registry';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let stage: OffscreenCanvas | null = null;

/**
 * The exact video frame at master time t, drawn like the Video window shows
 * it: letterboxed in the stage, rotated, then the digital zoom crop of the
 * whole stage. Decodes with WebCodecs (frame-accurate), never screen capture.
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

  const bmp = await src.frame(src.indexAt(local));
  if (!stage || stage.width !== w || stage.height !== h) stage = new OffscreenCanvas(w, h);
  const g = stage.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  const rot = vi.rotation;
  const dw = rot % 180 ? bmp.height : bmp.width, dh = rot % 180 ? bmp.width : bmp.height;
  const s = Math.min(w / dw, h / dh);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate((rot * Math.PI) / 180);
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, (-bmp.width * s) / 2, (-bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  g.restore();
  if (zoom && zoom.s > 1) ctx.drawImage(stage, zoom.x * w, zoom.y * h, w / zoom.s, h / zoom.s, 0, 0, w, h);
  else ctx.drawImage(stage, 0, 0);
}
