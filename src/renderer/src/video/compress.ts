import { create } from 'zustand';
import { buildMp4, copyAudioTrack, type MuxTrack, type Run } from '@core/pack/mp4mux';
import { mediaSource, replaceVideoFile, useMedia } from '../data/media';
import { trimOf, useSync } from '../data/sync';
import { trimRange } from '../pack/packer';
import { useApp } from '../store';
import { encodeAac } from './aac';
import { reencodeVideo } from './encode';

/**
 * Compressed copies (team request: smaller workspaces to send around).
 * Re-encodes a video to H.264 with its picture adjustments baked in, writes
 * "NAME.huskylog.mp4" next to the original (never over an existing file), and
 * switches the stream to it in place. Frame times are kept exactly (minus the
 * trimmed start, which the sync markers absorb), so sync is unchanged.
 * Audio: AAC is copied; PCM is encoded to AAC.
 */
export type CompressQuality = '1080' | '720' | 'keep';
export const QUALITIES: Record<CompressQuality, { label: string; fit: { long: number; short: number } | null; bpp: number }> = {
  '1080': { label: '1080p, medium (≈ 5 Mbit/s)', fit: { long: 1920, short: 1080 }, bpp: 0.08 },
  '720': { label: '720p, small (≈ 2 Mbit/s)', fit: { long: 1280, short: 720 }, bpp: 0.07 },
  keep: { label: 'Original resolution', fit: null, bpp: 0.08 },
};
export interface CompressOptions { quality: CompressQuality; trim: boolean }

export interface CompressJob {
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  error?: string;
  before?: number;
  after?: number;
  opts: CompressOptions;
  signal: { cancelled: boolean };
}

const AUTO_KEY = 'huskylog.compressNew';
function readAuto(): CompressOptions | null {
  try { const v = localStorage.getItem(AUTO_KEY); return v ? (JSON.parse(v) as CompressOptions) : null; } catch { return null; }
}

export const useCompress = create<{ jobs: Record<string, CompressJob>; auto: CompressOptions | null }>(() => ({ jobs: {}, auto: readAuto() }));

/** "Compress new videos" (remembered on this computer). */
export function setAutoCompress(o: CompressOptions | null): void {
  useCompress.setState({ auto: o });
  try { if (o) localStorage.setItem(AUTO_KEY, JSON.stringify(o)); else localStorage.removeItem(AUTO_KEY); } catch { /* storage unavailable: the setting lasts this session */ }
}

/** Estimated size (bytes) of a compressed copy. */
export function estimateCompressed(id: string, o: CompressOptions): number | null {
  const v = useMedia.getState().videos[id];
  const vi = v?.video;
  if (!v || !vi) return null;
  const r = o.trim ? trimRange(id) : null;
  const dur = r ? Math.min(vi.endS, r[1]) - Math.max(vi.startS, r[0]) : vi.durationS;
  const q = QUALITIES[o.quality];
  const quarter = vi.rotation % 180 !== 0;
  let w = quarter ? vi.height : vi.width, h = quarter ? vi.width : vi.height;
  if (v.adjust) { if (v.adjust.rot % 180) [w, h] = [h, w]; w *= v.adjust.crop.w; h *= v.adjust.crop.h; }
  const k = q.fit ? Math.min(1, q.fit.long / Math.max(w, h), q.fit.short / Math.min(w, h)) : 1;
  return Math.round((q.bpp * w * k * h * k * (vi.fpsAvg || 30) * Math.max(0, dur)) / 8 + (v.audio ? 16000 * dur : 0));
}

/** A copy is worth making when it comes out at most this fraction of the original. */
export const WORTH_IT = 0.75;

export const isCompressedName = (p: string) => /\.huskylog(-\d+)?\.mp4$/i.test(p);

export function enqueueCompress(id: string, opts: CompressOptions): void {
  const cur = useCompress.getState().jobs[id];
  if (cur && (cur.status === 'queued' || cur.status === 'running')) return;
  useCompress.setState((s) => ({ jobs: { ...s.jobs, [id]: { status: 'queued', progress: 0, opts, signal: { cancelled: false } } } }));
  void runQueue();
}

export function cancelCompress(id: string): void {
  const j = useCompress.getState().jobs[id];
  if (!j) return;
  j.signal.cancelled = true;
  if (j.status !== 'running') dropJob(id);
}
const dropJob = (id: string) => useCompress.setState((s) => { const { [id]: _gone, ...jobs } = s.jobs; return { jobs }; });

/** After an import, starts compression if "Compress new videos" is on. */
export function maybeAutoCompress(path: string): void {
  const auto = useCompress.getState().auto;
  if (!auto || isCompressedName(path)) return;
  const v = Object.values(useMedia.getState().videos).find((x) => x.path === path);
  if (!v || v.status !== 'ready' || !v.video?.supported || v.original) return;
  // Skip videos a copy wouldn't make meaningfully smaller.
  const est = estimateCompressed(v.id, { ...auto, trim: false });
  if (est !== null && est > v.size * WORTH_IT) return;
  enqueueCompress(v.id, { ...auto, trim: false });
}

let running = false;
async function runQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = Object.entries(useCompress.getState().jobs).find(([, j]) => j.status === 'queued');
      if (!next) break;
      const [id, job] = next;
      const set = (p: Partial<CompressJob>) => useCompress.setState((s) => (s.jobs[id] ? { jobs: { ...s.jobs, [id]: { ...s.jobs[id]!, ...p } } } : s));
      set({ status: 'running', progress: 0 });
      try {
        const r = await compressVideo(id, job.opts, (f) => set({ progress: f }), job.signal);
        set({ status: 'done', progress: 1, before: r.before, after: r.after });
      } catch (e) {
        if (job.signal.cancelled) dropJob(id);
        else set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally { running = false; }
}

/** Writes the compressed copy and switches the stream to it. */
export async function compressVideo(id: string, o: CompressOptions, onProgress: (f: number) => void, signal: { cancelled: boolean }): Promise<{ path: string; before: number; after: number }> {
  const v = useMedia.getState().videos[id], src = mediaSource(id);
  if (!v?.video || !src) throw new Error('Video not loaded');
  const tables = await src.muxSource();
  if (!tables.video) throw new Error('No video track');
  const tr = o.trim ? trimRange(id) : null;
  // The stream's own trim (Sync tab) always applies; "only the flight" narrows further.
  const own = trimOf(id) ?? [v.video.startS, v.video.endS];
  const [t0, t1] = tr ? [Math.max(v.video.startS, own[0], tr[0]), Math.min(v.video.endS, own[1], tr[1])] : [Math.max(v.video.startS, own[0]), Math.min(v.video.endS, own[1])];
  const target = await window.huskylog.compressTarget(v.path);
  const temp = await window.huskylog.packTempCreate();
  const q = QUALITIES[o.quality];
  const res = await reencodeVideo(src, tables.video, t0, t1, async (b) => { await window.huskylog.packTempWrite(temp, b); }, (f) => onProgress(f * 0.97),
    { fit: q.fit, bitsPerPixel: q.bpp, bake: { fileRot: v.video.rotation, adjust: v.adjust }, signal });
  if (signal.cancelled) throw new Error('cancelled');
  const tracks: MuxTrack[] = [res.track];
  const runs: Run[] = [{ from: 'enc', offset: 0, size: res.bytes }];
  if (tables.audio) {
    const a = copyAudioTrack(tables.audio, res.tCut, res.firstPts, res.lastPts);
    if (a) { tracks.push(a.track); runs.push(...a.runs); }
  } else if (src.hasPcmAudio) {
    const pcm = await src.pcmRange(res.firstPts, res.lastPts);
    if (pcm) {
      const aac = await encodeAac(pcm.planes, pcm.rate);
      await window.huskylog.packTempWrite(temp, aac.bytes);
      tracks.push({ ...aac.track, shift: pcm.start - res.tCut - aac.delay });
      runs.push({ from: 'enc', offset: res.bytes, size: aac.bytes.length });
    }
  }
  const mp4 = buildMp4(tracks);
  const after = await window.huskylog.exportWriteMp4(target, { src: v.path, enc: temp, head: mp4.head, moov: mp4.moov, runs });
  onProgress(0.99);
  // Switch the stream to the copy. Its times start tCut later, so the markers move with them.
  const file = await window.huskylog.compressOpen(target);
  const original = v.original ?? { name: v.path.replace(/^.*[\\/]/, ''), size: v.size, path: v.path };
  await replaceVideoFile(id, file, { adjust: undefined, original });
  useSync.setState((s) => (s.markers[id] ? { markers: { ...s.markers, [id]: s.markers[id]!.map((m) => ({ ...m, t: m.t - res.tCut })) } } : s));
  // The trim is in the old file's time too: move it the same way (this also re-solves).
  const own2 = trimOf(id);
  useSync.getState().setOptions(id, own2 ? { trim: [own2[0] - res.tCut, own2[1] - res.tCut] } : {});
  useApp.setState((s) => ({ files: [...s.files.filter((f) => f.path !== file.path), file] }));
  return { path: target, before: v.size, after };
}
