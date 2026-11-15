import { EVENT_NAMES, HOUSEKEEPING_PARAMS, modeName, servoFunctionName, vehicleFromFirmware, type Vehicle } from '../ardupilot/tables';
import { columnUnit } from './decoder';
import { decodeRows } from './decoder';
import { isNumericChar } from './format';
import type { LogIndex } from './types';

export interface ChannelInfo {
  /** e.g. "ATT.Roll", "IMU[1].AccZ" (bare name when the type has one instance). */
  id: string;
  type: string;
  instance: number | null;
  field: string;
  unit: string;
  /** Friendly extra label, e.g. "Throttle" for RCOU.C1. */
  label?: string;
  count: number;
  rateHz: number;
}

export interface LogEvent {
  t: number;
  kind: 'MSG' | 'MODE' | 'EV' | 'ARM' | 'ERR';
  text: string;
}

export interface ModeSpan { t0: number; t1: number; name: string; num: number }

export interface ParamEntry { name: string; value: number; default: number | null; t: number }

export interface LogSummary {
  vehicle: Vehicle;
  firmware: string;
  board: string;
  timeRange: [number, number];
  channels: ChannelInfo[];
  events: LogEvent[];
  modes: ModeSpan[];
  /** All PARM rows in time order (initial dump + in-flight changes). */
  params: ParamEntry[];
  armed: [number, number][];
  files: string[];
  diagnostics: { skippedBytes: number; truncatedTail: number; outOfOrder: number; formats: number; types: number };
}

/** Message types decoded eagerly into the summary. */
export function summarize(bytes: Uint8Array, index: LogIndex): LogSummary {
  const rows = (n: string) => decodeRows(bytes, index, n);
  const msgs = rows('MSG');
  const ver = rows('VER')[0];
  const firmware = (ver?.['FWS'] as string) || (msgs.find((m) => /Ardu|Rover/.test(String(m['Message'])))?.['Message'] as string) || '';
  const board = (msgs.find((m) => /^[\w-]+ [0-9A-F]{8}/.test(String(m['Message'])))?.['Message'] as string)?.split(' ')[0] ?? '';
  const vehicle = vehicleFromFirmware(firmware);
  const [t0, t1] = index.timeRange;

  // Params, in time order. SERVOn_FUNCTION drives RCOU labels.
  const params: ParamEntry[] = rows('PARM').map((r) => ({
    name: String(r['Name']), value: Number(r['Value']),
    default: r['Default'] === undefined || Number.isNaN(r['Default']) ? null : Number(r['Default']), t: r._t,
  }));
  const servoFn = new Map<number, number>();
  for (const p of params) {
    const m = /^SERVO(\d+)_FUNCTION$/.exec(p.name);
    if (m) servoFn.set(Number(m[1]), p.value);
  }

  // Channel catalog.
  const channels: ChannelInfo[] = [];
  for (const [type, st] of index.stats) {
    const def = index.formats.get(type)!;
    if (def.timeCol === undefined || ['FMT', 'FMTU', 'UNIT', 'MULT', 'PARM', 'MSG', 'FILE'].includes(def.name)) continue;
    const insts = st.instances ? [...st.instances.keys()].sort((a, b) => a - b) : [null];
    const multi = insts.length > 1;
    const dur = st.lastTime - st.firstTime;
    for (const inst of insts) {
      const count = inst === null ? st.count : st.instances!.get(inst)!;
      for (let c = 0; c < def.format.length; c++) {
        if (c === def.timeCol || c === def.instanceCol || !isNumericChar(def.format[c]!)) continue;
        const field = def.columns[c]!;
        const id = `${def.name}${multi ? `[${inst}]` : ''}.${field}`;
        let label: string | undefined;
        const rc = /^C(\d+)$/.exec(field);
        if (rc && (def.name === 'RCOU' || def.name === 'RCO2' || def.name === 'RCO3')) {
          label = servoFunctionName(servoFn.get(Number(rc[1])) ?? 0) ?? undefined;
        }
        channels.push({ id, type: def.name, instance: multi ? inst : null, field, unit: columnUnit(index, def, c), label, count, rateHz: dur > 0 ? count / dur : 0 });
      }
    }
  }
  channels.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  // Events.
  const events: LogEvent[] = [];
  for (const m of msgs) events.push({ t: m._t, kind: 'MSG', text: String(m['Message']) });
  const modeRows = rows('MODE');
  for (const m of modeRows) {
    const num = Number(m['ModeNum'] ?? m['Mode']);
    events.push({ t: m._t, kind: 'MODE', text: modeName(vehicle, num) });
  }
  for (const e of rows('EV')) events.push({ t: e._t, kind: 'EV', text: EVENT_NAMES[Number(e['Id'])] ?? `EVENT ${e['Id']}` });
  const armed: [number, number][] = [];
  let armStart: number | null = null;
  for (const a of rows('ARM')) {
    const on = Number(a['ArmState']) === 1;
    events.push({ t: a._t, kind: 'ARM', text: on ? 'Armed' : 'Disarmed' });
    if (on && armStart === null) armStart = a._t;
    if (!on && armStart !== null) { armed.push([armStart, a._t]); armStart = null; }
  }
  if (armStart !== null) armed.push([armStart, t1]);
  for (const e of rows('ERR')) events.push({ t: e._t, kind: 'ERR', text: `Subsys ${e['Subsys']} ECode ${e['ECode']}` });
  events.sort((a, b) => a.t - b.t);

  const modes: ModeSpan[] = modeRows.map((m, i) => ({
    t0: m._t, t1: modeRows[i + 1]?._t ?? t1, num: Number(m['ModeNum'] ?? m['Mode']),
    name: modeName(vehicle, Number(m['ModeNum'] ?? m['Mode'])),
  }));

  const fileNames = [...new Set(rows('FILE').map((f) => String(f['FileName'])))];

  return {
    vehicle, firmware, board, timeRange: [t0, t1], channels, events, modes, params, armed, files: fileNames,
    diagnostics: {
      skippedBytes: index.skippedBytes, truncatedTail: index.truncatedTail, outOfOrder: index.outOfOrder,
      formats: index.formats.size, types: index.stats.size,
    },
  };
}

/** Value of every parameter at time t (last PARM row at or before t). */
export function paramsAt(params: ParamEntry[], t: number): Map<string, ParamEntry> {
  const out = new Map<string, ParamEntry>();
  for (const p of params) {
    if (p.t > t && out.has(p.name)) continue;
    if (p.t <= t || !out.has(p.name)) out.set(p.name, p);
  }
  return out;
}

/** In-flight parameter changes (after the initial dump). */
export function paramChanges(params: ParamEntry[], includeHousekeeping = false): (ParamEntry & { from: number })[] {
  const seen = new Map<string, number>();
  const out: (ParamEntry & { from: number })[] = [];
  for (const p of params) {
    const prev = seen.get(p.name);
    if (prev !== undefined && prev !== p.value && (includeHousekeeping || !HOUSEKEEPING_PARAMS.test(p.name))) {
      out.push({ ...p, from: prev });
    }
    seen.set(p.name, p.value);
  }
  return out;
}
