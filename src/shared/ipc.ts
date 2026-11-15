/** IPC contract shared by main, preload and renderer. Keep it small and typed. */

export interface OpenedFile {
  path: string;
  name: string;
  size: number;
  /** URL the renderer uses to read the file (supports HTTP range requests). */
  url: string;
}

export interface PresetFile {
  name: string;
  json: string;
}

export type BBoxTuple = [west: number, south: number, east: number, north: number];

export interface MapArea {
  id: string;
  name: string;
  bbox: BBoxTuple;
  created: string;
  imageryProvider: string;
  imageryAttribution: string;
  imageryMaxZoom: number;
  terrain: boolean;
  terrainMaxZoom: number;
  tiles: number;
  failed: number;
  complete: boolean;
  bytes: number;
}

export interface MapDownloadRequest {
  /** Existing area id to resume, or omitted for a new area. */
  id?: string;
  name: string;
  bbox: BBoxTuple;
  provider: 'usgs' | 'custom';
  customUrl?: string;
  customAttribution?: string;
  imageryMaxZoom: number;
  terrain: boolean;
  terrainMaxZoom: number;
}

export interface MapProgress {
  id: string; done: number; total: number; failed: number; bytes: number;
  finished: boolean; cancelled: boolean; error?: string;
}

export interface HuskyLogApi extends WorkspaceApi, UpdateApi {
  /** Native "open files" dialog. Each chosen file is allow-listed for hl-file://. */
  openFiles(): Promise<OpenedFile[]>;
  /** App version and runtime info, for the about box and diagnostics. */
  info(): Promise<{ version: string; electron: string; chrome: string; offline: true }>;
  /** Outbound network requests blocked by the offline guard. */
  blockedRequests(): Promise<string[]>;
  /** Native save dialog, then writes UTF-8 text. Returns the path, or null if cancelled. */
  saveText(defaultName: string, content: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  /** Native open dialog for a single text file. Returns its contents, or null. */
  openText(filters: { name: string; extensions: string[] }[]): Promise<{ path: string; content: string } | null>;
  /** Graph presets stored in %APPDATA%/HuskyLog/presets. */
  listPresets(): Promise<PresetFile[]>;
  savePreset(name: string, json: string): Promise<void>;
  deletePreset(name: string): Promise<void>;
  /** Offline map cache (DESIGN §9). */
  mapAreas(): Promise<MapArea[]>;
  mapEstimate(req: MapDownloadRequest): Promise<{ imagery: number; terrain: number; bytes: number }>;
  mapDownload(req: MapDownloadRequest): Promise<MapArea>;
  mapCancel(id: string): Promise<void>;
  mapDelete(id: string): Promise<void>;
  onMapProgress(cb: (p: MapProgress) => void): () => void;
  /** Test hooks, only active when HUSKYLOG_E2E=1. */
  e2eRegister(path: string): Promise<OpenedFile | null>;
  e2eSaveTextTo(path: string): Promise<void>;
}

export const IPC = {
  openFiles: 'hl:open-files',
  info: 'hl:info',
  blockedRequests: 'hl:blocked-requests',
  saveText: 'hl:save-text',
  openText: 'hl:open-text',
  listPresets: 'hl:list-presets',
  savePreset: 'hl:save-preset',
  deletePreset: 'hl:delete-preset',
  mapAreas: 'hl:map-areas',
  mapEstimate: 'hl:map-estimate',
  mapDownload: 'hl:map-download',
  mapCancel: 'hl:map-cancel',
  mapDelete: 'hl:map-delete',
  e2eRegister: 'hl:e2e-register',
  e2eSaveTextTo: 'hl:e2e-save-text-to',
} as const;

// ---- Workspace & Pack & Go (DESIGN §11) ----

/** A workspace opened from disk, resolved by main (files allow-listed). */
export interface OpenedSession {
  kind: 'hlws' | 'hlpack';
  path: string;
  /** Workspace JSON text (renderer parses it with core/workspace). */
  workspace: string;
  /** Resolved file per stream id; null when it could not be found. */
  files: Record<string, OpenedFile | null>;
  /** Map areas a pack added to this computer's map cache. */
  importedMapAreas: string[];
}

/** Stream as the renderer describes it when saving (main fills relative paths and hashes). */
/** `ref`: a stream whose file is missing on this computer keeps its saved reference. */
export interface SaveStream { id: string; kind: 'log' | 'video'; name: string; path: string; size: number; ref?: import('../core/workspace/workspace').FileRef }

export interface PackRun { from: 'src' | 'enc'; offset: number; size: number }
export type PackEntrySpec =
  | { kind: 'file'; name: string; path: string; method: 'store' | 'deflate' }
  | { kind: 'mp4'; name: string; src: string; enc?: string; head: Uint8Array; moov: Uint8Array; runs: PackRun[] };
export interface PackSpec {
  out: string;
  /** Workspace JSON with stream refs already pointing at pack entries. */
  workspace: string;
  entries: PackEntrySpec[];
  mapAreas: string[];
  options: { video: 'full' | 'trim' | 'reencode' };
}
export interface PackProgress { done: number; total: number; entry: string; finished: boolean; error?: string; cancelled?: boolean; bytes?: number }

export interface WorkspaceApi {
  /** Native open dialog for .hlws / .hlpack. */
  pickWorkspace(): Promise<string | null>;
  /** Validates the file, then reloads the window into it. Resolves only on error. */
  openWorkspace(path: string): Promise<{ error: string }>;
  /** Reloads into an empty session. */
  newWorkspace(): Promise<void>;
  /** The session to restore at startup (once), or null. */
  bootSession(): Promise<OpenedSession | null>;
  /** Saves; path null → Save As dialog. Saving to the open .hlpack updates it in place. */
  saveWorkspace(ws: string, streams: SaveStream[], path: string | null, current: { kind: 'hlws' | 'hlpack' | 'none'; path: string | null }): Promise<{ path: string; kind: 'hlws' | 'hlpack'; workspace: string } | null>;
  /** "Locate file" for a missing stream: checks size and quick hash. */
  locateFile(name: string, size: number, quickHash?: string): Promise<{ file: OpenedFile; matches: boolean } | null>;
  /** Save dialog for a new .hlpack. */
  pickPackPath(defaultName: string): Promise<string | null>;
  /** Temp file for re-encoded video (returns an id). */
  packTempCreate(): Promise<string>;
  packTempWrite(id: string, data: Uint8Array): Promise<number>;
  /** Writes the pack. Progress arrives through onPackProgress. */
  packWrite(spec: PackSpec): Promise<{ path: string; bytes: number }>;
  packCancel(): Promise<void>;
  onPackProgress(cb: (p: PackProgress) => void): () => void;
  /** Tells main whether there are unsaved changes (close guard) and the session name. */
  setDirty(dirty: boolean): Promise<void>;
  /** Main asks the renderer to save before closing; resolve true when saved. */
  onSaveBeforeClose(cb: () => Promise<boolean>): () => void;
  /** An .hlws/.hlpack was opened from Explorer while running. */
  onOpenRequest(cb: (path: string) => void): () => void;
  /** Test hooks (HUSKYLOG_E2E=1): next dialog answers. */
  e2eSetDialogPaths(paths: { open?: string; save?: string; pack?: string; locate?: string; export?: string; closeChoice?: number }): Promise<void>;
  /** Export (DESIGN §10): save dialog, then write only to the chosen path. */
  exportPickPath(defaultName: string, kind: 'mp4' | 'gif'): Promise<string | null>;
  exportWriteFile(path: string, data: Uint8Array): Promise<number>;
  exportWriteMp4(path: string, spec: { src: string; enc?: string; head: Uint8Array; moov: Uint8Array; runs: PackRun[] }): Promise<number>;
}

export const WS_IPC = {
  pick: 'ws:pick', open: 'ws:open', new: 'ws:new', boot: 'ws:boot', save: 'ws:save', locate: 'ws:locate',
  pickPack: 'pack:pick', tempCreate: 'pack:temp-create', tempWrite: 'pack:temp-write', write: 'pack:write', cancel: 'pack:cancel',
  setDirty: 'ws:set-dirty', saved: 'ws:saved-before-close', e2e: 'ws:e2e-dialogs',
  exportPick: 'export:pick', exportWriteFile: 'export:write-file', exportWriteMp4: 'export:write-mp4',
} as const;

// ---- Updates (electron-updater, GitHub Releases) ----
export interface UpdateStatus {
  state: 'idle' | 'disabled' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  version: string;            // running version
  available?: string;         // newer version found
  percent?: number;
  notes?: string;
  error?: string;
  checked?: string;
  /** The user asked (File → Check for updates) rather than the launch check. */
  manual?: boolean;
  enabled?: boolean;
}
export interface UpdateApi {
  updateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  /** Quits, installs the downloaded update silently and relaunches. */
  installUpdate(): Promise<boolean>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
}
export const UPDATE_IPC = { get: 'update:get', check: 'update:check', install: 'update:install', status: 'update:status' } as const;
