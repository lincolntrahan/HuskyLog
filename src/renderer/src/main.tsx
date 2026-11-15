import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import './app.css';
import './debug';
import { App } from './App';
import { startPlaybackClock } from './data/timeline';

// Cesium reads this global to find its workers/assets (served locally).
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = CESIUM_BASE_URL;

createRoot(document.getElementById('root')!).render(<App />);
startPlaybackClock();
