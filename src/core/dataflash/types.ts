export interface FormatDef {
  type: number;
  name: string;
  /** Full message length including the 3-byte header. */
  length: number;
  format: string;
  columns: string[];
  /** Byte offset of each column within the body. */
  offsets: number[];
  /** FMTU unit ids / multiplier ids, one char per column (if logged). */
  unitIds?: string;
  multIds?: string;
  /** Column index of the instance field (FMTU unit '#'), if any. */
  instanceCol?: number;
  /** Column index of TimeUS / TimeMS, if any. */
  timeCol?: number;
  timeScale?: number; // seconds per raw time unit
}

export interface TypeStats {
  count: number;
  firstTime: number; // seconds, NaN if the type has no time column
  lastTime: number;
  /** Instance value → message count (only for instanced types). */
  instances?: Map<number, number>;
}

export interface LogIndex {
  size: number;
  formats: Map<number, FormatDef>;
  byName: Map<string, FormatDef>;
  /** Message start offsets per type id, in file order. */
  offsets: Map<number, Uint32Array>;
  stats: Map<number, TypeStats>;
  unitLabels: Map<string, string>;
  multValues: Map<string, number>;
  /** Bytes skipped while resyncing after corrupt data. */
  skippedBytes: number;
  /** Bytes of a half-written message at the end of the file (power cut). */
  truncatedTail: number;
  /** Count of adjacent messages (any types) whose times go backwards. Normal:
   *  subsystems write with small delays, so never assume global time order. */
  outOfOrder: number;
  timeRange: [number, number];
}

/** One decoded (type, instance) series: columnar, time in seconds. */
export interface DecodedSeries {
  type: string;
  instance: number | null;
  time: Float64Array;
  fields: Record<string, Float64Array>;
  units: Record<string, string>;
}

export type Row = Record<string, number | string> & { _t: number };
