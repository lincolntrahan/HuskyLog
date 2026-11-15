import { buildMp4, copyAudioTrack, planVideoTrim, trimVideoTrack, type MuxTrack, type Run } from '@core/pack/mp4mux';
import { packEntryName, stringifyWorkspace, type Workspace } from '@core/workspace/workspace';
import type { MapArea, PackEntrySpec } from '../../../shared/ipc';
import { useLogs } from '../data/logs';
import { mediaSource, useMedia } from '../data/media';
import { localToMaster, masterToLocal, streamSolution, referenceId } from '../data/sync';
import { useTimeline } from '../data/timeline';
import { loadTrack } from '../data/track';
import { captureWorkspace, useSession } from '../data/workspace';
import { reencodeVideo } from '../video/encode';

/**
 * Pack & Go (DESIGN §11.2). The renderer plans each entry (it knows the sync
 * mapping and can read MP4 tables / run WebCodecs); main writes the zip.
 */
export type VideoMode = 'full' | 'trim' | 'reencode';
export const TRIM_MARGIN = 5; // s around the reference log

export interface PackEstimate { bytes: number; exact: boolean; perStream: { id: string; name: string; bytes: number; note: string }[]; mapAreas: MapArea[]; mapBytes: number }

const fileName = (p: string) => p.replace(/^.*[\\/]|^.*!\//g, '');

/** Master-time range the trim keeps: the selected range if there is one, else the reference log. */
export function trimBasis(): { range: [number, number]; kind: 'selection' | 'log' } | null {
  const sel = useTimeline.getState().range;
  if (sel) return { range: sel, kind: 'selection' };
  const ref = referenceId();
  const r = ref ? useLogs.getState().logs[ref]?.summary?.timeRange : undefined;
  return r ? { range: [masterOf(ref!, r[0]), masterOf(ref!, r[1])], kind: 'log' } : null;
}
const masterOf = (id: string, t: number) => localToMaster(id, t);

/** Local time range of a video to keep (+ margin), or null if unsynced. */
export function trimRange(videoId: string): [number, number] | null {
  const sol = streamSolution(videoId);
  const v = useMedia.getState().videos[videoId]?.video;
  if (!sol || sol.status === 'unsynced' || sol.status === 'reference' || !v) return null;
  const range = trimBasis()?.range;
  if (!range) return null;
  const a = masterToLocal(videoId, range[0]) - TRIM_MARGIN, b = masterToLocal(videoId, range[1]) + TRIM_MARGIN;
  const lo = Math.max(v.startS, a), hi = Math.min(v.endS, b);
  return hi > lo ? [lo, hi] : null;
}

/** Map areas overlapping any loaded log's flight. */
export async function areasForFlights(areas: MapArea[]): Promise<MapArea[]> {
  const boxes: [number, number, number, number][] = [];
  for (const id of useLogs.getState().order) {
    const tr = await loadTrack(id).catch(() => null);
    if (tr) boxes.push(tr.bbox);
  }
  return areas.filter((a) => a.complete !== false && boxes.some((b) => a.bbox[0] <= b[2] && a.bbox[2] >= b[0] && a.bbox[1] <= b[3] && a.bbox[3] >= b[1]));
}

export async function estimatePack(mode: VideoMode, includeMaps: boolean): Promise<PackEstimate> {
  const logs = useLogs.getState(), media = useMedia.getState();
  const perStream: PackEstimate['perStream'] = [];
  let exact = true;
  for (const id of logs.order) {
    const l = logs.logs[id]!;
    perStream.push({ id, name: l.name, bytes: l.size ?? 0, note: 'compressed (often 3–5× smaller)' });
    exact = false;
  }
  for (const id of media.order) {
    const v = media.videos[id]!;
    if (v.status !== 'ready' || !v.video) continue;
    const r = mode === 'full' ? null : trimRange(id);
    if (mode === 'full' || !r) {
      perStream.push({ id, name: v.name, bytes: v.size, note: mode === 'full' ? 'original' : 'not synced: kept whole' });
      continue;
    }
    if (mode === 'trim') {
      const src = await mediaSource(id)!.muxSource();
      const plan = planVideoTrim(src.video!, r[0], r[1]);
      const tv = trimVideoTrack(src.video!, plan.first, plan.last);
      const audio = src.audio ? copyAudioTrack(src.audio, plan.tCut, r[0], r[1]) : null;
      const size = buildMp4([tv.track, ...(audio ? [audio.track] : [])]).fileSize;
      perStream.push({ id, name: v.name, bytes: size, note: `trimmed to ${(r[1] - r[0]).toFixed(0)} s (stream copy)` });
    } else {
      const h = Math.min(720, v.video.height);
      const w = (v.video.width * h) / v.video.height;
      const bits = 0.1 * w * h * (v.video.fpsAvg || 30) * (r[1] - r[0]);
      perStream.push({ id, name: v.name, bytes: Math.round(bits / 8 + (v.audio ? 16000 * (r[1] - r[0]) : 0)), note: `≈ re-encoded to ${h}p, ${(r[1] - r[0]).toFixed(0)} s` });
      exact = false;
    }
  }
  let mapAreas: MapArea[] = [], mapBytes = 0;
  if (includeMaps) {
    mapAreas = await areasForFlights(await window.huskylog.mapAreas());
    mapBytes = mapAreas.reduce((s, a) => s + a.bytes, 0);
  }
  return { bytes: perStream.reduce((s, x) => s + x.bytes, 0) + mapBytes, exact, perStream, mapAreas, mapBytes };
}

export interface PackPhase { phase: 'planning' | 'encoding' | 'writing'; fraction: number; label: string }

/** Plans and writes the pack. Resolves with its path and size. */
export async function packAndGo(out: string, mode: VideoMode, includeMaps: boolean, onPhase: (p: PackPhase) => void, signal: { cancelled: boolean }): Promise<{ path: string; bytes: number }> {
  const ws: Workspace = captureWorkspace();
  if (useSession.getState().missing.length) throw new Error('Some files of this session are missing. Locate them first (Import tab), then pack.');
  const logs = useLogs.getState(), media = useMedia.getState();
  const entries: PackEntrySpec[] = [];
  const markers = { ...ws.sync.markers };

  for (const s of ws.streams) {
    if (signal.cancelled) throw new Error('Packing cancelled');
    const path = s.kind === 'log' ? logs.logs[s.id]!.path : media.videos[s.id]!.path;
    const name = packEntryName(s, fileName(path));
    onPhase({ phase: 'planning', fraction: 0, label: `Planning ${s.name}` });
    if (s.kind === 'log') {
      entries.push({ kind: 'file', name, path, method: 'deflate' });
      s.file = { name: fileName(path), size: logs.logs[s.id]!.size ?? 0, rel: name };
      continue;
    }
    const v = media.videos[s.id]!;
    const r = mode === 'full' ? null : trimRange(s.id);
    if (!r) {
      entries.push({ kind: 'file', name, path, method: 'store' });
      s.file = { name: fileName(path), size: v.size, rel: name };
      continue;
    }
    const src = mediaSource(s.id)!;
    const tables = await src.muxSource();
    if (!tables.video) throw new Error(`${v.name} has no video track`);
    let tracks: MuxTrack[], runs: Run[], tCut: number, enc: string | undefined;
    if (mode === 'trim') {
      const plan = planVideoTrim(tables.video, r[0], r[1]);
      const tv = trimVideoTrack(tables.video, plan.first, plan.last);
      const audio = tables.audio ? copyAudioTrack(tables.audio, plan.tCut, r[0], r[1]) : null;
      tracks = [tv.track, ...(audio ? [audio.track] : [])];
      runs = [...tv.runs, ...(audio?.runs ?? [])];
      tCut = plan.tCut;
    } else {
      enc = await window.huskylog.packTempCreate();
      const id = enc;
      const res = await reencodeVideo(src, tables.video, r[0], r[1], async (b) => { await window.huskylog.packTempWrite(id, b); },
        (f) => onPhase({ phase: 'encoding', fraction: f, label: `Re-encoding ${v.name}` }), { signal });
      const audio = tables.audio ? copyAudioTrack(tables.audio, res.tCut, res.firstPts, res.lastPts) : null;
      tracks = [res.track, ...(audio ? [audio.track] : [])];
      runs = [{ from: 'enc', offset: 0, size: res.bytes }, ...(audio?.runs ?? [])];
      tCut = res.tCut;
    }
    const mp4 = buildMp4(tracks);
    const mp4Name = name.replace(/\.(mov|m4v)$/i, '.mp4');
    entries.push({ kind: 'mp4', name: mp4Name, src: path, enc, head: mp4.head, moov: mp4.moov, runs });
    s.file = { name: fileName(mp4Name), size: mp4.fileSize, rel: mp4Name };
    // The new file starts tCut later: move this video's markers so sync stays exact.
    markers[s.id] = (markers[s.id] ?? []).map((m) => ({ ...m, t: m.t - tCut }));
  }
  ws.sync = { ...ws.sync, markers };
  const areas = includeMaps ? await areasForFlights(await window.huskylog.mapAreas()) : [];
  ws.mapAreas = areas.map((a) => a.id);
  ws.app = ''; ws.saved = new Date().toISOString();

  const off = window.huskylog.onPackProgress((p) => onPhase({ phase: 'writing', fraction: p.total ? p.done / p.total : 0, label: `Writing ${p.entry.replace(/^.*\//, '')}` }));
  const cancelWatch = window.setInterval(() => { if (signal.cancelled) void window.huskylog.packCancel(); }, 100);
  try {
    return await window.huskylog.packWrite({ out, workspace: stringifyWorkspace(ws), entries, mapAreas: ws.mapAreas, options: { video: mode } });
  } finally {
    off();
    window.clearInterval(cancelWatch);
  }
}
