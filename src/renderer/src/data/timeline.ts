import { create } from 'zustand';
import { useLogs } from './logs';
import { useMedia } from './media';
import { localToMaster, isSynced, trimOf } from './sync';

/**
 * Master timeline (DESIGN §6). Phase 1: master time = the first log's TimeUS
 * seconds. Phase 4 adds per-stream mappings from the Sync tab.
 */
interface TimelineState {
  t: number;                       // playhead, master seconds
  playing: boolean;
  speed: number;
  range: [number, number] | null;  // global selection (stats / export default)
  /** Workspace crop (right-drag on a timeline): every window shows only this time range. */
  crop: [number, number] | null;
  setT: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  setRange: (r: [number, number] | null) => void;
  setCrop: (r: [number, number] | null) => void;
}

export const useTimeline = create<TimelineState>((set) => ({
  t: 0,
  playing: false,
  speed: 1,
  range: null,
  crop: null,
  setT: (t) => set({ t }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  setRange: (range) => set({ range }),
  setCrop: (crop) => set((s) => {
    if (!crop) return { crop: null };
    const c: [number, number] = [Math.min(crop[0], crop[1]), Math.max(crop[0], crop[1])];
    // Keep the playhead and selection inside the crop.
    const t = Math.min(c[1], Math.max(c[0], s.t));
    const range = s.range && s.range[1] > c[0] && s.range[0] < c[1] ? [Math.max(c[0], s.range[0]), Math.min(c[1], s.range[1])] as [number, number] : null;
    return { crop: c, t, range };
  }),
}));

/** The time range the workspace shows: the crop if one is set, else everything loaded. */
export function timeDomain(): [number, number] {
  const c = useTimeline.getState().crop;
  return c ?? fullDomain();
}

/** Union of loaded logs' (and synced videos') time ranges. */
export function fullDomain(): [number, number] {
  let a = Infinity, b = -Infinity;
  for (const l of Object.values(useLogs.getState().logs)) {
    if (!l.summary) continue;
    const r = trimOf(l.id) ?? l.summary.timeRange;
    a = Math.min(a, localToMaster(l.id, r[0]));
    b = Math.max(b, localToMaster(l.id, r[1]));
  }
  for (const v of Object.values(useMedia.getState().videos)) {
    if (!v.video || !isSynced(v.id)) continue;
    const r = trimOf(v.id) ?? [v.video.startS, v.video.endS];
    a = Math.min(a, localToMaster(v.id, r[0]));
    b = Math.max(b, localToMaster(v.id, r[1]));
  }
  return Number.isFinite(a) ? [a, b] : [0, 1];
}

/** Drives playback with requestAnimationFrame. Call once at app start. */
export function startPlaybackClock(): void {
  let last = performance.now();
  const tick = (now: number) => {
    const s = useTimeline.getState();
    if (s.playing) {
      const [a, b] = s.range ?? timeDomain();
      let t = s.t + ((now - last) / 1000) * s.speed;
      if (t > b) t = s.range ? a : b; // loop inside a selection, stop at the end
      if (t >= b && !s.range) s.setPlaying(false);
      if (t < a) t = a;
      s.setT(t);
    }
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '–';
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, '0')}`;
}
