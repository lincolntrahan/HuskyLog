import { create } from 'zustand';
import { holdAt, interpAt, medianDt } from '@core/series/series';
import { formatValue } from '@core/overlay/format';
import { channelExists, loadChannel, primaryLog, useLogs } from '../data/logs';
import { loadExpression, useExpressions } from '../data/expressions';
import { inTrim, masterToLocal } from '../data/sync';
import { fmtTime } from '../data/timeline';
import { sampleAngleAt } from '../data/track';
import type { AdiState } from '../adi/drawAdi';
import { paramsAt } from '@core/dataflash/summary';
import { centred, rcCal, rcMap, unipolar, type SticksInput } from '@core/overlay/sticks';
import type { OverlayItem, ReadoutLine } from './model';

/**
 * Overlay data: resolves readout sources (channels, named or inline
 * expressions, @specials) into series, caches them, and samples them at the
 * master playhead through the stream's sync mapping.
 */
export type SeriesRes = { kind: 'series'; t: Float64Array; v: Float64Array; unit: string; maxGap: number };
export type Resolved =
  | SeriesRes
  | { kind: 'special'; which: 'mode' | 'armed' | 'time' | 'local' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

const SPECIALS = new Set(['mode', 'armed', 'time', 'local']);
const cache = new Map<string, Resolved>();

/** Bumped whenever a source finishes loading, so overlay layers redraw. */
export const useOverlayData = create<{ version: number }>(() => ({ version: 0 }));
const bump = () => useOverlayData.setState((s) => ({ version: s.version + 1 }));
// New logs or edited named expressions can change what a source means.
useLogs.subscribe((s, p) => { if (s.logs !== p.logs) { cache.clear(); bump(); } });
useExpressions.subscribe((s, p) => { if (s.version !== p.version) { cache.clear(); bump(); } });

export const streamOf = (item: Pick<OverlayItem, 'stream'>): string | undefined => {
  const logs = useLogs.getState().logs;
  return item.stream && logs[item.stream]?.status === 'ready' ? item.stream : primaryLog()?.id;
};

export function resolveSource(stream: string | undefined, source: string): Resolved {
  const src = source.trim();
  if (src.startsWith('@')) {
    const w = src.slice(1).toLowerCase();
    return SPECIALS.has(w)
      ? { kind: 'special', which: w as 'mode' }
      : { kind: 'error', message: `Unknown special source ${src} (use @mode, @armed, @time or @local)` };
  }
  if (!stream) return { kind: 'error', message: 'No log loaded' };
  if (!src) return { kind: 'error', message: 'No source' };
  const key = `${stream}|${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  cache.set(key, { kind: 'loading' });
  const named = useExpressions.getState().named;
  const load = channelExists({ stream, id: src })
    ? loadChannel({ stream, id: src })
    : loadExpression(stream, src in named ? named[src]! : src, named);
  void load
    .then(
      (s) => { cache.set(key, s ? { kind: 'series', t: s.t, v: s.v, unit: s.unit, maxGap: 5 * medianDt(s.t) || Infinity } : { kind: 'error', message: `${src} not found` }); },
      (e: unknown) => { cache.set(key, { kind: 'error', message: e instanceof Error ? e.message : String(e) }); },
    )
    .finally(bump);
  return { kind: 'loading' };
}

/** Value of a series at stream-local time (NaN outside the data or across gaps). */
export function sampleSeries(r: SeriesRes, local: number, mode: 'interp' | 'hold' = 'interp'): number {
  const n = r.t.length;
  if (!n || local < r.t[0]! - 1e-9 || local > r.t[n - 1]! + r.maxGap) return NaN;
  return mode === 'hold' ? holdAt(r, local) : interpAt(r, Math.min(local, r.t[n - 1]!), r.maxGap);
}

export interface LineValue { label: string; text: string; error?: string }

/** Text of one readout line at master time t. */
export function lineValue(line: ReadoutLine, item: OverlayItem, tMaster: number): LineValue {
  const stream = streamOf(item);
  const r = resolveSource(stream, line.source);
  const local = stream ? masterToLocal(stream, tMaster) : tMaster;
  const unit = line.unit ?? '';
  const withUnit = (s: string) => (unit && s !== '–' ? `${s} ${unit}` : s);
  // Trimmed out: no value (time sources still show).
  if (stream && !inTrim(stream, local) && !(r.kind === 'special' && (r.which === 'time' || r.which === 'local'))) return { label: line.label, text: '–' };
  switch (r.kind) {
    case 'loading': return { label: line.label, text: '…' };
    case 'error': return { label: line.label, text: '?', error: r.message };
    case 'series': return { label: line.label, text: withUnit(formatValue(sampleSeries(r, local, item.sample), line.format || '%.2f')) };
    case 'special': {
      const sum = stream ? useLogs.getState().logs[stream]?.summary : undefined;
      if (r.which === 'time') return { label: line.label, text: fmtTime(tMaster) };
      if (r.which === 'local') return { label: line.label, text: fmtTime(local) };
      if (!sum) return { label: line.label, text: '–' };
      if (r.which === 'mode') return { label: line.label, text: sum.modes.find((m) => local >= m.t0 && local < m.t1)?.name ?? '–' };
      return { label: line.label, text: sum.armed.some(([a, b]) => local >= a && local < b) ? 'ARMED' : 'DISARMED' };
    }
  }
}

const SPEED = ['ARSP.Airspeed', 'CTUN.As', 'GPS.Spd'];
const ALT = ['POS.RelHomeAlt', 'BARO.Alt', 'GPS.Alt'];

/** Attitude state for an ADI overlay at master time t (null when there is no data). */
export function adiState(item: OverlayItem, tMaster: number): AdiState | null {
  const stream = streamOf(item);
  if (!stream) return null;
  const local = masterToLocal(stream, tMaster);
  if (!inTrim(stream, local)) return null;
  const s = (id: string): SeriesRes | null => { const r = resolveSource(stream, id); return r.kind === 'series' ? r : null; };
  const roll = s('ATT.Roll'), pitch = s('ATT.Pitch'), yaw = s('ATT.Yaw');
  if (!roll || !pitch) return null;
  const rollV = sampleSeries(roll, local), pitchV = sampleSeries(pitch, local);
  if (Number.isNaN(rollV) || Number.isNaN(pitchV)) return null;
  const first = (ids: string[]) => {
    const id = ids.find((x) => channelExists({ stream, id: x }));
    const r = id ? s(id) : null;
    return r ? sampleSeries(r, local) : undefined;
  };
  const sum = useLogs.getState().logs[stream]?.summary;
  return {
    roll: rollV, pitch: pitchV, heading: yaw ? sampleAngleAt(yaw.t, yaw.v, local) : 0,
    airspeed: first(SPEED), altitude: first(ALT),
    mode: sum?.modes.find((m) => local >= m.t0 && local < m.t1)?.name,
    armed: sum ? sum.armed.some(([a, b]) => local >= a && local < b) : undefined,
    speedLabel: 'm/s', altLabel: 'm',
  };
}

// ---------------------------------------------------------------- pilot sticks

export interface StickAxis { pwm: number; ch: number }
export interface SticksState {
  input: SticksInput;
  /** Raw PWM of the four primary controls (µs) and their channel numbers. */
  raw: { roll: StickAxis; pitch: StickAxis; throttle: StickAxis; yaw: StickAxis };
  /** Channels 5–8: position 0…1 (min…max), trim position, PWM. */
  aux: { ch: number; v: number; trim: number; pwm: number }[];
  loading: boolean;
}

// Parameter lookup per log and whole second (RC calibration rarely changes in flight).
const paramMemo = new Map<string, { key: number; get: (n: string) => number | undefined }>();
function paramGetter(stream: string, local: number): (n: string) => number | undefined {
  const params = useLogs.getState().logs[stream]?.summary?.params ?? [];
  const key = Math.floor(local);
  const m = paramMemo.get(stream);
  if (m && m.key === key) return m.get;
  const at = paramsAt(params, local);
  const get = (n: string) => at.get(n)?.value;
  paramMemo.set(stream, { key, get });
  return get;
}

/** Stick positions and aux sliders from the log's RC input (RCIN) at master time t. */
export function sticksState(item: OverlayItem, tMaster: number): SticksState | null {
  const stream = streamOf(item);
  if (!stream) return null;
  const local = masterToLocal(stream, tMaster);
  if (!inTrim(stream, local)) return null;
  const get = paramGetter(stream, local);
  const map = rcMap(get);
  let loading = false;
  const pwm = (ch: number): number => {
    const id = ch <= 14 ? `RCIN.C${ch}` : `RCI2.C${ch}`;
    if (!channelExists({ stream, id })) return NaN;
    const r = resolveSource(stream, id);
    if (r.kind === 'loading') loading = true;
    return r.kind === 'series' ? sampleSeries(r, local, item.sample ?? 'interp') : NaN;
  };
  const p = { roll: pwm(map.roll), pitch: pwm(map.pitch), throttle: pwm(map.throttle), yaw: pwm(map.yaw) };
  // ArduPilot: elevator stick forward = low PWM; shown with forward = up.
  const pitchSign = item.flipElevator ? 1 : -1;
  const input: SticksInput = {
    roll: centred(p.roll, rcCal(get, map.roll)),
    pitch: pitchSign * centred(p.pitch, rcCal(get, map.pitch)),
    throttle: unipolar(p.throttle, rcCal(get, map.throttle)),
    yaw: centred(p.yaw, rcCal(get, map.yaw)),
  };
  const aux = [5, 6, 7, 8].map((ch) => {
    const c = rcCal(get, ch), v = pwm(ch);
    return { ch, v: unipolar(v, c), trim: unipolar(c.trim, c), pwm: v };
  });
  return {
    input, aux, loading,
    raw: { roll: { pwm: p.roll, ch: map.roll }, pitch: { pwm: p.pitch, ch: map.pitch }, throttle: { pwm: p.throttle, ch: map.throttle }, yaw: { pwm: p.yaw, ch: map.yaw } },
  };
}
