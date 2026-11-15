import type { GeoPoint, MissionItem, ModeSpan } from '@core/dataflash/summary';
import type { BBox } from '@core/maps/tiles';
import { lowerBound } from '@core/series/series';
import { loadChannel, useLogs } from './logs';

/**
 * Flight path + attitude for the 3D map and horizon (DESIGN §7.1, §7.3).
 * Position: POS (25 Hz) when logged, else GPS (5 Hz). Attitude: ATT.
 */
export interface Track {
  stream: string;
  source: 'POS' | 'GPS';
  t: Float64Array;
  lat: Float64Array;
  lng: Float64Array;
  altAmsl: Float64Array;
  relAlt: Float64Array;
  att: { t: Float64Array; roll: Float64Array; pitch: Float64Array; yaw: Float64Array } | null;
  modes: ModeSpan[];
  home: GeoPoint | null;
  terrainAtHome: number | null;
  mission: MissionItem[];
  bbox: BBox;
}

const cache = new Map<string, Promise<Track | null>>();

export function loadTrack(stream: string): Promise<Track | null> {
  let p = cache.get(stream);
  if (!p) { p = buildTrack(stream); cache.set(stream, p); }
  return p;
}

async function buildTrack(stream: string): Promise<Track | null> {
  const sum = useLogs.getState().logs[stream]?.summary;
  if (!sum) return null;
  const ch = (id: string) => loadChannel({ stream, id });
  let source: Track['source'] = 'POS';
  let [lat, lng, alt, rel] = await Promise.all([ch('POS.Lat'), ch('POS.Lng'), ch('POS.Alt'), ch('POS.RelHomeAlt')]);
  if (!lat || !lng || !alt) {
    source = 'GPS';
    [lat, lng, alt] = await Promise.all([ch('GPS.Lat'), ch('GPS.Lng'), ch('GPS.Alt')]);
    rel = null;
  }
  if (!lat || !lng || !alt) return null;

  // Drop samples before a position fix (0,0).
  const keep: number[] = [];
  for (let i = 0; i < lat.v.length; i++) if (Math.abs(lat.v[i]!) > 1e-6 || Math.abs(lng.v[i]!) > 1e-6) keep.push(i);
  if (keep.length < 2) return null;
  const pick = (a: Float64Array) => Float64Array.from(keep, (i) => a[i]!);
  const homeAlt = sum.home?.alt ?? alt.v[keep[0]!]!;
  const relAlt = rel ? pick(rel.v) : Float64Array.from(keep, (i) => alt.v[i]! - homeAlt);

  const [roll, pitch, yaw] = await Promise.all([ch('ATT.Roll'), ch('ATT.Pitch'), ch('ATT.Yaw')]);
  const latK = pick(lat.v), lngK = pick(lng.v);
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (let i = 0; i < latK.length; i++) {
    w = Math.min(w, lngK[i]!); e = Math.max(e, lngK[i]!);
    s = Math.min(s, latK[i]!); n = Math.max(n, latK[i]!);
  }
  return {
    stream, source, t: pick(lat.t), lat: latK, lng: lngK, altAmsl: pick(alt.v), relAlt,
    att: roll && pitch && yaw ? { t: roll.t, roll: roll.v, pitch: pitch.v, yaw: yaw.v } : null,
    modes: sum.modes, home: sum.home, terrainAtHome: sum.terrainAtHome, mission: sum.mission,
    bbox: [w, s, e, n],
  };
}

/** Linear interpolation of a series at time t (clamped to the ends). */
export function sampleAt(t: Float64Array, v: Float64Array, x: number): number {
  const n = t.length;
  if (!n) return NaN;
  if (x <= t[0]!) return v[0]!;
  if (x >= t[n - 1]!) return v[n - 1]!;
  const i = lowerBound(t, x);
  const f = (x - t[i - 1]!) / (t[i]! - t[i - 1]!);
  return v[i - 1]! + (v[i]! - v[i - 1]!) * f;
}

/** Heading interpolation that takes the short way round 360°. */
export function sampleAngleAt(t: Float64Array, v: Float64Array, x: number): number {
  const n = t.length;
  if (!n) return NaN;
  if (x <= t[0]!) return v[0]!;
  if (x >= t[n - 1]!) return v[n - 1]!;
  const i = lowerBound(t, x);
  const f = (x - t[i - 1]!) / (t[i]! - t[i - 1]!);
  let d = v[i]! - v[i - 1]!;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (v[i - 1]! + d * f + 360) % 360;
}

export interface Pose { lat: number; lng: number; altAmsl: number; relAlt: number; roll: number; pitch: number; yaw: number; index: number }

export function poseAt(tr: Track, x: number): Pose {
  const a = tr.att;
  return {
    lat: sampleAt(tr.t, tr.lat, x), lng: sampleAt(tr.t, tr.lng, x),
    altAmsl: sampleAt(tr.t, tr.altAmsl, x), relAlt: sampleAt(tr.t, tr.relAlt, x),
    roll: a ? sampleAt(a.t, a.roll, x) : 0, pitch: a ? sampleAt(a.t, a.pitch, x) : 0, yaw: a ? sampleAngleAt(a.t, a.yaw, x) : 0,
    index: Math.min(tr.t.length - 1, lowerBound(tr.t, x)),
  };
}

/** Indices of a decimated copy of the track for drawing (keeps turns, ≤ max points). */
export function decimateIndices(tr: Track, max = 4000): number[] {
  const n = tr.t.length;
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = n / max;
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(Math.floor(k * step));
  out.push(n - 1);
  return out;
}
