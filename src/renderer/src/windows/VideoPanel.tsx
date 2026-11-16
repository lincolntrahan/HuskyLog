import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { OverlayLayer } from '../overlay/OverlayLayer';
import { isExporting, registerExportSource } from '../export/registry';
import { drawVideoAt } from '../export/videoDraw';
import { useOverlays, type OverlayItem } from '../overlay/model';
import { NO_ZOOM, panBy, zoomAt, zoomTransform, type VideoZoom } from '@core/overlay/zoom';
import { useMedia, mediaSource } from '../data/media';
import { masterToLocal, streamSolution, useSync } from '../data/sync';
import { useApp } from '../store';
import { fmtTime, useTimeline } from '../data/timeline';

interface VideoCfg { stream?: string; muted: boolean; zoom?: VideoZoom }

/**
 * Video window (DESIGN §7.4, §6.1): shows a video stream at the master playhead
 * through its sync mapping. Paused/scrubbing: the exact frame via WebCodecs.
 * Playing: the native <video> element at the playback rate, re-locked to the
 * timeline whenever it drifts more than ~1 frame.
 */
export function VideoPanel({ api, params }: IDockviewPanelProps<{ video?: VideoCfg; overlays?: OverlayItem[] }>) {
  const media = useMedia();
  const [cfg, setCfgState] = useState<VideoCfg>(params?.video ?? { muted: true });
  const setCfg = (c: VideoCfg) => { setCfgState(c); api.updateParameters({ video: c }); };
  const sol = useSync((s) => s.solution);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [overlay, setOverlay] = useState<string | null>(null);
  const [showing, setShowing] = useState<'canvas' | 'video'>('canvas');
  const [info, setInfo] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const zoom = cfg.zoom ?? NO_ZOOM;
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // Digital zoom/crop: wheel zooms about the cursor, drag pans, double-click resets.
  useEffect(() => {
    const stage = stageRef.current!;
    const host = stage.ownerDocument.defaultView ?? window;
    const editingHere = () => useOverlays.getState().editing === api.id;
    const set = (z: VideoZoom) => setCfg({ ...cfgRef.current, zoom: z.s <= 1.0001 ? undefined : z });
    const onWheel = (e: WheelEvent) => {
      if (editingHere()) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const z = cfgRef.current.zoom ?? NO_ZOOM;
      set(zoomAt(z, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.deltaY < 0 ? 1.25 : 0.8));
    };
    let drag: { x: number; y: number; z: VideoZoom } | null = null;
    const onDown = (e: MouseEvent) => {
      const z = cfgRef.current.zoom;
      if (!z || e.button !== 0 || editingHere()) return;
      drag = { x: e.clientX, y: e.clientY, z };
      e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      set(panBy(drag.z, -(e.clientX - drag.x) / r.width, -(e.clientY - drag.y) / r.height));
    };
    const onUp = () => { drag = null; };
    const onDbl = () => { if (!editingHere()) set(NO_ZOOM); };
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('mousedown', onDown);
    stage.addEventListener('dblclick', onDbl);
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseup', onUp);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('mousedown', onDown);
      stage.removeEventListener('dblclick', onDbl);
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseup', onUp);
    };
  }, [api.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ready = media.order.filter((id) => media.videos[id]?.status === 'ready');
  const newest = ready[ready.length - 1];
  const stream = cfg.stream && media.videos[cfg.stream] ? cfg.stream : newest;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  useEffect(() => registerExportSource({
    id: api.id, type: 'video', title: api.title ?? 'Video', content: () => stageRef.current,
    draw: (c, t, w, h) => drawVideoAt(c, streamRef.current, cfgRef.current.zoom, t, w, h),
    videoStream: () => streamRef.current,
  }), [api.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!cfg.stream && newest) setCfg({ ...cfg, stream: newest }); }, [newest]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = stream ? media.videos[stream] : undefined;
  const status = stream ? sol.streams[stream]?.status ?? 'unsynced' : 'unsynced';

  useEffect(() => {
    if (!stream || !v?.video) return;
    const src = mediaSource(stream);
    const video = videoRef.current!, canvas = canvasRef.current!;
    if (!src) return;
    const vi = v.video;
    const fps = vi.fpsAvg || 30;
    let wanted = -1, drawn = -1, busy = false, lastLocal = NaN;
    const d = ((window.__hl as Record<string, unknown>)[`video:${api.id}`] = { local: NaN, index: -1, showing: 'canvas', overlay: null as string | null, drawn: -1 });

    const drawFrame = async () => {
      if (busy || wanted === drawn || wanted < 0) return;
      busy = true;
      const target = wanted;
      try {
        const bmp = await src.frame(target);
        const rot = vi.rotation;
        const sw = rot % 180 ? bmp.height : bmp.width, sh = rot % 180 ? bmp.width : bmp.height;
        if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; }
        const ctx = canvas.getContext('2d')!;
        ctx.save(); ctx.translate(sw / 2, sh / 2); ctx.rotate((rot * Math.PI) / 180);
        ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2); ctx.restore();
        drawn = target;
        d.drawn = target;
      } catch { /* undecodable frame: leave the last one */ }
      busy = false;
      if (wanted !== drawn) void drawFrame();
    };

    const update = () => {
      if (isExporting()) { lastLocal = NaN; return; } // the export decodes its own frames
      const tl = useTimeline.getState();
      const s = streamSolution(stream);
      if (!s || s.status === 'unsynced') {
        setOverlay('Not synced yet: place a shared event on this video and the log in the Sync tab.');
        d.overlay = 'unsynced';
        if (!video.paused) video.pause();
        return;
      }
      const local = masterToLocal(stream, tl.t);
      d.local = local;
      if (local < vi.startS - 0.5 / fps || local > vi.endS + 1 / fps) {
        const msg = local < vi.startS ? `Video starts in ${fmtTime(vi.startS - local)}` : `Video ended ${fmtTime(local - vi.endS)} ago`;
        setOverlay(msg); d.overlay = msg;
        if (!video.paused) video.pause();
        setShowing('canvas'); d.showing = 'canvas';
        return;
      }
      setOverlay(null); d.overlay = null;
      if (tl.playing) {
        if (video.getAttribute('src') !== v.url) video.src = v.url;
        video.muted = cfg.muted;
        const rate = tl.speed / s.a;
        if (Math.abs(video.playbackRate - rate) > 1e-6) video.playbackRate = rate;
        if (video.paused) { video.currentTime = local; void video.play().catch(() => undefined); }
        else if (Math.abs(video.currentTime - local) > 1 / fps) video.currentTime = local; // re-lock beyond 1 frame
        setShowing('video'); d.showing = 'video';
      } else {
        if (!video.paused) video.pause();
        setShowing('canvas'); d.showing = 'canvas';
        if (local !== lastLocal) {
          wanted = src.indexAt(local);
          d.index = wanted;
          setInfo(`frame ${wanted} · ${fmtTime(local)} local`);
          void drawFrame();
        }
      }
      lastLocal = local;
    };
    update();
    const unsubT = useTimeline.subscribe(update);
    const unsubS = useSync.subscribe(update);
    return () => { unsubT(); unsubS(); video.pause(); };
  }, [stream, v?.status, cfg.muted, api.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rot = v?.video?.rotation ?? 0;
  return (
    <div className="hl-panel video-panel">
      <div className="video-bar">
        <select value={stream ?? ''} onChange={(e) => setCfg({ ...cfg, stream: e.target.value })} aria-label="Video stream">
          {ready.length === 0 && <option value="">No videos: add some on the Import tab</option>}
          {ready.map((id) => <option key={id} value={id}>{media.videos[id]!.name}</option>)}
        </select>
        <label className="chk"><input type="checkbox" checked={!cfg.muted} onChange={(e) => setCfg({ ...cfg, muted: !e.target.checked })} /> Sound</label>
        {stream && <span className={`small st-${status}`}>{status === 'unsynced' ? 'not synced' : status}</span>}
        {status === 'unsynced' && stream && <button onClick={() => useApp.getState().setTab('sync')}>Open Sync tab</button>}
      </div>
      <div className={`video-stage${cfg.zoom ? ' zoomed' : ''}`} ref={stageRef}>
        <div className="video-zoom" style={{ transform: zoomTransform(zoom) }}>
          <canvas ref={canvasRef} style={{ display: showing === 'canvas' ? 'block' : 'none' }} />
          <video ref={videoRef} playsInline preload="auto" style={{ display: showing === 'video' ? 'block' : 'none', transform: rot ? `rotate(${rot}deg)` : undefined }} />
        </div>
        {!stream && <div className="placeholder">Import a video on the Import tab.</div>}
        {stream && overlay && <div className="placeholder video-overlay">{overlay}</div>}
        <OverlayLayer api={api} initial={params?.overlays} />
        {cfg.zoom && (
          <span className="video-zoom-badge" title="Digital zoom (wheel to zoom, drag to pan). Click or double-click the video to reset."
            onClick={() => setCfg({ ...cfg, zoom: undefined })}>{cfg.zoom.s.toFixed(1)}× ✕</span>
        )}
      </div>
      <div className="video-info">{v?.video ? `${v.video.codec} ${v.video.width}×${v.video.height} ${v.video.fpsAvg.toFixed(2)} fps${v.video.vfr ? ' VFR' : ''}${v.audio ? ` · audio ${v.audio.codec}` : ''} · ${info}` : ' '}</div>
    </div>
  );
}
