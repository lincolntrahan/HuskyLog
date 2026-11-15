import { app, protocol, type WebContents } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROVIDERS, countTiles, fillTemplate, iterTiles, tileRanges, type BBox, type TileProvider,
} from '../core/maps/tiles';
import type { MapArea, MapDownloadRequest, MapProgress } from '../shared/ipc';

/**
 * Offline map cache (DESIGN §9). Each area stores one MBTiles file per layer
 * (imagery, terrain) in userData/maps, plus a small JSON record. Tiles are
 * served to Cesium through hl-tiles://any/<layer>/<z>/<x>/<y>, looked up across
 * all cached areas. Downloads run here in the main process with Node's fetch,
 * so they are the only network access the app ever makes, and only on request.
 */

const dir = () => join(app.getPath('userData'), 'maps');
const dbs = new Map<string, DatabaseSync>(); // `${areaId}.${layer}` → db

function openDb(areaId: string, layer: string): DatabaseSync {
  const key = `${areaId}.${layer}`;
  let db = dbs.get(key);
  if (!db) {
    mkdirSync(dir(), { recursive: true });
    db = new DatabaseSync(join(dir(), `${key}.mbtiles`));
    db.exec(`CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
               PRIMARY KEY (zoom_level, tile_column, tile_row));`);
    dbs.set(key, db);
  }
  return db;
}

// MBTiles stores rows in TMS order (y flipped).
const tmsRow = (z: number, y: number) => 2 ** z - 1 - y;

export function listAreas(): MapArea[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith('.area.json'))
    .map((f) => {
      const a = JSON.parse(readFileSync(join(dir(), f), 'utf8')) as MapArea;
      a.bytes = ['imagery', 'terrain'].reduce((s, l) => {
        const p = join(dir(), `${a.id}.${l}.mbtiles`);
        return s + (existsSync(p) ? statSync(p).size : 0);
      }, 0);
      return a;
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

let servingCache: MapArea[] | null = null; // area list for tile lookups (no disk reads per tile)
const servingAreas = () => (servingCache ??= listAreas());

function saveArea(a: MapArea) {
  servingCache = null;
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${a.id}.area.json`), JSON.stringify(a, null, 2));
}

export function deleteArea(id: string): void {
  servingCache = null;
  for (const l of ['imagery', 'terrain']) {
    const key = `${id}.${l}`;
    dbs.get(key)?.close();
    dbs.delete(key);
    rmSync(join(dir(), `${key}.mbtiles`), { force: true });
  }
  rmSync(join(dir(), `${id}.area.json`), { force: true });
}

export function estimate(req: MapDownloadRequest): { imagery: number; terrain: number; bytes: number } {
  const img = providerFor(req);
  const imagery = countTiles(tileRanges(req.bbox, 0, Math.min(req.imageryMaxZoom, img.maxZoom)));
  const terrain = req.terrain ? countTiles(tileRanges(req.bbox, 0, Math.min(req.terrainMaxZoom, PROVIDERS['terrarium']!.maxZoom))) : 0;
  return { imagery, terrain, bytes: imagery * img.avgBytes + terrain * PROVIDERS['terrarium']!.avgBytes };
}

function providerFor(req: MapDownloadRequest): TileProvider {
  if (req.provider === 'custom') {
    if (!req.customUrl || !/\{z\}/.test(req.customUrl) || !/\{x\}/.test(req.customUrl) || !/\{y\}/.test(req.customUrl)) {
      throw new Error('Custom URL must contain {z}, {x} and {y}');
    }
    return { id: 'custom', name: 'Custom', layer: 'imagery', url: req.customUrl, maxZoom: req.imageryMaxZoom, attribution: req.customAttribution ?? '', avgBytes: 30_000 };
  }
  return PROVIDERS[req.provider] ?? PROVIDERS['usgs']!;
}

const running = new Map<string, { cancel: boolean }>();

export function cancelDownload(id: string): void {
  const r = running.get(id);
  if (r) r.cancel = true;
}

/** Downloads (or resumes) an area. Progress goes to the requesting window. */
export async function download(req: MapDownloadRequest, sender: WebContents): Promise<MapArea> {
  const img = providerFor(req);
  const id = req.id ?? `area-${Date.now().toString(36)}`;
  const existing = listAreas().find((a) => a.id === id);
  const area: MapArea = existing ?? {
    id, name: req.name, bbox: req.bbox, created: new Date().toISOString(),
    imageryProvider: img.id, imageryAttribution: img.attribution, imageryMaxZoom: Math.min(req.imageryMaxZoom, img.maxZoom),
    terrain: req.terrain, terrainMaxZoom: req.terrain ? Math.min(req.terrainMaxZoom, 15) : 0,
    tiles: 0, failed: 0, complete: false, bytes: 0,
  };
  saveArea(area);
  const jobs: { layer: 'imagery' | 'terrain'; url: string; z: number; x: number; y: number }[] = [];
  for (const [z, x, y] of iterTiles(tileRanges(area.bbox, 0, area.imageryMaxZoom))) jobs.push({ layer: 'imagery', url: img.url, z, x, y });
  if (area.terrain) {
    for (const [z, x, y] of iterTiles(tileRanges(area.bbox, 0, area.terrainMaxZoom))) jobs.push({ layer: 'terrain', url: PROVIDERS['terrarium']!.url, z, x, y });
  }

  const state = { cancel: false };
  running.set(id, state);
  const dbI = openDb(id, 'imagery'), dbT = area.terrain ? openDb(id, 'terrain') : null;
  for (const [db, prov] of [[dbI, img], [dbT, PROVIDERS['terrarium']!]] as const) {
    if (!db) continue;
    const meta = db.prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)');
    meta.run('name', `${area.name} (${prov.layer})`);
    meta.run('format', prov.layer === 'terrain' ? 'png' : 'jpg');
    meta.run('bounds', area.bbox.join(','));
    meta.run('attribution', prov.attribution);
  }
  const has = (db: DatabaseSync, z: number, x: number, y: number) =>
    !!db.prepare('SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(z, x, tmsRow(z, y));
  const put = (db: DatabaseSync, z: number, x: number, y: number, data: Uint8Array) =>
    db.prepare('INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)').run(z, x, tmsRow(z, y), data);

  let done = 0, failed = 0, bytes = 0, lastSend = 0, lastError = '';
  const total = jobs.length;
  const send = (final = false) => {
    const now = Date.now();
    if (!final && now - lastSend < 150) return;
    lastSend = now;
    const p: MapProgress = { id, done, total, failed, bytes, finished: final, cancelled: state.cancel, error: lastError || undefined };
    if (!sender.isDestroyed()) sender.send('hl:map-progress', p);
  };

  let next = 0;
  const worker = async () => {
    while (!state.cancel) {
      const j = jobs[next++];
      if (!j) return;
      const db = j.layer === 'imagery' ? dbI : dbT!;
      if (has(db, j.z, j.x, j.y)) { done++; send(); continue; }
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok && !state.cancel; attempt++) {
        try {
          const res = await fetch(fillTemplate(j.url, j.z, j.x, j.y), {
            headers: { 'User-Agent': 'HuskyLog offline map cache' },
            signal: AbortSignal.timeout(20_000),
          });
          if (res.status === 404) { ok = true; break; } // provider has no tile here: not an error
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = new Uint8Array(await res.arrayBuffer());
          put(db, j.z, j.x, j.y, data);
          bytes += data.length;
          ok = true;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (!ok && !state.cancel) failed++;
      done++;
      send();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  running.delete(id);

  area.tiles = done;
  area.failed = failed;
  area.complete = !state.cancel && failed === 0;
  saveArea(area);
  send(true);
  return { ...area, bytes: listAreas().find((a) => a.id === id)?.bytes ?? 0 };
}

/** Serves cached tiles: hl-tiles://any/<layer>/<z>/<x>/<y>. */
export function handleTilesProtocol(): void {
  protocol.handle('hl-tiles', (req) => {
    const m = /^hl-tiles:\/\/([^/]+)\/(imagery|terrain)\/(\d+)\/(\d+)\/(\d+)/.exec(req.url);
    if (!m) return new Response('Bad tile URL', { status: 400 });
    const [, scope, layer, zs, xs, ys] = m;
    const z = Number(zs), x = Number(xs), y = Number(ys);
    const areas = scope === 'any' ? servingAreas() : servingAreas().filter((a) => a.id === scope);
    for (const a of areas) {
      if (layer === 'terrain' && !a.terrain) continue;
      const row = openDb(a.id, layer!).prepare('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?')
        .get(z, x, tmsRow(z, y)) as { tile_data: Uint8Array } | undefined;
      if (row) {
        return new Response(Buffer.from(row.tile_data), {
          headers: { 'Content-Type': layer === 'terrain' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'max-age=86400' },
        });
      }
    }
    return new Response('No tile', { status: 404 });
  });
}

export type { BBox };
