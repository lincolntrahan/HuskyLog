import { mp4aStsd, type MuxTrack } from '@core/pack/mp4mux';

/**
 * PCM → AAC for MP4 output (export, compressed copies). Raw PCM in MP4 plays
 * in few players, and the platform AAC encoder only takes 44.1/48 kHz, so
 * audio is resampled to 48 kHz first (OfflineAudioContext), then encoded
 * with WebCodecs.
 */
export const AAC_RATE = 48000;

export interface AacResult {
  /** Audio track; samples are in `bytes` order. `shift` is left to the caller. */
  track: Omit<MuxTrack, 'shift'>;
  bytes: Uint8Array;
  /** Encoder delay in seconds: the first decoded audio this long is priming, not signal. */
  delay: number;
}

async function resample(planes: Float32Array[], rate: number): Promise<Float32Array[]> {
  if (Math.abs(rate - AAC_RATE) < 0.5) return planes;
  const n = planes[0]!.length;
  const outN = Math.max(1, Math.round((n * AAC_RATE) / rate));
  const ctx = new OfflineAudioContext(planes.length, outN, AAC_RATE);
  const buf = ctx.createBuffer(planes.length, n, rate);
  planes.forEach((p, c) => buf.copyToChannel(p as Float32Array<ArrayBuffer>, c));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return planes.map((_, c) => out.getChannelData(c));
}

export async function encodeAac(planesIn: Float32Array[], rate: number, bitrate = 128000): Promise<AacResult> {
  let planes = await resample(planesIn, rate);
  // Mono AAC isn't offered everywhere: fall back to stereo with the channel duplicated.
  let channels = Math.min(2, planes.length);
  const cfg = (ch: number): AudioEncoderConfig => ({ codec: 'mp4a.40.2', sampleRate: AAC_RATE, numberOfChannels: ch, bitrate });
  if (!(await AudioEncoder.isConfigSupported(cfg(channels))).supported) {
    if (channels === 1 && (await AudioEncoder.isConfigSupported(cfg(2))).supported) { channels = 2; planes = [planes[0]!, planes[0]!]; }
    else throw new Error('This computer cannot encode AAC audio.');
  }
  planes = planes.slice(0, channels);

  const chunks: { data: Uint8Array; duration: number; timestamp: number }[] = [];
  let asc: Uint8Array | null = null;
  let err: unknown = null;
  const enc = new AudioEncoder({
    output: (c, meta) => {
      const d = meta?.decoderConfig?.description;
      if (!asc && d) asc = new Uint8Array(d instanceof ArrayBuffer ? d.slice(0) : (d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
      const b = new Uint8Array(c.byteLength);
      c.copyTo(b);
      chunks.push({ data: b, duration: c.duration ?? 0, timestamp: c.timestamp });
    },
    error: (e) => { err = e; },
  });
  enc.configure(cfg(channels));
  const n = planes[0]!.length, BLOCK = 4800;
  for (let i = 0; i < n; i += BLOCK) {
    const m = Math.min(BLOCK, n - i);
    const data = new Float32Array(m * channels);
    for (let c = 0; c < channels; c++) data.set(planes[c]!.subarray(i, i + m), c * m);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: AAC_RATE, numberOfFrames: m, numberOfChannels: channels, timestamp: Math.round((i * 1e6) / AAC_RATE), data });
    enc.encode(ad);
    ad.close();
    while (enc.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush();
  enc.close();
  if (err) throw err instanceof Error ? err : new Error(String(err));
  if (!asc || !chunks.length) throw new Error('AAC encoder produced no output');

  const total = chunks.reduce((s, c) => s + c.data.length, 0);
  const bytes = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { bytes.set(c.data, p); p += c.data.length; }
  // Every AAC frame is 1024 samples; timestamps from the encoder are informational only.
  let dts = 0;
  const samples = chunks.map((c) => { const s = { size: c.data.length, dts, cts: dts, duration: 1024, sync: true }; dts += 1024; return s; });
  // Encoder delay, if the encoder reports one (a negative first timestamp). The
  // Windows encoder doesn't add any: measured, the decoded audio lines up with
  // the input with no correction (a 1024-sample correction made it 21 ms early).
  const delay = chunks[0]!.timestamp < 0 ? -chunks[0]!.timestamp / 1e6 : 0;
  return { track: { kind: 'audio', timescale: AAC_RATE, samples, stsd: mp4aStsd(AAC_RATE, channels, asc, bitrate) }, bytes, delay };
}
