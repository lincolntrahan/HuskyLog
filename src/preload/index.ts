import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type HuskyLogApi } from '../shared/ipc';

const api: HuskyLogApi = {
  openFiles: () => ipcRenderer.invoke(IPC.openFiles),
  info: () => ipcRenderer.invoke(IPC.info),
  blockedRequests: () => ipcRenderer.invoke(IPC.blockedRequests),
  e2eRegister: (path) => ipcRenderer.invoke(IPC.e2eRegister, path),
};

contextBridge.exposeInMainWorld('huskylog', api);
