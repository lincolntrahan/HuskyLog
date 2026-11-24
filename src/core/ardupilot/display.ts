/**
 * Display conversions for logged fields (team preference), applied wherever a
 * channel is read (graphs, readouts, expressions, Sync lanes) and to its unit.
 *
 * AETR (ArduPlane's mixer inputs): aileron, elevator, rudder and steering are
 * logged as ±4500; shown as servo PWM, 1000–2000 µs (v / 9 + 1500). Throttle
 * is logged as 0–100 %; shown on the same 1000–2000 µs scale.
 */
export interface FieldDisplay { unit: string; f: (v: number) => number }

const CENTRED = new Set(['Ail', 'Elev', 'Rudd', 'Steer']);

export function fieldDisplay(type: string, field: string): FieldDisplay | null {
  if (type === 'AETR') {
    if (CENTRED.has(field)) return { unit: 'us', f: (v) => v / 9 + 1500 };
    if (field === 'Thr') return { unit: 'us', f: (v) => 1000 + v * 10 };
  }
  return null;
}
