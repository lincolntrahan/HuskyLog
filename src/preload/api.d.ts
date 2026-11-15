import type { HuskyLogApi } from '../shared/ipc';

declare global {
  interface Window {
    huskylog: HuskyLogApi;
  }
  const CESIUM_BASE_URL: string;
}

export {};
