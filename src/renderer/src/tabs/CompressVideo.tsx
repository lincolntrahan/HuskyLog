import { useState } from 'react';
import { useMedia } from '../data/media';
import { trimRange } from '../pack/packer';
import { cancelCompress, enqueueCompress, estimateCompressed, QUALITIES, setAutoCompress, useCompress, WORTH_IT, type CompressQuality } from '../video/compress';
import { useTimeline } from '../data/timeline';

export const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(n > 1e8 ? 0 : 1)} MB`);

/** "Compress new videos" switch (top of the Videos table). */
export function AutoCompressSwitch() {
  const auto = useCompress((s) => s.auto);
  return (
    <label className="chk auto-compress" title="Every video you add from now on gets a compressed copy beside it, and the workspace uses the copy">
      <input type="checkbox" checked={!!auto} onChange={(e) => setAutoCompress(e.target.checked ? { quality: '1080', trim: false } : null)} aria-label="Compress new videos" />
      Compress new videos
      {auto && (
        <select value={auto.quality} onChange={(e) => setAutoCompress({ ...auto, quality: e.target.value as CompressQuality })} aria-label="Compression quality for new videos">
          {(Object.keys(QUALITIES) as CompressQuality[]).map((k) => <option key={k} value={k}>{QUALITIES[k].label}</option>)}
        </select>
      )}
    </label>
  );
}

/** Row state: progress + Cancel while compressing, the saving when done, or the error. */
export function CompressStatus({ id }: { id: string }) {
  const job = useCompress((s) => s.jobs[id]);
  if (!job) return null;
  if (job.status === 'queued') return <span className="muted">waiting to compress… <button className="link" onClick={() => cancelCompress(id)}>cancel</button></span>;
  if (job.status === 'running') return <span className="compress-run"><progress max={1} value={job.progress} aria-label={`Compressing ${id}`} /> {Math.round(job.progress * 100)} % <button onClick={() => cancelCompress(id)}>Cancel</button></span>;
  if (job.status === 'done') return <span className="ok">Compressed {job.before ? fmtBytes(job.before) : ''} → {job.after ? fmtBytes(job.after) : ''}</span>;
  return <span className="err" title={job.error}>Compression failed: {job.error}</span>;
}

/** "Compress…" for one video: quality, optional trim to the synced flight, estimate. */
export function CompressDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const v = useMedia((s) => s.videos[id]);
  const [quality, setQuality] = useState<CompressQuality>(useCompress.getState().auto?.quality ?? '1080');
  const canTrim = !!trimRange(id);
  const [trim, setTrim] = useState(false);
  const hasSel = !!useTimeline((s) => s.range);
  if (!v?.video) return null;
  const est = estimateCompressed(id, { quality, trim });
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Compress video">
        <h3>Compress {v.name}</h3>
        <p className="muted">Writes <code>{v.path.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')}.huskylog.mp4</code> beside the original and switches this session to it. The original isn't touched; sync markers stay exact.{v.adjust ? ' The rotation, mirror and crop you set are built into the copy.' : ''}</p>
        {(Object.keys(QUALITIES) as CompressQuality[]).map((k) => (
          <label key={k} className="radio"><input type="radio" name="cq" checked={quality === k} onChange={() => setQuality(k)} /> {QUALITIES[k].label}</label>
        ))}
        <label className={`chk${canTrim ? '' : ' muted'}`} title={canTrim ? 'Keep the part that overlaps the flight log (± 5 s); the rest is dropped from the copy' : 'Sync the video to a log first'}>
          <input type="checkbox" checked={trim && canTrim} disabled={!canTrim} onChange={(e) => setTrim(e.target.checked)} aria-label="Trim" /> {hasSel ? 'Only the selection' : 'Only the flight log’s span'} (± 5 s)
        </label>
        <div><b>{fmtBytes(v.size)}</b> now → about <b>{est ? fmtBytes(est) : '?'}</b>{est && est < v.size ? ` (${(v.size / est).toFixed(1)}× smaller)` : ''}</div>
        {est !== null && est > v.size * WORTH_IT && <div className="warn">This video is already small: a copy wouldn't save much{est > v.size ? ' (it could even come out bigger)' : ''}. Try 720p, or trim it.</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => { enqueueCompress(id, { quality, trim: trim && canTrim }); onClose(); }}>Compress</button>
        </div>
      </div>
    </div>
  );
}
