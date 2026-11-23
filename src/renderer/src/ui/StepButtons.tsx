/**
 * −10 s −1 s −10f −1f | +1f +10f +1 s +10 s, for Review and Sync.
 * `frame` names the small step: "frame" for video, "sample" for a log lane.
 */
export function StepButtons({ onStep, frame = 'frame', disabled }: { onStep: (unit: 's' | 'f', n: number) => void; frame?: 'frame' | 'sample'; disabled?: boolean }) {
  const f = frame === 'frame' ? 'f' : 'smp';
  const b = (unit: 's' | 'f', n: number, label: string, tip: string) => (
    <button key={label} onClick={() => onStep(unit, n)} disabled={disabled} title={tip} aria-label={tip}>{label}</button>
  );
  return (
    <span className="step-buttons" role="group" aria-label="Step">
      {b('s', -10, '−10s', 'Back 10 seconds')}
      {b('s', -1, '−1s', 'Back 1 second')}
      {b('f', -10, `−10${f}`, `Back 10 ${frame}s`)}
      {b('f', -1, `−1${f}`, `Back 1 ${frame}`)}
      <span className="step-sep" />
      {b('f', 1, `+1${f}`, `Forward 1 ${frame}`)}
      {b('f', 10, `+10${f}`, `Forward 10 ${frame}s`)}
      {b('s', 1, '+1s', 'Forward 1 second')}
      {b('s', 10, '+10s', 'Forward 10 seconds')}
    </span>
  );
}
