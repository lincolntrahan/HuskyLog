import { create } from 'zustand';
import type { OpenedFile } from '../../../shared/ipc';
import { MediaSource, type AudioInfo, type VideoInfo } from '../video/MediaSource';

/** Imported video streams (DESIGN §12, video). */
export interface VideoStream {
  id: string;
  name: string;
  path: string;
  url: string;
  size: number;
  status: 'loading' | 'ready' | 'error';
  error?: string;
  video?: VideoInfo;
  audio?: AudioInfo | null;
  createdUtc?: string | null;
}

interface MediaState { videos: Record<string, VideoStream>; order: string[] }
export const useMedia = create<MediaState>(() => ({ videos: {}, order: [] }));

const sources = new Map<string, MediaSource>();
let n = 0;

export const isVideoFile = (f: OpenedFile) => /\.(mp4|mov|m4v)$/i.test(f.name);

export async function openVideo(file: OpenedFile): Promise<void> {
  if (Object.values(useMedia.getState().videos).some((v) => v.path === file.path)) return;
  const id = `vid${++n}`;
  const name = file.name.replace(/\.[^.]+$/, '');
  useMedia.setState((s) => ({
    videos: { ...s.videos, [id]: { id, name, path: file.path, url: file.url, size: file.size, status: 'loading' } },
    order: [...s.order, id],
  }));
  const patch = (p: Partial<VideoStream>) => useMedia.setState((s) => ({ videos: { ...s.videos, [id]: { ...s.videos[id]!, ...p } } }));
  try {
    const src = await MediaSource.open(file.url, file.size);
    if (!src.video) throw new Error('No video track');
    sources.set(id, src);
    patch({ status: 'ready', video: src.video, audio: src.audio, createdUtc: src.createdUtc?.toISOString() ?? null });
  } catch (e) {
    patch({ status: 'error', error: e instanceof Error ? e.message : String(e) });
  }
}

export const mediaSource = (id: string) => sources.get(id);
