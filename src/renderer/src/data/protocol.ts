import type { DecodedSeries } from '@core/dataflash/types';
import type { LogSummary } from '@core/dataflash/summary';

/** Messages between the renderer and the parser worker. */
export type WorkerRequest =
  | { id: number; op: 'open'; streamId: string; url: string }
  | { id: number; op: 'decode'; streamId: string; type: string }
  | { id: number; op: 'file'; streamId: string; name: string }
  | { id: number; op: 'close'; streamId: string };

export type WorkerResponse =
  | { id: number; op: 'progress'; fraction: number; phase: 'reading' | 'indexing' }
  | { id: number; op: 'opened'; summary: LogSummary; indexMs: number; bytes: number }
  | { id: number; op: 'decoded'; series: DecodedSeries[] }
  | { id: number; op: 'file'; data: Uint8Array }
  | { id: number; op: 'closed' }
  | { id: number; op: 'error'; message: string };
