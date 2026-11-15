import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import './app.css';
import './debug';
import { App } from './App';
import { startPlaybackClock, useTimeline } from './data/timeline';
import { useExpressions } from './data/expressions';
import { useMedia, mediaSource } from './data/media';
import { useSync } from './data/sync';
import { loadChannel, useLogs } from './data/logs';
import { useOverlays } from './overlay/model';
import { startSession, workspaceDebug } from './data/workspace';

// Cesium reads this global to find its workers/assets (served locally).
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = CESIUM_BASE_URL;

createRoot(document.getElementById('root')!).render(<App />);
startPlaybackClock();
// Diagnostics for the e2e harness and DevTools.
Object.assign(window.__hl, { timeline: useTimeline, expressions: useExpressions, media: useMedia, mediaSource, syncStore: useSync, logs: useLogs, loadChannel, overlays: useOverlays, workspace: workspaceDebug });
void startSession();
