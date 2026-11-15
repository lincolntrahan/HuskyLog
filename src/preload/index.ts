import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type HuskyLogApi, type MapProgress } from '../shared/ipc';

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
};

contextBridge.exposeInMainWorld('huskylog', api);
