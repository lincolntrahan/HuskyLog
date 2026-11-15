import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, session, shell } from 'electron';
import { join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IPC, type OpenedFile } from '../shared/ipc';
import { allowFile, handleHlFile, registerHlFileScheme } from './hlFileProtocol';

const DEV_URL = process.env['ELECTRON_RENDERER_URL']; // set by electron-vite in dev
const E2E = process.env['HUSKYLOG_E2E'] === '1';
const RENDERER_DIR = join(__dirname, '../renderer');
const APP_ORIGIN = 'app://huskylog';
const blocked: string[] = [];

registerHlFileScheme();
// Test runs use a throwaway profile so they never touch the user's presets/settings.
if (E2E) app.setPath('userData', join(tmpdir(), 'huskylog-e2e-profile'));

/** Production UI is served from app://huskylog/ so pages have a real, same-origin
 *  origin (needed for pop-out windows and a strict CSP). */
function handleAppScheme(): void {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const file = normalize(join(RENDERER_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
    if (!file.startsWith(resolve(RENDERER_DIR) + sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

/** Offline guard: the app never talks to the network on its own. Only the dev
 *  server is allowed (and, in later phases, the explicit map-download action,
 *  which runs in main, not here). */
function installOfflineGuard(): void {
  const devOrigin = DEV_URL ? new URL(DEV_URL).origin : null;
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, cb) => {
      const u = new URL(details.url);
      const isDev = devOrigin && (u.origin === devOrigin || (u.hostname === 'localhost' && u.protocol === 'ws:'));
      if (isDev) return cb({});
      if (blocked.length < 500) blocked.push(details.url);
      console.warn('[offline-guard] blocked', details.url);
      cb({ cancel: true });
    },
  );
}

function windowChrome(): Electron.BrowserWindowConstructorOptions {
  return {
    backgroundColor: '#14171c',
    autoHideMenuBar: true,
  };
}

/** Optional display placement (HUSKYLOG_DISPLAY=secondary), used so automated
 *  test runs open on a second monitor instead of over whatever the user is doing. */
function placement(w: number, h: number, offset = 0): { x?: number; y?: number } {
  if (process.env['HUSKYLOG_DISPLAY'] !== 'secondary') return {};
  const primary = screen.getPrimaryDisplay();
  const d = screen.getAllDisplays().find((x) => x.id !== primary.id);
  if (!d) return {};
  const a = d.workArea;
  return { x: a.x + Math.max(0, Math.round((a.width - w) / 2)) + offset, y: a.y + Math.max(0, Math.round((a.height - h) / 2)) + offset };
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...windowChrome(),
    width: 1500,
    height: 950,
    ...placement(1500, 950),
    show: false,
    title: 'HuskyLog',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Pop-out windows render from this window's JS context. If this window
      // is minimized or covered, throttling would freeze them too.
      backgroundThrottling: false,
    },
  });
  // Test runs on another display open without stealing keyboard focus.
  const quiet = process.env['HUSKYLOG_DISPLAY'] === 'secondary';
  win.once('ready-to-show', () => (quiet ? win.showInactive() : win.show()));

  // Compare protocol + host: URL.origin is "null" for custom schemes like app://.
  const home = new URL(DEV_URL ?? APP_ORIGIN);
  const sameOrigin = (url: string) => {
    try {
      const u = new URL(url);
      return u.protocol === home.protocol && u.host === home.host;
    } catch {
      return false;
    }
  };
  // Pop-outs: allow same-origin popout.html (opened by dockview) as real OS windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url) && new URL(url).pathname.endsWith('/popout.html')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...windowChrome(), title: 'HuskyLog', ...placement(900, 600, 60),
          ...(quiet ? { focusable: false } : {}),
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) e.preventDefault();
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

function registerIpc(): void {
  ipcMain.handle(IPC.openFiles, async (e): Promise<OpenedFile[]> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Flight data', extensions: ['bin', 'tlog', 'csv', 'mp4', 'mov', 'm4v', 'mkv'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths.map(allowFile);
  });
  ipcMain.handle(IPC.info, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    offline: true as const,
  }));
  ipcMain.handle(IPC.blockedRequests, () => blocked.slice());
  ipcMain.handle(IPC.e2eRegister, (_e, path: string) => (E2E ? allowFile(path) : null));

  // Text save/open (CSV export, preset import/export).
  let e2eSavePath: string | null = null;
  ipcMain.handle(IPC.e2eSaveTextTo, (_e, path: string) => { if (E2E) e2eSavePath = path; });
  ipcMain.handle(IPC.saveText, async (e, defaultName: string, content: string, filters: Electron.FileFilter[]) => {
    let path = E2E ? e2eSavePath : null;
    if (!path) {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters });
      if (r.canceled || !r.filePath) return null;
      path = r.filePath;
    }
    await writeFile(path, content, 'utf8');
    return path;
  });
  ipcMain.handle(IPC.openText, async (e, filters: Electron.FileFilter[]) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], content: await readFile(r.filePaths[0], 'utf8') };
  });

  // Graph presets: one JSON file per preset in %APPDATA%/HuskyLog/presets.
  const presetDir = () => join(app.getPath('userData'), 'presets');
  const safe = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || 'preset';
  ipcMain.handle(IPC.listPresets, async () => {
    await mkdir(presetDir(), { recursive: true });
    const files = (await readdir(presetDir())).filter((f) => f.endsWith('.json'));
    return Promise.all(files.map(async (f) => ({ name: f.slice(0, -5), json: await readFile(join(presetDir(), f), 'utf8') })));
  });
  ipcMain.handle(IPC.savePreset, async (_e, name: string, json: string) => {
    await mkdir(presetDir(), { recursive: true });
    await writeFile(join(presetDir(), `${safe(name)}.json`), json, 'utf8');
  });
  ipcMain.handle(IPC.deletePreset, async (_e, name: string) => {
    await rm(join(presetDir(), `${safe(name)}.json`), { force: true });
  });
}

app.whenReady().then(() => {
  handleAppScheme();
  handleHlFile();
  installOfflineGuard();
  registerIpc();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('web-contents-created', (_e, contents) => {
  // Never open external links inside the app.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(DEV_URL ?? '\0')) void shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => app.quit());
