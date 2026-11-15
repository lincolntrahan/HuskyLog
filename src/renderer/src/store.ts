import { create } from 'zustand';
import type { OpenedFile } from '../../shared/ipc';
import { isLogFile, openLog } from './data/logs';
import { isVideoFile, openVideo } from './data/media';

export type AppTab = 'import' | 'sync' | 'review';

export interface CameraState {
  lon: number; lat: number; height: number;
  heading: number; pitch: number; roll: number;
}

interface AppState {
  tab: AppTab;
  setTab: (t: AppTab) => void;
  files: OpenedFile[];
  addFiles: (f: OpenedFile[]) => void;
  /** Per-window camera, kept in the store so a viewer can be re-created
   *  (e.g. after moving to a pop-out) without losing the view. */
  cameras: Record<string, CameraState>;
  setCamera: (windowId: string, c: CameraState) => void;
}

export const useApp = create<AppState>((set) => ({
  tab: 'review',
  setTab: (tab) => set({ tab }),
  files: [],
  addFiles: (f) => {
    set((s) => ({ files: [...s.files, ...f.filter((n) => !s.files.some((o) => o.path === n.path))] }));
    for (const file of f) {
      if (isLogFile(file)) void openLog(file);
      else if (isVideoFile(file)) void openVideo(file);
    }
  },
  cameras: {},
  setCamera: (id, c) => set((s) => ({ cameras: { ...s.cameras, [id]: c } })),
}));

export const isVideo = (f: OpenedFile) => /\.(mp4|mov|m4v|mkv)$/i.test(f.name);

// e2e harness hook: lets scripts/e2e.mjs add files without the native dialog
// (the main process only honours e2eRegister when HUSKYLOG_E2E=1).
window.addEventListener('hl-e2e-add', (e) => {
  const f = (e as CustomEvent<OpenedFile | null>).detail;
  if (f) useApp.getState().addFiles([f]);
});
