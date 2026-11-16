import { createFile, MP4BoxBuffer, DataStream } from 'mp4box';
import type { SrcTrack } from '@core/pack/mp4mux';
import { srcTrack, type Mp4Like } from '@core/pack/mp4src';
import { drawScaled, releaseScratch } from './scale';

/**
 * Random access to MP4/MOV video and audio without loading the file:
 *  - the container is parsed with HTTP range reads (moov may sit after a
 *    multi-GB mdat; mp4box tells us where to jump)
 *  - video frames are decoded on demand with WebCodecs, one GOP per read
 *  - audio is decoded once into a min/max waveform (for the Sync tab)
 *
 * Timing uses presentation timestamps with the edit list applied, never
 * frame index / fps, because phone video is often variable frame rate.
 */

interface Sample { offset: number; size: number; cts: number; duration: number; isSync: boolean; timescale: number }

export interface VideoInfo {
  codec: string; width: number; height: number; rotation: 0 | 90 | 180 | 270;
  frames: number; keyframes: number; durationS: number; fpsAvg: number; vfr: boolean;
  supported: boolean; startS: number; endS: number;
}
export interface AudioInfo { codec: string; sampleRate: number; channels: number; samples: number; supported: boolean }
export interface Waveform { start: number; binDt: number; min: Float32Array; max: Float32Array; rms: Float32Array }

type Mp4File = ReturnType<typeof createFile>;
type Trak = {
  samples: { offset: number; size: number; cts: number; duration: number; is_sync: boolean; timescale: number }[];
  mdia: { mdhd: { timescale: number }; minf: { stbl: { stsd: { entries: Record<string, unknown>[] } } } };
  tkhd: { matrix: number[] | Int32Array };
  edts?: { elst?: { entries: { segment_duration: number; media_time: number }[] } };
};

export class MediaSource {
  url = '';
  size = 0;
  bytesRead = 0;
  /** Bytes read to parse the container (index only, not media data). */
  parseBytes = 0;
  video: VideoInfo | null = null;
  audio: AudioInfo | null = null;
  createdUtc: Date | null = null;

  private file!: Mp4File;
  private vSamples: Sample[] = [];  // decode order
  private pres: number[] = [];      // presentation order → decode index
  private vShift = 0;               // edit-list shift (µs)
  private vConfig!: VideoDecoderConfig;
  private aSamples: Sample[] = [];
  private aShift = 0;
  private aConfig: AudioDecoderConfig | null = null;
  private cache = new Map<number, ImageBitmap>();
  private cacheOrder: number[] = [];
  /** Scrub cache budget per video (decoded RGBA bitmaps are large: 4K ≈ 33 MB each). */
  private static CACHE_BYTES = 384 << 20;
  private cacheMax = 90;
  /** Cached bitmaps are at most this big on the long edge (4K would allow only a few frames). */
  private static CACHE_EDGE = 1920;
  private bmpSize: { w: number; h: number } | null = null;
  private waveform: Promise<Waveform | null> | null = null;
  private decodeChain: Promise<unknown> = Promise.resolve();

  static async open(url: string, size: number): Promise<MediaSource> {
    const m = new MediaSource();
    m.url = url;
    m.size = size;
    await m.parse();
    return m;
  }

  private async read(start: number, end: number): Promise<ArrayBuffer> {
    const res = await fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!res.ok) throw new Error(`Read failed (${res.status})`);
    const buf = await res.arrayBuffer();
    this.bytesRead += buf.byteLength;
    return buf;
  }

  private async parse() {
    const file = createFile();
    this.file = file;
    let info: Parameters<NonNullable<Mp4File['onReady']>>[0] | null = null;
    file.onReady = (i) => { info = i; };
    let err: unknown = null;
    file.onError = (e: unknown) => { err = e; };
    let pos = 0;
    const CHUNK = 1 << 20;
    while (!info && pos < this.size && !err) {
      const end = Math.min(this.size, pos + CHUNK);
      const buf = await this.read(pos, end);
      const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, pos), end >= this.size);
      pos = next > pos ? next : end;
    }
    this.parseBytes = this.bytesRead;
    if (err) throw new Error(String(err));
    if (!info) throw new Error('Not a readable MP4/MOV file (no movie header found)');
    const mi = info as unknown as {
      videoTracks: { id: number; codec: string; video?: { width: number; height: number } }[];
      audioTracks: { id: number; codec: string; audio?: { sample_rate: number; channel_count: number } }[];
      created?: Date;
    };
    this.createdUtc = mi.created && mi.created.getUTCFullYear() > 1970 ? mi.created : null;

    const vt = mi.videoTracks[0];
    if (vt) {
      const trak = file.getTrackById(vt.id) as unknown as Trak;
      this.vSamples = trak.samples.map((s) => ({ offset: s.offset, size: s.size, cts: s.cts, duration: s.duration, isSync: s.is_sync, timescale: s.timescale }));
      this.pres = this.vSamples.map((_, i) => i).sort((a, b) => this.vSamples[a]!.cts - this.vSamples[b]!.cts);
      this.vShift = editShiftUs(file, trak);
      this.vConfig = { codec: vt.codec, codedWidth: vt.video!.width, codedHeight: vt.video!.height, description: boxBytes(trak, ['avcC', 'hvcC', 'vpcC', 'av1C']) };
      const n = this.pres.length;
      const support = await VideoDecoder.isConfigSupported(this.vConfig).catch(() => ({ supported: false }));
      const startS = n ? this.ptsUs(0) / 1e6 : 0, endS = n ? this.ptsUs(n - 1) / 1e6 : 0;
      let minD = Infinity, maxD = 0;
      for (let i = 1; i < n; i++) { const d = this.ptsUs(i) - this.ptsUs(i - 1); minD = Math.min(minD, d); maxD = Math.max(maxD, d); }
      const k = Math.min(1, MediaSource.CACHE_EDGE / Math.max(vt.video!.width, vt.video!.height));
      if (k < 1) this.bmpSize = { w: Math.round(vt.video!.width * k), h: Math.round(vt.video!.height * k) };
      const bw = this.bmpSize?.w ?? vt.video!.width, bh = this.bmpSize?.h ?? vt.video!.height;
      this.cacheMax = Math.max(8, Math.min(90, Math.floor(MediaSource.CACHE_BYTES / (bw * bh * 4))));
      this.video = {
        codec: vt.codec, width: vt.video!.width, height: vt.video!.height, rotation: rotationOf(trak.tkhd.matrix),
        frames: n, keyframes: this.vSamples.filter((s) => s.isSync).length, durationS: endS - startS,
        fpsAvg: endS > startS ? (n - 1) / (endS - startS) : 0, vfr: maxD - minD > 1000, supported: !!support.supported, startS, endS,
      };
    }
    const at = mi.audioTracks[0];
    if (at?.audio) {
      const trak = file.getTrackById(at.id) as unknown as Trak;
      this.aSamples = trak.samples.map((s) => ({ offset: s.offset, size: s.size, cts: s.cts, duration: s.duration, isSync: true, timescale: s.timescale }));
      this.aShift = editShiftUs(file, trak);
      const desc = aacConfig(trak);
      this.aConfig = { codec: at.codec, sampleRate: at.audio.sample_rate, numberOfChannels: at.audio.channel_count, ...(desc ? { description: desc } : {}) };
      const support = await AudioDecoder.isConfigSupported(this.aConfig).catch(() => ({ supported: false }));
      this.audio = { codec: at.codec, sampleRate: at.audio.sample_rate, channels: at.audio.channel_count, samples: this.aSamples.length, supported: !!support.supported };
    }
  }

  get frameCount() { return this.pres.length; }

  private rawUs(i: number): number {
    const s = this.vSamples[this.pres[i]!]!;
    return Math.round((s.cts * 1e6) / s.timescale);
  }
  /** Display time (µs) of frame i (presentation order), edit list applied. */
  ptsUs(i: number): number { return this.rawUs(i) + this.vShift; }

  /** Frame shown at local time t (seconds): last frame with pts <= t. */
  indexAt(tS: number): number {
    const tUs = tS * 1e6;
    let lo = 0, hi = this.pres.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ptsUs(mid) <= tUs + 1) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Decoded frame i as an ImageBitmap (cached). Calls are serialised. */
  frame(i: number): Promise<ImageBitmap> {
    const p = this.decodeChain.then(() => this.decodeFrame(i));
    this.decodeChain = p.catch(() => undefined);
    return p;
  }

  private async decodeFrame(i: number): Promise<ImageBitmap> {
    i = Math.max(0, Math.min(this.pres.length - 1, i));
    const hit = this.cache.get(i);
    if (hit) return hit;
    const target = this.pres[i]!;
    let k = target;
    while (k > 0 && !this.vSamples[k]!.isSync) k--;
    // Open GOP: leading frames display before their keyframe and need the previous GOP.
    if (k > 0 && this.vSamples[target]!.cts < this.vSamples[k]!.cts) {
      k--;
      while (k > 0 && !this.vSamples[k]!.isSync) k--;
    }
    // Decode ahead (for stepping forward), but no more than half the cache holds.
    const ahead = Math.min(30, Math.floor(this.cacheMax / 2));
    let end = Math.min(this.vSamples.length - 1, target + ahead);
    for (let j = target + 1; j <= end; j++) if (this.vSamples[j]!.isSync) { end = j - 1; break; }

    // One range read covering the needed samples (they are close together).
    const first = this.vSamples.slice(k, end + 1).reduce((a, s) => Math.min(a, s.offset), Infinity);
    const last = this.vSamples.slice(k, end + 1).reduce((a, s) => Math.max(a, s.offset + s.size), 0);
    const buf = new Uint8Array(await this.read(first, last));

    const rawToPres = new Map<number, number>();
    for (let p = Math.max(0, i - 60); p < Math.min(this.pres.length, i + 60); p++) rawToPres.set(this.rawUs(p), p);
    const pending: Promise<void>[] = [];
    let decodeErr: unknown = null;
    const decoder = new VideoDecoder({
      output: (f) => {
        const p = rawToPres.get(f.timestamp);
        // Keep only frames near the target: a whole GOP of 4K bitmaps would not fit.
        if (p === undefined || p < i - ahead || p > i + ahead) { f.close(); return; }
        const sz = this.bmpSize;
        if (sz) {
          // Shrink on the GPU (createImageBitmap's own resize is slow for 4K frames).
          try { this.put(p, this.shrunk(f, sz.w, sz.h)); } finally { f.close(); }
          return;
        }
        pending.push(createImageBitmap(f).then((bmp) => { f.close(); this.put(p, bmp); }, (e) => { f.close(); throw e; }));
      },
      error: (e) => { decodeErr = e; },
    });
    decoder.configure(this.vConfig);
    for (let j = k; j <= end; j++) {
      const s = this.vSamples[j]!;
      decoder.decode(new EncodedVideoChunk({
        type: s.isSync ? 'key' : 'delta',
        timestamp: Math.round((s.cts * 1e6) / s.timescale),
        duration: Math.round((s.duration * 1e6) / s.timescale),
        data: buf.subarray(s.offset - first, s.offset - first + s.size),
      }));
    }
    await decoder.flush();
    decoder.close();
    await Promise.all(pending);
    if (decodeErr) throw decodeErr instanceof Error ? decodeErr : new Error(String(decodeErr));
    const bmp = this.cache.get(i);
    if (!bmp) throw new Error(`Frame ${i} did not decode`);
    return bmp;
  }

  private shrinkCanvas: OffscreenCanvas | null = null;
  /** f scaled to w x h, as a GPU-backed ImageBitmap. */
  private shrunk(f: VideoFrame, w: number, h: number): ImageBitmap {
    const c = (this.shrinkCanvas ??= new OffscreenCanvas(w, h));
    drawScaled(c.getContext('2d')!, `cache:${this.url}`, f, f.displayWidth, f.displayHeight, 0, 0, w, h);
    return c.transferToImageBitmap();
  }

  private put(p: number, bmp: ImageBitmap) {
    if (this.cache.has(p)) { bmp.close(); return; }
    this.cache.set(p, bmp);
    this.cacheOrder.push(p);
    while (this.cacheOrder.length > this.cacheMax) {
      const old = this.cacheOrder.shift()!;
      this.cache.get(old)?.close();
      this.cache.delete(old);
    }
  }

  /** Audio waveform (min/max/rms per bin), decoded once. Null without audio. */
  getWaveform(binsPerSecond = 200): Promise<Waveform | null> {
    this.waveform ??= this.decodeWaveform(binsPerSecond).catch(() => null);
    return this.waveform;
  }

  private async decodeWaveform(bps: number): Promise<Waveform | null> {
    if (!this.audio?.supported || !this.aConfig || !this.aSamples.length) return null;
    const ss = this.aSamples;
    const t0 = (ss[0]!.cts / ss[0]!.timescale) + this.aShift / 1e6;
    const last = ss[ss.length - 1]!;
    const dur = (last.cts + last.duration) / last.timescale + this.aShift / 1e6 - t0;
    const n = Math.ceil(dur * bps) + 1;
    const min = new Float32Array(n).fill(0), max = new Float32Array(n).fill(0), sumSq = new Float64Array(n), cnt = new Uint32Array(n);
    const binDt = 1 / bps;

    const decoder = new AudioDecoder({
      output: (d) => {
        const frames = d.numberOfFrames;
        const ch = new Float32Array(frames);
        d.copyTo(ch, { planeIndex: 0, format: 'f32-planar' });
        const tStart = d.timestamp / 1e6 + this.aShift / 1e6 - t0;
        const sr = d.sampleRate;
        for (let k = 0; k < frames; k++) {
          const b = Math.floor((tStart + k / sr) * bps);
          if (b < 0 || b >= n) continue;
          const v = ch[k]!;
          if (v < min[b]!) min[b] = v;
          if (v > max[b]!) max[b] = v;
          sumSq[b] = sumSq[b]! + v * v; cnt[b] = cnt[b]! + 1;
        }
        d.close();
      },
      error: () => undefined,
    });
    decoder.configure(this.aConfig);
    // Read audio in runs of nearly-contiguous samples (they sit between video chunks).
    let i = 0;
    while (i < ss.length) {
      let j = i;
      while (j + 1 < ss.length && ss[j + 1]!.offset - (ss[j]!.offset + ss[j]!.size) < 256 * 1024 && ss[j + 1]!.offset + ss[j + 1]!.size - ss[i]!.offset < 8 << 20) j++;
      const start = ss[i]!.offset, end = ss[j]!.offset + ss[j]!.size;
      const buf = new Uint8Array(await this.read(start, end));
      for (let k = i; k <= j; k++) {
        const s = ss[k]!;
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((s.cts * 1e6) / s.timescale), duration: Math.round((s.duration * 1e6) / s.timescale), data: buf.subarray(s.offset - start, s.offset - start + s.size) }));
      }
      i = j + 1;
    }
    await decoder.flush();
    decoder.close();
    const rms = new Float32Array(n);
    for (let b = 0; b < n; b++) rms[b] = cnt[b] ? Math.sqrt(sumSq[b]! / cnt[b]!) : 0;
    return { start: t0, binDt, min, max, rms };
  }

  /** What FrameReader needs: samples in decode order, edit shift, decoder config, reads. */
  readerInput() {
    return { samples: this.vSamples, pres: this.pres, shiftUs: this.vShift, config: this.vConfig, read: (a: number, b: number) => this.read(a, b), indexAt: (t: number) => this.indexAt(t) };
  }

  /** Decoder config of the video track (re-encode in Pack & Go). */
  get videoDecoderConfig(): VideoDecoderConfig { return this.vConfig; }

  /** Reads a byte range of the file (re-encode reads sample data with it). */
  readRange(start: number, end: number): Promise<ArrayBuffer> { return this.read(start, end); }

  /** Raw track tables plus the original stsd bytes, for the MP4 muxer (Pack & Go trim). */
  async muxSource(): Promise<{ video?: SrcTrack; audio?: SrcTrack }> {
    const info = this.file.getInfo() as unknown as { videoTracks: { id: number }[]; audioTracks: { id: number }[] };
    const get = async (id: number | undefined, kind: 'video' | 'audio'): Promise<SrcTrack | undefined> => {
      if (id === undefined) return undefined;
      const r = srcTrack(this.file as unknown as Mp4Like, { id, kind });
      const stsd = new Uint8Array(await this.read(r.stsdRange.start, r.stsdRange.start + r.stsdRange.size));
      return { ...r.track, stsd };
    };
    return { video: await get(info.videoTracks[0]?.id, 'video'), audio: await get(info.audioTracks[0]?.id, 'audio') };
  }

  dispose() {
    releaseScratch(`cache:${this.url}`);
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
  }
}

function rotationOf(m: number[] | Int32Array): 0 | 90 | 180 | 270 {
  // tkhd matrix [a b u c d v x y w] in 16.16 fixed point.
  const a = m[0]! / 65536, b = m[1]! / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  const r = ((deg % 360) + 360) % 360;
  return (r === 90 || r === 180 || r === 270 ? r : 0) as 0 | 90 | 180 | 270;
}

function editShiftUs(file: Mp4File, trak: Trak): number {
  const movieTs = (file as unknown as { moov?: { mvhd?: { timescale: number } } }).moov?.mvhd?.timescale ?? 1000;
  const mediaTs = trak.mdia.mdhd.timescale;
  let shift = 0;
  for (const e of trak.edts?.elst?.entries ?? []) {
    if (e.media_time === -1) shift += (e.segment_duration * 1e6) / movieTs;
    else { shift -= (e.media_time * 1e6) / mediaTs; break; }
  }
  return Math.round(shift);
}

function boxBytes(trak: Trak, names: string[]): Uint8Array | undefined {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    for (const n of names) {
      const box = entry[n] as { write(s: DataStream): void } | undefined;
      if (box) {
        const s = new DataStream();
        box.write(s);
        return new Uint8Array((s as unknown as { buffer: ArrayBuffer }).buffer, 8);
      }
    }
  }
  return undefined;
}

/** AAC AudioSpecificConfig from the esds descriptor tree (tag 5). */
function aacConfig(trak: Trak): Uint8Array | undefined {
  const entry = trak.mdia.minf.stbl.stsd.entries[0] as { esds?: { esd?: unknown } } | undefined;
  const find = (d: unknown): Uint8Array | undefined => {
    if (!d || typeof d !== 'object') return undefined;
    const o = d as { tag?: number; data?: Uint8Array; descs?: unknown[] };
    if (o.tag === 5 && o.data) return new Uint8Array(o.data);
    for (const c of o.descs ?? []) { const r = find(c); if (r) return r; }
    return undefined;
  };
  return find(entry?.esds?.esd);
}
