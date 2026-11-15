import { create } from 'zustand';
import type { DecodedSeries } from '@core/dataflash/types';
import type { ChannelInfo, LogSummary } from '@core/dataflash/summary';
import type { Series } from '@core/series/series';
import type { OpenedFile } from '../../../shared/ipc';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** A reference to one plottable channel of one log. */
export interface ChannelRef { stream: string; id: string }
export const refKey = (r: ChannelRef) => `${r.stream}|${r.id}`;

export interface LogStream {
  id: string;
  name: string;
  path: string;
  status: 'loading' | 'ready' | 'error';
  progress: number;
  phase: 'reading' | 'indexing';
  summary?: LogSummary;
  indexMs?: number;
  error?: string;
}

interface LogsState {
  logs: Record<string, LogStream>;
  order: string[];
}

export const useLogs = create<LogsState>(() => ({ logs: {}, order: [] }));
const patch = (id: string, p: Partial<LogStream>) =>
  useLogs.setState((s) => ({ logs: { ...s.logs, [id]: { ...s.logs[id]!, ...p } } }));

// ---- worker RPC ----
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: (r: WorkerResponse & { op: 'progress' }) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./parser.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const r = e.data;
    const p = pending.get(r.id);
    if (!p) return;
    if (r.op === 'progress') { p.onProgress?.(r); return; }
    pending.delete(r.id);
    if (r.op === 'error') p.reject(new Error(r.message)); else p.resolve(r);
  };
  return worker;
}

type DistOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
function call(req: DistOmit<WorkerRequest, 'id'>, onProgress?: (r: WorkerResponse & { op: 'progress' }) => void): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ ...req, id } as WorkerRequest);
  });
}

// ---- public API ----
export const isLogFile = (f: OpenedFile) => /\.bin$/i.test(f.name);

export async function openLog(file: OpenedFile): Promise<void> {
  const existing = Object.values(useLogs.getState().logs).find((l) => l.path === file.path);
  if (existing) return;
  const id = `log${nextId++}`;
  useLogs.setState((s) => ({
    logs: { ...s.logs, [id]: { id, name: file.name.replace(/\.bin$/i, ''), path: file.path, status: 'loading', progress: 0, phase: 'reading' } },
    order: [...s.order, id],
  }));
  try {
    const r = await call({ op: 'open', streamId: id, url: file.url }, (p) => patch(id, { progress: p.fraction, phase: p.phase }));
    if (r.op !== 'opened') throw new Error('unexpected reply');
    patch(id, { status: 'ready', progress: 1, summary: r.summary, indexMs: r.indexMs });
  } catch (e) {
    patch(id, { status: 'error', error: String(e) });
  }
}

const typeCache = new Map<string, Promise<DecodedSeries[]>>();

function decoded(stream: string, type: string): Promise<DecodedSeries[]> {
  const key = `${stream}|${type}`;
  let p = typeCache.get(key);
  if (!p) {
    p = call({ op: 'decode', streamId: stream, type }).then((r) => (r.op === 'decoded' ? r.series : []));
    typeCache.set(key, p);
  }
  return p;
}

/** Parses "IMU[1].AccZ" / "ATT.Roll". A bare name means instance 0 (DESIGN §4.1). */
export function parseChannelId(id: string): { type: string; instance: number | null; field: string } | null {
  const m = /^([A-Za-z0-9_]+)(?:\[(\d+)\])?\.([A-Za-z0-9_]+)$/.exec(id);
  return m ? { type: m[1]!, instance: m[2] !== undefined ? Number(m[2]) : null, field: m[3]! } : null;
}

export interface LoadedChannel extends Series { unit: string; info?: ChannelInfo }

export async function loadChannel(ref: ChannelRef): Promise<LoadedChannel | null> {
  const p = parseChannelId(ref.id);
  if (!p) return null;
  const all = await decoded(ref.stream, p.type);
  const s = all.find((x) => x.instance === null || x.instance === (p.instance ?? 0)) ?? null;
  const v = s?.fields[p.field];
  if (!s || !v) return null;
  const info = useLogs.getState().logs[ref.stream]?.summary?.channels.find((c) => c.id === ref.id);
  return { t: s.time, v, unit: s.units[p.field] ?? '', info };
}

export function channelExists(ref: ChannelRef): boolean {
  const sum = useLogs.getState().logs[ref.stream]?.summary;
  if (!sum) return false;
  if (sum.channels.some((c) => c.id === ref.id)) return true;
  const p = parseChannelId(ref.id);
  return !!p && p.instance === null && sum.channels.some((c) => c.id === `${p.type}[0].${p.field}`);
}

export async function embeddedFile(stream: string, name: string): Promise<Uint8Array> {
  const r = await call({ op: 'file', streamId: stream, name });
  if (r.op !== 'file') throw new Error('unexpected reply');
  return r.data;
}

/** The log the graphs default to (first loaded). */
export function primaryLog(): LogStream | undefined {
  const s = useLogs.getState();
  return s.order.map((id) => s.logs[id]!).find((l) => l.status === 'ready');
}
