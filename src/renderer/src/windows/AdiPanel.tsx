import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { OverlayLayer } from '../overlay/OverlayLayer';
import { registerExportSource } from '../export/registry';
import type { OverlayItem } from '../overlay/model';
import { drawAdi, type AdiState } from '../adi/drawAdi';
import { channelExists, loadChannel, primaryLog, useLogs, type LoadedChannel } from '../data/logs';
import { useTimeline } from '../data/timeline';
import { sampleAngleAt, sampleAt } from '../data/track';

interface AdiCfg { speed: string; alt: string }
const SPEED_OPTIONS = ['ARSP.Airspeed', 'CTUN.As', 'GPS.Spd'];
const ALT_OPTIONS = ['POS.RelHomeAlt', 'BARO.Alt', 'POS.Alt', 'GPS.Alt'];

/** Artificial horizon window (DESIGN §7.3). Sources are configurable. */
export function AdiPanel({ api, params }: IDockviewPanelProps<{ adi?: AdiCfg; overlays?: OverlayItem[] }>) {
  const [cfg, setCfgState] = useState<AdiCfg>(params?.adi ?? { speed: 'ARSP.Airspeed', alt: 'POS.RelHomeAlt' });
  const setCfg = (c: AdiCfg) => { setCfgState(c); api.updateParameters({ adi: c }); };
  const [settings, setSettings] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useLogs((s) => s.logs);
  const log = primaryLog();
  const [ch, setCh] = useState<Record<string, LoadedChannel | null>>({});

  useEffect(() => {
    if (!log) return;
    const ids = ['ATT.Roll', 'ATT.Pitch', 'ATT.Yaw', cfg.speed, cfg.alt];
    let cancelled = false;
    void Promise.all(ids.map(async (id) => [id, channelExists({ stream: log.id, id }) ? await loadChannel({ stream: log.id, id }) : null] as const))
      .then((pairs) => { if (!cancelled) setCh(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [log?.id, cfg.speed, cfg.alt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const canvas = canvasRef.current!, box = boxRef.current!;
    const sum = log?.summary;
    const draw = () => {
      const dpr = (box.ownerDocument.defaultView ?? window).devicePixelRatio || 1;
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const state = stateAt(useTimeline.getState().t);
      drawAdi(ctx, w, h, state);
      (window.__hl as Record<string, unknown>)[`adi:${api.id}`] = state;
    };
    const stateAt = (t: number): AdiState => {
      const v = (id: string) => { const c = ch[id]; return c ? sampleAt(c.t, c.v, t) : undefined; };
      const yaw = ch['ATT.Yaw'];
      return {
        roll: v('ATT.Roll') ?? 0, pitch: v('ATT.Pitch') ?? 0, heading: yaw ? sampleAngleAt(yaw.t, yaw.v, t) : 0,
        airspeed: v(cfg.speed), altitude: v(cfg.alt),
        mode: sum?.modes.find((m) => t >= m.t0 && t < m.t1)?.name,
        armed: sum ? sum.armed.some(([a, b]) => t >= a && t < b) : undefined,
        speedLabel: 'm/s', altLabel: 'm',
      };
    };
    draw();
    const unsub = useTimeline.subscribe((s, p) => { if (s.t !== p.t) draw(); });
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    // Export draws the vector instrument directly at the output size.
    const unreg = registerExportSource({
      id: api.id, type: 'adi', title: api.title ?? 'Horizon', content: () => boxRef.current,
      draw: async (c, t, w, h) => { drawAdi(c as CanvasRenderingContext2D, w, h, stateAt(t)); },
    });
    return () => { unsub(); ro.disconnect(); unreg(); };
  }, [ch, cfg, log?.summary, api.id]);

  return (
    <div className="hl-panel adi-panel" ref={boxRef}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <OverlayLayer api={api} initial={params?.overlays} />
      {!log && <div className="placeholder">Load a .bin log on the Import tab.</div>}
      <button className="adi-gear" title="Choose airspeed and altitude sources" onClick={() => setSettings((s) => !s)}>⚙</button>
      {settings && (
        <div className="adi-settings">
          <label>Speed <select value={cfg.speed} onChange={(e) => setCfg({ ...cfg, speed: e.target.value })}>{SPEED_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select></label>
          <label>Altitude <select value={cfg.alt} onChange={(e) => setCfg({ ...cfg, alt: e.target.value })}>{ALT_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select></label>
        </div>
      )}
    </div>
  );
}
