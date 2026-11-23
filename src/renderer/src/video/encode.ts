import { planVideoTrim, type MuxTrack, type SrcTrack } from '@core/pack/mp4mux';
import type { MediaSource } from './MediaSource';
import { H264Sink } from './h264';
import { adjustedSize, isIdentity, type VideoAdjust } from '@core/video/adjust';
import { drawPicture } from '../export/videoDraw';

/**
 * "Re-encode smaller" for Pack & Go: decodes the kept range with WebCodecs,
 * scales to ≤ 720p and encodes H.264 (H264Sink), streaming the encoded bytes
 * to `sink`. Output frame times are the original presentation times − tCut.
 */
export interface EncodeResult { track: MuxTrack; bytes: number; tCut: number; firstPts: number; lastPts: number; frames: number; mode: string; width: number; height: number }

export async function reencodeVideo(
  src: MediaSource, v: SrcTrack, t0: number, t1: number,
  sink: (bytes: Uint8Array) => Promise<void>,
  onProgress: (fraction: number) => void,
  opts: {
    maxHeight?: number;
    /** Fit inside long × short pixels in either orientation (e.g. 1920 × 1080); overrides maxHeight. */
    fit?: { long: number; short: number } | null;
    /** Bake the picture: the file rotation plus these adjustments (output has no rotation flag). */
    bake?: { fileRot: number; adjust?: VideoAdjust };
    bitsPerPixel?: number;
    signal?: { cancelled: boolean };
  } = {},
): Promise<EncodeResult> {
  const plan = planVideoTrim(v, t0, t1);
  const samples = v.samples.slice(plan.first, plan.last + 1);
  const keptPts = samples.map((s) => s.cts / v.timescale + v.shift).sort((a, b) => a - b);
  const firstPts = keptPts[0]!, lastPts = keptPts[keptPts.length - 1]!;
  const tCut = firstPts;
  const fps = keptPts.length > 1 ? (keptPts.length - 1) / Math.max(1e-6, lastPts - firstPts) : 30;

  const dec = src.videoDecoderConfig;
  const srcW = dec.codedWidth ?? v.width ?? 1280, srcH = dec.codedHeight ?? v.height ?? 720;
  const bake = opts.bake && (opts.bake.fileRot || !isIdentity(opts.bake.adjust)) ? opts.bake : null;
  const base = bake ? adjustedSize(srcW, srcH, bake.fileRot, bake.adjust ?? { rot: 0, flipH: false, flipV: false, fine: 0, crop: { x: 0, y: 0, w: 1, h: 1 } }) : { w: srcW, h: srcH };
  const k = opts.fit
    ? Math.min(1, opts.fit.long / Math.max(base.w, base.h), opts.fit.short / Math.min(base.w, base.h))
    : opts.fit === null ? 1 : Math.min(1, (opts.maxHeight ?? 720) / base.h);
  const outW = Math.max(2, Math.round((base.w * k) / 2) * 2), outH = Math.max(2, Math.round((base.h * k) / 2) * 2);
  const canvas = new OffscreenCanvas(outW, outH);
  const g = canvas.getContext('2d')!;
  const enc = await H264Sink.create({ width: outW, height: outH, fps, ...(opts.bitsPerPixel ? { bitsPerPixel: opts.bitsPerPixel } : {}) }, sink);

  let encoded = 0, decErr: unknown = null;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  const frames: VideoFrame[] = [];
  const decoder = new VideoDecoder({
    output: (f) => {
      const p = f.timestamp / 1e6 + v.shift;
      if (p < firstPts - 1e-6 || p > lastPts + 1e-6) { f.close(); return; }
      if (bake) { g.fillStyle = '#000'; g.fillRect(0, 0, outW, outH); drawPicture(g, 'reencode', f, f.displayWidth, f.displayHeight, bake.fileRot, bake.adjust, outW, outH); }
      else g.drawImage(f, 0, 0, outW, outH);
      f.close();
      frames.push(new VideoFrame(canvas, { timestamp: Math.round((p - tCut) * 1e6), duration: Math.round(1e6 / fps) }));
    },
    error: (e) => { decErr = e; },
  });
  decoder.configure(dec);
  const drain = async () => {
    while (frames.length) {
      const fr = frames.shift()!;
      await enc.add(fr, encoded % keyEvery === 0);
      fr.close();
      encoded++;
    }
  };

  // Read sample data in ~8 MB batches of nearby samples.
  let i = 0;
  while (i < samples.length) {
    if (opts.signal?.cancelled) throw new Error('cancelled');
    if (decErr) break;
    let j = i, lo = samples[i]!.offset, hi = samples[i]!.offset + samples[i]!.size;
    while (j + 1 < samples.length) {
      const n = samples[j + 1]!;
      const nlo = Math.min(lo, n.offset), nhi = Math.max(hi, n.offset + n.size);
      if (nhi - nlo > 8 << 20) break;
      lo = nlo; hi = nhi; j++;
    }
    const buf = new Uint8Array(await src.readRange(lo, hi));
    for (let k = i; k <= j; k++) {
      const s = samples[k]!;
      decoder.decode(new EncodedVideoChunk({ type: s.sync ? 'key' : 'delta', timestamp: Math.round((s.cts * 1e6) / v.timescale), duration: Math.round((s.duration * 1e6) / v.timescale), data: buf.subarray(s.offset - lo, s.offset - lo + s.size) }));
      while (decoder.decodeQueueSize > 8) { await drain(); await new Promise((r) => setTimeout(r, 1)); }
      await drain();
    }
    onProgress((j + 1) / samples.length);
    i = j + 1;
  }
  await decoder.flush();
  decoder.close();
  await drain();
  if (decErr) throw new Error(`Re-encode failed: ${String(decErr)}`);
  const track = await enc.finish(bake ? undefined : v.matrix);
  return { track, bytes: enc.bytes, tCut, firstPts, lastPts, frames: track.samples.length, mode: enc.mode, width: outW, height: outH };
}
