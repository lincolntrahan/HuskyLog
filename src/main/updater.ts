import { app, ipcMain, type BrowserWindow } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';
import { UPDATE_IPC, type UpdateStatus } from '../shared/ipc';
import { allowClose } from './workspaceService';

/**
 * Auto-update from GitHub Releases (electron-updater).
 *  - Checks once, quietly, shortly after launch, from the main process on its
 *    own network session; the app windows stay behind the offline guard.
 *    Offline (at the field) the check just fails and is logged.
 *  - A new version downloads in the background; the window then offers
 *    "Restart to update" (after asking to save). If ignored, it installs
 *    when HuskyLog is next closed.
 *  - Per-user NSIS install, so updating never needs admin rights.
 *  - HUSKYLOG_UPDATE_URL points the updater at another feed (testing).
 */

const { autoUpdater } = electronUpdater;
let status: UpdateStatus = { state: 'idle', version: app.getVersion() };
let win: BrowserWindow | null = null;
let manual = false;

async function log(msg: string): Promise<void> {
  try {
    const dir = join(app.getPath('userData'), 'logs');
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'updater.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging is best effort */ }
}

function set(s: Partial<UpdateStatus>): void {
  status = { ...status, ...s, manual };
  if (win && !win.isDestroyed()) win.webContents.send(UPDATE_IPC.status, status);
}

function notes(n: unknown): string | undefined {
  if (typeof n === 'string') return n;
  if (Array.isArray(n)) return n.map((x: { note?: string | null }) => x.note ?? '').join('\n');
  return undefined;
}

export function updaterEnabled(): boolean {
  if (process.env['HUSKYLOG_UPDATE_URL']) return true;
  return app.isPackaged && process.env['HUSKYLOG_E2E'] !== '1' && process.env['HUSKYLOG_NO_UPDATE'] !== '1';
}

export function setupUpdater(): void {
  ipcMain.handle(UPDATE_IPC.get, () => ({ ...status, enabled: updaterEnabled() }));
  ipcMain.handle(UPDATE_IPC.check, async () => {
    if (!updaterEnabled()) return { ...status, state: 'disabled' as const };
    manual = true;
    await check();
    return status;
  });
  ipcMain.handle(UPDATE_IPC.install, () => {
    if (status.state !== 'ready') return false;
    void log(`installing ${status.available}`);
    allowClose();                       // the renderer already asked to save
    setImmediate(() => autoUpdater.quitAndInstall(true, true)); // silent install, then relaunch
    return true;
  });
  if (!updaterEnabled()) return;

  const feed = process.env['HUSKYLOG_UPDATE_URL'];
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = { info: (m: unknown) => void log(`info ${String(m)}`), warn: (m: unknown) => void log(`warn ${String(m)}`), error: (m: unknown) => void log(`error ${String(m)}`), debug: () => undefined };
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current', checked: new Date().toISOString() }));
  autoUpdater.on('update-available', (i) => set({ state: 'downloading', available: i.version, percent: 0, notes: notes(i.releaseNotes) }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: p.percent }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'ready', available: i.version, notes: notes(i.releaseNotes), percent: 100 }));
  autoUpdater.on('error', (e) => {
    void log(`error ${e?.stack ?? String(e)}`);
    // Offline is normal for this app: only say so when the user asked.
    set({ state: 'error', error: friendly(e) });
  });
}

function friendly(e: unknown): string {
  const s = String((e as Error)?.message ?? e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::/i.test(s)) return 'Could not reach GitHub (offline?).';
  if (/404|latest\.yml/i.test(s)) return 'No release has been published yet.';
  return s.split('\n')[0]!.slice(0, 200);
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ state: 'error', error: friendly(e) });
  }
}

/** Call once the main window exists; checks a few seconds after launch. */
export function startUpdater(w: BrowserWindow): void {
  win = w;
  if (!updaterEnabled()) return;
  const delay = Number(process.env['HUSKYLOG_UPDATE_DELAY_MS'] ?? 8000);
  setTimeout(() => { manual = false; void check(); }, delay);
}
