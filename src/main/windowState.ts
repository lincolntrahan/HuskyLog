import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Monitor memory (DESIGN §6): remembers where the main window and each pop-out
 * window were, per window id (and per window type as a fallback), in
 * %APPDATA%/HuskyLog/window-state.json. A saved position is only reused when
 * that area is still on a connected monitor; otherwise the default applies.
 */
export interface SavedBounds { bounds: Rectangle; maximized?: boolean }
interface StateFile {
  main?: SavedBounds;
  popouts: Record<string, SavedBounds>;   // by window (panel) id
  byType: Record<string, SavedBounds>;    // by window type (video, graph, …)
  last?: SavedBounds;                     // most recent pop-out
}

const file = () => join(app.getPath('userData'), 'window-state.json');
let state: StateFile | null = null;
let timer: NodeJS.Timeout | null = null;

function load(): StateFile {
  if (state) return state;
  try {
    const s = JSON.parse(readFileSync(file(), 'utf8')) as Partial<StateFile>;
    state = { popouts: s.popouts ?? {}, byType: s.byType ?? {}, main: s.main, last: s.last };
  } catch {
    state = { popouts: {}, byType: {} };
  }
  return state;
}

function save(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void writeFile(file(), JSON.stringify(load(), null, 1), 'utf8').catch(() => undefined); }, 250);
}

/** Writes pending changes now (app quit). */
export function flushWindowState(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  try { writeFileSync(file(), JSON.stringify(load(), null, 1), 'utf8'); } catch { /* read-only profile */ }
}

/** True when enough of the rect (its title bar area included) is on a connected display. */
export function onScreen(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    const titleVisible = b.y >= a.y - 8 && b.y < a.y + a.height - 40;
    return w >= 120 && h >= 60 && titleVisible;
  });
}

const onPrimary = (b: Rectangle) => screen.getDisplayMatching(b).id === screen.getPrimaryDisplay().id;

/** Saved bounds for a pop-out: by id, then by type, then the last pop-out. */
export function popoutBounds(id: string | null, type: string | null, avoidPrimary: boolean): SavedBounds | undefined {
  const s = load();
  const c = [id ? s.popouts[id] : undefined, type ? s.byType[type] : undefined, s.last];
  return c.find((x) => x && onScreen(x.bounds) && !(avoidPrimary && onPrimary(x.bounds)));
}

export function mainBounds(avoidPrimary: boolean): SavedBounds | undefined {
  const m = load().main;
  return m && onScreen(m.bounds) && !(avoidPrimary && onPrimary(m.bounds)) ? m : undefined;
}

/** Within 2 px of where it was restored counts as "not moved". On a display
 *  scaled differently from the primary, Windows rounds sizes on every
 *  restore; saving the rounded value made windows grow ~1–5 px per launch. */
const close = (a: Rectangle, b: Rectangle) =>
  Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;

function record(win: BrowserWindow, restored: Rectangle | undefined, put: (b: SavedBounds) => void): void {
  const snap = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    // Normal bounds, so a maximized window restores to its pre-maximize size.
    const now = win.getNormalBounds();
    put({ bounds: restored && close(now, restored) ? restored : now, maximized: win.isMaximized() });
    save();
  };
  // 'move'/'resize' fire for user drags and programmatic changes alike ('moved'
  // does not), and a pop-out closed by dockview gets 'closed' but no 'close'.
  win.on('move', snap);
  win.on('resize', snap);
  win.on('maximize', snap);
  win.on('unmaximize', snap);
  win.on('close', snap);
}

export function trackMain(win: BrowserWindow, restored?: Rectangle): void {
  record(win, restored, (b) => { load().main = b; });
}

export function trackPopout(win: BrowserWindow, id: string | null, type: string | null, restored?: Rectangle): void {
  record(win, restored, (b) => {
    const s = load();
    if (id) s.popouts[id] = b;
    if (type) s.byType[type] = b;
    s.last = b;
  });
}

/** Parses the window id / type the renderer puts on the pop-out URL. */
export function popoutKey(url: string): { id: string | null; type: string | null } {
  try {
    const q = new URL(url).searchParams;
    return { id: q.get('w') || null, type: q.get('k') || null };
  } catch {
    return { id: null, type: null };
  }
}
