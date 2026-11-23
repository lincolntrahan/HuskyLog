import { SourceMenu } from '../ui/SourceMenu';
import { isValidFormat } from '@core/overlay/format';
import { useLogs } from '../data/logs';
import { useOverlays, type OverlayItem, type ReadoutLine } from './model';
import { lineValue, streamOf } from './values';
import { useTimeline } from '../data/timeline';


/** Properties of the selected overlay (edit mode). */
/** `side`: which side of the window the panel sits on (away from the selected overlay). */
export function OverlayEditor({ win, item, side }: { win: string; item: OverlayItem; side: 'left' | 'right' }) {
  const patch = (p: Partial<OverlayItem>) => useOverlays.getState().patch(win, item.id, p);
  const logs = useLogs();
  const t = useTimeline((s) => s.t);
  const stream = streamOf(item);
  const lines = item.lines ?? [];
  const setLine = (i: number, p: Partial<ReadoutLine>) => patch({ lines: lines.map((l, k) => (k === i ? { ...l, ...p } : l)) });
  const ready = logs.order.filter((id) => logs.logs[id]?.status === 'ready');

  return (
    <div className={`overlay-editor side-${side}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="oe-head">
        <b>{item.kind === 'adi' ? 'Horizon overlay' : item.kind === 'sticks' ? 'Pilot sticks' : 'Readout'}</b>
        <button title="Delete overlay (Del)" onClick={() => useOverlays.getState().remove(win, item.id)}>Delete</button>
      </div>
      {ready.length > 1 && (
        <label>Log <select value={stream ?? ''} onChange={(e) => patch({ stream: e.target.value })}>
          {ready.map((id) => <option key={id} value={id}>{logs.logs[id]!.name}</option>)}
        </select></label>
      )}
      {item.kind === 'readout' && (
        <>
          <table className="oe-lines">
            <thead><tr><th>Label</th><th title="A channel (ATT.Roll), a named or inline expression, or @mode, @armed, @time, @local">Source</th><th>Format</th><th>Unit</th><th>Now</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const v = lineValue(l, item, t);
                const badFmt = l.format && !isValidFormat(l.format);
                return (
                  <tr key={i}>
                    <td><input value={l.label} onChange={(e) => setLine(i, { label: e.target.value, labelAuto: false })} aria-label={`Label ${i + 1}`} style={{ width: 56 }} /></td>
                    <td>
                      <span className="src-cell">
                        <input value={l.source} onChange={(e) => setLine(i, { source: e.target.value })} aria-label={`Source ${i + 1}`} style={{ width: 122 }}
                          className={v.error ? 'bad' : ''} title={v.error ?? 'Type a channel or expression, or pick one with ▾'} />
                        <SourceMenu stream={stream} value={l.source} compact ariaLabel={`Pick source ${i + 1}`}
                          onPick={(p) => setLine(i, {
                            source: p.source,
                            // Fill label/unit/format from the pick unless the user already typed their own label.
                            label: l.labelAuto === false && l.label ? l.label : p.label,
                            unit: p.unit ?? '',
                            format: p.format ?? (l.format || '%.1f'),
                          })} />
                      </span>
                    </td>
                    <td><input value={l.format} onChange={(e) => setLine(i, { format: e.target.value })} aria-label={`Format ${i + 1}`} style={{ width: 50 }}
                      className={badFmt ? 'bad' : ''} title="printf style: %.1f, %d, %+.2f, %,d, %.3e" /></td>
                    <td><input value={l.unit ?? ''} onChange={(e) => setLine(i, { unit: e.target.value })} aria-label={`Unit ${i + 1}`} style={{ width: 38 }} /></td>
                    <td className="mono small" title={v.error ?? ''}>{v.text}</td>
                    <td><button title="Remove line" onClick={() => patch({ lines: lines.filter((_, k) => k !== i) })}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="oe-row">
            <button onClick={() => patch({ lines: [...lines, { label: '', source: '', format: '%.1f', unit: '' }] })}>＋ Line</button>
            <label>Between samples <select value={item.sample ?? 'interp'} onChange={(e) => patch({ sample: e.target.value as 'interp' | 'hold' })}>
              <option value="interp">interpolate</option><option value="hold">hold last</option>
            </select></label>
            <label>Align <select value={item.style.align} onChange={(e) => patch({ style: { ...item.style, align: e.target.value as 'left' } })}>
              <option value="left">left</option><option value="center">centre</option><option value="right">right</option>
            </select></label>
          </div>
        </>
      )}
      {item.kind === 'adi' && (
        <div className="oe-row">
          <label className="chk"><input type="checkbox" checked={item.hud ?? true} onChange={(e) => patch({ hud: e.target.checked })} /> See-through (HUD)</label>
          <label className="chk"><input type="checkbox" checked={item.tapes ?? false} onChange={(e) => patch({ tapes: e.target.checked })} /> Speed / altitude / heading tapes</label>
          <label title="Backward for tail cams: roll and pitch are mirrored and the heading turned 180°, so the horizon matches the picture">Camera faces <select value={item.facing ?? 'forward'} onChange={(e) => patch({ facing: e.target.value as 'forward' | 'backward' })} aria-label="Camera faces">
            <option value="forward">forward</option><option value="backward">backward</option>
          </select></label>
        </div>
      )}
      {item.kind === 'sticks' && (
        <>
          <div className="oe-row">
            <label title="Mode 2: throttle and rudder on the left stick. Mode 1: elevator and rudder on the left.">Transmitter <select value={item.stickMode ?? 2} onChange={(e) => patch({ stickMode: Number(e.target.value) as 1 | 2 })} aria-label="Transmitter mode">
              <option value={2}>Mode 2 (throttle left)</option><option value={1}>Mode 1 (throttle right)</option>
            </select></label>
            <label className="chk"><input type="checkbox" checked={item.aux ?? true} onChange={(e) => patch({ aux: e.target.checked })} aria-label="Channel 5-8 sliders" /> Channel 5–8 sliders</label>
          </div>
          <div className="oe-row">
            <label className="chk"><input type="checkbox" checked={!!item.values} onChange={(e) => patch({ values: e.target.checked })} aria-label="PWM values" /> PWM values (µs)</label>
            <label className="chk" title="ArduPilot expects the elevator stick forward to give a low PWM. Tick this if the dot moves opposite to the stick."><input type="checkbox" checked={!!item.flipElevator} onChange={(e) => patch({ flipElevator: e.target.checked })} aria-label="Flip elevator" /> Flip elevator</label>
          </div>
          <div className="muted small">From the log's RC input (RCIN), calibrated with its RCn_MIN/TRIM/MAX/REVERSED and mapped with RCMAP_* (AETR by default).</div>
        </>
      )}
      <div className="oe-row">
        {item.kind !== 'adi' && <label>Text <input type="color" value={item.style.color} onChange={(e) => patch({ style: { ...item.style, color: e.target.value } })} aria-label="Text colour" /></label>}
        <label>Box <input type="color" value={item.style.bg} onChange={(e) => patch({ style: { ...item.style, bg: e.target.value } })} aria-label="Box colour" /></label>
        <label>Opacity <input type="range" min={0} max={1} step={0.05} value={item.style.opacity} onChange={(e) => patch({ style: { ...item.style, opacity: Number(e.target.value) } })} aria-label="Box opacity" /></label>
      </div>
    </div>
  );
}

