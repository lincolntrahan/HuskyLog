import { useApp } from './store';
import { timeDomain, useTimeline } from './data/timeline';
import { stepReview } from './data/step';

/**
 * Review keyboard shortcuts, installed on the main window and on every pop-out
 * window (a pop-out is its own OS window, so its key events never reach the
 * main window's listeners).
 *   Space        play / pause
 *   ← / →        step one video frame (Shift: 1 s)
 *   , / .        step one frame (Shift: 10 frames)
 *   Home / End   jump to the start / end
 */
const installed = new WeakSet<Window>();

export function handleGlobalKey(e: KeyboardEvent, inPopout: boolean): void {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target as HTMLElement | null;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
  // The Sync tab handles its own keys (Space plays the selected lane there).
  if (!inPopout && useApp.getState().tab === 'sync') return;
  const tl = useTimeline.getState();
  if (e.code === 'Space') { e.preventDefault(); tl.setPlaying(!tl.playing); return; }
  // The Sync tab has its own arrow keys; these apply to Review (and pop-outs).
  if (!inPopout && useApp.getState().tab !== 'review') return;
  const [a, b] = timeDomain();
  const clamp = (t: number) => Math.min(b, Math.max(a, t));
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    stepReview(e.shiftKey ? 's' : 'f', dir);
    e.preventDefault();
  } else if (e.key === ',' || e.key === '.' || e.key === '<' || e.key === '>') {
    stepReview('f', (e.key === '.' || e.key === '>' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    e.preventDefault();
  } else if (e.key === 'Home') { tl.setT(a); e.preventDefault(); }
  else if (e.key === 'End') { tl.setT(b); e.preventDefault(); }
}

export function installGlobalKeys(w: Window): void {
  if (installed.has(w)) return;
  installed.add(w);
  const inPopout = w !== window;
  w.addEventListener('keydown', (e) => handleGlobalKey(e, inPopout));
}
