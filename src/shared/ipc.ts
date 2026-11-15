/** IPC contract shared by main, preload and renderer. Keep it small and typed. */

export interface OpenedFile {
  path: string;
  name: string;
  size: number;
  /** URL the renderer uses to read the file (supports HTTP range requests). */
  url: string;
}

export interface HuskyLogApi {
  /** Native "open files" dialog. Each chosen file is allow-listed for hl-file://. */
  openFiles(): Promise<OpenedFile[]>;
  /** App version and runtime info, for the about box and diagnostics. */
  info(): Promise<{ version: string; electron: string; chrome: string; offline: true }>;
  /** Count of outbound network requests blocked by the offline guard. */
  blockedRequests(): Promise<string[]>;
  /** Test hook, only active when HUSKYLOG_E2E=1. Allow-lists a path without a dialog. */
  e2eRegister(path: string): Promise<OpenedFile | null>;
}

export const IPC = {
  openFiles: 'hl:open-files',
  info: 'hl:info',
  blockedRequests: 'hl:blocked-requests',
  e2eRegister: 'hl:e2e-register',
} as const;
