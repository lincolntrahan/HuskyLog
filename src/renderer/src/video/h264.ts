import { avc1Stsd, type MuxSample, type MuxTrack } from '@core/pack/mp4mux';

/**
 * H.264 encoding with WebCodecs (the platform encoder), producing an MP4 video
 * track for the app's MP4 writer. Used by export (Phase 7) and by Pack & Go's
 * re-encode. Encoded bytes stream to `sink` in ~4 MB batches.
 *
 * B-frames: if the encoder reorders frames, decode timestamps are rebuilt from
 * the sorted presentation times and an edit list removes the reorder delay,
 * so presentation times stay exactly what was submitted.
 */
export interface H264Options { width: number; height: number; fps: number; bitsPerPixel?: number; mode?: 'quality' | 'realtime' }

/** Smallest High-profile level that fits the frame size and rate. */
export function avcCodecFor(w: number, h: number, fps: number): string {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
  const levels: [number, number, number][] = [[0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
  const lv = levels.find(([, f, r]) => fs <= f && mbps <= r)?.[0] ?? 0x34;
  return `avc1.6400${lv.toString(16).padStart(2, '0')}`;
}

export class H264Sink {
  private encoder!: VideoEncoder;
  private samples: { size: number; pts: number; key: boolean }[] = [];
  private avcC: Uint8Array | null = null;
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private chain: Promise<void> = Promise.resolve();
  private err: unknown = null;
  bytes = 0;
  mode: 'quality' | 'realtime' = 'quality';

  private constructor(private o: H264Options, private sink: (b: Uint8Array) => Promise<void>) {}

  static async create(o: H264Options, sink: (b: Uint8Array) => Promise<void>): Promise<H264Sink> {
    const s = new H264Sink(o, sink);
    const bitrate = Math.round(Math.max(300_000, (o.bitsPerPixel ?? 0.1) * o.width * o.height * o.fps));
    const base = { codec: avcCodecFor(o.width, o.height, o.fps), width: o.width, height: o.height, bitrate, framerate: o.fps, avc: { format: 'avc' } } as VideoEncoderConfig;
    let config: VideoEncoderConfig | null = null;
    for (const latencyMode of o.mode === 'realtime' ? ['realtime'] as const : ['quality', 'realtime'] as const) {
      const c = { ...base, latencyMode };
      if ((await VideoEncoder.isConfigSupported(c)).supported) { config = c; s.mode = latencyMode; break; }
    }
    if (!config) throw new Error(`This computer cannot encode H.264 at ${o.width}×${o.height} ${o.fps} fps.`);
    s.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const d = meta?.decoderConfig?.description;
        if (!s.avcC && d) s.avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
        const b = new Uint8Array(chunk.byteLength);
        chunk.copyTo(b);
        s.samples.push({ size: b.length, pts: chunk.timestamp, key: chunk.type === 'key' });
        s.pending.push(b); s.pendingLen += b.length; s.bytes += b.length;
        if (s.pendingLen > 4 << 20) s.flushBytes();
      },
      error: (e) => { s.err = e; },
    });
    s.encoder.configure(config);
    return s;
  }

  private flushBytes() {
    if (!this.pendingLen) return;
    const buf = new Uint8Array(this.pendingLen);
    let p = 0;
    for (const b of this.pending) { buf.set(b, p); p += b.length; }
    this.pending = []; this.pendingLen = 0;
    this.chain = this.chain.then(() => this.sink(buf));
  }

  /** Encodes a frame (timestamp in µs). Waits when the encoder queue is long. */
  async add(frame: VideoFrame, keyFrame: boolean): Promise<void> {
    if (this.err) throw new Error(`Encoder failed: ${String(this.err)}`);
    this.encoder.encode(frame, { keyFrame });
    while (this.encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
  }

  /** Flushes and returns the video track (timescale 1 MHz). */
  async finish(matrix?: number[]): Promise<MuxTrack> {
    await this.encoder.flush();
    this.encoder.close();
    if (this.err) throw new Error(`Encoder failed: ${String(this.err)}`);
    this.flushBytes();
    await this.chain;
    if (!this.avcC || !this.samples.length) throw new Error('The encoder produced no output.');
    const pts = this.samples.map((s) => s.pts);
    const sorted = [...pts].sort((a, b) => a - b);
    // dts_i = i-th smallest pts, shifted so dts ≤ pts everywhere (reorder delay).
    let delay = 0;
    for (let i = 0; i < pts.length; i++) delay = Math.max(delay, sorted[i]! - pts[i]!);
    const out: MuxSample[] = this.samples.map((s, i) => ({ size: s.size, dts: sorted[i]! - delay, cts: s.pts, duration: 0, sync: s.key }));
    for (let i = 0; i < out.length; i++) out[i]!.duration = i + 1 < out.length ? Math.max(1, out[i + 1]!.dts - out[i]!.dts) : Math.round(1e6 / this.o.fps);
    // Rebase so the first decode time is 0; the edit list then starts presentation at the first frame.
    const d0 = out[0]!.dts;
    for (const s of out) { s.dts -= d0; s.cts -= d0; }
    return {
      kind: 'video', timescale: 1_000_000, shift: d0 / 1e6, // pts = cts + d0: exactly the submitted timestamps
      stsd: avc1Stsd(this.o.width, this.o.height, this.avcC), width: this.o.width, height: this.o.height, matrix, samples: out,
    };
  }

  /** True when the encoder reordered frames (B-frames). */
  get reordered(): boolean { return this.samples.some((s, i) => i > 0 && s.pts < this.samples[i - 1]!.pts); }
}
