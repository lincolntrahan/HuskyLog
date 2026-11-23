/**
 * Pilot-sticks overlay math (team request): RC input PWM → stick positions.
 *
 * Calibration comes from the log's own parameters: RCn_MIN / TRIM / MAX /
 * REVERSED, and RCMAP_ROLL / PITCH / THROTTLE / YAW for which channel is
 * which (AETR = 1, 2, 3, 4 is the default). Centred axes map trim → 0 and
 * min/max → ∓1 (separately per side, so an off-centre trim still reaches the
 * edges); throttle maps min → 0, max → 1.
 */
export interface RcCal { min: number; trim: number; max: number; reversed: boolean }
export const DEFAULT_CAL: RcCal = { min: 1000, trim: 1500, max: 2000, reversed: false };

/** Centred axis: −1 … +1 (trim = 0). NaN in, NaN out. */
export function centred(pwm: number, c: RcCal): number {
  if (!Number.isFinite(pwm)) return NaN;
  const lo = Math.max(1, c.trim - c.min), hi = Math.max(1, c.max - c.trim);
  let v = pwm >= c.trim ? (pwm - c.trim) / hi : (pwm - c.trim) / lo;
  if (c.reversed) v = -v;
  return Math.max(-1, Math.min(1, v));
}

/** Throttle-style axis: 0 … 1 (min = 0). */
export function unipolar(pwm: number, c: RcCal): number {
  if (!Number.isFinite(pwm)) return NaN;
  let v = (pwm - c.min) / Math.max(1, c.max - c.min);
  if (c.reversed) v = 1 - v;
  return Math.max(0, Math.min(1, v));
}

export interface SticksInput {
  /** −1 … 1, right positive. */ roll: number;
  /** −1 … 1, stick forward positive. */ pitch: number;
  /** 0 … 1. */ throttle: number;
  /** −1 … 1, right positive. */ yaw: number;
}
/** One gimbal's dot: x right, y up, both −1 … 1. */
export interface Gimbal { x: number; y: number }

/**
 * Left and right gimbals for a transmitter mode.
 * Mode 2 (most common): left = rudder + throttle, right = aileron + elevator.
 * Mode 1: left = rudder + elevator, right = aileron + throttle.
 */
export function gimbals(s: SticksInput, mode: 1 | 2): { left: Gimbal; right: Gimbal } {
  const thrY = Number.isFinite(s.throttle) ? s.throttle * 2 - 1 : NaN;
  return mode === 1
    ? { left: { x: s.yaw, y: s.pitch }, right: { x: s.roll, y: thrY } }
    : { left: { x: s.yaw, y: thrY }, right: { x: s.roll, y: s.pitch } };
}

/** Channel numbers of the four primary controls from RCMAP_* (AETR by default). */
export function rcMap(get: (name: string) => number | undefined): { roll: number; pitch: number; throttle: number; yaw: number } {
  const ch = (name: string, def: number) => { const v = get(name); return v && v >= 1 && v <= 16 ? Math.round(v) : def; };
  return { roll: ch('RCMAP_ROLL', 1), pitch: ch('RCMAP_PITCH', 2), throttle: ch('RCMAP_THROTTLE', 3), yaw: ch('RCMAP_YAW', 4) };
}

/** Calibration of channel n from RCn_* parameters (sane defaults when missing). */
export function rcCal(get: (name: string) => number | undefined, n: number): RcCal {
  const min = get(`RC${n}_MIN`) ?? DEFAULT_CAL.min, max = get(`RC${n}_MAX`) ?? DEFAULT_CAL.max;
  const trim = get(`RC${n}_TRIM`) ?? (min + max) / 2;
  return { min, trim: Math.min(max, Math.max(min, trim)), max: max > min ? max : min + 1, reversed: (get(`RC${n}_REVERSED`) ?? 0) > 0 };
}
