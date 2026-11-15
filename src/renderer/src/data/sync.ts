import { create } from 'zustand';
import { solve, toLocal, toMaster, type SyncSolution, type StreamSolution } from '@core/timesync/solver';
import { useLogs } from './logs';
import { useMedia } from './media';

/**
 * Sync state (DESIGN §5): named events, markers per stream, per-stream options,
 * and the solved mapping (master = a · local + b). Re-solved on every change.
 * Phase 6 saves this in the workspace file.
 */
export interface SyncEvent { id: string; name: string; color: string }
export interface StreamOptions { offsetOnly?: boolean; nudge?: number }

const EVENT_COLORS = ['#ffb000', '#ff5c8a', '#3ddc97', '#c792ea', '#7fdbff', '#ff7a45', '#e6db74'];

interface SyncState {
  events: SyncEvent[];
  markers: Record<string, { eventId: string; t: number }[]>;
  options: Record<string, StreamOptions>;
  reference: string | null;
  solution: SyncSolution;
  addEvent: (name: string) => string;
  renameEvent: (id: string, name: string) => void;
  removeEvent: (id: string) => void;
  setMarker: (stream: string, eventId: string, t: number) => void;
  removeMarker: (stream: string, eventId: string) => void;
  setOptions: (stream: string, o: StreamOptions) => void;
  setReference: (stream: string) => void;
}

/** All stream ids: logs first (in load order), then videos. */
export function allStreams(): { id: string; kind: 'log' | 'video'; name: string }[] {
  const l = useLogs.getState(), m = useMedia.getState();
  return [
    ...l.order.filter((id) => l.logs[id]?.status === 'ready').map((id) => ({ id, kind: 'log' as const, name: l.logs[id]!.name })),
    ...m.order.filter((id) => m.videos[id]?.status === 'ready').map((id) => ({ id, kind: 'video' as const, name: m.videos[id]!.name })),
  ];
}

function resolve(s: Pick<SyncState, 'markers' | 'options' | 'reference'>): SyncSolution {
  const streams = allStreams();
  const reference = s.reference && streams.some((x) => x.id === s.reference) ? s.reference : streams[0]?.id ?? '';
  return solve({
    reference,
    streams: streams.map((x) => ({ id: x.id, markers: s.markers[x.id] ?? [], ...s.options[x.id] })),
  });
}

let nextEvent = 1;
export const useSync = create<SyncState>((set, get) => {
  const update = (p: Partial<SyncState>) => {
    const next = { ...get(), ...p };
    set({ ...p, solution: resolve(next) });
  };
  return {
    events: [],
    markers: {},
    options: {},
    reference: null,
    solution: { streams: {}, eventTimes: {} },
    addEvent: (name) => {
      const id = `ev${nextEvent++}`;
      update({ events: [...get().events, { id, name, color: EVENT_COLORS[(get().events.length) % EVENT_COLORS.length]! }] });
      return id;
    },
    renameEvent: (id, name) => update({ events: get().events.map((e) => (e.id === id ? { ...e, name } : e)) }),
    removeEvent: (id) => {
      const markers = Object.fromEntries(Object.entries(get().markers).map(([k, v]) => [k, v.filter((m) => m.eventId !== id)]));
      update({ events: get().events.filter((e) => e.id !== id), markers });
    },
    setMarker: (stream, eventId, t) => {
      const list = (get().markers[stream] ?? []).filter((m) => m.eventId !== eventId);
      update({ markers: { ...get().markers, [stream]: [...list, { eventId, t }].sort((a, b) => a.t - b.t) } });
    },
    removeMarker: (stream, eventId) => update({ markers: { ...get().markers, [stream]: (get().markers[stream] ?? []).filter((m) => m.eventId !== eventId) } }),
    setOptions: (stream, o) => update({ options: { ...get().options, [stream]: { ...get().options[stream], ...o } } }),
    setReference: (stream) => update({ reference: stream }),
  };
});

// Re-solve when streams appear (a log or video finishes loading).
const resync = () => useSync.setState((s) => ({ solution: resolve(s) }));
useLogs.subscribe((s, p) => { if (s.logs !== p.logs) resync(); });
useMedia.subscribe((s, p) => { if (s.videos !== p.videos) resync(); });

export function streamSolution(id: string): StreamSolution | undefined {
  return useSync.getState().solution.streams[id];
}
export const referenceId = () => Object.values(useSync.getState().solution.streams).find((s) => s.status === 'reference')?.id ?? null;
export const isSynced = (id: string) => { const s = streamSolution(id); return !!s && s.status !== 'unsynced'; };
export const localToMaster = (id: string, t: number) => { const s = streamSolution(id); return s ? toMaster(s, t) : t; };
export const masterToLocal = (id: string, t: number) => { const s = streamSolution(id); return s ? toLocal(s, t) : t; };
