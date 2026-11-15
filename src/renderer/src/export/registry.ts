/**
 * Export sources (DESIGN §7 "drawFrame", §10): every exportable window
 * registers how to draw itself onto a canvas at an exact master time.
 * Overlays are drawn on top by the compositor, relative to `content()`.
 */
export interface ExportSource {
  id: string;            // dockview panel id
  type: string;          // map3d, video, graph, adi
  title: string;
  /** The element overlays are positioned in (also used for "as on screen"). */
  content(): HTMLElement | null;
  /** Draws the window at master time t into (0, 0, w, h) of ctx. */
  draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, t: number, w: number, h: number): Promise<void>;
}

const sources = new Map<string, ExportSource>();
const listeners = new Set<() => void>();

export function registerExportSource(s: ExportSource): () => void {
  sources.set(s.id, s);
  listeners.forEach((l) => l());
  return () => {
    if (sources.get(s.id) === s) sources.delete(s.id);
    listeners.forEach((l) => l());
  };
}
export const exportSources = (): ExportSource[] => [...sources.values()];
export const exportSource = (id: string) => sources.get(id);
export function onExportSourcesChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True when the element is actually shown (an inactive tab has no size). */
export function isShown(el: HTMLElement | null): boolean {
  return !!el && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
}

/** Draws "message" centred on a dark background (out of range, not synced…). */
export function drawMessage(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, msg: string): void {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8a94a3'; ctx.font = `${Math.max(11, Math.round(h * 0.04))}px Segoe UI, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
  ctx.textAlign = 'left';
}
