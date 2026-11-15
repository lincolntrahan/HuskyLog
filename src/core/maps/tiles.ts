/** Web-Mercator (XYZ) tile maths shared by the map-cache downloader and UI. */

export type BBox = [west: number, south: number, east: number, north: number];

export function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
export function latToY(lat: number, z: number): number {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export interface TileRange { z: number; x0: number; x1: number; y0: number; y1: number }

/** Tile ranges covering a bbox for each zoom in [minZ, maxZ]. */
export function tileRanges(b: BBox, minZ: number, maxZ: number): TileRange[] {
  const out: TileRange[] = [];
  for (let z = minZ; z <= maxZ; z++) {
    const max = 2 ** z - 1;
    out.push({
      z,
      x0: Math.max(0, lonToX(b[0], z)), x1: Math.min(max, lonToX(b[2], z)),
      y0: Math.max(0, latToY(b[3], z)), y1: Math.min(max, latToY(b[1], z)),
    });
  }
  return out;
}

export function countTiles(ranges: TileRange[]): number {
  return ranges.reduce((a, r) => a + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0);
}

export function* iterTiles(ranges: TileRange[]): Generator<[number, number, number]> {
  for (const r of ranges) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield [r.z, x, y];
}

/** Expands a bbox by a margin in metres. */
export function padBBox(b: BBox, metres: number): BBox {
  const dLat = metres / 111_320;
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const dLon = metres / (111_320 * Math.max(0.01, Math.cos(midLat)));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
}

export interface TileProvider {
  id: string;
  name: string;
  layer: 'imagery' | 'terrain';
  url: string; // template with {z} {x} {y}
  maxZoom: number;
  attribution: string;
  /** Rough bytes per tile, for size estimates. */
  avgBytes: number;
}

export const PROVIDERS: Record<string, TileProvider> = {
  usgs: {
    id: 'usgs', name: 'USGS National Map imagery (US, public domain)', layer: 'imagery',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16, attribution: 'USGS The National Map: Orthoimagery', avgBytes: 26_000,
  },
  terrarium: {
    id: 'terrarium', name: 'Terrain Tiles (AWS open data, Terrarium)', layer: 'terrain',
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    maxZoom: 15, attribution: 'Terrain: Mapzen/Tilezen terrain tiles (USGS 3DEP, SRTM, and others) via AWS Open Data', avgBytes: 75_000,
  },
};

export const fillTemplate = (url: string, z: number, x: number, y: number) =>
  url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Terrarium PNG RGB → metres above mean sea level. */
export const terrariumHeight = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;
