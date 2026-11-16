import { useEffect, useMemo, useRef, useState } from 'react';
import { snapEdge, smooth } from '@core/timesync/snap';
import { toLocal, toMaster } from '@core/timesync/solver';
import { useLogs, channelExists } from '../data/logs';
import { useMedia, mediaSource } from '../data/media';
import { allStreams, useSync } from '../data/sync';
import { useExpressions, loadExpression } from '../data/expressions';
import { fmtTime } from '../data/timeline';
import { Lane, type LaneSignal } from '../sync/Lane';
import { SourceMenu } from '../ui/SourceMenu';
import { useApp } from '../store';
import type { Waveform } from '../video/MediaSource';

const SIG_COLORS = ['#ffb000', '#3ddc97', '#c792ea', '#7fdbff'];
const ACC_MAG = 'sqrt(IMU.AccX^2 + IMU.AccY^2 + IMU.AccZ^2)';
const isThrottleLike = (id: string, label?: string) => label === 'Throttle' || /^(AETR\.Thr|CTUN\.ThO|RCIN\.C3)$/.test(id);

/**
 * Sync tab (DESIGN §5.5): one lane per stream; put the same named event on each
 * stream (prop start, touchdown…) and the solver lines them up.
 */
export function SyncTab() {
  const logs = useLogs();
  const media = useMedia();
  const named = useExpressions((s) => s.named);
  const sync = useSync();
  const streams = useMemo(() => allStreams(), [logs, media]); // eslint-disable-line react-hooks/exhaustive-deps

  const [mode, setMode] = useState<'local' | 'aligned'>('local');
  const [views, setViews] = useState<Record<string, [number, number]>>({});
  const [alignedView, setAlignedView] = useState<[number, number] | null>(null);
  const [cursors, setCursors] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [activeEvent, setActiveEvent] = useState<string | null>(null);
  const [newEvent, setNewEvent] = useState('');
  const [suggest, setSuggest] = useState<Record<string, number | null>>({});
  const [laneChannels, setLaneChannels] = useState<Record<string, string[]>>({});
  const [snapIdx, setSnapIdx] = useState<Record<string, number>>({});
  const [signals, setSignals] = useState<Record<string, LaneSignal[]>>({});
  const [waveforms, setWaveforms] = useState<Record<string, Waveform | null>>({});
  const [addChan, setAddChan] = useState('');
  const previewRef = useRef<HTMLCanvasElement>(null);

  // Default view per stream = its whole local range.
  const rangeOf = (id: string): [number, number] => {
    const l = logs.logs[id];
    if (l?.summary) return l.summary.timeRange;
    const v = media.videos[id]?.video;
    return v ? [v.startS, v.endS] : [0, 1];
  };
  const viewOf = (id: string): [number, number] => {
    if (mode === 'aligned') {
      const s = sync.solution.streams[id];
      const av = alignedView ?? masterRange();
      return s && s.status !== 'unsynced' ? [toLocal(s, av[0]), toLocal(s, av[1])] : rangeOf(id);
    }
    return views[id] ?? rangeOf(id);
  };
  const masterRange = (): [number, number] => {
    let a = Infinity, b = -Infinity;
    for (const st of streams) {
      const s = sync.solution.streams[st.id];
      if (!s || s.status === 'unsynced') continue;
      const [l0, l1] = rangeOf(st.id);
      a = Math.min(a, toMaster(s, l0)); b = Math.max(b, toMaster(s, l1));
    }
    return Number.isFinite(a) ? [a, b] : [0, 1];
  };

  // Log lanes: default channels = throttle output, ESC RPM, IMU acceleration magnitude.
  useEffect(() => {
    const next = { ...laneChannels };
    let changed = false;
    for (const st of streams) {
      if (st.kind !== 'log' || next[st.id]) continue;
      const ch = logs.logs[st.id]!.summary!.channels;
      const thr = ch.find((c) => c.label === 'Throttle')?.id;
      const list = [thr, channelExists({ stream: st.id, id: 'ESC.RPM' }) ? 'ESC.RPM' : undefined, ACC_MAG].filter(Boolean) as string[];
      next[st.id] = list;
      changed = true;
      if (thr && list.length > 1) setSnapIdx((s) => ({ ...s, [st.id]: 1 })); // snap on RPM by default (physical, not commanded)
    }
    if (changed) setLaneChannels(next);
  }, [streams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const [id, list] of Object.entries(laneChannels)) {
      void Promise.all(list.map(async (src, k) => {
        try {
          const d = await loadExpression(id, src, named);
          const label = logs.logs[id]?.summary?.channels.find((c) => c.id === src)?.label;
          return { label: label ? `${src} (${label})` : src === ACC_MAG ? '|IMU accel|' : src, color: SIG_COLORS[k % SIG_COLORS.length]!, t: d.t, v: d.v };
        } catch { return null; }
      })).then((sigs) => setSignals((s) => ({ ...s, [id]: sigs.filter(Boolean) as LaneSignal[] })));
    }
  }, [laneChannels, named]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const st of streams) {
      if (st.kind !== 'video' || st.id in waveforms) continue;
      setWaveforms((w) => ({ ...w, [st.id]: undefined as unknown as null }));
      void mediaSource(st.id)?.getWaveform().then((wf) => setWaveforms((w) => ({ ...w, [st.id]: wf })));
    }
  }, [streams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!selected && streams[0]) setSelected(streams[0].id); }, [streams, selected]);
  useEffect(() => { if (!activeEvent && sync.events[0]) setActiveEvent(sync.events[0].id); }, [sync.events, activeEvent]);

  const sel = streams.find((s) => s.id === selected);
  const cursor = selected ? cursors[selected] ?? null : null;
  const setCursor = (id: string, t: number) => { setCursors((c) => ({ ...c, [id]: t })); setSuggest((s) => ({ ...s, [id]: null })); };

  // ---- playback (find the moment by playing and scrubbing) ----
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sound, setSound] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    if (!playing || !sel) return;
    const id = sel.id;
    const [r0, r1] = rangeOf(id);
    const start = cursorRef.current ?? r0;
    const video = videoRef.current;
    let raf = 0, last = performance.now(), lastSet = 0, stopped = false;
    let t = start >= r1 - 1e-3 ? r0 : start;
    const win = (previewRef.current?.ownerDocument.defaultView ?? window);
    if (sel.kind === 'video' && video) {
      const v = media.videos[id]!;
      if (video.getAttribute('src') !== v.url) video.src = v.url;
      video.muted = !sound;
      video.playbackRate = rate;
      video.currentTime = t;
      void video.play().catch(() => setPlaying(false));
      video.onended = () => setPlaying(false);
    }
    const tick = (now: number) => {
      if (stopped) return;
      if (sel.kind === 'video' && video) t = video.currentTime;
      else { t += ((now - last) / 1000) * rate; if (t >= r1) { t = r1; setPlaying(false); } }
      last = now;
      if (now - lastSet > 33) { lastSet = now; setCursor(id, t); follow(id, t); }
      raf = win.requestAnimationFrame(tick);
    };
    raf = win.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      win.cancelAnimationFrame(raf);
      if (video) { video.pause(); video.onended = null; if (sel.kind === 'video') setCursor(id, video.currentTime); }
      else setCursor(id, t);
    };
  }, [playing, sel?.id, rate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (videoRef.current) videoRef.current.muted = !sound; }, [sound]);
  useEffect(() => { setPlaying(false); }, [sel?.id]);

  /** Keeps the cursor in view while playing (pans the lane). */
  const follow = (id: string, t: number) => {
    if (mode === 'aligned') return;
    setViews((x) => {
      const v = x[id] ?? rangeOf(id);
      const span = v[1] - v[0];
      if (t > v[0] + span * 0.92 || t < v[0]) return { ...x, [id]: [t - span * 0.1, t + span * 0.9] };
      return x;
    });
  };

  // Video preview of the selected video lane at its cursor. Only the latest
  // requested frame is decoded, so scrubbing never queues up stale frames.
  const wantRef = useRef<{ id: string; i: number } | null>(null);
  const busyRef = useRef(false);
  const drawPreview = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      for (;;) {
        const w = wantRef.current;
        const c = previewRef.current;
        const src = w ? mediaSource(w.id) : undefined;
        if (!w || !c || !src) break;
        const bmp = await src.frame(w.i).catch(() => null);
        if (bmp && wantRef.current === w) {
          const rot = src.video!.rotation;
          const sw = rot % 180 ? bmp.height : bmp.width, sh = rot % 180 ? bmp.width : bmp.height;
          if (c.width !== sw || c.height !== sh) { c.width = sw; c.height = sh; }
          const ctx = c.getContext('2d')!;
          ctx.save(); ctx.translate(sw / 2, sh / 2); ctx.rotate((rot * Math.PI) / 180);
          ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2); ctx.restore();
          (window.__hl as Record<string, unknown>)['syncPreview'] = { index: w.i, id: w.id };
          if (wantRef.current === w) break;
        }
        if (!bmp) break;
      }
    } finally { busyRef.current = false; }
  };
  useEffect(() => {
    if (!sel || sel.kind !== 'video' || cursor === null || playing) return;
    const src = mediaSource(sel.id);
    if (!src) return;
    wantRef.current = { id: sel.id, i: src.indexAt(cursor) };
    void drawPreview();
  }, [sel?.id, cursor, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Drag on the preview to jog (1 px = 1 frame, Shift ×10); wheel = ±1 frame. */
  const onPreviewDown = (e: React.MouseEvent) => {
    if (!sel || sel.kind !== 'video') return;
    const src = mediaSource(sel.id);
    if (!src) return;
    e.preventDefault();
    setPlaying(false);
    const host = e.currentTarget.ownerDocument.defaultView ?? window;
    const startX = e.clientX;
    const i0 = src.indexAt(cursorRef.current ?? src.ptsUs(0) / 1e6);
    const move = (ev: MouseEvent) => {
      const di = Math.round((ev.clientX - startX) * (ev.shiftKey ? 10 : 1));
      const i = Math.max(0, Math.min(src.frameCount - 1, i0 + di));
      setCursor(sel.id, src.ptsUs(i) / 1e6);
    };
    const up = () => { host.removeEventListener('mousemove', move); host.removeEventListener('mouseup', up); };
    host.addEventListener('mousemove', move);
    host.addEventListener('mouseup', up);
  };
  const onPreviewWheel = (e: React.WheelEvent) => { setPlaying(false); step(e.deltaY > 0 ? 1 : -1); };

  // ---- actions ----
  const step = (dir: number, big = false) => {
    if (!sel || cursor === null) return;
    if (sel.kind === 'video') {
      const src = mediaSource(sel.id)!;
      if (big) return setCursor(sel.id, cursor + dir);
      const i = Math.max(0, Math.min(src.frameCount - 1, src.indexAt(cursor) + dir));
      return setCursor(sel.id, src.ptsUs(i) / 1e6);
    }
    const s = signals[sel.id]?.[snapIdx[sel.id] ?? 0] ?? signals[sel.id]?.[0];
    if (!s || big) return setCursor(sel.id, cursor + dir * (big ? 1 : 0.01));
    let lo = 0, hi = s.t.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s.t[m]! < cursor) lo = m + 1; else hi = m; }
    const i = Math.max(0, Math.min(s.t.length - 1, dir > 0 ? (s.t[lo]! > cursor + 1e-9 ? lo : lo + 1) : lo - 1));
    setCursor(sel.id, s.t[i]!);
  };
  const snap = () => {
    if (!sel || cursor === null) return;
    let r: number | null = null;
    if (sel.kind === 'video') {
      const wf = waveforms[sel.id];
      if (wf) {
        const t = Float64Array.from({ length: wf.rms.length }, (_, i) => wf.start + (i + 0.5) * wf.binDt);
        r = snapEdge(t, smooth(wf.rms, 5), cursor, 1.5, 0.25);
      }
    } else {
      const s = signals[sel.id]?.[snapIdx[sel.id] ?? 0];
      if (s) r = snapEdge(s.t, s.v, cursor, 1.5, 0.5);
    }
    setSuggest((x) => ({ ...x, [sel.id]: r }));
  };
  const acceptSnap = () => { if (sel && suggest[sel.id] != null) setCursor(sel.id, suggest[sel.id]!); };
  const place = () => {
    if (!sel || cursor === null) return;
    let ev = activeEvent;
    if (!ev) ev = sync.addEvent(newEvent.trim() || `Event ${sync.events.length + 1}`);
    setActiveEvent(ev);
    sync.setMarker(sel.id, ev, cursor);
  };
  const addEvent = () => {
    const name = newEvent.trim();
    if (!name) return;
    setActiveEvent(sync.addEvent(name));
    setNewEvent('');
  };

  // Keys work anywhere on the Sync tab (no need to click into it first).
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (cursor === null && sel) setCursor(sel.id, rangeOf(sel.id)[0]); setPlaying((p) => !p); return; }
    if (e.key === 'ArrowRight') { setPlaying(false); step(1, e.shiftKey); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { setPlaying(false); step(-1, e.shiftKey); e.preventDefault(); }
    if (e.key === 'm' || e.key === 'M') place();
    if (e.key === 's' || e.key === 'S') snap();
    if (e.key === 'Enter') acceptSnap();
    if (e.key === 'Delete' && sel && activeEvent) sync.removeMarker(sel.id, activeEvent);
  };
  const appTab = useApp((s) => s.tab);
  useEffect(() => {
    if (appTab !== 'sync') { setPlaying(false); return; }
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [appTab]);

  (window.__hl as Record<string, unknown>)['sync'] = { setCursor, setSelected, place, snap, acceptSnap, setActiveEvent, step, getSuggest: () => suggest, getCursors: () => cursors, setPlaying, isPlaying: () => playing, setRate, setSound };

  const activeName = sync.events.find((e) => e.id === activeEvent)?.name ?? '';
  const selChannels = sel?.kind === 'log' ? laneChannels[sel.id] ?? [] : [];
  const snapChan = sel?.kind === 'log' ? selChannels[snapIdx[sel.id] ?? 0] : undefined;
  const snapChanLabel = sel && snapChan ? logs.logs[sel.id]?.summary?.channels.find((c) => c.id === snapChan)?.label : undefined;
  const commandedWarning = sel?.kind === 'log' && snapChan && isThrottleLike(snapChan, snapChanLabel) && /prop|motor|spin|start/i.test(activeName);

  if (!streams.length) {
    return <div className="page"><h2>Sync</h2><p className="muted">Import a log and at least one video on the Import tab, then line them up here.</p></div>;
  }

  return (
    <div className="sync">
      <div className="sync-bar">
        <div className="seg">
          <button className={mode === 'local' ? 'primary' : ''} onClick={() => setMode('local')} title="Each lane scrubs in its own time">Local</button>
          <button className={mode === 'aligned' ? 'primary' : ''} onClick={() => { setMode('aligned'); setAlignedView(masterRange()); }} title="All lanes on the master timeline using the current solution">Aligned</button>
        </div>
        <span className="muted">Events:</span>
        {sync.events.map((e) => (
          <button key={e.id} className={`ev-chip${e.id === activeEvent ? ' on' : ''}`} style={{ borderColor: e.color }} onClick={() => setActiveEvent(e.id)}>
            <span className="dot" style={{ background: e.color }} />{e.name}
          </button>
        ))}
        <input value={newEvent} onChange={(e) => setNewEvent(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addEvent()} placeholder="New event (e.g. Prop start)" aria-label="New event name" style={{ width: 190 }} />
        <button onClick={addEvent} disabled={!newEvent.trim()}>Add event</button>
        <span className="sync-hint muted">drag: scrub · Space play/pause · ←/→ frame/sample · S snap · Enter accept · M place marker · wheel zoom · Alt-drag pan</span>
      </div>

      <div className="lanes">
        {streams.map((st) => {
          const s = sync.solution.streams[st.id];
          const status = s?.status ?? 'unsynced';
          const v = viewOf(st.id);
          return (
            <div key={st.id} className={`lane${selected === st.id ? ' sel' : ''}`}>
              <div className="lane-head" onClick={() => setSelected(st.id)}>
                <div className="lane-name">{st.kind === 'video' ? '🎥' : '📈'} {st.name}</div>
                <div className={`lane-status st-${status}`}>
                  {status === 'reference' ? 'Reference (master time)' : status === 'synced' ? `Synced · offset ${s!.b.toFixed(3)} s${s!.usedDrift ? ` · ${s!.driftPpm.toFixed(0)} ppm` : ''}` : 'Not synced'}
                </div>
                {st.kind === 'log' && (
                  <div className="lane-chans">
                    {(laneChannels[st.id] ?? []).map((c, k) => (
                      <span key={c} className={`lane-chan${(snapIdx[st.id] ?? 0) === k ? ' snap' : ''}`} style={{ color: SIG_COLORS[k % SIG_COLORS.length] }}
                        title="Click: use for snapping · ×: remove" onClick={(e) => { e.stopPropagation(); setSnapIdx((x) => ({ ...x, [st.id]: k })); }}>
                        {c === ACC_MAG ? '|IMU accel|' : c}
                        <b onClick={(e) => { e.stopPropagation(); setLaneChannels((x) => ({ ...x, [st.id]: x[st.id]!.filter((_, j) => j !== k) })); }}> ×</b>
                      </span>
                    ))}
                  </div>
                )}
                {st.kind === 'video' && <div className="muted small">{waveforms[st.id] ? 'audio waveform' : waveforms[st.id] === null ? 'no audio' : 'decoding audio…'}</div>}
              </div>
              <div className="lane-body">
                <Lane
                  view={v}
                  signals={signals[st.id]}
                  waveform={st.kind === 'video' ? waveforms[st.id] : undefined}
                  markers={sync.markers[st.id] ?? []}
                  events={sync.events}
                  cursor={cursors[st.id] ?? null}
                  suggestion={suggest[st.id] ?? null}
                  selected={selected === st.id}
                  dim={mode === 'aligned' && status === 'unsynced' ? 'Not synced yet — place at least one shared event in Local mode' : null}
                  toDisplay={mode === 'aligned' && s && status !== 'unsynced' ? (t) => toMaster(s, t) : undefined}
                  fromDisplay={mode === 'aligned' && s && status !== 'unsynced' ? (t) => toLocal(s, t) : undefined}
                  onSelect={() => setSelected(st.id)}
                  onCursor={(t) => setCursor(st.id, t)}
                  onScrub={(on) => { if (on) { setPlaying(false); setSelected(st.id); } }}
                  onMarkerDrag={(ev, t) => sync.setMarker(st.id, ev, t)}
                  onView={(nv) => {
                    if (mode === 'aligned') {
                      const sl = sync.solution.streams[st.id];
                      if (sl && sl.status !== 'unsynced') setAlignedView([toMaster(sl, nv[0]), toMaster(sl, nv[1])]);
                    } else setViews((x) => ({ ...x, [st.id]: nv }));
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="sync-bottom">
        <div className="sync-tools">
          {sel && (
            <>
              <div className="row">
                <b>{sel.name}</b>
                <span className="mono">{cursor === null ? 'click or drag in a lane to set the cursor' : `cursor ${fmtTime(cursor)}`}</span>
                {cursor !== null && sync.solution.streams[sel.id]?.status !== 'unsynced' && <span className="mono muted">= master {fmtTime(toMaster(sync.solution.streams[sel.id]!, cursor))}</span>}
              </div>
              <div className="row">
                <button className={playing ? 'primary' : ''} onClick={() => { if (cursor === null) setCursor(sel.id, rangeOf(sel.id)[0]); setPlaying((p) => !p); }} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} style={{ width: 40 }}>{playing ? '❚❚' : '▶'}</button>
                <select value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Sync playback speed" title="Playback speed">
                  {[0.1, 0.25, 0.5, 1, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
                </select>
                {sel.kind === 'video' && <label className="chk"><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound</label>}
                <button onClick={() => step(-1, true)} disabled={cursor === null}>−1 s</button>
                <button onClick={() => step(-1)} disabled={cursor === null}>◀ {sel.kind === 'video' ? 'frame' : 'sample'}</button>
                <button onClick={() => step(1)} disabled={cursor === null}>{sel.kind === 'video' ? 'frame' : 'sample'} ▶</button>
                <button onClick={() => step(1, true)} disabled={cursor === null}>+1 s</button>
                <button onClick={snap} disabled={cursor === null} title={sel.kind === 'video' ? 'Nearest sound onset (motor start, impact)' : 'Nearest step in the highlighted channel'}>Snap (S)</button>
                {suggest[sel.id] != null && <button className="primary" onClick={acceptSnap}>Accept {fmtTime(suggest[sel.id]!)} (Enter)</button>}
              </div>
              <div className="row">
                <select value={activeEvent ?? ''} onChange={(e) => setActiveEvent(e.target.value || null)} aria-label="Event to place">
                  {sync.events.length === 0 && <option value="">(type a new event name above)</option>}
                  {sync.events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <button className="primary" onClick={place} disabled={cursor === null || (!activeEvent && !newEvent.trim())}>Place marker here (M)</button>
                {activeEvent && (sync.markers[sel.id] ?? []).some((m) => m.eventId === activeEvent) && (
                  <button onClick={() => sync.removeMarker(sel.id, activeEvent)}>Remove “{activeName}” marker</button>
                )}
                {sel.kind === 'log' && (
                  <span className="row">
                    <SourceMenu stream={sel.id} specials={false} placeholder="＋ channel…" ariaLabel="Pick a lane channel" onPick={(p) => setLaneChannels((x) => ({ ...x, [sel.id]: [...(x[sel.id] ?? []).filter((c) => c !== p.source), p.source] }))} />
                    <input value={addChan} onChange={(e) => setAddChan(e.target.value)} placeholder="or type an expression" aria-label="Add lane channel" style={{ width: 160 }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && addChan.trim()) { setLaneChannels((x) => ({ ...x, [sel.id]: [...(x[sel.id] ?? []), addChan.trim()] })); setAddChan(''); } }} />
                  </span>
                )}
              </div>
              {commandedWarning && (
                <div className="warn">
                  “{activeName}” on <b>{snapChan}{snapChanLabel ? ` (${snapChanLabel})` : ''}</b> is the throttle <i>command</i>. The prop physically spins up 0.2–0.5 s later.
                  A video shows the physical event, so snap on ESC RPM or IMU vibration instead (click that channel in the lane header).
                </div>
              )}
            </>
          )}
        </div>
        {sel?.kind === 'video' && (
          <div className="sync-preview">
            <div className="sync-preview-stage" onMouseDown={onPreviewDown} onWheel={onPreviewWheel} title="Drag sideways to jog frame by frame (Shift: ×10) · wheel: ±1 frame">
              <canvas ref={previewRef} style={{ display: playing ? 'none' : 'block' }} />
              <video ref={videoRef} playsInline preload="auto" style={{ display: playing ? 'block' : 'none', transform: media.videos[sel.id]?.video?.rotation ? `rotate(${media.videos[sel.id]!.video!.rotation}deg)` : undefined }} />
            </div>
            {cursor !== null && mediaSource(sel.id) && <div className="mono small">frame {mediaSource(sel.id)!.indexAt(cursor)} · {fmtTime(cursor)}</div>}
          </div>
        )}
        <div className="sync-results">
          <table className="grid">
            <thead><tr><th>Stream</th><th>Status</th><th>Offset</th><th>Drift</th><th>Residuals</th><th>Options</th></tr></thead>
            <tbody>
              {streams.map((st) => {
                const s = sync.solution.streams[st.id];
                const opts = sync.options[st.id] ?? {};
                const fps = media.videos[st.id]?.video?.fpsAvg || 30;
                return (
                  <tr key={st.id}>
                    <td>{st.name}</td>
                    <td className={`st-${s?.status}`}>{s?.status ?? '—'}{s?.warning ? ' ⚠' : ''}</td>
                    <td className="mono">{s && s.status === 'synced' ? `${s.b.toFixed(3)} s` : ''}</td>
                    <td className="mono">{s?.usedDrift ? `${s.driftPpm.toFixed(0)} ppm` : s?.status === 'synced' ? 'off' : ''}</td>
                    <td className="mono small" title={s?.warning}>{(s?.residuals ?? []).map((r) => `${sync.events.find((e) => e.id === r.eventId)?.name ?? r.eventId}: ${r.ms.toFixed(1)} ms`).join(' · ')}</td>
                    <td>
                      {s?.status !== 'reference' && (
                        <>
                          <label className="chk"><input type="checkbox" checked={!!opts.offsetOnly} onChange={(e) => sync.setOptions(st.id, { offsetOnly: e.target.checked })} /> offset only</label>
                          {st.kind === 'video' && <button title="Nudge −1 frame" onClick={() => sync.setOptions(st.id, { nudge: (opts.nudge ?? 0) - 1 / fps })}>−f</button>}
                          {st.kind === 'video' && <button title="Nudge +1 frame" onClick={() => sync.setOptions(st.id, { nudge: (opts.nudge ?? 0) + 1 / fps })}>+f</button>}
                          <button title="Nudge −1 ms" onClick={() => sync.setOptions(st.id, { nudge: (opts.nudge ?? 0) - 0.001 })}>−1ms</button>
                          <button title="Nudge +1 ms" onClick={() => sync.setOptions(st.id, { nudge: (opts.nudge ?? 0) + 0.001 })}>+1ms</button>
                          {opts.nudge ? <span className="mono small"> {(opts.nudge * 1000).toFixed(1)} ms</span> : null}
                        </>
                      )}
                      {s?.status !== 'reference' && st.kind === 'log' && <button onClick={() => sync.setReference(st.id)}>Make reference</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.values(sync.solution.streams).find((s) => s.warning) && <div className="warn">{Object.values(sync.solution.streams).find((s) => s.warning)!.warning}</div>}
        </div>
      </div>
    </div>
  );
}
