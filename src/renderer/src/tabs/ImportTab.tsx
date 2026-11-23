import { useApp } from '../store';
import { useLogs } from '../data/logs';
import { useMedia } from '../data/media';
import { fmtTime } from '../data/timeline';
import { MissingFiles } from '../workspace/FileMenu';
import { RemoveStreamButton } from './RemoveStream';
import { AdjustVideoDialog } from './AdjustVideo';
import { AutoCompressSwitch, CompressDialog, CompressStatus } from './CompressVideo';
import { useCompress } from '../video/compress';
import { useState } from 'react';

const fmtSize = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`);

export function ImportTab() {
  const { files, addFiles } = useApp();
  const { logs, order } = useLogs();
  const media = useMedia();
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [compressing, setCompressing] = useState<string | null>(null);
  const jobs = useCompress((s) => s.jobs);
  const others = files.filter((f) => !/\.(bin|mp4|mov|m4v)$/i.test(f.name));
  return (
    <div className="page">
      <h2>Import</h2>
      <p className="muted">
        Add DataFlash logs (.bin), MAVLink telemetry (.tlog), CSV sensor logs and ground videos.
        Logs are parsed in the background; videos are read in place (nothing is copied). .tlog and CSV importers arrive in Phase 8.
      </p>
      <button className="primary" onClick={async () => addFiles(await window.huskylog.openFiles())}>Add files…</button>
      <MissingFiles />

      {order.length > 0 && (
        <>
          <h3>Logs</h3>
          <table className="files">
            <thead><tr><th>Log</th><th>Vehicle</th><th>Duration</th><th>Channels</th><th>Status</th><th /></tr></thead>
            <tbody>
              {order.map((id) => {
                const l = logs[id]!;
                const s = l.summary;
                return (
                  <tr key={id}>
                    <td title={l.path}>{l.name}</td>
                    <td>{s ? `${s.firmware || s.vehicle}${s.board ? ` · ${s.board}` : ''}` : ''}</td>
                    <td>{s ? fmtTime(s.timeRange[1] - s.timeRange[0]) : ''}</td>
                    <td>{s ? s.channels.length : ''}</td>
                    <td>
                      {l.status === 'loading' && <progress max={1} value={l.progress} title={l.phase} />}
                      {l.status === 'ready' && (
                        <span className="ok" title={s ? `index ${l.indexMs?.toFixed(0)} ms · ${s.diagnostics.formats} formats · ${s.diagnostics.types} message types` : ''}>
                          Ready{s && s.diagnostics.truncatedTail ? ' · last message incomplete (normal after power-off)' : ''}
                          {s && s.diagnostics.skippedBytes ? ` · skipped ${s.diagnostics.skippedBytes} corrupt bytes` : ''}
                        </span>
                      )}
                      {l.status === 'error' && <span className="err">{l.error}</span>}
                    </td>
                    <td>{l.status !== 'loading' && <RemoveStreamButton id={id} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {media.order.length > 0 && (
        <>
          <div className="h3-row"><h3>Videos</h3><AutoCompressSwitch /></div>
          <table className="files">
            <thead><tr><th>Video</th><th>Format</th><th>Duration</th><th>Audio</th><th>Status</th><th /></tr></thead>
            <tbody>
              {media.order.map((id) => {
                const v = media.videos[id]!;
                const i = v.video;
                return (
                  <tr key={id}>
                    <td title={v.path}>{v.name}</td>
                    <td>{i ? `${i.codec} · ${i.width}×${i.height}${i.rotation ? ` · rotated ${i.rotation}°` : ''}${v.adjust ? ' · adjusted' : ''}${v.original ? ` · compressed copy of ${v.original.name}` : ''} · ${i.fpsAvg.toFixed(2)} fps${i.vfr ? ' (variable)' : ''}` : ''}</td>
                    <td>{i ? fmtTime(i.durationS) : ''}</td>
                    <td>{v.audio ? `${v.audio.codec} ${v.audio.sampleRate / 1000} kHz` : v.status === 'ready' ? 'none' : ''}</td>
                    <td>
                      {v.status === 'loading' && <span className="muted">reading…</span>}
                      {jobs[id] ? <CompressStatus id={id} /> : v.status === 'ready' && (i?.supported ? <span className="ok">Ready · sync it on the Sync tab</span> : <span className="err">This computer can't decode {i?.codec}</span>)}
                      {v.status === 'error' && <span className="err">{v.error}</span>}
                    </td>
                    <td className="row-actions">
                      {v.status === 'ready' && i?.supported && <button onClick={() => setAdjusting(id)} title="Rotate, mirror, straighten or crop this video" aria-label={`Adjust ${id}`}>Adjust…</button>}
                      {v.status === 'ready' && i?.supported && !(jobs[id]?.status === 'running' || jobs[id]?.status === 'queued') && <button onClick={() => setCompressing(id)} title="Make a smaller copy for sharing workspaces" aria-label={`Compress ${id}`}>Compress…</button>}
                      {v.status !== 'loading' && <RemoveStreamButton id={id} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {adjusting && <AdjustVideoDialog id={adjusting} onClose={() => setAdjusting(null)} />}
      {compressing && <CompressDialog id={compressing} onClose={() => setCompressing(null)} />}

      {others.length > 0 && (
        <>
          <h3>Other files</h3>
          <table className="files">
            <thead><tr><th>Name</th><th>Size</th><th>Path</th></tr></thead>
            <tbody>
              {others.map((f) => (
                <tr key={f.path}><td>{f.name}</td><td>{fmtSize(f.size)}</td><td className="muted">{f.path}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
