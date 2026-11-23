import { useEffect, useRef, useState } from 'react';
import { installGlobalKeys } from '../keys';
import { useLogs } from '../data/logs';
import { fmtTime, timeDomain, useTimeline } from '../data/timeline';
import { stepReview } from '../data/step';
import { StepButtons } from '../ui/StepButtons';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];

/** Global transport: play/pause, speed, scrub, selection and crop readouts. */
export function TimelineBar() {
  useLogs((s) => s.logs);
  const { t, playing, speed, range, crop, setT, setPlaying, setSpeed, setRange, setCrop } = useTimeline();
  const [a, b] = timeDomain();
  const wrapRef = useRef<HTMLDivElement>(null);
  // Right-drag on the scrubber crops the workspace to the dragged time range.
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);

  // Space / arrows / Home / End (pop-outs install the same keys when they open).
  useEffect(() => installGlobalKeys(window), []);

  const timeAt = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return a + f * (b - a);
  };
  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 2) return;
    e.preventDefault();
    const x0 = e.clientX;
    setDrag({ x0, x1: x0 });
    const doc = wrapRef.current!.ownerDocument;
    const move = (m: MouseEvent) => setDrag({ x0, x1: m.clientX });
    const up = (m: MouseEvent) => {
      doc.removeEventListener('mousemove', move);
      doc.removeEventListener('mouseup', up);
      setDrag(null);
      if (Math.abs(m.clientX - x0) >= 4) setCrop([timeAt(x0), timeAt(m.clientX)]);
    };
    doc.addEventListener('mousemove', move);
    doc.addEventListener('mouseup', up);
  };
  const band = (() => {
    if (!drag || !wrapRef.current) return null;
    const r = wrapRef.current.getBoundingClientRect();
    const l = Math.max(0, Math.min(drag.x0, drag.x1) - r.left), w = Math.min(r.width, Math.max(drag.x0, drag.x1) - r.left) - l;
    return <div className="crop-band" style={{ left: l, width: Math.max(0, w) }} />;
  })();

  return (
    <div className="timeline">
      <button onClick={() => setPlaying(!playing)} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} style={{ width: 36 }}>{playing ? '❚❚' : '▶'}</button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <StepButtons onStep={stepReview} />
      <span className="mono time">{fmtTime(t)}</span>
      <div ref={wrapRef} className="scrub-wrap" onMouseDown={onDown} onContextMenu={(e) => e.preventDefault()} title="Drag to scrub · right-drag to crop the workspace to a time range">
        <input type="range" min={a} max={b} step={0.01} value={Math.min(b, Math.max(a, t))} onChange={(e) => setT(Number(e.target.value))} aria-label="Playhead" className="scrub" />
        {band}
      </div>
      <span className="mono muted">{fmtTime(b)}</span>
      {crop && (
        <span className="crop-pill" title="Every window shows only this time range (right-drag on a timeline or graph to change it)">
          Cropped {fmtTime(crop[0])} → {fmtTime(crop[1])}
          <button onClick={() => setCrop(null)} title="Show the whole flight again" aria-label="Clear crop">×</button>
        </span>
      )}
      {range && (
        <span className="sel-pill">
          {fmtTime(range[0])} → {fmtTime(range[1])}
          <button onClick={() => setRange(null)} title="Clear selection (Esc in a graph)" aria-label="Clear selection">×</button>
        </span>
      )}
    </div>
  );
}
