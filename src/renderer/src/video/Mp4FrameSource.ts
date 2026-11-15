import { createFile, DataStream, MP4BoxBuffer } from 'mp4box';

/**
 * Frame-accurate random access to an MP4/MOV video track with WebCodecs.
 * Phase 0 spike: reads the whole file into memory. Phase 4 switches to range
 * reads through hl-file:// and adds an index for multi-GB files.
 *
 * Timing uses each frame's presentation timestamp (cts), never index / fps,
 * because phone video is often variable frame rate.
 */

interface RawSample { cts: number; dts: number; duration: number; isSync: boolean; data: Uint8Array; timescale: number }

export interface TrackInfo {
  codec: string;
  width: number;
  height: number;
  frames: number;
  keyframes: number;
  durationS: number;
  fpsAvg: number;
  vfr: boolean;
  supported: boolean;
}

export class Mp4FrameSource {
  private samples: RawSample[] = []; // decode order
  private pres: number[] = []; // presentation order → decode index
  private config!: VideoDecoderConfig;
  private cache = new Map<number, ImageBitmap>(); // presentation index → bitmap
  private cacheOrder: number[] = [];
  private static CACHE_MAX = 90;
  info!: TrackInfo;

  static async open(url: string): Promise<Mp4FrameSource> {
    const src = new Mp4FrameSource();
    await src.load(url);
    return src;
  }

  get frameCount() { return this.pres.length; }

  /** Edit-list shift (µs) from raw composition time to display time. */
  private shiftUs = 0;

  /** Raw composition timestamp of frame i (µs): what the decoder sees. */
  private rawUs(i: number): number {
    const s = this.samples[this.pres[i]!]!;
    return Math.round((s.cts * 1e6) / s.timescale);
  }

  /** Display timestamp of frame i, in microseconds, with the edit list applied.
   *  B-frame encoders shift composition times (x264: +2 frames) and write an
   *  edit list to undo it; ignoring it makes every frame read late. */
  ptsUs(i: number): number {
    return this.rawUs(i) + this.shiftUs;
  }

  /** Index of the frame shown at time tUs (last frame with pts <= tUs). */
  indexAt(tUs: number): number {
    let lo = 0, hi = this.pres.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ptsUs(mid) <= tUs) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  private async load(url: string) {
    const buf = await (await fetch(url)).arrayBuffer();
    const file = createFile();
    let trackId = -1;
    let meta: { codec: string; width: number; height: number } | null = null;
    file.onError = (e: unknown) => { throw new Error(String(e)); };
    file.onReady = (info) => {
      const vt = info.videoTracks[0];
      if (!vt) throw new Error('No video track');
      trackId = vt.id;
      meta = { codec: vt.codec, width: vt.video!.width, height: vt.video!.height };
      file.setExtractionOptions(trackId, undefined, { nbSamples: 1e9 });
      file.start();
    };
    file.onSamples = (_id, _user, samples) => {
      for (const s of samples) {
        this.samples.push({ cts: s.cts, dts: s.dts, duration: s.duration, isSync: s.is_sync, data: s.data!, timescale: s.timescale });
      }
    };
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0), true);
    file.flush();
    if (!meta) throw new Error('Not a readable MP4/MOV file');
    const m = meta as { codec: string; width: number; height: number };

    this.config = { codec: m.codec, codedWidth: m.width, codedHeight: m.height, description: this.description(file, trackId) };
    this.pres = this.samples.map((_, i) => i).sort((a, b) => this.samples[a]!.cts - this.samples[b]!.cts);
    this.shiftUs = this.editListShiftUs(file, trackId);

    const support = await VideoDecoder.isConfigSupported(this.config);
    const n = this.pres.length;
    const durS = n > 1 ? (this.ptsUs(n - 1) - this.ptsUs(0)) / 1e6 : 0;
    const deltas = this.pres.slice(1).map((_, i) => this.ptsUs(i + 1) - this.ptsUs(i));
    const minD = Math.min(...deltas), maxD = Math.max(...deltas);
    this.info = {
      codec: m.codec, width: m.width, height: m.height, frames: n,
      keyframes: this.samples.filter((s) => s.isSync).length,
      durationS: durS, fpsAvg: durS > 0 ? (n - 1) / durS : 0,
      vfr: maxD - minD > 1000, // > 1 ms spread between frame intervals
      supported: !!support.supported,
    };
  }

  /** Initial empty edits delay the track; the first real edit's media_time says
   *  which composition time is shown at t = 0. */
  private editListShiftUs(file: ReturnType<typeof createFile>, trackId: number): number {
    const f = file as unknown as { moov?: { mvhd?: { timescale: number } } };
    const trak = file.getTrackById(trackId) as unknown as {
      mdia: { mdhd: { timescale: number } };
      edts?: { elst?: { entries: Array<{ segment_duration: number; media_time: number }> } };
    };
    const entries = trak.edts?.elst?.entries ?? [];
    const movieTs = f.moov?.mvhd?.timescale ?? 1000;
    const mediaTs = trak.mdia.mdhd.timescale;
    let shift = 0;
    for (const e of entries) {
      if (e.media_time === -1) {
        shift += (e.segment_duration * 1e6) / movieTs;
      } else {
        shift -= (e.media_time * 1e6) / mediaTs;
        break;
      }
    }
    return Math.round(shift);
  }

  private description(file: ReturnType<typeof createFile>, trackId: number): Uint8Array | undefined {
    const trak = file.getTrackById(trackId) as unknown as {
      mdia: { minf: { stbl: { stsd: { entries: Array<Record<string, { write(s: DataStream): void } | undefined>> } } } };
    };
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry['avcC'] ?? entry['hvcC'] ?? entry['vpcC'] ?? entry['av1C'];
      if (box) {
        const stream = new DataStream();
        box.write(stream);
        return new Uint8Array((stream as unknown as { buffer: ArrayBuffer }).buffer, 8); // skip box header
      }
    }
    return undefined;
  }

  /** Decoded frame i (presentation order) as an ImageBitmap. */
  async frame(i: number): Promise<ImageBitmap> {
    i = Math.max(0, Math.min(this.pres.length - 1, i));
    const hit = this.cache.get(i);
    if (hit) return hit;

    // Decode from the keyframe at or before frame i's decode position, then keep
    // going a little past it so the next forward steps are cache hits.
    const target = this.pres[i]!;
    let k = target;
    while (k > 0 && !this.samples[k]!.isSync) k--;
    // Open GOP (x265 default, some Android phones): "leading" frames are stored
    // after a keyframe but displayed before it and reference the previous GOP.
    // If the target displays before the keyframe we found, start one GOP earlier.
    if (k > 0 && this.samples[target]!.cts < this.samples[k]!.cts) {
      k--;
      while (k > 0 && !this.samples[k]!.isSync) k--;
    }
    let end = Math.min(this.samples.length - 1, target + 30);
    for (let j = target + 1; j <= end; j++) if (this.samples[j]!.isSync) { end = j - 1; break; }

    const tsToPres = new Map<number, number>();
    for (let p = 0; p < this.pres.length; p++) tsToPres.set(this.rawUs(p), p);

    const pending: Promise<void>[] = [];
    const decoder = new VideoDecoder({
      output: (f) => {
        const p = tsToPres.get(f.timestamp);
        pending.push(
          createImageBitmap(f).then((bmp) => { f.close(); if (p !== undefined) this.put(p, bmp); else bmp.close(); }),
        );
      },
      error: (e) => { throw e; },
    });
    decoder.configure(this.config);
    for (let j = k; j <= end; j++) {
      const s = this.samples[j]!;
      decoder.decode(new EncodedVideoChunk({
        type: s.isSync ? 'key' : 'delta',
        timestamp: Math.round((s.cts * 1e6) / s.timescale),
        duration: Math.round((s.duration * 1e6) / s.timescale),
        data: s.data,
      }));
    }
    await decoder.flush();
    decoder.close();
    await Promise.all(pending);
    const bmp = this.cache.get(i);
    if (!bmp) throw new Error(`Frame ${i} did not decode`);
    return bmp;
  }

  private put(p: number, bmp: ImageBitmap) {
    if (this.cache.has(p)) { bmp.close(); return; }
    this.cache.set(p, bmp);
    this.cacheOrder.push(p);
    while (this.cacheOrder.length > Mp4FrameSource.CACHE_MAX) {
      const old = this.cacheOrder.shift()!;
      this.cache.get(old)?.close();
      this.cache.delete(old);
    }
  }

  dispose() {
    for (const b of this.cache.values()) b.close();
    this.cache.clear();
  }
}
