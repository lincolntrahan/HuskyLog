import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFile, MP4BoxBuffer } from 'mp4box';
import { buildMp4, copyAudioTrack, planVideoTrim, trimVideoTrack, type Run, type SrcTrack } from './mp4mux';
import { srcTrack, type Mp4Like } from './mp4src';

const gen = resolve(__dirname, '../../../test-data/generated');
const clip = (n: string) => join(gen, n);

function parse(buf: Uint8Array) {
  const f = createFile();
  let info: { videoTracks: { id: number }[]; audioTracks: { id: number }[] } | null = null;
  f.onReady = (i) => { info = i as unknown as typeof info; };
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  f.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, 0), true);
  f.flush();
  if (!info) throw new Error('mp4box did not parse');
  const i = info as { videoTracks: { id: number }[]; audioTracks: { id: number }[] };
  const get = (id: number | undefined, kind: 'video' | 'audio'): SrcTrack | undefined => {
    if (id === undefined) return undefined;
    const r = srcTrack(f as unknown as Mp4Like, { id, kind });
    return { ...r.track, stsd: buf.subarray(r.stsdRange.start, r.stsdRange.start + r.stsdRange.size) };
  };
  return { video: get(i.videoTracks[0]?.id, 'video'), audio: get(i.audioTracks[0]?.id, 'audio') };
}

const ptsOf = (t: SrcTrack) => t.samples.map((s) => s.cts / t.timescale + t.shift).sort((a, b) => a - b);

function assemble(src: Uint8Array, tracks: Parameters<typeof buildMp4>[0], runs: Run[]): Uint8Array {
  const { head, moov, fileSize } = buildMp4(tracks);
  const out = new Uint8Array(fileSize);
  out.set(head);
  let p = head.length;
  for (const r of runs) { out.set(src.subarray(r.offset, r.offset + r.size), p); p += r.size; }
  out.set(moov, p);
  return out;
}

describe.runIf(existsSync(clip('h264_60fps_bframes.mp4')))('mp4 trim (stream copy)', () => {
  it('keeps exact frame times and bytes for a B-frame H.264 clip', () => {
    const src = new Uint8Array(readFileSync(clip('h264_60fps_bframes.mp4')));
    const s = parse(src);
    const v = s.video!;
    const plan = planVideoTrim(v, 4.0, 7.0);
    expect(v.samples[plan.first]!.sync).toBe(true);
    const tv = trimVideoTrack(v, plan.first, plan.last);
    const out = assemble(src, [tv.track], tv.runs);
    const o = parse(out);
    const ov = o.video!;
    expect(ov.samples.length).toBe(plan.last - plan.first + 1);
    expect(ov.timescale).toBe(v.timescale);
    expect(ov.width).toBe(v.width);
    // Every frame keeps its presentation time, minus tCut.
    const oldPts = ptsOf({ ...v, samples: v.samples.slice(plan.first, plan.last + 1) });
    const newPts = ptsOf(ov);
    expect(newPts.length).toBe(oldPts.length);
    for (let i = 0; i < newPts.length; i++) expect(newPts[i]! + plan.tCut).toBeCloseTo(oldPts[i]!, 9);
    // The trim covers the requested range in whole GOPs.
    expect(oldPts[0]!).toBeLessThanOrEqual(4.0 + 1e-9);
    expect(oldPts[oldPts.length - 1]!).toBeGreaterThanOrEqual(7.0 - 0.02);
    // Sample bytes are identical (stream copy).
    for (const k of [0, 5, ov.samples.length - 1]) {
      const a = v.samples[plan.first + k]!, b = ov.samples[k]!;
      expect(Buffer.compare(Buffer.from(src.subarray(a.offset, a.offset + a.size)), Buffer.from(out.subarray(b.offset, b.offset + b.size)))).toBe(0);
      expect(b.sync).toBe(a.sync);
    }
  });
});

describe.runIf(existsSync(clip('ground_cam_sync.mp4')))('mp4 trim with audio', () => {
  it('keeps audio aligned to the video (new pts = old pts − tCut)', () => {
    const src = new Uint8Array(readFileSync(clip('ground_cam_sync.mp4')));
    const s = parse(src);
    const v = s.video!, a = s.audio!;
    const plan = planVideoTrim(v, 10.3, 30.0);
    const tv = trimVideoTrack(v, plan.first, plan.last);
    const firstPts = ptsOf({ ...v, samples: v.samples.slice(plan.first, plan.last + 1) })[0]!;
    const ta = copyAudioTrack(a, plan.tCut, firstPts, 30.0)!;
    const out = assemble(src, [tv.track, ta.track], [...tv.runs, ...ta.runs]);
    const o = parse(out);
    const oa = o.audio!;
    expect(oa.samples.length).toBe(ta.track.samples.length);
    const keptOld = a.samples.filter((x) => x.cts / a.timescale + a.shift >= firstPts - 1e-9 && x.cts / a.timescale + a.shift <= 30);
    const oldA = keptOld.map((x) => x.cts / a.timescale + a.shift);
    const newA = oa.samples.map((x) => x.cts / oa.timescale + oa.shift);
    // Edit-list rounding is below a microsecond (movie timescale 1 MHz).
    for (const k of [0, 10, newA.length - 1]) expect(Math.abs(newA[k]! + plan.tCut - oldA[k]!)).toBeLessThan(2e-6);
    expect(oa.timescale).toBe(a.timescale);
  });
});
