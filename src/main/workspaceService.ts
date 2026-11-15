import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  WS_IPC, type OpenedFile, type OpenedSession, type PackEntrySpec, type PackProgress, type PackSpec, type SaveStream,
} from '../shared/ipc';
import {
  candidatePaths, parseWorkspace, relativePath, stringifyWorkspace, WorkspaceError, type FileRef, type Workspace, type WorkspaceStream,
} from '../core/workspace/workspace';
import { allowFile, allowVirtual, virtualSource } from './hlFileProtocol';
import { extractEntry, readEntry, readZip, replaceEntries, ZipWriter, type ZipEntry } from './zip';
import { invalidateAreas, mapsDir } from './mapCache';

/**
 * Workspace (.hlws) and Pack & Go (.hlpack) — DESIGN §11.
 * Opening a session reloads the renderer into a clean state and hands it the
 * resolved session at boot (bootSession), so nothing from the previous session
 * can leak into the next one.
 */

const E2E = process.env['HUSKYLOG_E2E'] === '1';
const PACK_FORMAT = 'huskylog-pack';

let pending: OpenedSession | null = null;
let dirty = false;
let forceClose = false;
const e2e: { open?: string; save?: string; pack?: string; locate?: string; export?: string; closeChoice?: number } = {};
const temps = new Map<string, string>();
let packCancelled = false;

/** Pack entries extracted to the cache (deflated logs): cache path → origin. */
const extracted = new Map<string, { pack: string; entry: string }>();
const zipCache = new Map<string, { mtime: number; entries: ZipEntry[] }>();

async function entriesOf(pack: string): Promise<ZipEntry[]> {
  const m = statSync(pack).mtimeMs;
  const c = zipCache.get(pack.toLowerCase());
  if (c && c.mtime === m) return c.entries;
  const entries = await readZip(pack);
  zipCache.set(pack.toLowerCase(), { mtime: m, entries });
  return entries;
}

/** sha256(size | first 64 KB | last 64 KB): fast identity check for big files. */
export async function quickHash(path: string, size = statSync(path).size): Promise<string> {
  const h = createHash('sha256').update(String(size));
  const fh = await open(path, 'r');
  try {
    const n = Math.min(65536, size);
    const a = Buffer.alloc(n);
    await fh.read(a, 0, n, 0);
    h.update(a);
    if (size > n) { const b = Buffer.alloc(n); await fh.read(b, 0, n, size - n); h.update(b); }
  } finally { await fh.close(); }
  return h.digest('hex');
}

/** The pack and entry behind a renderer-side path, if it lives in a pack. */
function packOrigin(path: string): { pack: string; entry: string } | undefined {
  const i = path.indexOf('!/');
  if (i > 0 && /\.hlpack$/i.test(path.slice(0, i))) return { pack: path.slice(0, i), entry: path.slice(i + 2) };
  return extracted.get(resolve(path).toLowerCase());
}

async function openEntry(pack: string, e: ZipEntry): Promise<OpenedFile> {
  if (e.method === 'store') return allowVirtual(`${pack}!/${e.name}`, pack, e.dataOffset, e.size);
  // Compressed entries (logs) are small enough to extract to a per-pack cache once.
  const st = statSync(pack);
  const key = createHash('sha1').update(`${resolve(pack).toLowerCase()}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const dir = join(app.getPath('userData'), 'pack-cache', key);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, e.name.replace(/[\\/]/g, '__'));
  if (!existsSync(dest) || statSync(dest).size !== e.size) await extractEntry(pack, e, dest);
  extracted.set(resolve(dest).toLowerCase(), { pack, entry: e.name });
  const f = allowFile(dest);
  return { ...f, name: basename(e.name) };
}

async function resolveRef(ref: FileRef, wsDir: string): Promise<OpenedFile | null> {
  if (ref.pack && ref.rel) {
    const packs = [ref.pack.rel ? candidatePaths({ name: '', size: 0, rel: ref.pack.rel }, wsDir)[0] : undefined, ref.pack.path].filter((p): p is string => !!p && existsSync(p));
    for (const p of packs) {
      const e = (await entriesOf(p)).find((x) => x.name === ref.rel);
      if (e) return openEntry(p, e);
    }
    return null;
  }
  for (const c of candidatePaths(ref, wsDir)) {
    try {
      const st = statSync(c);
      if (!st.isFile() || st.size !== ref.size) continue;
      if (ref.quickHash && (await quickHash(c, st.size)) !== ref.quickHash) continue;
      return allowFile(c);
    } catch { /* not there */ }
  }
  return null;
}

export async function loadSession(path: string): Promise<OpenedSession> {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new WorkspaceError(`File not found: ${abs}`);
  const files: Record<string, OpenedFile | null> = {};
  const imported: string[] = [];
  if (/\.hlpack$/i.test(abs)) {
    let entries: ZipEntry[];
    try { entries = await entriesOf(abs); } catch { throw new WorkspaceError('This is not a HuskyLog pack (not a zip file).'); }
    const wsEntry = entries.find((e) => e.name === 'workspace.hlws');
    if (!wsEntry) throw new WorkspaceError('This pack has no workspace.hlws.');
    const text = (await readEntry(abs, wsEntry)).toString('utf8');
    const ws = parseWorkspace(text);
    for (const s of ws.streams) {
      const e = s.file.rel && !s.file.pack ? entries.find((x) => x.name === s.file.rel) : undefined;
      files[s.id] = e ? await openEntry(abs, e) : await resolveRef(s.file, dirname(abs));
    }
    // Map areas travel with the pack; add the ones this computer doesn't have.
    for (const e of entries.filter((x) => /^maps\/[^/]+\.area\.json$/.test(x.name))) {
      const id = basename(e.name, '.area.json');
      const dir = mapsDir();
      if (existsSync(join(dir, `${id}.area.json`))) continue;
      mkdirSync(dir, { recursive: true });
      for (const f of entries.filter((x) => x.name.startsWith(`maps/${id}.`) && !x.name.endsWith('.area.json'))) await extractEntry(abs, f, join(dir, basename(f.name)));
      await extractEntry(abs, e, join(dir, `${id}.area.json`)); // last: an area only appears once its tiles are in place
      imported.push(id);
    }
    if (imported.length) invalidateAreas();
    return { kind: 'hlpack', path: abs, workspace: text, files, importedMapAreas: imported };
  }
  const text = await readFile(abs, 'utf8');
  const ws = parseWorkspace(text);
  for (const s of ws.streams) files[s.id] = await resolveRef(s.file, dirname(abs));
  return { kind: 'hlws', path: abs, workspace: text, files, importedMapAreas: [] };
}

/** File refs for saving: relative to the workspace folder, pack entries, or inside the open pack. */
async function refFor(s: SaveStream, wsDir: string, intoPack: string | null): Promise<FileRef> {
  if (s.ref) return s.ref;
  const origin = packOrigin(s.path);
  if (origin) {
    if (intoPack && resolve(origin.pack).toLowerCase() === resolve(intoPack).toLowerCase()) return { name: basename(origin.entry), size: s.size, rel: origin.entry };
    return { name: basename(origin.entry), size: s.size, rel: origin.entry, pack: { path: resolve(origin.pack), rel: relativePath(wsDir, resolve(origin.pack)) } };
  }
  const abs = resolve(s.path);
  return { name: basename(abs), size: s.size, path: abs, rel: relativePath(wsDir, abs), quickHash: await quickHash(abs, s.size).catch(() => undefined) };
}

async function composeWorkspace(wsText: string, streams: SaveStream[], wsDir: string, intoPack: string | null): Promise<Workspace> {
  const ws = parseWorkspace(wsText);
  ws.app = app.getVersion();
  ws.saved = new Date().toISOString();
  ws.streams = await Promise.all(streams.map(async (s): Promise<WorkspaceStream> => ({ id: s.id, kind: s.kind, name: s.name, file: await refFor(s, wsDir, intoPack) })));
  return ws;
}

function sender(e: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined;
}

// ------------------------------------------------------------------ packing

type Src = { file: string; base: number };
const srcOf = (path: string): Src => {
  const v = virtualSource(path);
  return v ? { file: v.file, base: v.offset } : { file: path, base: 0 };
};

async function* rangeChunks(src: Src, offset: number, size: number): AsyncGenerator<Uint8Array> {
  if (size <= 0) return;
  for await (const c of createReadStream(src.file, { start: src.base + offset, end: src.base + offset + size - 1, highWaterMark: 1 << 20 })) {
    if (packCancelled) throw new Error('cancelled');
    yield c as Buffer;
  }
}

async function* mp4Chunks(e: Extract<PackEntrySpec, { kind: 'mp4' }>): AsyncGenerator<Uint8Array> {
  yield e.head;
  const src = srcOf(e.src);
  const enc = e.enc ? { file: temps.get(e.enc)!, base: 0 } : null;
  for (const r of e.runs) yield* rangeChunks(r.from === 'enc' ? enc! : src, r.offset, r.size);
  yield e.moov;
}

function entrySize(e: PackEntrySpec): number {
  if (e.kind === 'mp4') return e.head.length + e.moov.length + e.runs.reduce((s, r) => s + r.size, 0);
  const v = virtualSource(e.path);
  return v ? v.size : statSync(e.path).size;
}

async function writePack(spec: PackSpec, wc: WebContents): Promise<{ path: string; bytes: number }> {
  packCancelled = false;
  const mapFiles: { name: string; path: string; method: 'store' | 'deflate' }[] = [];
  for (const id of spec.mapAreas) {
    const dir = mapsDir();
    for (const [suffix, method] of [['imagery.mbtiles', 'store'], ['terrain.mbtiles', 'store'], ['area.json', 'deflate']] as const) {
      const p = join(dir, `${id}.${suffix}`);
      if (existsSync(p)) mapFiles.push({ name: `maps/${id}.${suffix}`, path: p, method });
    }
  }
  const total = spec.entries.reduce((s, e) => s + entrySize(e), 0) + mapFiles.reduce((s, f) => s + statSync(f.path).size, 0);
  let done = 0, last = 0, current = '';
  const progress = (p: Partial<PackProgress> = {}) => { if (!wc.isDestroyed()) wc.send('hl:pack-progress', { done, total, entry: current, finished: false, ...p } satisfies PackProgress); };
  const tick = (n: number) => {
    done += n;
    const now = Date.now();
    if (now - last > 100) { last = now; progress(); }
  };
  const partial = `${spec.out}.partial`;
  const w = await ZipWriter.create(partial);
  try {
    await w.addBuffer('workspace.hlws', Buffer.from(spec.workspace, 'utf8'));
    for (const e of spec.entries) {
      current = e.name;
      if (packCancelled) throw new Error('cancelled');
      if (e.kind === 'mp4') await w.addStream(e.name, mp4Chunks(e), 'store', tick);
      else {
        const src = srcOf(e.path);
        const size = entrySize(e);
        await w.addStream(e.name, rangeChunks(src, 0, size), e.method, tick);
      }
    }
    for (const f of mapFiles) {
      current = f.name;
      await w.addStream(f.name, rangeChunks({ file: f.path, base: 0 }, 0, statSync(f.path).size), f.method, tick);
    }
    const manifest = {
      format: PACK_FORMAT, version: 1, app: app.getVersion(), created: new Date().toISOString(), options: spec.options,
      entries: w.entries.map((e) => ({ name: e.name, size: e.size, method: e.method, sha256: e.sha256 })),
    };
    await w.addBuffer('manifest.json', Buffer.from(JSON.stringify(manifest, null, 1)));
    await w.finish();
    await rm(spec.out, { force: true });
    await rename(partial, spec.out);
    const bytes = statSync(spec.out).size;
    progress({ done: total, finished: true, bytes });
    return { path: spec.out, bytes };
  } catch (err) {
    await w.abort();
    await rm(partial, { force: true });
    const cancelled = packCancelled || String(err).includes('cancelled');
    progress({ finished: true, cancelled, error: cancelled ? undefined : String(err) });
    throw cancelled ? new Error('Packing cancelled') : err;
  } finally {
    for (const p of temps.values()) await rm(p, { force: true }).catch(() => undefined);
    temps.clear();
  }
}

// ------------------------------------------------------------------ IPC

export function openPathFromArgv(argv: string[]): string | null {
  return argv.slice(1).find((a) => /\.(hlws|hlpack)$/i.test(a) && existsSync(a)) ?? null;
}

/** Called once at startup when the app was launched with a workspace/pack (file association). */
export async function preloadSession(path: string): Promise<void> {
  try { pending = await loadSession(path); } catch (e) { console.warn('[workspace] could not open', path, e); }
}

export function reloadInto(win: BrowserWindow, session: OpenedSession | null): void {
  pending = session;
  dirty = false;
  // Pop-outs belong to the old page; close them before it goes away.
  for (const w of BrowserWindow.getAllWindows()) if (w !== win && w.webContents.getURL().includes('popout.html')) w.destroy();
  win.webContents.reload();
}

/** Asks to save unsaved changes when the main window closes. */
export function installCloseGuard(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (forceClose || !dirty) return;
    if (E2E && e2e.closeChoice === undefined) return;
    e.preventDefault();
    const choice = E2E ? e2e.closeChoice! : dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
      title: 'HuskyLog', message: 'Save changes to this workspace before closing?',
    });
    if (choice === 2) return;
    if (choice === 1) { forceClose = true; win.close(); return; }
    const token = randomUUID();
    ipcMain.once(`${WS_IPC.saved}:${token}`, (_ev, ok: boolean) => { if (ok) { forceClose = true; win.close(); } });
    win.webContents.send('ws:save-before-close', token);
  });
}

export function registerWorkspaceIpc(): void {
  const filters = [{ name: 'HuskyLog workspace or pack', extensions: ['hlws', 'hlpack'] }];
  ipcMain.handle(WS_IPC.pick, async (e) => {
    if (E2E && e2e.open) { const p = e2e.open; delete e2e.open; return p; }
    const r = await dialog.showOpenDialog(sender(e)!, { properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  ipcMain.handle(WS_IPC.open, async (e, path: string) => {
    let session: OpenedSession;
    try { session = await loadSession(path); } catch (err) {
      return { error: err instanceof WorkspaceError ? err.message : `Could not open ${basename(path)}: ${String(err)}` };
    }
    const win = sender(e);
    if (win) setTimeout(() => reloadInto(win, session), 30);
    return { error: '' };
  });
  ipcMain.handle(WS_IPC.new, (e) => { const win = sender(e); if (win) setTimeout(() => reloadInto(win, null), 30); });
  ipcMain.handle(WS_IPC.boot, () => { const s = pending; pending = null; return s; });
  ipcMain.handle(WS_IPC.save, async (e, wsText: string, streams: SaveStream[], path: string | null, current: { kind: string; path: string | null }) => {
    let target = path;
    if (!target) {
      if (E2E && e2e.save) { target = e2e.save; delete e2e.save; }
      else {
        const def = current.path ? join(dirname(current.path), `${basename(current.path, extname(current.path))}.hlws`) : 'session.hlws';
        const r = await dialog.showSaveDialog(sender(e)!, { defaultPath: def, filters: [{ name: 'HuskyLog workspace', extensions: ['hlws'] }] });
        if (r.canceled || !r.filePath) return null;
        target = r.filePath;
      }
    }
    target = resolve(target);
    if (/\.hlpack$/i.test(target)) {
      if (current.kind !== 'hlpack' || !current.path || resolve(current.path).toLowerCase() !== target.toLowerCase()) {
        throw new Error('To make a new pack, use Pack & Go.');
      }
      const ws = await composeWorkspace(wsText, streams, dirname(target), target);
      const text = stringifyWorkspace(ws);
      const entries = await entriesOf(target);
      const mEntry = entries.find((x) => x.name === 'manifest.json');
      const manifest = mEntry ? JSON.parse((await readEntry(target, mEntry)).toString('utf8')) as { entries?: { name: string; size: number; sha256?: string }[]; updated?: string } : {};
      const buf = Buffer.from(text, 'utf8');
      manifest.entries = (manifest.entries ?? []).filter((x) => x.name !== 'workspace.hlws');
      manifest.entries.unshift({ name: 'workspace.hlws', size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
      manifest.updated = new Date().toISOString();
      await replaceEntries(target, { 'workspace.hlws': buf, 'manifest.json': Buffer.from(JSON.stringify(manifest, null, 1)) });
      zipCache.delete(target.toLowerCase());
      return { path: target, kind: 'hlpack' as const, workspace: text };
    }
    const ws = await composeWorkspace(wsText, streams, dirname(target), null);
    const text = stringifyWorkspace(ws);
    await writeFile(target, text, 'utf8');
    return { path: target, kind: 'hlws' as const, workspace: text };
  });
  ipcMain.handle(WS_IPC.locate, async (e, name: string, size: number, hash?: string) => {
    let p: string | null = null;
    if (E2E && e2e.locate) { p = e2e.locate; delete e2e.locate; }
    else {
      const ext = extname(name).slice(1);
      const r = await dialog.showOpenDialog(sender(e)!, { title: `Locate ${name}`, properties: ['openFile'], filters: [{ name, extensions: ext ? [ext] : ['*'] }, { name: 'All files', extensions: ['*'] }] });
      p = r.canceled ? null : r.filePaths[0] ?? null;
    }
    if (!p) return null;
    const st = statSync(p);
    const matches = st.size === size && (!hash || (await quickHash(p, st.size)) === hash);
    return { file: allowFile(p), matches };
  });
  ipcMain.handle(WS_IPC.pickPack, async (e, defaultName: string) => {
    if (E2E && e2e.pack) { const p = e2e.pack; delete e2e.pack; return p; }
    const r = await dialog.showSaveDialog(sender(e)!, { defaultPath: defaultName, filters: [{ name: 'HuskyLog pack', extensions: ['hlpack'] }] });
    return r.canceled || !r.filePath ? null : r.filePath;
  });
  ipcMain.handle(WS_IPC.tempCreate, async () => {
    const id = randomUUID();
    const p = join(tmpdir(), `huskylog-enc-${id}.bin`);
    await writeFile(p, new Uint8Array(0));
    temps.set(id, p);
    return id;
  });
  ipcMain.handle(WS_IPC.tempWrite, async (_e, id: string, data: Uint8Array) => {
    const p = temps.get(id);
    if (!p) throw new Error('No such temp file');
    const fh = await open(p, 'a');
    try { await fh.write(data); } finally { await fh.close(); }
    return statSync(p).size;
  });
  ipcMain.handle(WS_IPC.write, (e, spec: PackSpec) => writePack(spec, e.sender));
  ipcMain.handle(WS_IPC.cancel, () => { packCancelled = true; });
  ipcMain.handle(WS_IPC.setDirty, (_e, d: boolean) => { dirty = d; });
  ipcMain.handle(WS_IPC.e2e, (_e, paths: typeof e2e) => { if (E2E) Object.assign(e2e, paths); });
}

// ------------------------------------------------------------------ export (DESIGN §10)

/** Paths the user picked in an export save dialog; the renderer may only write those. */
const exportTargets = new Set<string>();

export function registerExportIpc(): void {
  ipcMain.handle(WS_IPC.exportPick, async (e, defaultName: string, kind: 'mp4' | 'gif') => {
    let p: string | null = null;
    if (E2E && e2e.export) { p = e2e.export; delete e2e.export; }
    else {
      const r = await dialog.showSaveDialog(sender(e)!, { defaultPath: defaultName, filters: [kind === 'gif' ? { name: 'GIF animation', extensions: ['gif'] } : { name: 'MP4 video', extensions: ['mp4'] }] });
      p = r.canceled || !r.filePath ? null : r.filePath;
    }
    if (p) exportTargets.add(resolve(p).toLowerCase());
    return p;
  });
  const allowed = (p: string) => exportTargets.has(resolve(p).toLowerCase());
  ipcMain.handle(WS_IPC.exportWriteFile, async (_e, path: string, data: Uint8Array) => {
    if (!allowed(path)) throw new Error('Not an export target');
    await writeFile(path, data);
    return statSync(path).size;
  });
  ipcMain.handle(WS_IPC.exportWriteMp4, async (_e, path: string, spec: Omit<Extract<PackEntrySpec, { kind: 'mp4' }>, 'kind' | 'name'>) => {
    if (!allowed(path)) throw new Error('Not an export target');
    const fh = await open(`${path}.partial`, 'w');
    try {
      for await (const c of mp4Chunks({ kind: 'mp4', name: '', ...spec })) await fh.write(c);
    } finally {
      await fh.close();
      if (spec.enc) { const t = temps.get(spec.enc); temps.delete(spec.enc); if (t) await rm(t, { force: true }).catch(() => undefined); }
    }
    await rm(path, { force: true });
    await rename(`${path}.partial`, path);
    return statSync(path).size;
  });
}

/** Lets the next window close go through without the unsaved-changes prompt (update install). */
export function allowClose(): void { forceClose = true; }
