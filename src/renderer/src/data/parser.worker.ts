/// <reference lib="webworker" />
import { indexLog } from '@core/dataflash/indexer';
import { decodeType, extractFiles } from '@core/dataflash/decoder';
import { summarize } from '@core/dataflash/summary';
import type { LogIndex } from '@core/dataflash/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Parser worker: holds each log's bytes and index, decodes message types on
 * demand and transfers typed arrays to the UI thread (DESIGN §4.2).
 */
const logs = new Map<string, { bytes: Uint8Array; index: LogIndex }>();
const post = (m: WorkerResponse, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function readWithProgress(id: number, url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Cannot read file (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let o = 0, next = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, o);
    o += value.length;
    if (total && o >= next) { post({ id, op: 'progress', fraction: o / total, phase: 'reading' }); next = o + total / 20; }
  }
  return o === total ? out : out.subarray(0, o);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    switch (req.op) {
      case 'open': {
        const bytes = await readWithProgress(req.id, req.url);
        const t0 = performance.now();
        const index = indexLog(bytes, (f) => post({ id: req.id, op: 'progress', fraction: f, phase: 'indexing' }));
        const summary = summarize(bytes, index);
        logs.set(req.streamId, { bytes, index });
        post({ id: req.id, op: 'opened', summary, indexMs: performance.now() - t0, bytes: bytes.length });
        break;
      }
      case 'decode': {
        const log = logs.get(req.streamId);
        if (!log) throw new Error('Log not open');
        const series = decodeType(log.bytes, log.index, req.type);
        const transfer: Transferable[] = [];
        for (const s of series) {
          transfer.push(s.time.buffer);
          for (const f of Object.values(s.fields)) transfer.push(f.buffer);
        }
        post({ id: req.id, op: 'decoded', series }, transfer);
        break;
      }
      case 'file': {
        const log = logs.get(req.streamId);
        const data = log && extractFiles(log.bytes, log.index).get(req.name);
        if (!data) throw new Error(`No embedded file ${req.name}`);
        post({ id: req.id, op: 'file', data }, [data.buffer]);
        break;
      }
      case 'close':
        logs.delete(req.streamId);
        post({ id: req.id, op: 'closed' });
        break;
    }
  } catch (err) {
    post({ id: req.id, op: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
