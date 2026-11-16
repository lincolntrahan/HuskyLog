/**
 * Ready-made sources offered at the top of the source menu (like UAV Log
 * Viewer's preset folders). Channel picks are shown only when the log has
 * them; expressions only when every channel they use exists.
 */
export interface QuickPick { folder: string; name: string; source: string; unit?: string; format?: string; channels: string[] }

export const G_EXPR = 'hypot(IMU.AccX, IMU.AccY, IMU.AccZ) / g';

export const QUICK_PICKS: QuickPick[] = [
  { folder: 'Expressions', name: 'G (total acceleration)', source: G_EXPR, unit: 'g', format: '%.2f', channels: ['IMU.AccX', 'IMU.AccY', 'IMU.AccZ'] },
  { folder: 'Expressions', name: 'Electrical power', source: 'BAT.Volt * BAT.Curr', unit: 'W', format: '%.0f', channels: ['BAT.Volt', 'BAT.Curr'] },
  { folder: 'Expressions', name: 'Energy used', source: 'integrate(BAT.Curr) / 3.6', unit: 'mAh', format: '%.0f', channels: ['BAT.Curr'] },
  { folder: 'Expressions', name: 'Ground speed', source: 'GPS.Spd * 3.6', unit: 'km/h', format: '%.1f', channels: ['GPS.Spd'] },
  { folder: 'Flight', name: 'Altitude above home', source: 'POS.RelHomeAlt', unit: 'm', format: '%.1f', channels: ['POS.RelHomeAlt'] },
  { folder: 'Flight', name: 'Airspeed', source: 'ARSP.Airspeed', unit: 'm/s', format: '%.1f', channels: ['ARSP.Airspeed'] },
  { folder: 'Flight', name: 'Ground speed (m/s)', source: 'GPS.Spd', unit: 'm/s', format: '%.1f', channels: ['GPS.Spd'] },
  { folder: 'Flight', name: 'Throttle out', source: 'CTUN.ThO', unit: '%', format: '%.0f', channels: ['CTUN.ThO'] },
  { folder: 'Flight', name: 'Battery voltage', source: 'BAT.Volt', unit: 'V', format: '%.2f', channels: ['BAT.Volt'] },
  { folder: 'Flight', name: 'Battery current', source: 'BAT.Curr', unit: 'A', format: '%.1f', channels: ['BAT.Curr'] },
  { folder: 'Attitude', name: 'Roll', source: 'ATT.Roll', unit: '°', format: '%.1f', channels: ['ATT.Roll'] },
  { folder: 'Attitude', name: 'Pitch', source: 'ATT.Pitch', unit: '°', format: '%.1f', channels: ['ATT.Pitch'] },
  { folder: 'Attitude', name: 'Heading (yaw)', source: 'ATT.Yaw', unit: '°', format: '%.0f', channels: ['ATT.Yaw'] },
];

/** Special readout sources (not channels). */
export const SPECIALS: { source: string; name: string }[] = [
  { source: '@mode', name: 'Flight mode' },
  { source: '@armed', name: 'Armed / disarmed' },
  { source: '@time', name: 'Time (master)' },
  { source: '@local', name: 'Time (this log)' },
];

/** Log plumbing that is never worth plotting (as UAV Log Viewer hides it). */
export const HIDDEN_TYPES = new Set(['FMT', 'FMTU', 'UNIT', 'MULT', 'PARM', 'MSG', 'FILE', 'STRT', 'VER']);
