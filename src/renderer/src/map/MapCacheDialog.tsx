import { useCallback, useEffect, useState } from 'react';
import type { MapArea, MapDownloadRequest, MapProgress } from '../../../shared/ipc';
import { padBBox, PROVIDERS, type BBox } from '@core/maps/tiles';
import type { Track } from '../data/track';

/** Shared list of cached map areas (refreshed after downloads/deletes). */
let listeners: (() => void)[] = [];
export function useMapAreas() {
  const [areas, setAreas] = useState<MapArea[]>([]);
  const reload = useCallback(async () => { setAreas(await window.huskylog.mapAreas()); }, []);
  useEffect(() => {
    void reload();
    const l = () => void reload();
    listeners.push(l);
    return () => { listeners = listeners.filter((x) => x !== l); };
  }, [reload]);
  return { areas, reload: async () => { await reload(); listeners.forEach((l) => l()); } };
}

const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);

/**
 * Map Cache Manager (DESIGN §9): download imagery + terrain for an area while
 * online, then everything works offline. Areas are stored as MBTiles files.
 */
export function MapCacheDialog({ track, logName, areas, onClose }: { track: Track | null; logName: string; areas: MapArea[]; onClose: () => void }) {
  const [margin, setMargin] = useState(2000);
  const [name, setName] = useState(logName);
  const [provider, setProvider] = useState<'usgs' | 'custom'>('usgs');
  const [customUrl, setCustomUrl] = useState('');
  const [customAttr, setCustomAttr] = useState('');
  const [maxZoom, setMaxZoom] = useState(PROVIDERS['usgs']!.maxZoom);
  const [terrain, setTerrain] = useState(true);
  const [est, setEst] = useState<{ imagery: number; terrain: number; bytes: number } | null>(null);
  const [progress, setProgress] = useState<MapProgress | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [list, setList] = useState(areas);

  const bbox: BBox | null = track ? padBBox(track.bbox, margin) : null;
  const req = (id?: string): MapDownloadRequest | null => bbox && {
    id, name: name.trim() || 'Area', bbox, provider, customUrl, customAttribution: customAttr,
    imageryMaxZoom: maxZoom, terrain, terrainMaxZoom: 15,
  };

  useEffect(() => {
    const r = req();
    if (!r) { setEst(null); return; }
    window.huskylog.mapEstimate(r).then(setEst, (e) => setError(String(e)));
  }, [margin, provider, maxZoom, terrain, customUrl, track]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => window.huskylog.onMapProgress(setProgress), []);
  const refresh = async () => setList(await window.huskylog.mapAreas());

  const start = async (resume?: MapArea) => {
    setError('');
    const r: MapDownloadRequest | null = resume
      ? { id: resume.id, name: resume.name, bbox: resume.bbox, provider: (resume.imageryProvider === 'custom' ? 'custom' : 'usgs'), imageryMaxZoom: resume.imageryMaxZoom, terrain: resume.terrain, terrainMaxZoom: resume.terrainMaxZoom, customUrl, customAttribution: customAttr }
      : req();
    if (!r) return;
    setBusyId(r.id ?? 'new');
    setProgress({ id: r.id ?? 'new', done: 0, total: (est?.imagery ?? 0) + (est?.terrain ?? 0), failed: 0, bytes: 0, finished: false, cancelled: false });
    try {
      const area = await window.huskylog.mapDownload(r);
      if (area.failed) setError(`${area.failed} tile(s) failed to download${progress?.error ? ` (${progress.error})` : ''}. Check the connection and press Resume.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && !busyId && onClose()}>
      <div className="modal cache-modal" role="dialog" aria-label="Map cache">
        <h3>Offline map cache</h3>
        <p className="muted">Download satellite imagery and terrain while online; the 3D map then works with no internet. This is the only time HuskyLog uses the network.</p>

        <h4>New area</h4>
        {!track ? <p className="muted">Load a log first; the area is placed around its flight track.</p> : (
          <>
            <div className="form-grid">
              <label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} aria-label="Area name" />
              <label>Area</label>
              <span>Flight track + <input type="number" min={0} max={20000} step={500} value={margin} onChange={(e) => setMargin(Number(e.target.value))} style={{ width: 80 }} aria-label="Margin" /> m margin
                {bbox && <span className="muted"> ({((bbox[2] - bbox[0]) * 111.32 * Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180)).toFixed(1)} × {((bbox[3] - bbox[1]) * 111.32).toFixed(1)} km)</span>}
              </span>
              <label>Imagery</label>
              <span>
                <select value={provider} onChange={(e) => { const p = e.target.value as 'usgs' | 'custom'; setProvider(p); if (p === 'usgs') setMaxZoom(PROVIDERS['usgs']!.maxZoom); }} aria-label="Imagery source">
                  <option value="usgs">{PROVIDERS['usgs']!.name}</option>
                  <option value="custom">Custom XYZ URL…</option>
                </select>
                {' '}max zoom <input type="number" min={10} max={provider === 'usgs' ? 16 : 22} value={maxZoom} onChange={(e) => setMaxZoom(Number(e.target.value))} style={{ width: 56 }} aria-label="Max zoom" />
              </span>
              {provider === 'custom' && (
                <>
                  <label>URL</label><input value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://example.com/tiles/{z}/{x}/{y}.jpg" aria-label="Custom URL" />
                  <label>Attribution</label><input value={customAttr} onChange={(e) => setCustomAttr(e.target.value)} placeholder="© provider" aria-label="Attribution" />
                  <span /><span className="muted small">Only use a provider whose terms allow offline caching.</span>
                </>
              )}
              <label>Terrain</label>
              <label className="chk"><input type="checkbox" checked={terrain} onChange={(e) => setTerrain(e.target.checked)} /> 3D terrain (AWS open terrain tiles, to zoom 15)</label>
            </div>
            <div className="modal-actions">
              <span className="muted">{est ? `${est.imagery + est.terrain} tiles, about ${mb(est.bytes)}` : ''}</span>
              <button className="primary" disabled={!!busyId || !est || (provider === 'custom' && !customUrl)} onClick={() => void start()}>Download</button>
            </div>
          </>
        )}

        {progress && busyId && (
          <div className="dl">
            <progress max={progress.total || 1} value={progress.done} />
            <span className="mono">{progress.done}/{progress.total} · {mb(progress.bytes)}{progress.failed ? ` · ${progress.failed} failed` : ''}</span>
            <button onClick={() => void window.huskylog.mapCancel(progress.id)}>Cancel</button>
            <span className="muted">{pct}%</span>
          </div>
        )}
        {error && <div className="err">{error}</div>}

        <h4>Cached areas</h4>
        {list.length === 0 && <p className="muted">None yet.</p>}
        {list.length > 0 && (
          <table className="grid">
            <thead><tr><th>Name</th><th>Size</th><th>Zoom</th><th>Terrain</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td><td>{mb(a.bytes)}</td><td>0–{a.imageryMaxZoom}</td><td>{a.terrain ? `0–${a.terrainMaxZoom}` : '—'}</td>
                  <td>{a.complete ? <span className="ok">Complete</span> : <span className="err">Incomplete{a.failed ? ` (${a.failed} failed)` : ''}</span>}</td>
                  <td>
                    {!a.complete && <button disabled={!!busyId} onClick={() => void start(a)}>Resume</button>}
                    <button disabled={!!busyId} onClick={async () => { await window.huskylog.mapDelete(a.id); await refresh(); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="modal-actions"><button onClick={onClose} disabled={!!busyId}>Close</button></div>
      </div>
    </div>
  );
}
