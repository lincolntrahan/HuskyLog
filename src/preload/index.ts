import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type HuskyLogApi } from '../shared/ipc';

const api: HuskyLogApi = {
  openFiles: () => ipcRenderer.invoke(IPC.openFiles),
  info: () => ipcRenderer.invoke(IPC.info),
  blockedRequests: () => ipcRenderer.invoke(IPC.blockedRequests),
  saveText: (name, content, filters) => ipcRenderer.invoke(IPC.saveText, name, content, filters),
  openText: (filters) => ipcRenderer.invoke(IPC.openText, filters),
  listPresets: () => ipcRenderer.invoke(IPC.listPresets),
  savePreset: (name, json) => ipcRenderer.invoke(IPC.savePreset, name, json),
  deletePreset: (name) => ipcRenderer.invoke(IPC.deletePreset, name),
  e2eRegister: (path) => ipcRenderer.invoke(IPC.e2eRegister, path),
  e2eSaveTextTo: (path) => ipcRenderer.invoke(IPC.e2eSaveTextTo, path),
};

contextBridge.exposeInMainWorld('huskylog', api);
