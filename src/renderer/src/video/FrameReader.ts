import type { MediaSource } from './MediaSource';

/**
 * Sequential frame access for export (DESIGN §10).
 *
 * The scrub path (MediaSource.frame) is built for random access: every cache
 * miss starts a new decoder at the previous keyframe and keeps full-size
 * bitmaps. Export walks forward in time, so this reader runs ONE decoder
 * straight through the range: each sample is read and decoded exactly once,
 * frames stay as VideoFrames (GPU memory, never copied to bitmaps), and only a
 * few are held at a time, so several 4K feeds fit in memory.
 *
 * frameAt(t) returns the frame shown at local time t (last pts <= t). The
 * frame belongs to the reader and stays valid until a later frameAt call
 * moves past it, or close().
 */
const MAX_QUEUED = 4;         // decoded frames waiting to be shown
const MAX_DECODE_QUEUE = 6;   // samples handed to the decoder but not yet decoded
const READ_BYTES = 6 << 20;   // one range read covers up to this many bytes of samples

export class FrameReader {
  private decoder: VideoDecoder;
  private queue: { pts: number; frame: VideoFrame }[] = [];
  private done = false;
  private closed = false;
  private err: Error | null = null;
  private waiters: (() => void)[] = [];

  constructor(private src: MediaSource, localStart: number, localEnd: number) {
    const inp = src.readerInput();
    this.decoder = new VideoDecoder({
      output: (f) => {
        if (this.closed) { f.close(); return; }
        this.queue.push({ pts: f.timestamp + inp.shiftUs, frame: f });
        this.signal();
      },
      error: (e) => { this.err = e instanceof Error ? e : new Error(String(e)); this.signal(); },
    });
    this.decoder.addEventListener('dequeue', () => this.signal());
    this.decoder.configure(inp.config);
    void this.feed(localStart, localEnd).catch((e) => { this.err ??= e instanceof Error ? e : new Error(String(e)); this.signal(); });
  }

  private signal() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
  private changed() { return new Promise<void>((r) => this.waiters.push(r)); }

  /** Reads and decodes samples (decode order) from the keyframe before localStart to past localEnd. */
  private async feed(localStart: number, localEnd: number) {
    const { samples, pres, indexAt, read } = this.src.readerInput();
    const i0 = indexAt(localStart), i1 = indexAt(localEnd);
    // Decode-order span: from the keyframe at or before the first needed frame
    // (one GOP earlier for an open-GOP leading frame) to the last needed frame.
    let first = Infinity, last = 0;
    for (let i = i0; i <= i1; i++) { first = Math.min(first, pres[i]!); last = Math.max(last, pres[i]!); }
    let k = first;
    while (k > 0 && !samples[k]!.isSync) k--;
    if (k > 0 && samples[first]!.cts < samples[k]!.cts) { k--; while (k > 0 && !samples[k]!.isSync) k--; }
    // References always decode before the frames using them, and flush() releases
    // reordered frames, so decoding stops at the last needed sample.
    const end = last;

    let j = k;
    while (j <= end && !this.closed) {
      // Batch nearby samples into one read (audio sits between them, so allow small gaps).
      let b = j;
      const start = samples[j]!.offset;
      while (b + 1 <= end && samples[b + 1]!.offset >= start && samples[b + 1]!.offset + samples[b + 1]!.size - start < READ_BYTES) b++;
      const lo = Math.min(...samples.slice(j, b + 1).map((s) => s.offset));
      const hi = Math.max(...samples.slice(j, b + 1).map((s) => s.offset + s.size));
      const buf = new Uint8Array(await read(lo, hi));
      for (let n = j; n <= b; n++) {
        while (!this.closed && !this.err && (this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE || this.queue.length >= MAX_QUEUED)) await this.changed();
        if (this.closed || this.err) return;
        const s = samples[n]!;
        this.decoder.decode(new EncodedVideoChunk({
          type: s.isSync ? 'key' : 'delta',
          timestamp: Math.round((s.cts * 1e6) / s.timescale),
          duration: Math.round((s.duration * 1e6) / s.timescale),
          data: buf.subarray(s.offset - lo, s.offset - lo + s.size),
        }));
      }
      j = b + 1;
    }
    if (this.closed) return;
    // flush() releases the frames still held for reordering (at most a few).
    await this.decoder.flush();
    this.done = true;
    this.signal();
  }

  /** The frame shown at local time tS (seconds); null if nothing decoded. */
  async frameAt(tS: number): Promise<VideoFrame | null> {
    const tUs = tS * 1e6 + 1;
    for (;;) {
      if (this.err) throw this.err;
      // Drop frames the next one replaces.
      while (this.queue.length >= 2 && this.queue[1]!.pts <= tUs) { this.queue.shift()!.frame.close(); this.signal(); }
      const head = this.queue[0];
      // The head is the answer once we know the following frame is later (or there is none).
      if (head && (this.queue.length >= 2 || this.done)) return head.frame;
      if (!head && this.done) return null;
      await this.changed();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const q of this.queue) q.frame.close();
    this.queue = [];
    try { this.decoder.close(); } catch { /* already closed */ }
    this.signal();
  }
}
