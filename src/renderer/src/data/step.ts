import { mediaSource, useMedia } from './media';
import { isSynced, localToMaster, masterToLocal } from './sync';
import { timeDomain, useTimeline } from './timeline';

/**
 * Review stepping: ± seconds, or ± frames of the video in view. A frame step
 * lands exactly on that video's next/previous frame (variable frame rate
 * included); with no video at the playhead it falls back to 1/30 s.
 */
type Dock = { panels: { id: string; params?: { video?: { stream?: string } }; view?: { contentComponent?: string }; api: { component?: string } }[] };

/** The video the frame steps follow: the first Video window's stream that covers the playhead. */
export function frameVideo(t = useTimeline.getState().t): string | null {
  const m = useMedia.getState();
  const dock = (window.__hl as Record<string, unknown>)['dock'] as Dock | undefined;
  const fromWindows = (dock?.panels ?? []).filter((p) => p.id.startsWith('video')).map((p) => p.params?.video?.stream).filter((s): s is string => !!s && !!m.videos[s]);
  const candidates = [...fromWindows, ...m.order];
  for (const id of candidates) {
    const v = m.videos[id]?.video;
    if (!v || !isSynced(id) || !mediaSource(id)) continue;
    const local = masterToLocal(id, t);
    if (local >= v.startS - 0.5 && local <= v.endS + 0.5) return id;
  }
  return null;
}

export function stepReview(unit: 's' | 'f', n: number): void {
  const tl = useTimeline.getState();
  const [a, b] = timeDomain();
  tl.setPlaying(false);
  let t = tl.t + (unit === 's' ? n : n / 30);
  if (unit === 'f') {
    const id = frameVideo(tl.t);
    const src = id ? mediaSource(id) : undefined;
    if (id && src) {
      const local = masterToLocal(id, tl.t);
      const i = Math.max(0, Math.min(src.frameCount - 1, src.indexAt(local + 1e-6) + n));
      t = localToMaster(id, src.ptsUs(i) / 1e6);
    }
  }
  tl.setT(Math.min(b, Math.max(a, t)));
}
