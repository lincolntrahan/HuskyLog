/**
 * Per-video picture adjustments (team request): rotate in 90° steps, mirror,
 * straighten (fine rotation), crop. Non-destructive: stored with the
 * workspace and applied when drawing (Video window, export, Sync preview);
 * baked in only when a compressed copy is written.
 *
 * Order, as the user sees it: the file's own rotation, then `rot`, then the
 * mirror (in screen space, so ↔ always flips left/right as shown), then the
 * fine rotation about the centre (the box keeps its size; corners outside are
 * black unless cropped away), then the crop, in normalised coordinates of
 * that box.
 */
export interface CropRect { x: number; y: number; w: number; h: number }
export interface VideoAdjust {
  rot: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  /** Degrees, clockwise, −45…45. */
  fine: number;
  crop: CropRect;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
export const NO_ADJUST: VideoAdjust = { rot: 0, flipH: false, flipV: false, fine: 0, crop: FULL_CROP };

export function isIdentity(a: VideoAdjust | undefined | null): boolean {
  if (!a) return true;
  const c = a.crop;
  return a.rot === 0 && !a.flipH && !a.flipV && Math.abs(a.fine) < 1e-6 && c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
}

/** Size of the picture after the file rotation and `rot` (before the crop). */
export function orientedSize(iw: number, ih: number, fileRot: number, a: VideoAdjust): { w: number; h: number } {
  const quarter = ((fileRot + a.rot) / 90) % 2 !== 0;
  return quarter ? { w: ih, h: iw } : { w: iw, h: ih };
}

/** Size of the adjusted picture (the crop of the oriented box), in source pixels. */
export function adjustedSize(iw: number, ih: number, fileRot: number, a: VideoAdjust): { w: number; h: number } {
  const o = orientedSize(iw, ih, fileRot, a);
  return { w: o.w * a.crop.w, h: o.h * a.crop.h };
}

/** The minimal 2D context surface used (CanvasRenderingContext2D or OffscreenCanvasRenderingContext2D). */
export interface TransformCtx {
  translate(x: number, y: number): void;
  rotate(r: number): void;
  scale(x: number, y: number): void;
}

/**
 * Sets ctx's transform so that drawing the source image at
 * (−iw/2, −ih/2, iw, ih) puts the adjusted picture into the box
 * (x, y, w, h), scaled to fill it (the caller picks a box of the adjusted
 * aspect, see fitBox). Returns the scale from source pixels to output pixels.
 */
export function applyAdjust(ctx: TransformCtx, iw: number, ih: number, fileRot: number, a: VideoAdjust, x: number, y: number, w: number, h: number): number {
  const o = orientedSize(iw, ih, fileRot, a);
  const k = Math.min(w / (o.w * a.crop.w), h / (o.h * a.crop.h));
  const cx = (a.crop.x + a.crop.w / 2 - 0.5) * o.w, cy = (a.crop.y + a.crop.h / 2 - 0.5) * o.h;
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(k, k);
  ctx.translate(-cx, -cy);
  ctx.rotate((a.fine * Math.PI) / 180);
  ctx.scale(a.flipH ? -1 : 1, a.flipV ? -1 : 1);
  ctx.rotate(((fileRot + a.rot) * Math.PI) / 180);
  return k;
}

/** The largest box of the given aspect (w/h) centred in (W, H). */
export function fitBox(aspect: number, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const w = Math.min(W, H * aspect), h = w / aspect;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/**
 * The largest centred crop with the oriented box's aspect that has no black
 * corners after a fine rotation of `deg` (for "Crop out corners").
 */
export function cornerFreeCrop(ow: number, oh: number, deg: number): CropRect {
  const t = Math.abs((deg * Math.PI) / 180), c = Math.cos(t), s = Math.sin(t);
  const k = Math.min(1, ow / (ow * c + oh * s), oh / (ow * s + oh * c));
  return { x: (1 - k) / 2, y: (1 - k) / 2, w: k, h: k };
}

/** Keeps a crop inside the box with a minimum size. */
export function clampCrop(c: CropRect, min = 0.05): CropRect {
  const w = Math.min(1, Math.max(min, c.w)), h = Math.min(1, Math.max(min, c.h));
  return { x: Math.min(1 - w, Math.max(0, c.x)), y: Math.min(1 - h, Math.max(0, c.y)), w, h };
}

/** Next 90° step: dir +1 clockwise, −1 counter-clockwise. */
export const rotateStep = (r: VideoAdjust['rot'], dir: 1 | -1): VideoAdjust['rot'] => (((r + dir * 90) % 360 + 360) % 360) as VideoAdjust['rot'];

/** Parses a stored adjustment (workspace), tolerating missing fields. */
export function parseAdjust(v: unknown): VideoAdjust | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<VideoAdjust>;
  const rot = [0, 90, 180, 270].includes(o.rot as number) ? (o.rot as VideoAdjust['rot']) : 0;
  const crop = o.crop && typeof o.crop === 'object' ? clampCrop({ x: Number(o.crop.x) || 0, y: Number(o.crop.y) || 0, w: Number(o.crop.w) || 1, h: Number(o.crop.h) || 1 }, 0.01) : FULL_CROP;
  const a: VideoAdjust = { rot, flipH: !!o.flipH, flipV: !!o.flipV, fine: Math.max(-45, Math.min(45, Number(o.fine) || 0)), crop };
  return isIdentity(a) ? undefined : a;
}

/** Moves a crop with the picture when it is turned 90° (dir +1 clockwise) or mirrored. */
export function turnCrop(c: CropRect, op: 'cw' | 'ccw' | 'flipH' | 'flipV'): CropRect {
  switch (op) {
    case 'cw': return { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
    case 'ccw': return { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
    case 'flipH': return { ...c, x: 1 - c.x - c.w };
    case 'flipV': return { ...c, y: 1 - c.y - c.h };
  }
}
