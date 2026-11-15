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

export interface HuskyLogApi {
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
