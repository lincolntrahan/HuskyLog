import { contextBridge, ipcRenderer } from 'electron';
import { IPC, WS_IPC, type HuskyLogApi, type MapProgress, type PackProgress } from '../shared/ipc';

const api: HuskyLogApi = {
  openFiles: () => ipcRenderer.invoke(IPC.openFiles),
  info: () => ipcRenderer.invoke(IPC.info),
  blockedRequests: () => ipcRenderer.invoke(IPC.blockedRequests),
  saveText: (name, content, filters) => ipcRenderer.invoke(IPC.saveText, name, content, filters),
  openText: (filters) => ipcRenderer.invoke(IPC.openText, filters),
  listPresets: () => ipcRenderer.invoke(IPC.listPresets),
  savePreset: (name, json) => ipcRenderer.invoke(IPC.savePreset, name, json),
  deletePreset: (name) => ipcRenderer.invoke(IPC.deletePreset, name),
  mapAreas: () => ipcRenderer.invoke(IPC.mapAreas),
  mapEstimate: (req) => ipcRenderer.invoke(IPC.mapEstimate, req),
  mapDownload: (req) => ipcRenderer.invoke(IPC.mapDownload, req),
  mapCancel: (id) => ipcRenderer.invoke(IPC.mapCancel, id),
  mapDelete: (id) => ipcRenderer.invoke(IPC.mapDelete, id),
  onMapProgress: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, p: MapProgress) => cb(p);
    ipcRenderer.on('hl:map-progress', h);
    return () => ipcRenderer.removeListener('hl:map-progress', h);
  },
  e2eRegister: (path) => ipcRenderer.invoke(IPC.e2eRegister, path),
  e2eSaveTextTo: (path) => ipcRenderer.invoke(IPC.e2eSaveTextTo, path),
  // Workspace & Pack & Go
  pickWorkspace: () => ipcRenderer.invoke(WS_IPC.pick),
  openWorkspace: (path) => ipcRenderer.invoke(WS_IPC.open, path),
  newWorkspace: () => ipcRenderer.invoke(WS_IPC.new),
  bootSession: () => ipcRenderer.invoke(WS_IPC.boot),
  saveWorkspace: (ws, streams, path, current) => ipcRenderer.invoke(WS_IPC.save, ws, streams, path, current),
  locateFile: (name, size, hash) => ipcRenderer.invoke(WS_IPC.locate, name, size, hash),
  pickPackPath: (name) => ipcRenderer.invoke(WS_IPC.pickPack, name),
  packTempCreate: () => ipcRenderer.invoke(WS_IPC.tempCreate),
  packTempWrite: (id, data) => ipcRenderer.invoke(WS_IPC.tempWrite, id, data),
  packWrite: (spec) => ipcRenderer.invoke(WS_IPC.write, spec),
  packCancel: () => ipcRenderer.invoke(WS_IPC.cancel),
  onPackProgress: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, p: PackProgress) => cb(p);
    ipcRenderer.on('hl:pack-progress', h);
    return () => ipcRenderer.removeListener('hl:pack-progress', h);
  },
  setDirty: (d) => ipcRenderer.invoke(WS_IPC.setDirty, d),
  onSaveBeforeClose: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, token: string) => {
      const reply = `${WS_IPC.saved}:${token}`;
      void cb().then((ok) => ipcRenderer.send(reply, ok), () => ipcRenderer.send(reply, false));
    };
    ipcRenderer.on('ws:save-before-close', h);
    return () => ipcRenderer.removeListener('ws:save-before-close', h);
  },
  onOpenRequest: (cb) => {
    const h = (_e: Electron.IpcRendererEvent, path: string) => cb(path);
    ipcRenderer.on('ws:open-request', h);
    return () => ipcRenderer.removeListener('ws:open-request', h);
  },
  e2eSetDialogPaths: (paths) => ipcRenderer.invoke(WS_IPC.e2e, paths),
  exportPickPath: (name, kind) => ipcRenderer.invoke(WS_IPC.exportPick, name, kind),
  exportWriteFile: (path, data) => ipcRenderer.invoke(WS_IPC.exportWriteFile, path, data),
  exportWriteMp4: (path, spec) => ipcRenderer.invoke(WS_IPC.exportWriteMp4, path, spec),
};

contextBridge.exposeInMainWorld('huskylog', api);
