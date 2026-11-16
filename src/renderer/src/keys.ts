import { useApp } from './store';
import { timeDomain, useTimeline } from './data/timeline';

/**
 * Review keyboard shortcuts, installed on the main window and on every pop-out
 * window (a pop-out is its own OS window, so its key events never reach the
 * main window's listeners).
 *   Space        play / pause
 *   ← / →        step 1/30 s (Shift: 1 s)
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
    const dt = (e.shiftKey ? 1 : 1 / 30) * (e.key === 'ArrowRight' ? 1 : -1);
    tl.setPlaying(false);
    tl.setT(clamp(tl.t + dt));
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
