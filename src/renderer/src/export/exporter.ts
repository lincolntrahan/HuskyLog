import { buildMp4, copyAudioTrack, type MuxTrack, type Run } from '@core/pack/mp4mux';
import { buildPalette, GifEncoder, samplePixels } from '@core/export/gif';
import { mediaSource, useMedia } from '../data/media';
import { masterToLocal } from '../data/sync';
import { useTimeline } from '../data/timeline';
import { drawOverlays } from '../overlay/draw';
import { useOverlays } from '../overlay/model';
import { H264Sink } from '../video/h264';
import { exportSource, isShown, setExporting } from './registry';
import { startExportReaders, stopExportReaders } from './videoDraw';

/**
 * Export (DESIGN §10): a deterministic offline render, not screen capture.
 * For each frame time the windows draw themselves at exactly that time
 * (decoded video frame, rendered map once its tiles have loaded, graph,
 * instrument), overlays go on top, and the frame is encoded. The user's
 * playhead is restored afterwards.
 */
export type LayoutKind = 'screen' | 'grid' | 'pip';
export interface ExportOptions {
  windows: string[];
  layout: LayoutKind;
  t0: number; t1: number;
  width: number; height: number; fps: number;
  format: 'mp4' | 'gif';
  /** Video stream whose audio goes into the MP4 (null: silent). */
  audio: string | null;
}
export interface Placement { id: string; x: number; y: number; w: number; h: number }
type Ctx = OffscreenCanvasRenderingContext2D;

export const GIF_MAX_SECONDS = 10;
export const GIF_MAX_WIDTH = 800;
const BG = '#0d1014';

const aspectOf = (id: string) => {
  const el = exportSource(id)?.content();
  return el && el.clientWidth && el.clientHeight ? el.clientWidth / el.clientHeight : 16 / 9;
};

function gridLayout(ids: string[], W: number, H: number, gap: number): Placement[] {
  const n = ids.length;
  // Pick the column count that wastes the least area for these aspect ratios.
  let best: Placement[] = [], bestScore = -1;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols + 1)) / cols, ch = (H - gap * (rows + 1)) / rows;
    let used = 0;
    const pl = ids.map((id, i) => {
      const a = aspectOf(id);
      const w = Math.min(cw, ch * a), h = w / a;
      used += w * h;
      const c = i % cols, r = Math.floor(i / cols);
      return { id, x: Math.round(gap + c * (cw + gap) + (cw - w) / 2), y: Math.round(gap + r * (ch + gap) + (ch - h) / 2), w: Math.round(w), h: Math.round(h) };
    });
    if (used > bestScore) { bestScore = used; best = pl; }
  }
  return best;
}

/** Where each window goes in a W×H frame. */
export function computeLayout(o: Pick<ExportOptions, 'windows' | 'layout'>, W: number, H: number): Placement[] {
  const ids = o.windows.filter((id) => exportSource(id));
  if (!ids.length) return [];
  if (o.layout === 'pip' && ids.length > 1) {
    const [main, ...rest] = ids;
    const m = Math.round(W * 0.02);
    const out: Placement[] = [{ id: main!, x: 0, y: 0, w: W, h: H }];
    let y = H - m;
    for (const id of rest) {
      const w = Math.round(W * 0.3), h = Math.round(w / aspectOf(id));
      y -= h;
      out.push({ id, x: W - m - w, y, w, h });
      y -= m;
    }
    return out;
  }
  if (o.layout === 'screen') {
    const els = ids.map((id) => exportSource(id)!.content());
    const sameWindow = els.every((e) => isShown(e) && e!.ownerDocument === els[0]!.ownerDocument);
    if (sameWindow) {
      const rects = els.map((e) => e!.getBoundingClientRect());
      const x0 = Math.min(...rects.map((r) => r.left)), y0 = Math.min(...rects.map((r) => r.top));
      const bw = Math.max(...rects.map((r) => r.right)) - x0, bh = Math.max(...rects.map((r) => r.bottom)) - y0;
      const s = Math.min(W / bw, H / bh);
      const ox = (W - bw * s) / 2, oy = (H - bh * s) / 2;
      return ids.map((id, i) => {
        const r = rects[i]!;
        const x = Math.round(ox + (r.left - x0) * s), y = Math.round(oy + (r.top - y0) * s);
        return { id, x, y, w: Math.round(ox + (r.right - x0) * s) - x, h: Math.round(oy + (r.bottom - y0) * s) - y };
      });
    }
  }
  return gridLayout(ids, W, H, Math.round(Math.min(W, H) * 0.006));
}

/** Where export time went (ms, summed over frames): for diagnosing slow exports. */
export interface ExportTiming { render: number; encode: number; draw: Record<string, number> }

/** Renders one composite frame at master time t. */
export async function renderComposite(ctx: Ctx, placements: Placement[], t: number, W: number, H: number, timing?: ExportTiming): Promise<void> {
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  for (const p of placements) {
    const src = exportSource(p.id);
    if (!src || p.w < 2 || p.h < 2) continue;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    ctx.translate(p.x, p.y);
    const d0 = performance.now();
    await src.draw(ctx, t, p.w, p.h);
    if (timing) timing.draw[p.id] = (timing.draw[p.id] ?? 0) + performance.now() - d0;
    const items = useOverlays.getState().byWindow[p.id] ?? [];
    if (items.length) drawOverlays(ctx as unknown as CanvasRenderingContext2D, p.w, p.h, items, t);
    ctx.restore();
  }
}

export interface ExportProgress { frame: number; frames: number; phase: 'render' | 'palette' | 'write'; etaS: number | null }

/** Renders and encodes the export; writes `out`. */
export async function runExport(o: ExportOptions, out: string, onProgress: (p: ExportProgress) => void, signal: { cancelled: boolean }): Promise<{ path: string; bytes: number; frames: number; encoder?: string; timing: ExportTiming }> {
  if (o.format === 'gif' && o.t1 - o.t0 > GIF_MAX_SECONDS + 1e-6) throw new Error(`GIF export is limited to ${GIF_MAX_SECONDS} s.`);
  const W = o.width & ~1, H = o.height & ~1;
  const frames = Math.max(1, Math.round((o.t1 - o.t0) * o.fps));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: o.format === 'gif' })!;
  const placements = computeLayout(o, W, H);
  if (!placements.length) throw new Error('Choose at least one window to export.');
  const tl = useTimeline.getState();
  const saved = { t: tl.t, playing: tl.playing };
  tl.setPlaying(false);
  setExporting(true);
  startExportReaders(placements.map((p) => exportSource(p.id)?.videoStream?.()).filter((s): s is string => !!s), o.t0, o.t1);
  const started = performance.now();
  const timing: ExportTiming = { render: 0, encode: 0, draw: {} };
  const eta = (i: number) => (i > 2 ? ((performance.now() - started) / 1000 / i) * (frames - i) : null);
  try {
    if (o.format === 'mp4') {
      const temp = await window.huskylog.packTempCreate();
      const sink = await H264Sink.create({ width: W, height: H, fps: o.fps, bitsPerPixel: 0.12 }, async (b) => { await window.huskylog.packTempWrite(temp, b); });
      const keyEvery = Math.max(1, Math.round(o.fps * 2));
      for (let i = 0; i < frames; i++) {
        if (signal.cancelled) throw new Error('Export cancelled');
        const t = o.t0 + i / o.fps;
        const r0 = performance.now();
        useTimeline.getState().setT(t);
        await renderComposite(ctx, placements, t, W, H, timing);
        const r1 = performance.now();
        const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / o.fps), duration: Math.round(1e6 / o.fps) });
        await sink.add(f, i % keyEvery === 0);
        f.close();
        timing.render += r1 - r0; timing.encode += performance.now() - r1;
        onProgress({ frame: i + 1, frames, phase: 'render', etaS: eta(i + 1) });
      }
      const video = await sink.finish();
      const tracks: MuxTrack[] = [video];
      const runs: Run[] = [{ from: 'enc', offset: 0, size: sink.bytes }];
      let srcPath = '';
      if (o.audio) {
        const src = mediaSource(o.audio);
        const tables = src ? await src.muxSource() : null;
        if (tables?.audio) {
          // Output time 0 = master t0 = local L0 of that video.
          const L0 = masterToLocal(o.audio, o.t0), L1 = masterToLocal(o.audio, o.t1);
          const a = copyAudioTrack(tables.audio, L0, L0, L1);
          if (a) { tracks.push(a.track); runs.push(...a.runs); srcPath = useMedia.getState().videos[o.audio]!.path; }
        }
      }
      onProgress({ frame: frames, frames, phase: 'write', etaS: 0 });
      const mp4 = buildMp4(tracks);
      const bytes = await window.huskylog.exportWriteMp4(out, { src: srcPath, enc: temp, head: mp4.head, moov: mp4.moov, runs });
      return { path: out, bytes, frames, encoder: sink.mode, timing };
    }
    // GIF: render all frames, then one palette for the whole clip, then encode.
    const rgba: Uint8ClampedArray[] = [];
    for (let i = 0; i < frames; i++) {
      if (signal.cancelled) throw new Error('Export cancelled');
      const t = o.t0 + i / o.fps;
      useTimeline.getState().setT(t);
      const r0 = performance.now();
      await renderComposite(ctx, placements, t, W, H, timing);
      timing.render += performance.now() - r0;
      rgba.push(ctx.getImageData(0, 0, W, H).data);
      onProgress({ frame: i + 1, frames, phase: 'render', etaS: eta(i + 1) });
    }
    onProgress({ frame: frames, frames, phase: 'palette', etaS: null });
    const enc = new GifEncoder(W, H, buildPalette(samplePixels(rgba)), o.fps);
    for (let i = 0; i < rgba.length; i++) {
      if (signal.cancelled) throw new Error('Export cancelled');
      enc.addFrame(rgba[i]!);
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
    }
    onProgress({ frame: frames, frames, phase: 'write', etaS: 0 });
    const bytes = await window.huskylog.exportWriteFile(out, enc.finish());
    return { path: out, bytes, frames, timing };
  } finally {
    stopExportReaders();
    setExporting(false);
    const s = useTimeline.getState();
    s.setT(saved.t);
    s.setPlaying(saved.playing);
  }
}
