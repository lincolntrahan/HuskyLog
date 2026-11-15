/** ArduPilot lookup tables (mode names, event ids, servo functions). */

export type Vehicle = 'plane' | 'copter' | 'rover' | 'sub' | 'tracker' | 'unknown';

export function vehicleFromFirmware(s: string): Vehicle {
  if (/ArduPlane/i.test(s)) return 'plane';
  if (/ArduCopter|ArduHeli/i.test(s)) return 'copter';
  if (/Rover|ArduRover/i.test(s)) return 'rover';
  if (/ArduSub/i.test(s)) return 'sub';
  if (/Tracker/i.test(s)) return 'tracker';
  return 'unknown';
}

const PLANE: Record<number, string> = {
  0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO', 5: 'FBWA', 6: 'FBWB', 7: 'CRUISE',
  8: 'AUTOTUNE', 10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED',
  17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO',
  24: 'THERMAL', 25: 'LOITER_ALT_QLAND', 26: 'AUTOLAND',
};
const COPTER: Record<number, string> = {
  0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE',
  9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW',
  19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG',
  25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL', 28: 'TURTLE',
};
const ROVER: Record<number, string> = {
  0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 6: 'FOLLOW', 7: 'SIMPLE', 8: 'DOCK',
  9: 'CIRCLE', 10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED',
};
const SUB: Record<number, string> = {
  0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 7: 'CIRCLE', 9: 'SURFACE', 16: 'POSHOLD', 19: 'MANUAL',
};

export function modeName(vehicle: Vehicle, num: number): string {
  const t = vehicle === 'plane' ? PLANE : vehicle === 'copter' ? COPTER : vehicle === 'rover' ? ROVER : vehicle === 'sub' ? SUB : {};
  return t[num] ?? `MODE ${num}`;
}

export const EVENT_NAMES: Record<number, string> = {
  10: 'ARMED', 11: 'DISARMED', 15: 'AUTO_ARMED', 17: 'LAND_COMPLETE_MAYBE', 18: 'LAND_COMPLETE',
  19: 'LOST_GPS', 21: 'FLIP_START', 22: 'FLIP_END', 25: 'SET_HOME', 26: 'SET_SIMPLE_ON', 27: 'SET_SIMPLE_OFF',
  28: 'NOT_LANDED', 29: 'SET_SUPERSIMPLE_ON', 30: 'AUTOTUNE_INITIALISED', 31: 'AUTOTUNE_OFF',
  32: 'AUTOTUNE_RESTART', 33: 'AUTOTUNE_SUCCESS', 34: 'AUTOTUNE_FAILED', 35: 'AUTOTUNE_REACHED_LIMIT',
  36: 'AUTOTUNE_PILOT_TESTING', 37: 'AUTOTUNE_SAVEDGAINS', 38: 'SAVE_TRIM', 39: 'SAVEWP_ADD_WP',
  41: 'FENCE_ENABLE', 42: 'FENCE_DISABLE', 43: 'ACRO_TRAINER_OFF', 44: 'ACRO_TRAINER_LEVELING',
  45: 'ACRO_TRAINER_LIMITED', 46: 'GRIPPER_GRAB', 47: 'GRIPPER_RELEASE', 49: 'PARACHUTE_DISABLED',
  50: 'PARACHUTE_ENABLED', 51: 'PARACHUTE_RELEASED', 52: 'LANDING_GEAR_DEPLOYED', 53: 'LANDING_GEAR_RETRACTED',
  54: 'MOTORS_EMERGENCY_STOPPED', 55: 'MOTORS_EMERGENCY_STOP_CLEARED', 56: 'MOTORS_INTERLOCK_DISABLED',
  57: 'MOTORS_INTERLOCK_ENABLED', 58: 'ROTOR_RUNUP_COMPLETE', 59: 'ROTOR_SPEED_BELOW_CRITICAL',
  60: 'EKF_ALT_RESET', 61: 'LAND_CANCELLED_BY_PILOT', 62: 'EKF_YAW_RESET', 63: 'AVOIDANCE_ADSB_ENABLE',
  64: 'AVOIDANCE_ADSB_DISABLE', 65: 'AVOIDANCE_PROXIMITY_ENABLE', 66: 'AVOIDANCE_PROXIMITY_DISABLE',
  67: 'GPS_PRIMARY_CHANGED', 71: 'ZIGZAG_STORE_A', 72: 'ZIGZAG_STORE_B', 73: 'LAND_REPO_ACTIVE',
  74: 'STANDBY_ENABLE', 75: 'STANDBY_DISABLE', 80: 'FENCE_FLOOR_ENABLE', 81: 'FENCE_FLOOR_DISABLE',
  85: 'EK3_SRC_PRIMARY', 86: 'EK3_SRC_SECONDARY', 87: 'EK3_SRC_TERTIARY', 90: 'AIRSPEED_PRIMARY_CHANGED',
  163: 'SURFACED', 164: 'NOT_SURFACED', 165: 'BOTTOMED', 166: 'NOT_BOTTOMED',
};

/** SERVOn_FUNCTION values → short label (common subset; unknown → "fn N"). */
const SERVO_FN: Record<number, string> = {
  1: 'RCPassThru', 2: 'Flap', 3: 'FlapAuto', 4: 'Aileron', 6: 'MountPan', 7: 'MountTilt', 8: 'MountRoll',
  10: 'CameraTrigger', 16: 'DiffSpoilerL1', 17: 'DiffSpoilerR1', 19: 'Elevator', 21: 'Rudder',
  22: 'SprayerPump', 24: 'FlaperonL', 25: 'FlaperonR', 26: 'GroundSteering', 27: 'Parachute', 28: 'Gripper',
  29: 'LandingGear', 30: 'EngineRunEnable', 33: 'Motor1', 34: 'Motor2', 35: 'Motor3', 36: 'Motor4',
  37: 'Motor5', 38: 'Motor6', 39: 'Motor7', 40: 'Motor8', 41: 'TiltMotorsFront', 45: 'TiltMotorRear',
  46: 'TiltMotorRearLeft', 47: 'TiltMotorRearRight', 67: 'Ignition', 69: 'Starter', 70: 'Throttle',
  73: 'ThrottleLeft', 74: 'ThrottleRight', 75: 'TiltMotorFrontLeft', 76: 'TiltMotorFrontRight',
  77: 'ElevonLeft', 78: 'ElevonRight', 79: 'VTailLeft', 80: 'VTailRight', 81: 'BoostThrottle',
  82: 'Motor9', 83: 'Motor10', 84: 'Motor11', 85: 'Motor12', 86: 'DiffSpoilerL2', 87: 'DiffSpoilerR2',
  88: 'Winch', 94: 'Script1', 95: 'Script2', 96: 'Script3', 97: 'Script4',
};

export const THROTTLE_FUNCTIONS = new Set([70, 73, 74, 81]);

export function servoFunctionName(fn: number): string | null {
  if (fn === 0) return null; // disabled
  return SERVO_FN[fn] ?? `fn ${fn}`;
}

/** Parameters ArduPilot updates by itself; hidden from "changes" by default. */
export const HOUSEKEEPING_PARAMS = /^(STAT_|BARO\d*_GND_PRESS|BARO\d*_GND_TEMP|ARSPD\d*_OFFSET|INS_GYR\d*OFFS|COMPASS_DEC$|SYSID_SW_MREV|FORMAT_VERSION)/;
