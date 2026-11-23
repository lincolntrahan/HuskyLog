import { create } from 'zustand';
import type { CameraFacing } from '../adi/drawAdi';
import type { NRect } from '@core/overlay/rect';

/**
 * Overlays (DESIGN §7.7): every window has a list of overlay items drawn on
 * top of it. Items live in this store, keyed by window (dockview panel) id,
 * and are mirrored into the panel's parameters so the layout serializer
 * (Phase 6 workspace) saves them with the window.
 */
export interface ReadoutLine {
  label: string;
  /** Channel id (ATT.Roll), named expression, any expression, or a special
   *  source: @mode, @armed, @time (master), @local (stream time). */
  source: string;
  format: string;    // printf style, e.g. "%.1f"
  /** False once the user typed a label; picking a source then keeps it. */
  labelAuto?: boolean;
  unit?: string;
}
export interface OverlayStyle {
  color: string;
  bg: string;        // CSS colour of the box background
  opacity: number;   // 0–1, box background opacity
  align: 'left' | 'center' | 'right';
}
export interface OverlayItem {
  id: string;
  kind: 'readout' | 'adi' | 'sticks';
  rect: NRect;
  style: OverlayStyle;
  /** Stream the sources come from (default: the primary log). */
  stream?: string;
  /** Sample-and-hold or linear interpolation between samples. */
  sample?: 'interp' | 'hold';
  lines?: ReadoutLine[];
  /** ADI: draw the speed/altitude/heading tapes. */
  tapes?: boolean;
  /** ADI: see-through HUD lines (true) or the filled sky/ground ball. */
  hud?: boolean;
  /** Which way the camera under this horizon looks (backward: tail cams). */
  facing?: CameraFacing;
  /** Sticks: transmitter mode (2: throttle on the left). */
  stickMode?: 1 | 2;
  /** Sticks: show the channel 5–8 sliders. */
  aux?: boolean;
  /** Sticks: print PWM values (µs). */
  values?: boolean;
  /** Sticks: elevator stick forward gives high PWM (ArduPilot's convention is low). */
  flipElevator?: boolean;
}

export const DEFAULT_STYLE: OverlayStyle = { color: '#ffffff', bg: '#000000', opacity: 0.45, align: 'left' };

let n = 0;
const newId = () => `ov${Date.now().toString(36)}${(n++).toString(36)}`;

export function newReadout(at?: Partial<NRect>): OverlayItem {
  return {
    id: newId(), kind: 'readout', rect: { x: 0.03, y: 0.05, w: 0.26, h: 0.16, ...at }, style: { ...DEFAULT_STYLE }, sample: 'interp',
    lines: [
      { label: 'Alt', source: 'POS.RelHomeAlt', format: '%.1f', unit: 'm' },
      { label: 'Speed', source: 'GPS.Spd', format: '%.1f', unit: 'm/s' },
    ],
  };
}
export function newAdi(at?: Partial<NRect>): OverlayItem {
  return { id: newId(), kind: 'adi', rect: { x: 0.62, y: 0.55, w: 0.35, h: 0.42, ...at }, style: { ...DEFAULT_STYLE, opacity: 0 }, tapes: false, hud: true };
}

export function newSticks(at?: Partial<NRect>): OverlayItem {
  return { id: newId(), kind: 'sticks', rect: { x: 0.03, y: 0.62, w: 0.34, h: 0.34, ...at }, style: { ...DEFAULT_STYLE, opacity: 0.35 }, stickMode: 2, aux: true, values: false };
}

/** Widget types, as the widget menu lists them. */
export const WIDGET_TYPES: { kind: OverlayItem['kind']; label: string; hint: string }[] = [
  { kind: 'readout', label: 'Readout', hint: 'Numbers from any channel or expression' },
  { kind: 'adi', label: 'Horizon', hint: 'Artificial horizon, optional speed/altitude/heading tapes' },
  { kind: 'sticks', label: 'Pilot sticks', hint: 'Stick positions (AETR) and channel 5–8 sliders' },
];

/** A new widget (a readout until its type is changed in its menu). */
export const newWidget = (at?: Partial<NRect>): OverlayItem => newReadout(at);

/**
 * Changes a widget's type in place: same id, position and log (the size is the new
 * type's default); the new
 * type's own settings start from their defaults (or what the widget had before).
 */
export function convertWidget(item: OverlayItem, kind: OverlayItem['kind']): OverlayItem {
  if (item.kind === kind) return item;
  const fresh = kind === 'readout' ? newReadout() : kind === 'adi' ? newAdi() : newSticks();
  return {
    // Same place, the new type's default size (a readout strip is too small for a horizon).
    ...fresh, ...item, kind, id: item.id,
    rect: { x: Math.max(0, Math.min(item.rect.x, 1 - fresh.rect.w)), y: Math.max(0, Math.min(item.rect.y, 1 - fresh.rect.h)), w: fresh.rect.w, h: fresh.rect.h },
    style: { ...item.style, opacity: kind === 'adi' && item.kind === 'readout' ? 0 : item.style.opacity },
    lines: item.lines ?? fresh.lines,
    hud: item.hud ?? fresh.hud, tapes: item.tapes ?? fresh.tapes,
    stickMode: item.stickMode ?? fresh.stickMode, aux: item.aux ?? fresh.aux, values: item.values ?? fresh.values,
  };
}

interface OverlayState {
  byWindow: Record<string, OverlayItem[]>;
  editing: string | null;            // window id in edit mode (one at a time)
  selected: string | null;           // overlay id
  set: (win: string, items: OverlayItem[]) => void;
  add: (win: string, item: OverlayItem) => void;
  patch: (win: string, id: string, p: Partial<OverlayItem>) => void;
  remove: (win: string, id: string) => void;
  setEditing: (win: string | null) => void;
  select: (id: string | null) => void;
}

export const useOverlays = create<OverlayState>((set, get) => ({
  byWindow: {},
  editing: null,
  selected: null,
  set: (win, items) => set({ byWindow: { ...get().byWindow, [win]: items } }),
  add: (win, item) => set({ byWindow: { ...get().byWindow, [win]: [...(get().byWindow[win] ?? []), item] }, selected: item.id }),
  patch: (win, id, p) => set({ byWindow: { ...get().byWindow, [win]: (get().byWindow[win] ?? []).map((o) => (o.id === id ? { ...o, ...p } : o)) } }),
  remove: (win, id) => set({ byWindow: { ...get().byWindow, [win]: (get().byWindow[win] ?? []).filter((o) => o.id !== id) }, selected: get().selected === id ? null : get().selected }),
  setEditing: (editing) => set({ editing, selected: null }),
  select: (selected) => set({ selected }),
}));
