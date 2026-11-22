import { create } from 'zustand';
import { useApp } from '../store';
import { useOverlays } from '../overlay/model';
import { closeLog, useLogs } from './logs';
import { closeVideo, useMedia } from './media';
import { useSync } from './sync';
import { useSession } from './workspace';

/**
 * Removing an imported log or video (Import tab). The file on disk is never
 * touched. Its sync markers go; readouts bound to it fall back to the main
 * log; graph windows drop its lines (they listen to `removed`). Video windows
 * showing it fall back to another video, or "No video".
 */
export const useRemoved = create<{ ids: string[] }>(() => ({ ids: [] }));

export interface RemovalImpact { name: string; kind: 'log' | 'video'; markers: number; readouts: number }

export function removalImpact(id: string): RemovalImpact | null {
  const log = useLogs.getState().logs[id], video = useMedia.getState().videos[id];
  const missing = useSession.getState().missing.find((m) => m.id === id);
  const name = log?.name ?? video?.name ?? missing?.name;
  if (!name) return null;
  const kind = log || missing?.kind === 'log' ? 'log' : 'video';
  const markers = useSync.getState().markers[id]?.length ?? 0;
  const readouts = Object.values(useOverlays.getState().byWindow).flat().filter((o) => o.stream === id).length;
  return { name, kind, markers, readouts };
}

export function removeStream(id: string): void {
  const path = useLogs.getState().logs[id]?.path ?? useMedia.getState().videos[id]?.path;
  if (useLogs.getState().logs[id]) closeLog(id);
  if (useMedia.getState().videos[id]) closeVideo(id);
  useSession.setState((s) => ({ missing: s.missing.filter((m) => m.id !== id) }));
  useSync.getState().forgetStream(id);
  // Readouts bound to it fall back to the main log.
  const ov = useOverlays.getState();
  for (const [win, items] of Object.entries(ov.byWindow)) for (const it of items) if (it.stream === id) ov.patch(win, it.id, { stream: undefined });
  // Forget the file, so adding it again opens it again.
  if (path) useApp.setState((s) => ({ files: s.files.filter((f) => f.path !== path) }));
  useRemoved.setState((s) => ({ ids: [...s.ids, id] }));
}
