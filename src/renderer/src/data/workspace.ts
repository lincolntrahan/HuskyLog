import { create } from 'zustand';
import {
  contentKey, parseWorkspace, stringifyWorkspace, WORKSPACE_FORMAT, WORKSPACE_VERSION, type FileRef, type Workspace, type WorkspaceStream,
} from '@core/workspace/workspace';
import type { OpenedFile, OpenedSession, SaveStream } from '../../../shared/ipc';
import { openLog, useLogs } from './logs';
import { openVideo, useMedia } from './media';
import { restoreSync, useSync } from './sync';
import { useExpressions } from './expressions';
import { useTimeline } from './timeline';
import { useApp, type AppTab } from '../store';
import { useOverlays } from '../overlay/model';
import { syncWindowCounter, whenDockReady } from '../tabs/ReviewTab';

/**
 * The current session (DESIGN §11): what was opened, whether it has unsaved
 * changes, and capture/restore of everything a workspace holds.
 */
export interface MissingStream { id: string; kind: 'log' | 'video'; name: string; ref: FileRef }

interface SessionState {
  kind: 'none' | 'hlws' | 'hlpack';
  path: string | null;
  /** contentKey of the last saved/opened state; null until the session has settled. */
  savedKey: string | null;
  dirty: boolean;
  missing: MissingStream[];
  /** Map areas the opened pack added to this computer. */
  importedMapAreas: string[];
  error: string | null;
}

export const useSession = create<SessionState>(() => ({
  kind: 'none', path: null, savedKey: null, dirty: false, missing: [], importedMapAreas: [], error: null,
}));

export const sessionName = (s: Pick<SessionState, 'path'>) => (s.path ? s.path.replace(/^.*[\\/]/, '') : 'Untitled');

function dock(): { toJSON(): unknown; fromJSON(j: unknown): void } | null {
  return ((window.__hl as Record<string, unknown>)['dock'] as { toJSON(): unknown; fromJSON(j: unknown): void } | undefined) ?? null;
}

/** Everything the session holds, as a workspace (stream refs are filled by main on save). */
export function captureWorkspace(): Workspace {
  const logs = useLogs.getState(), media = useMedia.getState(), sync = useSync.getState(), tl = useTimeline.getState();
  const streams: WorkspaceStream[] = [
    ...logs.order.map((id) => logs.logs[id]!).filter((l) => l.status !== 'error').map((l) => ({ id: l.id, kind: 'log' as const, name: l.name, file: { name: l.path.replace(/^.*[\\/]/, ''), size: l.size ?? 0, path: l.path } })),
    ...media.order.map((id) => media.videos[id]!).filter((v) => v.status !== 'error').map((v) => ({ id: v.id, kind: 'video' as const, name: v.name, file: { name: v.path.replace(/^.*[\\/]/, ''), size: v.size, path: v.path } })),
    ...useSession.getState().missing.map((m) => ({ id: m.id, kind: m.kind, name: m.name, file: m.ref })),
  ];
  return {
    format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, app: '', saved: '',
    streams,
    sync: { events: sync.events, markers: sync.markers, options: sync.options, reference: sync.reference },
    layout: dock()?.toJSON() ?? null,
    expressions: useExpressions.getState().named,
    cameras: useApp.getState().cameras,
    mapAreas: [],
    ui: { t: tl.t, range: tl.range, speed: tl.speed, tab: useApp.getState().tab },
  };
}

export function saveStreams(ws: Workspace = captureWorkspace()): SaveStream[] {
  const missing = new Map(useSession.getState().missing.map((m) => [m.id, m]));
  return ws.streams.map((s) => {
    const m = missing.get(s.id);
    return m ? { id: s.id, kind: s.kind, name: s.name, path: m.ref.path ?? '', size: m.ref.size, ref: m.ref }
      : { id: s.id, kind: s.kind, name: s.name, path: s.file.path ?? '', size: s.file.size };
  });
}

// ---------------------------------------------------------------- restore

function openStream(s: WorkspaceStream, f: OpenedFile): void {
  useApp.setState((a) => ({ files: [...a.files.filter((x) => x.path !== f.path), f] }));
  if (s.kind === 'log') void openLog(f, { id: s.id, name: s.name });
  else void openVideo(f, { id: s.id, name: s.name });
}

/** Restores a session handed over by main at startup. */
export async function applySession(session: OpenedSession): Promise<void> {
  const ws = parseWorkspace(session.workspace);
  useExpressions.getState().replaceAll(ws.expressions);
  useApp.setState({ cameras: ws.cameras as ReturnType<typeof useApp.getState>['cameras'], tab: (ws.ui.tab as AppTab) || 'review' });
  const missing: MissingStream[] = [];
  for (const s of ws.streams) {
    const f = session.files[s.id];
    if (f) openStream(s, f); else missing.push({ id: s.id, kind: s.kind, name: s.name, ref: s.file });
  }
  restoreSync(ws.sync);
  useOverlays.setState({ byWindow: {}, editing: null, selected: null });
  const api = await whenDockReady();
  if (ws.layout) {
    try {
      api.fromJSON(ws.layout as Parameters<typeof api.fromJSON>[0]);
      syncWindowCounter(api);
    } catch (e) {
      useSession.setState({ error: `The window layout could not be restored (${String(e)}). The default layout is shown.` });
    }
  }
  const tl = useTimeline.getState();
  tl.setSpeed(ws.ui.speed);
  tl.setRange(ws.ui.range);
  tl.setT(ws.ui.t);
  useSession.setState({ kind: session.kind, path: session.path, missing, importedMapAreas: session.importedMapAreas, savedKey: null, dirty: false });
  settle();
}

/** A missing stream was located by the user. */
export function provideMissing(id: string, f: OpenedFile): void {
  const m = useSession.getState().missing.find((x) => x.id === id);
  if (!m) return;
  useSession.setState((s) => ({ missing: s.missing.filter((x) => x.id !== id) }));
  openStream({ id: m.id, kind: m.kind, name: m.name, file: m.ref }, f);
}

// ---------------------------------------------------------------- saving

export async function saveSession(asNew = false): Promise<boolean> {
  const s = useSession.getState();
  const ws = captureWorkspace();
  try {
    const r = await window.huskylog.saveWorkspace(stringifyWorkspace(ws), saveStreams(ws), asNew || s.kind === 'none' ? null : s.path, { kind: s.kind, path: s.path });
    if (!r) return false;
    useSession.setState({ kind: r.kind, path: r.path, savedKey: contentKey(captureWorkspace()), dirty: false, error: null });
    void window.huskylog.setDirty(false);
    return true;
  } catch (e) {
    useSession.setState({ error: `Could not save: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}` });
    return false;
  }
}

// ---------------------------------------------------------------- dirty tracking

let settleTimer: number | undefined;
/** Takes the "saved" snapshot once loading has finished (windows apply their defaults first). */
function settle(): void {
  window.clearTimeout(settleTimer);
  const check = () => {
    const loading = Object.values(useLogs.getState().logs).some((l) => l.status === 'loading') || Object.values(useMedia.getState().videos).some((v) => v.status === 'loading');
    if (loading) { settleTimer = window.setTimeout(check, 200); return; }
    settleTimer = window.setTimeout(() => useSession.setState({ savedKey: contentKey(captureWorkspace()), dirty: false }), 800);
  };
  check();
}

function updateDirty(): void {
  const s = useSession.getState();
  if (s.savedKey === null) return;
  const d = contentKey(captureWorkspace()) !== s.savedKey;
  if (d !== s.dirty) { useSession.setState({ dirty: d }); void window.huskylog.setDirty(d); }
}

function updateTitle(): void {
  const s = useSession.getState();
  document.title = `${s.dirty ? '• ' : ''}${sessionName(s)} — HuskyLog`;
}

/** Starts the session: restores a workspace handed over by main, wires dirty tracking. */
export async function startSession(): Promise<void> {
  useSession.subscribe(updateTitle);
  updateTitle();
  window.setInterval(updateDirty, 700);
  window.huskylog.onSaveBeforeClose(() => saveSession(false));
  const session = await window.huskylog.bootSession();
  if (session) await applySession(session);
  else settle();
}

/** For the e2e harness and DevTools. */
export const workspaceDebug = { captureWorkspace, saveSession, useSession, contentKey, parseWorkspace };
