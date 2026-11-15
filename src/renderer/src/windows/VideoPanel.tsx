import { useCallback, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { isVideo, useApp } from '../store';
import { Mp4FrameSource } from '../video/Mp4FrameSource';
import { diag } from '../debug';

/**
 * Phase 0 spike: frame-accurate stepping with WebCodecs. Becomes the real Video
 * window (synced to the master timeline, overlays) in Phases 4–5.
 */
export function VideoPanel({ api }: IDockviewPanelProps) {
  const files = useApp((s) => s.files).filter(isVideo);
  const [path, setPath] = useState<string>('');
  const [src, setSrc] = useState<Mp4FrameSource | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const d = (diag.videos[api.id] ??= {});

  // Switch to a video when it is newly added.
  const newest = files[files.length - 1]?.path ?? '';
  useEffect(() => {
    if (newest) setPath(newest);
  }, [newest]);

  useEffect(() => {
    const f = files.find((x) => x.path === path);
    if (!f) return;
    let cancelled = false;
    setStatus('Loading…');
    Mp4FrameSource.open(f.url)
      .then((s) => {
        if (cancelled) return s.dispose();
        setSrc(s);
        setIndex(0);
        Object.assign(d, { codec: s.info.codec, supported: s.info.supported, samples: s.info.frames, keyframes: s.info.keyframes, fps: s.info.fpsAvg, error: undefined });
        setStatus('');
      })
      .catch((e) => { d.error = String(e); setStatus(String(e)); });
    return () => { cancelled = true; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!src || !src.info.supported) return;
    let cancelled = false;
    const t0 = performance.now();
    src.frame(index).then((bmp) => {
      if (cancelled) return;
      const c = canvasRef.current!;
      if (c.width !== bmp.width) { c.width = bmp.width; c.height = bmp.height; }
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      Object.assign(d, { index, ptsUs: src.ptsUs(index), lastStepMs: performance.now() - t0 });
    }).catch((e) => { d.error = String(e); setStatus(String(e)); });
    return () => { cancelled = true; };
  }, [src, index]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = useCallback((n: number) => setIndex((i) => (src ? Math.max(0, Math.min(src.frameCount - 1, i + n)) : 0)), [src]);
  const jumpS = (s: number) => src && setIndex(src.indexAt(src.ptsUs(index) + s * 1e6));
  (window.__hl as Record<string, unknown>)[`video:${api.id}`] = { step, setIndex };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1);
    if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1);
  };

  const info = src?.info;
  return (
    <div className="hl-panel video-panel" tabIndex={0} onKeyDown={onKey}>
      <div className="video-bar">
        <select value={path} onChange={(e) => setPath(e.target.value)} aria-label="Video file">
          {files.length === 0 && <option value="">No videos — add some on the Import tab</option>}
          {files.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
        </select>
        <button disabled={!src} onClick={() => jumpS(-1)} title="Back 1 s">−1 s</button>
        <button disabled={!src} onClick={() => step(-1)} title="Previous frame (←)">◀ frame</button>
        <button disabled={!src} onClick={() => step(1)} title="Next frame (→)">frame ▶</button>
        <button disabled={!src} onClick={() => jumpS(1)} title="Forward 1 s">+1 s</button>
        {src && (
          <input type="range" min={0} max={src.frameCount - 1} value={index} onChange={(e) => setIndex(Number(e.target.value))} style={{ flex: 1, minWidth: 120 }} aria-label="Frame" />
        )}
      </div>
      <div className="video-stage">
        <canvas ref={canvasRef} />
        {(!src || status) && <div className="placeholder">{status || 'Select a video'}</div>}
        {info && !info.supported && <div className="placeholder">This machine can't decode {info.codec}. Phase 4 adds automatic H.264 proxies for this case.</div>}
      </div>
      <div className="video-info">
        {info
          ? `${info.codec}  ${info.width}×${info.height}  ${info.fpsAvg.toFixed(2)} fps${info.vfr ? ' (VFR)' : ''}  frames ${info.frames}  keyframes ${info.keyframes}\n` +
            `frame ${index}  pts ${(src!.ptsUs(index) / 1e6).toFixed(6)} s  decode ${d.lastStepMs?.toFixed(1) ?? '–'} ms`
          : ' '}
      </div>
    </div>
  );
}
