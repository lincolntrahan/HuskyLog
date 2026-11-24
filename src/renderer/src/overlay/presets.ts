import { create } from 'zustand';
import { channelExists } from '../data/logs';
import { G_EXPR } from '../ui/quickPicks';
import type { ReadoutLine } from './model';

/**
 * Readout presets (team request): named sets of readout lines. Built-ins list
 * fallback sources per line (logs differ: ESC telemetry or an RPM sensor, EKF3
 * or EKF2…); applying picks the first one the log has. A line whose sources
 * are all missing is still added, so its "not found" shows what to retarget.
 * The user's own presets store plain lines and live on this computer.
 */
interface Candidate { src: string; needs?: string[] }
export interface PresetLine { label: string; candidates: Candidate[]; format: string; unit: string }
export interface ReadoutPreset { name: string; builtIn?: boolean; lines: PresetLine[] }

const ch = (src: string): Candidate => ({ src });
const ex = (src: string, needs: string[]): Candidate => ({ src, needs });

export const BUILT_IN_PRESETS: ReadoutPreset[] = [
  {
    name: 'Propulsion', builtIn: true, lines: [
      { label: 'RPM', candidates: [ch('ESC.RPM'), ch('RPM.rpm1')], format: '%.0f', unit: 'rpm' },
      { label: 'Voltage', candidates: [ch('BAT.Volt'), ch('ESC.Volt')], format: '%.2f', unit: 'V' },
      { label: 'Current', candidates: [ch('BAT.Curr'), ch('ESC.Curr')], format: '%.1f', unit: 'A' },
      { label: 'Power', candidates: [ex('BAT.Volt * BAT.Curr', ['BAT.Volt', 'BAT.Curr']), ex('ESC.Volt * ESC.Curr', ['ESC.Volt', 'ESC.Curr'])], format: '%.0f', unit: 'W' },
      { label: 'Throttle', candidates: [ch('CTUN.ThO'), ch('CTUN.ThrOut')], format: '%.0f', unit: '%' },
      { label: 'ESC temp', candidates: [ch('ESC.Temp')], format: '%.0f', unit: '°C' },
      { label: 'Used', candidates: [ex('BAT.CurrTot * 1000', ['BAT.CurrTot']), ex('ESC.CTot * 1000', ['ESC.CTot'])], format: '%.0f', unit: 'mAh' },
      { label: 'Energy', candidates: [ch('BAT.EnrgTot')], format: '%.1f', unit: 'Wh' },
    ],
  },
  {
    name: 'Flight state', builtIn: true, lines: [
      { label: 'Altitude', candidates: [ch('POS.RelHomeAlt'), ch('BARO.Alt'), ch('GPS.Alt')], format: '%.1f', unit: 'm' },
      { label: 'Airspeed', candidates: [ch('ARSP.Airspeed'), ch('CTUN.As')], format: '%.1f', unit: 'm/s' },
      { label: 'G load', candidates: [ex(G_EXPR, ['IMU.AccX', 'IMU.AccY', 'IMU.AccZ'])], format: '%.2f', unit: 'g' },
      { label: 'Climb', candidates: [ex('-XKF1.VD', ['XKF1.VD']), ex('-NKF1.VD', ['NKF1.VD']), ch('TECS.dh'), ex('-GPS.VZ', ['GPS.VZ'])], format: '%+.1f', unit: 'm/s' },
      { label: 'Ground speed', candidates: [ch('GPS.Spd')], format: '%.1f', unit: 'm/s' },
    ],
  },
  {
    name: 'Radio', builtIn: true, lines: [
      { label: 'RSSI', candidates: [ex('RSSI.RXRSSI * 100', ['RSSI.RXRSSI'])], format: '%.0f', unit: '%' },
      // Not in every log (ArduPilot logs RSSI as 0–1 and link quality as %): pick the channel with ▾.
      { label: 'RSSI dBm', candidates: [], format: '%.0f', unit: 'dBm' },
      { label: 'Link quality', candidates: [ch('RSSI.RXLQ')], format: '%.0f', unit: '%' },
      { label: 'Packet rate', candidates: [], format: '%.0f', unit: 'Hz' },
    ],
  },
];

const KEY = 'huskylog.readoutPresets';
function load(): ReadoutPreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((p): p is ReadoutPreset => !!p && typeof (p as ReadoutPreset).name === 'string' && Array.isArray((p as ReadoutPreset).lines)) : [];
  } catch { return []; }
}
function save(list: ReadoutPreset[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable: presets last this session */ }
}

/** The user's own presets (this computer). */
export const usePresets = create<{ mine: ReadoutPreset[] }>(() => ({ mine: load() }));

export const allPresets = (): ReadoutPreset[] => [...BUILT_IN_PRESETS, ...usePresets.getState().mine];

/** Saves (or replaces) one of the user's presets from readout lines. */
export function savePreset(name: string, lines: ReadoutLine[]): void {
  const p: ReadoutPreset = { name, lines: lines.map((l) => ({ label: l.label, candidates: l.source ? [{ src: l.source }] : [], format: l.format, unit: l.unit ?? '' })) };
  const mine = [...usePresets.getState().mine.filter((x) => x.name !== name), p];
  usePresets.setState({ mine });
  save(mine);
}
export function deletePreset(name: string): void {
  const mine = usePresets.getState().mine.filter((x) => x.name !== name);
  usePresets.setState({ mine });
  save(mine);
}

/** A preset's lines for a log: each line takes the first source the log has (else its first). */
export function presetLines(p: ReadoutPreset, stream: string | undefined): ReadoutLine[] {
  const has = (id: string) => !!stream && channelExists({ stream, id });
  return p.lines.map((l) => {
    const pick = l.candidates.find((c) => (c.needs ? c.needs.every(has) : has(c.src) || !/^[A-Za-z0-9_]+(\[\d+\])?\.[A-Za-z0-9_]+$/.test(c.src))) ?? l.candidates[0];
    return { label: l.label, source: pick?.src ?? '', format: l.format, unit: l.unit, labelAuto: false };
  });
}
