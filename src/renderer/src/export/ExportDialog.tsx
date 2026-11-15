import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useMedia } from '../data/media';
import { streamSolution } from '../data/sync';
import { fmtTime, timeDomain, useTimeline } from '../data/timeline';
import { sessionName, useSession } from '../data/workspace';
import { computeLayout, GIF_MAX_SECONDS, GIF_MAX_WIDTH, renderComposite, runExport, type ExportOptions, type ExportProgress, type LayoutKind } from './exporter';
import { exportSources, isShown, onExportSourcesChange } from './registry';

/** Export dialog (DESIGN §10): windows, layout, range, format, size, fps, audio. */
export const useExportUi = create<{ open: boolean }>(() => ({ open: false }));

const RES: [string, number, number][] = [['720p', 1280, 720], ['1080p', 1920, 1080], ['4K', 3840, 2160]];
const GIF_W = [480, 640, 800];
const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function parseTime(s: string): number | null {
  const m = /^\s*(-)?(?:(\d+):)?(\d+(?:\.\d*)?)\s*$/.exec(s);
  if (!m) return null;
  const v = (m[2] ? Number(m[2]) * 60 : 0) + Number(m[3]);
  return m[1] ? -v : v;
}

export function ExportDialog() {
  const open = useExportUi((s) => s.open);
  const [, bump] = useState(0);
  useEffect(() => onExportSourcesChange(() => bump((n) => n + 1)), []);
  const sources = exportSources();
  const shown = sources.filter((s) => isShown(s.content()));
  const media = useMedia();
  const [sel, setSel] = useState<string[]>([]);
  const [layout, setLayout] = useState<LayoutKind>('screen');
  const [format, setFormat] = useState<'mp4' | 'gif'>('mp4');
  const [res, setRes] = useState('1080p');
  const [custom, setCustom] = useState({ w: 1920, h: 1080 });
  const [gifW, setGifW] = useState(640);
  const [fps, setFps] = useState(30);
  const [gifFps, setGifFps] = useState(15);
  const [audio, setAudio] = useState<string>('');
  const [range, setRange] = useState<[string, string]>(['', '']);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<{ path: string; bytes: number; frames: number; encoder?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });
  const preview = useRef<HTMLCanvasElement>(null);

  // Defaults each time the dialog opens: visible windows, the selection (or 10 s from the playhead).
  useEffect(() => {
    if (!open) return;
    setSel(exportSources().filter((s) => isShown(s.content())).map((s) => s.id));
    const tl = useTimeline.getState();
    const [, b] = timeDomain();
    const r = tl.range ?? [tl.t, Math.min(b, tl.t + 10)];
    setRange([fmtTime(r[0]), fmtTime(r[1])]);
    const withAudio = useMedia.getState().order.find((id) => useMedia.getState().videos[id]?.audio && streamSolution(id)?.status !== 'unsynced');
    setAudio(withAudio ?? '');
    setResult(null); setErr(null); setProgress(null);
  }, [open]);

  const t0 = parseTime(range[0]), t1 = parseTime(range[1]);
  const dur = t0 !== null && t1 !== null ? t1 - t0 : NaN;
  const gifOk = dur > 0 && dur <= GIF_MAX_SECONDS + 1e-6;
  const effFormat = format === 'gif' && !gifOk ? 'mp4' : format;
  const preset = RES.find((r) => r[0] === res);
  const W = effFormat === 'gif' ? Math.min(GIF_MAX_WIDTH, gifW) : preset ? preset[1] : custom.w;
  const H = effFormat === 'gif' ? Math.round((W * 9) / 16 / 2) * 2 : preset ? preset[2] : custom.h;
  const rate = effFormat === 'gif' ? gifFps : fps;
  const opts: ExportOptions | null = t0 !== null && t1 !== null && dur > 0 && sel.length
    // Windows in selection order: the first one is the main picture in picture-in-picture.
    ? { windows: sel.filter((id) => sources.some((s) => s.id === id)), layout, t0, t1, width: W, height: H, fps: rate, format: effFormat, audio: effFormat === 'mp4' && audio ? audio : null }
    : null;
  (window.__hl as Record<string, unknown>)['export'] = {
    open: () => useExportUi.setState({ open: true }),
    set: (p: { windows?: string[]; layout?: LayoutKind; format?: 'mp4' | 'gif'; res?: string; fps?: number; gifFps?: number; gifW?: number; range?: [number, number]; audio?: string }) => {
      if (p.windows) setSel(p.windows); if (p.layout) setLayout(p.layout); if (p.format) setFormat(p.format); if (p.res) setRes(p.res);
      if (p.fps) setFps(p.fps); if (p.gifFps) setGifFps(p.gifFps); if (p.gifW) setGifW(p.gifW); if (p.audio !== undefined) setAudio(p.audio);
      if (p.range) setRange([fmtTime(p.range[0]), fmtTime(p.range[1])]);
    },
    getOptions: () => opts, getResult: () => result, getError: () => err, getProgress: () => progress,
    layout: () => (opts ? computeLayout(opts, opts.width, opts.height) : []),
  };

  // Live preview at the playhead.
  const key = JSON.stringify(opts ? { ...opts, t0: 0, t1: 0 } : null);
  useEffect(() => {
    if (!open || !opts || progress) return;
    let stale = false;
    const id = window.setTimeout(async () => {
      const c = preview.current;
      if (!c) return;
      const pw = 360, ph = Math.round((pw * opts.height) / opts.width);
      const off = new OffscreenCanvas(opts.width, opts.height);
      await renderComposite(off.getContext('2d')!, computeLayout(opts, opts.width, opts.height), useTimeline.getState().t, opts.width, opts.height);
      if (stale) return;
      c.width = pw; c.height = ph;
      c.getContext('2d')!.drawImage(off, 0, 0, pw, ph);
    }, 150);
    return () => { stale = true; window.clearTimeout(id); };
  }, [open, key, progress]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const close = () => { if (!progress) useExportUi.setState({ open: false }); };
  const start = async () => {
    if (!opts) return;
    const base = sessionName(useSession.getState()).replace(/\.(hlws|hlpack)$/i, '').replace(/^Untitled$/, 'export');
    const out = await window.huskylog.exportPickPath(`${base} ${fmtTime(opts.t0).replace(/:/g, '-')}.${opts.format}`, opts.format);
    if (!out) return;
    signal.current = { cancelled: false };
    setErr(null); setResult(null);
    setProgress({ frame: 0, frames: Math.round(dur * rate), phase: 'render', etaS: null });
    try { setResult(await runExport(opts, out, setProgress, signal.current)); }
    catch (e) { setErr(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)); }
    setProgress(null);
  };
  const audioVideos = media.order.filter((id) => media.videos[id]?.audio && sel.some((s) => s));
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <div className="modal-back">
      <div className="modal export" role="dialog" aria-label="Export video">
        <h3>Export video</h3>
        <div className="export-grid">
          <fieldset disabled={!!progress}>
            <div className="ex-row"><b>Windows</b>
              {sources.length === 0 && <span className="muted">No exportable windows (3D Map, Video, Graph, Horizon).</span>}
              {sources.map((s) => (
                <label key={s.id} className="chk" title={isShown(s.content()) ? '' : 'Not visible right now (hidden tab)'}>
                  <input type="checkbox" checked={sel.includes(s.id)} onChange={() => toggle(s.id)} aria-label={`Export ${s.title} (${s.id})`} /> {s.title}{shown.includes(s) ? '' : ' (hidden)'}
                </label>
              ))}
            </div>
            <div className="ex-row"><b>Layout</b>
              {([['screen', 'As on screen'], ['grid', 'Grid'], ['pip', 'Picture-in-picture']] as const).map(([k, l]) => (
                <label key={k} className="chk"><input type="radio" name="ex-layout" checked={layout === k} onChange={() => setLayout(k)} /> {l}</label>
              ))}
            </div>
            <div className="ex-row"><b>Time</b>
              <input value={range[0]} onChange={(e) => setRange([e.target.value, range[1]])} aria-label="Export start" style={{ width: 90 }} className={t0 === null ? 'bad' : ''} />
              →
              <input value={range[1]} onChange={(e) => setRange([range[0], e.target.value])} aria-label="Export end" style={{ width: 90 }} className={t1 === null ? 'bad' : ''} />
              <span className="muted">{dur > 0 ? `${dur.toFixed(2)} s` : 'end must be after start'}</span>
            </div>
            <div className="ex-row"><b>Format</b>
              <label className="chk"><input type="radio" name="ex-format" checked={effFormat === 'mp4'} onChange={() => setFormat('mp4')} /> MP4 (H.264)</label>
              <label className="chk" title={gifOk ? '' : `GIF is limited to ${GIF_MAX_SECONDS} s`}><input type="radio" name="ex-format" checked={effFormat === 'gif'} disabled={!gifOk} onChange={() => setFormat('gif')} /> GIF {gifOk ? '' : `(≤ ${GIF_MAX_SECONDS} s)`}</label>
            </div>
            {effFormat === 'mp4' ? (
              <>
                <div className="ex-row"><b>Size</b>
                  <select value={res} onChange={(e) => setRes(e.target.value)} aria-label="Resolution">
                    {RES.map(([n, w, h]) => <option key={n} value={n}>{n} ({w}×{h})</option>)}
                    <option value="custom">Custom…</option>
                  </select>
                  {res === 'custom' && (
                    <>
                      <input type="number" value={custom.w} min={160} max={7680} step={2} onChange={(e) => setCustom({ ...custom, w: Number(e.target.value) })} aria-label="Width" style={{ width: 70 }} />×
                      <input type="number" value={custom.h} min={120} max={4320} step={2} onChange={(e) => setCustom({ ...custom, h: Number(e.target.value) })} aria-label="Height" style={{ width: 70 }} />
                    </>
                  )}
                  <select value={fps} onChange={(e) => setFps(Number(e.target.value))} aria-label="Frame rate">
                    {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
                  </select>
                </div>
                <div className="ex-row"><b>Audio</b>
                  <select value={audio} onChange={(e) => setAudio(e.target.value)} aria-label="Audio source">
                    <option value="">None</option>
                    {audioVideos.map((id) => <option key={id} value={id} disabled={streamSolution(id)?.status === 'unsynced'}>{media.videos[id]!.name}{streamSolution(id)?.status === 'unsynced' ? ' (not synced)' : ''}</option>)}
                  </select>
                </div>
              </>
            ) : (
              <div className="ex-row"><b>Size</b>
                <select value={gifW} onChange={(e) => setGifW(Number(e.target.value))} aria-label="GIF width">
                  {GIF_W.map((w) => <option key={w} value={w}>{w}×{Math.round((w * 9) / 16 / 2) * 2}</option>)}
                </select>
                <select value={gifFps} onChange={(e) => setGifFps(Number(e.target.value))} aria-label="GIF frame rate">
                  {[10, 12, 15, 20].map((f) => <option key={f} value={f}>{f} fps</option>)}
                </select>
              </div>
            )}
          </fieldset>
          <div className="ex-preview">
            <canvas ref={preview} aria-label="Export preview" />
            <div className="muted small">Preview at the playhead · {W}×{H} · {dur > 0 ? Math.round(dur * rate) : 0} frames</div>
          </div>
        </div>
        {progress && (
          <div className="pack-progress">
            <progress max={progress.frames} value={progress.frame} />
            <span className="small">{progress.phase === 'render' ? `Frame ${progress.frame} / ${progress.frames}` : progress.phase === 'palette' ? 'Building the palette' : 'Writing file'}{progress.etaS !== null && progress.etaS > 0 ? ` · ${Math.ceil(progress.etaS)} s left` : ''}</span>
          </div>
        )}
        {result && <div className="ok">Exported {result.frames} frames: {result.path} ({fmtBytes(result.bytes)})</div>}
        {err && <div className="err">{err}</div>}
        <div className="modal-row">
          {!progress && <button className="primary" onClick={() => void start()} disabled={!opts}>Export…</button>}
          {progress && <button onClick={() => { signal.current.cancelled = true; }}>Cancel</button>}
          <button onClick={close} disabled={!!progress}>{result ? 'Done' : 'Close'}</button>
        </div>
      </div>
    </div>
  );
}
