import { create } from 'zustand';
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
  kind: 'readout' | 'adi';
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
