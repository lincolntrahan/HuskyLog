/**
 * Minimal MP4 writer for Pack & Go (DESIGN §11.2): "trim" copies whole GOPs of
 * the original samples (no re-encode), "re-encode" wraps WebCodecs output.
 * Audio is always copied. The caller streams the sample bytes into the mdat;
 * this module only computes the plan and writes the small boxes.
 *
 * Layout: ftyp | mdat (64-bit size) | video samples | audio samples | moov.
 *
 * Time model (same as the app's MediaSource): presentation time of a sample is
 *   pts = cts / timescale + shift,  shift from the edit list
 *   (empty edits add their duration; the first media edit subtracts media_time).
 * The new file is written so that every frame's pts is the old pts − tCut, and
 * the caller moves the stream's sync markers by −tCut, so sync stays exact.
 */

export interface SrcSample { offset: number; size: number; dts: number; cts: number; duration: number; sync: boolean }
export interface SrcTrack {
  kind: 'video' | 'audio';
  timescale: number;
  samples: SrcSample[];          // decode order
  shift: number;                 // seconds, from the edit list
  stsd: Uint8Array;              // raw stsd box from the source
  width?: number; height?: number;
  matrix?: number[];             // tkhd matrix (9 values, 16.16 / 2.30 fixed)
}
export interface MuxSample { size: number; dts: number; cts: number; duration: number; sync: boolean }
export interface MuxTrack {
  kind: 'video' | 'audio';
  timescale: number;
  samples: MuxSample[];
  shift: number;                 // seconds; written as an edit list
  stsd: Uint8Array;
  width?: number; height?: number; matrix?: number[];
}
/** One contiguous piece of mdat payload, taken from a source ('src') or the re-encode temp file ('enc'). */
export interface Run { from: 'src' | 'enc'; offset: number; size: number }

export const MOVIE_TIMESCALE = 1_000_000;

const pts = (t: SrcTrack, s: SrcSample) => s.cts / t.timescale + t.shift;

/** Picks whole GOPs covering presentation times [t0, t1]. */
export function planVideoTrim(v: SrcTrack, t0: number, t1: number): { first: number; last: number; tCut: number } {
  const n = v.samples.length;
  if (!n) throw new Error('Video has no frames');
  let first = 0;
  for (let i = 0; i < n; i++) {
    const s = v.samples[i]!;
    if (s.sync && pts(v, s) <= t0 + 1e-9) first = i;
    if (s.sync && pts(v, s) > t0) break;
  }
  let last = n - 1;
  for (let i = first + 1; i < n; i++) {
    const s = v.samples[i]!;
    if (s.sync && pts(v, s) > t1) { last = i - 1; break; }
  }
  const D = v.samples[first]!.dts;
  return { first, last, tCut: D / v.timescale };
}

/** Video track of a trim: the kept samples, re-based to dts 0, same edit shift. */
export function trimVideoTrack(v: SrcTrack, first: number, last: number): { track: MuxTrack; runs: Run[] } {
  const kept = v.samples.slice(first, last + 1);
  const D = kept[0]!.dts;
  return {
    track: { kind: 'video', timescale: v.timescale, shift: v.shift, stsd: v.stsd, width: v.width, height: v.height, matrix: v.matrix, samples: kept.map((s) => ({ size: s.size, dts: s.dts - D, cts: s.cts - D, duration: s.duration, sync: s.sync })) },
    runs: mergeRuns(kept.map((s) => ({ from: 'src' as const, offset: s.offset, size: s.size }))),
  };
}

/**
 * Audio copied for old presentation times [t0, t1], positioned so that
 * new pts = old pts − tCut (any offset is absorbed by the edit list).
 */
export function copyAudioTrack(a: SrcTrack, tCut: number, t0: number, t1: number): { track: MuxTrack; runs: Run[] } | null {
  const kept = a.samples.filter((s) => pts(a, s) >= t0 - 1e-9 && pts(a, s) <= t1);
  if (!kept.length) return null;
  const D = kept[0]!.dts;
  return {
    track: { kind: 'audio', timescale: a.timescale, shift: a.shift - tCut + D / a.timescale, stsd: a.stsd, samples: kept.map((s) => ({ size: s.size, dts: s.dts - D, cts: s.cts - D, duration: s.duration, sync: true })) },
    runs: mergeRuns(kept.map((s) => ({ from: 'src' as const, offset: s.offset, size: s.size }))),
  };
}

export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const p = out[out.length - 1];
    if (p && p.from === r.from && p.offset + p.size === r.offset) p.size += r.size;
    else out.push({ ...r });
  }
  return out;
}

// ---------------------------------------------------------------- boxes

class W {
  parts: Uint8Array[] = [];
  len = 0;
  push(b: Uint8Array) { this.parts.push(b); this.len += b.length; return this; }
  u8(v: number) { return this.push(new Uint8Array([v & 255])); }
  u16(v: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return this.push(b); }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return this.push(b); }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); return this.push(b); }
  u64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(Math.round(v))); return this.push(b); }
  i64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(Math.round(v))); return this.push(b); }
  str(s: string) { return this.push(new TextEncoder().encode(s)); }
  zeros(n: number) { return this.push(new Uint8Array(n)); }
  bytes(): Uint8Array { const o = new Uint8Array(this.len); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}

function box(type: string, ...content: (Uint8Array | W)[]): Uint8Array {
  const body = content.map((c) => (c instanceof W ? c.bytes() : c));
  const size = 8 + body.reduce((s, b) => s + b.length, 0);
  const w = new W().u32(size).str(type);
  for (const b of body) w.push(b);
  return w.bytes();
}
const full = (type: string, version: number, flags: number, ...content: (Uint8Array | W)[]) =>
  box(type, new W().u8(version).u8(flags >> 16).u16(flags & 0xffff), ...content);

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

function runLength(values: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const v of values) {
    const p = out[out.length - 1];
    if (p && p[1] === v) p[0]++; else out.push([1, v]);
  }
  return out;
}

function trak(t: MuxTrack, id: number, chunkOffset: number): { box: Uint8Array; movieDuration: number } {
  const mediaDur = t.samples.reduce((s, x) => s + x.duration, 0);
  // Edit list reproducing `shift` (see header comment).
  const edits: { seg: number; media: number }[] = [];
  let mediaStart = 0;
  if (t.shift > 1e-9) edits.push({ seg: Math.round(t.shift * MOVIE_TIMESCALE), media: -1 });
  else if (t.shift < -1e-9) mediaStart = Math.round(-t.shift * t.timescale);
  const mediaSeg = Math.max(0, Math.round(((mediaDur - mediaStart) / t.timescale) * MOVIE_TIMESCALE));
  if (edits.length || mediaStart) edits.push({ seg: mediaSeg, media: mediaStart });
  const movieDuration = edits.reduce((s, e) => s + e.seg, 0) || Math.round((mediaDur / t.timescale) * MOVIE_TIMESCALE);

  const video = t.kind === 'video';
  const m = t.matrix ?? IDENTITY;
  const tkhd = new W().u64(0).u64(0).u32(id).u32(0).u64(movieDuration).zeros(8).u16(0).u16(0).u16(video ? 0 : 0x0100).u16(0);
  for (const v of m) tkhd.i32(v);
  tkhd.u32(Math.round((t.width ?? 0) * 65536)).u32(Math.round((t.height ?? 0) * 65536));

  const elst = edits.length ? box('edts', full('elst', 1, 0, (() => {
    const w = new W().u32(edits.length);
    for (const e of edits) w.u64(e.seg).i64(e.media).u16(1).u16(0);
    return w;
  })())) : new Uint8Array(0);

  const mdhd = full('mdhd', 1, 0, new W().u64(0).u64(0).u32(t.timescale).u64(mediaDur).u16(0x55c4 /* und */).u16(0));
  const hdlr = full('hdlr', 0, 0, new W().u32(0).str(video ? 'vide' : 'soun').zeros(12).str(video ? 'VideoHandler' : 'SoundHandler').u8(0));
  const xmhd = video ? full('vmhd', 0, 1, new W().zeros(8)) : full('smhd', 0, 0, new W().zeros(4));
  const dinf = box('dinf', full('dref', 0, 0, new W().u32(1), full('url ', 0, 1)));

  const stts = full('stts', 0, 0, (() => { const r = runLength(t.samples.map((s) => s.duration)); const w = new W().u32(r.length); for (const [c, d] of r) w.u32(c).u32(d); return w; })());
  const offs = t.samples.map((s) => s.cts - s.dts);
  const needCtts = offs.some((o) => o !== 0);
  const ctts = needCtts ? full('ctts', offs.some((o) => o < 0) ? 1 : 0, 0, (() => { const r = runLength(offs); const w = new W().u32(r.length); for (const [c, o] of r) w.u32(c).i32(o); return w; })()) : new Uint8Array(0);
  const syncIdx = t.samples.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
  const stss = video && syncIdx.length < t.samples.length ? full('stss', 0, 0, (() => { const w = new W().u32(syncIdx.length); for (const i of syncIdx) w.u32(i); return w; })()) : new Uint8Array(0);
  const stsc = full('stsc', 0, 0, new W().u32(1).u32(1).u32(t.samples.length).u32(1));
  const stsz = full('stsz', 0, 0, (() => { const w = new W().u32(0).u32(t.samples.length); for (const s of t.samples) w.u32(s.size); return w; })());
  const co64 = full('co64', 0, 0, new W().u32(1).u64(chunkOffset));
  const stbl = box('stbl', t.stsd, stts, ctts, stss, stsc, stsz, co64);
  const mdia = box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, stbl));
  return { box: box('trak', full('tkhd', 1, 3, tkhd), elst, mdia), movieDuration };
}

/** ftyp + mdat header, and the moov to append after the payload. */
export function buildMp4(tracks: MuxTrack[]): { head: Uint8Array; moov: Uint8Array; payloadSize: number; fileSize: number } {
  const ftyp = box('ftyp', new W().str('isom').u32(0x200).str('isomiso2avc1mp41'));
  const payloadSize = tracks.reduce((s, t) => s + t.samples.reduce((a, x) => a + x.size, 0), 0);
  const mdatHead = new W().u32(1).str('mdat').u64(16 + payloadSize).bytes();
  const head = new Uint8Array(ftyp.length + mdatHead.length);
  head.set(ftyp); head.set(mdatHead, ftyp.length);
  let off = head.length, dur = 0;
  const traks: Uint8Array[] = [];
  tracks.forEach((t, i) => {
    const r = trak(t, i + 1, off);
    traks.push(r.box);
    dur = Math.max(dur, r.movieDuration);
    off += t.samples.reduce((a, x) => a + x.size, 0);
  });
  const mvhd = new W().u64(0).u64(0).u32(MOVIE_TIMESCALE).u64(dur).u32(0x10000).u16(0x0100).zeros(10);
  for (const v of IDENTITY) mvhd.i32(v);
  mvhd.zeros(24).u32(tracks.length + 1);
  const moov = box('moov', full('mvhd', 1, 0, mvhd), ...traks);
  return { head, moov, payloadSize, fileSize: head.length + payloadSize + moov.length };
}

/** stsd with one avc1 sample entry (for WebCodecs H.264 output, AVCC format). */
export function avc1Stsd(width: number, height: number, avcC: Uint8Array): Uint8Array {
  const entry = new W().zeros(6).u16(1)            // reserved, data_reference_index
    .zeros(16).u16(width).u16(height)
    .u32(0x00480000).u32(0x00480000).u32(0).u16(1) // 72 dpi, reserved, frame_count
    .zeros(32).u16(0x0018).u16(0xffff);            // compressor name, depth, pre_defined
  return full('stsd', 0, 0, new W().u32(1), box('avc1', entry, box('avcC', avcC)));
}
