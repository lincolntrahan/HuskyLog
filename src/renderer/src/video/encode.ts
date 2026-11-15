import { avc1Stsd, planVideoTrim, type MuxSample, type MuxTrack, type SrcTrack } from '@core/pack/mp4mux';
import type { MediaSource } from './MediaSource';

/**
 * "Re-encode smaller" for Pack & Go: decodes the kept range with WebCodecs,
 * scales to ≤ 720p and encodes H.264 (the platform encoder), streaming the
 * encoded bytes to `sink`. No ffmpeg. Phase 7 export reuses this path.
 * Output frame times are the original presentation times − tCut.
 */
export interface EncodeResult { track: MuxTrack; bytes: number; tCut: number; firstPts: number; lastPts: number; frames: number }

export async function reencodeVideo(
  src: MediaSource, v: SrcTrack, t0: number, t1: number,
  sink: (bytes: Uint8Array) => Promise<void>,
  onProgress: (fraction: number) => void,
  opts: { maxHeight?: number; signal?: { cancelled: boolean } } = {},
): Promise<EncodeResult> {
  const plan = planVideoTrim(v, t0, t1);
  const samples = v.samples.slice(plan.first, plan.last + 1);
  const ptsOf = (cts: number) => cts / v.timescale + v.shift;
  const keptPts = samples.map((s) => ptsOf(s.cts)).sort((a, b) => a - b);
  const firstPts = keptPts[0]!, lastPts = keptPts[keptPts.length - 1]!;
  const tCut = firstPts;
  const fps = keptPts.length > 1 ? (keptPts.length - 1) / Math.max(1e-6, lastPts - firstPts) : 30;

  const dec = src.videoDecoderConfig;
  const srcW = dec.codedWidth ?? v.width ?? 1280, srcH = dec.codedHeight ?? v.height ?? 720;
  const outH = Math.min(opts.maxHeight ?? 720, srcH) & ~1;
  const outW = Math.round((srcW * outH) / srcH / 2) * 2;
  const canvas = new OffscreenCanvas(outW, outH);
  const g = canvas.getContext('2d')!;

  // Quality-based target: ~0.1 bit per pixel per frame (720p30 ≈ 2.8 Mbit/s).
  const bitrate = Math.round(Math.max(400_000, 0.1 * outW * outH * fps));
  const config: VideoEncoderConfig = {
    codec: 'avc1.640028', width: outW, height: outH, bitrate, framerate: fps,
    latencyMode: 'realtime', // no B-frames: decode order = presentation order
    avc: { format: 'avc' },
  } as VideoEncoderConfig;
  const sup = await VideoEncoder.isConfigSupported(config);
  if (!sup.supported) throw new Error('This computer has no H.264 encoder available to WebCodecs.');

  const out: MuxSample[] = [];
  let avcC: Uint8Array | null = null;
  let pendingBytes: Uint8Array[] = [], pendingLen = 0, total = 0;
  let writeChain: Promise<void> = Promise.resolve();
  let encErr: unknown = null, decErr: unknown = null;
  const flushPending = () => {
    if (!pendingLen) return;
    const buf = new Uint8Array(pendingLen);
    let p = 0;
    for (const b of pendingBytes) { buf.set(b, p); p += b.length; }
    pendingBytes = []; pendingLen = 0;
    writeChain = writeChain.then(() => sink(buf));
  };
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!avcC && meta?.decoderConfig?.description) {
        const d = meta.decoderConfig.description;
        avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
      }
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      pendingBytes.push(b); pendingLen += b.length; total += b.length;
      out.push({ size: b.length, dts: chunk.timestamp, cts: chunk.timestamp, duration: chunk.duration ?? Math.round(1e6 / fps), sync: chunk.type === 'key' });
      if (pendingLen > 4 << 20) flushPending();
    },
    error: (e) => { encErr = e; },
  });
  encoder.configure(config);

  let encoded = 0;
  const keyEvery = Math.max(1, Math.round(fps * 2));
  const decoder = new VideoDecoder({
    output: (f) => {
      const p = f.timestamp / 1e6 + v.shift;
      if (p < firstPts - 1e-6 || p > lastPts + 1e-6) { f.close(); return; }
      g.drawImage(f, 0, 0, outW, outH);
      f.close();
      const frame = new VideoFrame(canvas, { timestamp: Math.round((p - tCut) * 1e6), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: encoded % keyEvery === 0 });
      frame.close();
      encoded++;
    },
    error: (e) => { decErr = e; },
  });
  decoder.configure(dec);

  // Read sample data in ~8 MB batches of nearby samples.
  let i = 0;
  while (i < samples.length) {
    if (opts.signal?.cancelled) throw new Error('cancelled');
    if (encErr || decErr) break;
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
    }
    // Backpressure: keep the codec queues short.
    while (decoder.decodeQueueSize > 16 || encoder.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 5));
    onProgress((j + 1) / samples.length);
    i = j + 1;
  }
  await decoder.flush();
  await encoder.flush();
  decoder.close(); encoder.close();
  if (decErr || encErr) throw new Error(`Re-encode failed: ${String(decErr ?? encErr)}`);
  flushPending();
  await writeChain;
  if (!avcC || !out.length) throw new Error('The encoder produced no output.');
  // Durations from the actual frame spacing (VFR-safe).
  for (let k = 0; k + 1 < out.length; k++) out[k]!.duration = Math.max(1, out[k + 1]!.cts - out[k]!.cts);
  return {
    track: { kind: 'video', timescale: 1_000_000, shift: 0, stsd: avc1Stsd(outW, outH, avcC), width: outW, height: outH, matrix: v.matrix, samples: out },
    bytes: total, tCut, firstPts, lastPts, frames: out.length,
  };
}
