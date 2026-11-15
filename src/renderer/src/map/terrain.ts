import { CustomHeightmapTerrainProvider, WebMercatorTilingScheme, Credit } from '@cesium/engine';
import { PROVIDERS, terrariumHeight } from '@core/maps/tiles';

/**
 * Terrain from cached Terrarium PNG tiles (hl-tiles://any/terrain/z/x/y).
 * Heights are metres above mean sea level, the same datum as the log's AMSL
 * altitudes, so the aircraft and the ground always agree (DESIGN §7.1).
 * Missing tiles fall back to the nearest cached ancestor (lower detail).
 */
const SIZE = 256;
const MAX_Z = PROVIDERS['terrarium']!.maxZoom;
const tileCache = new Map<string, Promise<Float32Array | null>>();

function decodeTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(`hl-tiles://any/terrain/${z}/${x}/${y}`);
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(SIZE, SIZE);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
      bmp.close();
      const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
      const h = new Float32Array(SIZE * SIZE);
      for (let i = 0; i < h.length; i++) h[i] = terrariumHeight(px[i * 4]!, px[i * 4 + 1]!, px[i * 4 + 2]!);
      return h;
    })().catch(() => null);
    tileCache.set(key, p);
    if (tileCache.size > 256) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

/** Bilinear sample of a decoded tile at fractional pixel coords. */
function bilinear(h: Float32Array, px: number, py: number): number {
  const x = Math.max(0, Math.min(SIZE - 1.001, px - 0.5)), y = Math.max(0, Math.min(SIZE - 1.001, py - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const a = h[y0 * SIZE + x0]!, b = h[y0 * SIZE + x0 + 1]!, c = h[(y0 + 1) * SIZE + x0]!, d = h[(y0 + 1) * SIZE + x0 + 1]!;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Finds the deepest cached tile covering (z, x, y): itself or an ancestor. */
async function coveringTile(z: number, x: number, y: number) {
  for (let az = Math.min(z, MAX_Z); az >= 0; az--) {
    const dz = z - az;
    const t = await decodeTile(az, x >> dz, y >> dz);
    if (t) return { h: t, dz, ox: x - ((x >> dz) << dz), oy: y - ((y >> dz) << dz) };
  }
  return null;
}

export function createTerrainProvider(): CustomHeightmapTerrainProvider {
  const W = 65;
  return new CustomHeightmapTerrainProvider({
    width: W,
    height: W,
    tilingScheme: new WebMercatorTilingScheme(),
    credit: new Credit(PROVIDERS['terrarium']!.attribution),
    callback: async (x: number, y: number, level: number) => {
      const c = await coveringTile(level, x, y);
      const out = new Float32Array(W * W);
      if (!c) return out; // nothing cached anywhere: sea level
      const scale = 2 ** c.dz;
      for (let r = 0; r < W; r++) {
        for (let k = 0; k < W; k++) {
          const px = ((c.ox + k / (W - 1)) / scale) * SIZE;
          const py = ((c.oy + r / (W - 1)) / scale) * SIZE;
          out[r * W + k] = bilinear(c.h, px, py);
        }
      }
      return out;
    },
  });
}

/** Ground height (m AMSL) at a point from the cached terrain, or null if none. */
export async function terrainHeightAt(lat: number, lng: number): Promise<number | null> {
  for (let z = MAX_Z; z >= 8; z--) {
    const n = 2 ** z;
    const fx = ((lng + 180) / 360) * n;
    const r = (lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
    const t = await decodeTile(z, Math.floor(fx), Math.floor(fy));
    if (t) return bilinear(t, (fx - Math.floor(fx)) * SIZE, (fy - Math.floor(fy)) * SIZE);
  }
  return null;
}

export function clearTerrainCache() {
  tileCache.clear();
}
