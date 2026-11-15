import { useEffect } from 'react';
import { installGlobalKeys } from '../keys';
import { useLogs } from '../data/logs';
import { fmtTime, timeDomain, useTimeline } from '../data/timeline';

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8];

/** Global transport: play/pause, speed, scrub, selection readout. */
export function TimelineBar() {
  useLogs((s) => s.logs);
  const { t, playing, speed, range, setT, setPlaying, setSpeed, setRange } = useTimeline();
  const [a, b] = timeDomain();

  // Space / arrows / Home / End (pop-outs install the same keys when they open).
  useEffect(() => installGlobalKeys(window), []);

  return (
    <div className="timeline">
      <button onClick={() => setPlaying(!playing)} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} style={{ width: 36 }}>{playing ? '❚❚' : '▶'}</button>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
        {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
      <span className="mono time">{fmtTime(t)}</span>
      <input type="range" min={a} max={b} step={0.01} value={Math.min(b, Math.max(a, t))} onChange={(e) => setT(Number(e.target.value))} aria-label="Playhead" className="scrub" />
      <span className="mono muted">{fmtTime(b)}</span>
      {range && (
        <span className="sel-pill">
          {fmtTime(range[0])} → {fmtTime(range[1])}
          <button onClick={() => setRange(null)} title="Clear selection (Esc in a graph)" aria-label="Clear selection">×</button>
        </span>
      )}
    </div>
  );
}
