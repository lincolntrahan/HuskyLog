/**
 * Diagnostics surface used by the e2e/spike harness (scripts/e2e.mjs) and handy
 * in DevTools. Not part of the app's public behaviour.
 */
export interface MapDiag {
  created: number;          // viewer instances created
  frames: number;           // frames rendered by the current instance
  hostIsPopout: boolean;
  contextLost: boolean;
  lastError?: string;
}
export interface VideoDiag {
  codec?: string;
  supported?: boolean;
  samples?: number;
  keyframes?: number;
  fps?: number;
  index?: number;
  ptsUs?: number;
  lastStepMs?: number;
  error?: string;
}

export const diag = {
  maps: {} as Record<string, MapDiag>,
  videos: {} as Record<string, VideoDiag>,
};

declare global {
  interface Window {
    __hl: typeof diag & { [k: string]: unknown };
  }
}
window.__hl = diag as Window['__hl'];
