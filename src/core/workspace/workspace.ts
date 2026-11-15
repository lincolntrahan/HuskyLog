/**
 * Workspace file (.hlws, JSON) — DESIGN §11.1. Pure data + helpers, shared by
 * main (paths, hashes, packs) and renderer (capture / restore).
 */

export const WORKSPACE_FORMAT = 'huskylog-workspace';
export const WORKSPACE_VERSION = 1;

export interface FileRef {
  /** Absolute path when saved (may not exist on another machine). */
  path?: string;
  /** Path relative to the .hlws folder, or the entry name inside a pack. */
  rel?: string;
  name: string;
  size: number;
  /** The file is an entry (`rel`) inside this .hlpack (absolute path and path relative to the .hlws). */
  pack?: { path: string; rel?: string };
  /** sha256 of size + first and last 64 KB: cheap identity for "locate file". */
  quickHash?: string;
}

export interface WorkspaceStream {
  id: string;            // log1, vid2 … (sync markers and windows refer to it)
  kind: 'log' | 'video';
  name: string;
  file: FileRef;
}

export interface WorkspaceSync {
  events: { id: string; name: string; color: string }[];
  markers: Record<string, { eventId: string; t: number }[]>;
  options: Record<string, { offsetOnly?: boolean; nudge?: number }>;
  reference: string | null;
}

export interface Workspace {
  format: typeof WORKSPACE_FORMAT;
  version: number;
  app: string;                       // app version that wrote it
  saved: string;                     // ISO time
  streams: WorkspaceStream[];
  sync: WorkspaceSync;
  /** dockview toJSON(): grid, panels (with each window's config and overlays), pop-outs. */
  layout: unknown;
  expressions: Record<string, string>;
  cameras: Record<string, unknown>;
  /** Offline map areas this session uses (ids in the map cache). */
  mapAreas: string[];
  ui: { t: number; range: [number, number] | null; speed: number; tab: string };
}

export class WorkspaceError extends Error {}

/** Parses and upgrades a workspace file to the current version. */
export function parseWorkspace(text: string): Workspace {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new WorkspaceError('This is not a HuskyLog workspace (not JSON).'); }
  const w = raw as Partial<Workspace> & { format?: string; version?: number };
  if (!w || w.format !== WORKSPACE_FORMAT) throw new WorkspaceError('This is not a HuskyLog workspace.');
  if (typeof w.version !== 'number' || w.version < 1) throw new WorkspaceError('Workspace has no version.');
  if (w.version > WORKSPACE_VERSION) throw new WorkspaceError(`This workspace was saved by a newer HuskyLog (format ${w.version}). Please update the app.`);
  // Migrations go here: if (w.version === 1) { …; w.version = 2; }
  return {
    format: WORKSPACE_FORMAT,
    version: WORKSPACE_VERSION,
    app: w.app ?? '',
    saved: w.saved ?? '',
    streams: (w.streams ?? []).filter((s) => s && s.id && s.file),
    sync: { events: w.sync?.events ?? [], markers: w.sync?.markers ?? {}, options: w.sync?.options ?? {}, reference: w.sync?.reference ?? null },
    layout: w.layout ?? null,
    expressions: w.expressions ?? {},
    cameras: w.cameras ?? {},
    mapAreas: w.mapAreas ?? [],
    ui: { t: w.ui?.t ?? 0, range: w.ui?.range ?? null, speed: w.ui?.speed ?? 1, tab: w.ui?.tab ?? 'review' },
  };
}

export function stringifyWorkspace(w: Workspace): string {
  return JSON.stringify(w, null, 1);
}

/** The part that matters for "unsaved changes" (playhead and save time excluded). */
export function contentKey(w: Workspace): string {
  const { saved: _s, app: _a, ui, ...rest } = w;
  return JSON.stringify({ ...rest, range: ui.range, tab: ui.tab });
}

/** Relative path from a folder to a file, with forward slashes (Windows-safe). */
export function relativePath(fromDir: string, file: string): string | undefined {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(fromDir).split('/'), b = norm(file).split('/');
  if (!a[0] || !b[0] || a[0].toLowerCase() !== b[0].toLowerCase()) return undefined; // other drive
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i]!.toLowerCase() === b[i]!.toLowerCase()) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

/** Candidate absolute paths for a file reference, most likely first. */
export function candidatePaths(ref: FileRef, workspaceDir: string): string[] {
  const join = (d: string, r: string) => {
    const parts = d.replace(/\\/g, '/').split('/');
    for (const seg of r.split('/')) {
      if (seg === '..') parts.pop(); else if (seg !== '.' && seg) parts.push(seg);
    }
    return parts.join('\\');
  };
  const out: string[] = [];
  if (ref.rel) out.push(join(workspaceDir, ref.rel));
  if (ref.path) out.push(ref.path);
  out.push(join(workspaceDir, ref.name));
  return [...new Set(out)];
}

/** Pack entry name for a stream's file. */
export const packEntryName = (s: Pick<WorkspaceStream, 'id'>, fileName: string) =>
  `streams/${s.id}/${fileName.replace(/[\\/:*?"<>|]/g, '_')}`;
