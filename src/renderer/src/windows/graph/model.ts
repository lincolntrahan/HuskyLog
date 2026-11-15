/** Graph window configuration (saved in the panel params / workspace / presets). */

export interface SeriesCfg {
  /** Stream id; omitted = the primary log (keeps presets portable between logs). */
  stream?: string;
  /** Channel id ("ATT.Roll", "IMU[1].AccZ"), or the expression source when kind is 'expr'. */
  id: string;
  kind?: 'expr';
  /** Optional display name and unit (used for expression series). */
  name?: string;
  unit?: string;
  color: string;
  axis: 'auto' | 'left' | 'right';
  visible: boolean;
}

export interface GraphCfg {
  series: SeriesCfg[];
  modeBands: boolean;
}

export const DEFAULT_GRAPH: GraphCfg = { series: [], modeBands: true };

/** Distinct on a dark background, colour-blind-aware ordering (Okabe-Ito based). */
export const PALETTE = ['#4ea1ff', '#ffb000', '#ff5c8a', '#3ddc97', '#c792ea', '#ff7a45', '#7fdbff', '#e6db74', '#a0a0ff', '#f78fb3'];

export function nextColor(used: string[]): string {
  return PALETTE.find((c) => !used.includes(c)) ?? PALETTE[used.length % PALETTE.length]!;
}

export interface GraphPreset {
  format: 'huskylog-graph-preset';
  version: 1;
  name: string;
  series: { id: string; kind?: 'expr'; name?: string; unit?: string; color?: string; axis?: SeriesCfg['axis'] }[];
  modeBands?: boolean;
  /** Named expressions the series rely on, added on load if missing. */
  named?: Record<string, string>;
}

export const BUILTIN_PRESETS: GraphPreset[] = [
  { format: 'huskylog-graph-preset', version: 1, name: 'Attitude tracking', series: [{ id: 'ATT.Roll' }, { id: 'ATT.DesRoll' }, { id: 'ATT.Pitch' }, { id: 'ATT.DesPitch' }] },
  { format: 'huskylog-graph-preset', version: 1, name: 'Rate controllers', series: [{ id: 'PIDR.Tar' }, { id: 'PIDR.Act' }, { id: 'PIDP.Tar' }, { id: 'PIDP.Act' }] },
  { format: 'huskylog-graph-preset', version: 1, name: 'Vibration', series: [{ id: 'VIBE.VibeX' }, { id: 'VIBE.VibeY' }, { id: 'VIBE.VibeZ' }, { id: 'VIBE.Clip', axis: 'right' }] },
  { format: 'huskylog-graph-preset', version: 1, name: 'Battery & power', series: [{ id: 'BAT.Volt' }, { id: 'BAT.Curr' }] },
  { format: 'huskylog-graph-preset', version: 1, name: 'Airspeed', series: [{ id: 'ARSP.Airspeed' }, { id: 'GPS.Spd' }, { id: 'CTUN.As' }] },
  { format: 'huskylog-graph-preset', version: 1, name: 'Altitude', series: [{ id: 'BARO.Alt' }, { id: 'POS.RelHomeAlt' }, { id: 'GPS.Alt' }] },
  { format: 'huskylog-graph-preset', version: 1, name: 'Throttle & RPM', series: [{ id: 'CTUN.ThO' }, { id: 'ESC.RPM', axis: 'right' }] },
  {
    format: 'huskylog-graph-preset', version: 1, name: 'Power & energy (expressions)',
    named: { power_W: 'BAT.Volt * BAT.Curr' },
    series: [
      { id: 'power_W', kind: 'expr', name: 'Power', unit: 'W' },
      { id: 'integrate(BAT.Curr) / 3.6', kind: 'expr', name: 'Used', unit: 'mAh', axis: 'right' },
    ],
  },
];

export function presetFromCfg(name: string, cfg: GraphCfg, named: Record<string, string> = {}): GraphPreset {
  return {
    format: 'huskylog-graph-preset', version: 1, name, modeBands: cfg.modeBands,
    series: cfg.series.map((s) => ({ id: s.id, kind: s.kind, name: s.name, unit: s.unit, color: s.color, axis: s.axis })),
    ...(Object.keys(named).length ? { named } : {}),
  };
}

export function cfgFromPreset(p: GraphPreset): GraphCfg {
  const used: string[] = [];
  return {
    modeBands: p.modeBands ?? true,
    series: p.series.map((s) => {
      const color = s.color ?? nextColor(used);
      used.push(color);
      const out: SeriesCfg = { id: s.id, color, axis: s.axis ?? 'auto', visible: true };
      if (s.kind) out.kind = s.kind;
      if (s.name) out.name = s.name;
      if (s.unit) out.unit = s.unit;
      return out;
    }),
  };
}

export function parsePreset(json: string): GraphPreset {
  const p = JSON.parse(json) as GraphPreset;
  if (p.format !== 'huskylog-graph-preset' || !Array.isArray(p.series)) throw new Error('Not a HuskyLog graph preset');
  return p;
}

/** Stable colour for a flight mode band. */
export function modeColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 55%)`;
}
