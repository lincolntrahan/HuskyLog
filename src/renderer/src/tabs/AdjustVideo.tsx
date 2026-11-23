import { useEffect, useRef, useState } from 'react';
import {
  clampCrop, cornerFreeCrop, fitBox, FULL_CROP, isIdentity, NO_ADJUST, orientedSize, rotateStep, turnCrop, type CropRect, type VideoAdjust,
} from '@core/video/adjust';
import { mediaSource, setAdjust, useMedia } from '../data/media';
import { isSynced, masterToLocal } from '../data/sync';
import { useTimeline } from '../data/timeline';
import { drawPicture } from '../export/videoDraw';

type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'new';
const PW = 640, PH = 400;

/**
 * "Adjust…" for one video: rotate in 90° steps, mirror, straighten and crop.
 * The preview shows the whole turned picture with the crop drawn over it; drag
 * the crop's edges or corners, drag inside it to move it, or drag outside it
 * to draw a new one. Nothing changes until Apply.
 */
export function AdjustVideoDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const v = useMedia((s) => s.videos[id]);
  const [a, setA] = useState<VideoAdjust>(v?.adjust ?? NO_ADJUST);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const aRef = useRef(a);
  aRef.current = a;

  // The frame at the playhead (if the video covers it), else the middle of the video.
  useEffect(() => {
    const src = mediaSource(id), vi = v?.video;
    if (!src || !vi) return;
    const local = isSynced(id) ? masterToLocal(id, useTimeline.getState().t) : NaN;
    const t = local >= vi.startS && local <= vi.endS ? local : (vi.startS + vi.endS) / 2;
    void src.frame(src.indexAt(t)).then(setBmp).catch(() => undefined);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileRot = v?.video?.rotation ?? 0;
  const geom = () => {
    if (!bmp) return null;
    const o = orientedSize(bmp.width, bmp.height, fileRot, aRef.current);
    return { o, box: fitBox(o.w / o.h, PW, PH) };
  };

  // Preview: the whole picture (turned, mirrored, straightened), darkened outside the crop.
  useEffect(() => {
    const c = canvasRef.current, g = geom();
    if (!c || !bmp || !g) return;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0d1014'; ctx.fillRect(0, 0, PW, PH);
    drawPicture(ctx, 'adjust-preview', bmp, bmp.width, bmp.height, fileRot, { ...a, crop: FULL_CROP }, PW, PH);
    const { box } = g, cr = a.crop;
    const x = box.x + cr.x * box.w, y = box.y + cr.y * box.h, w = cr.w * box.w, h = cr.h * box.h;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(box.x, box.y, box.w, y - box.y);
    ctx.fillRect(box.x, y + h, box.w, box.y + box.h - y - h);
    ctx.fillRect(box.x, y, x - box.x, h);
    ctx.fillRect(x + w, y, box.x + box.w - x - w, h);
    ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = '#ffcc00';
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]]) ctx.fillRect(hx! - 4, hy! - 4, 8, 8);
    // Thirds, to help level the horizon.
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
    for (const f of [1 / 3, 2 / 3]) {
      ctx.beginPath(); ctx.moveTo(x, y + h * f); ctx.lineTo(x + w, y + h * f); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + w * f, y); ctx.lineTo(x + w * f, y + h); ctx.stroke();
    }
  }, [a, bmp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Crop dragging.
  const onDown = (e: React.MouseEvent) => {
    const g = geom();
    if (!g || e.button !== 0) return;
    const r = canvasRef.current!.getBoundingClientRect();
    const sx = PW / r.width, sy = PH / r.height;
    const nx = (cx: number) => ((cx - r.left) * sx - g.box.x) / g.box.w, ny = (cy: number) => ((cy - r.top) * sy - g.box.y) / g.box.h;
    const px = nx(e.clientX), py = ny(e.clientY);
    const c0 = aRef.current.crop;
    const tol = 8 / g.box.w, tolY = 8 / g.box.h;
    const nearL = Math.abs(px - c0.x) < tol, nearR = Math.abs(px - (c0.x + c0.w)) < tol;
    const nearT = Math.abs(py - c0.y) < tolY, nearB = Math.abs(py - (c0.y + c0.h)) < tolY;
    const inX = px > c0.x - tol && px < c0.x + c0.w + tol, inY = py > c0.y - tolY && py < c0.y + c0.h + tolY;
    let handle: Handle = 'new';
    if (inX && inY) {
      const v2 = nearT ? 'n' : nearB ? 's' : '', h2 = nearL ? 'w' : nearR ? 'e' : '';
      handle = (v2 + h2 || 'move') as Handle;
    }
    const doc = canvasRef.current!.ownerDocument;
    const move = (m: MouseEvent) => {
      const qx = Math.min(1, Math.max(0, nx(m.clientX))), qy = Math.min(1, Math.max(0, ny(m.clientY)));
      let c: CropRect = { ...c0 };
      if (handle === 'move') c = { ...c0, x: c0.x + qx - px, y: c0.y + qy - py };
      else if (handle === 'new') c = { x: Math.min(px, qx), y: Math.min(py, qy), w: Math.abs(qx - px), h: Math.abs(qy - py) };
      else {
        let x0 = c0.x, y0 = c0.y, x1 = c0.x + c0.w, y1 = c0.y + c0.h;
        if (handle.includes('w')) x0 = Math.min(qx, x1 - 0.05);
        if (handle.includes('e')) x1 = Math.max(qx, x0 + 0.05);
        if (handle.includes('n')) y0 = Math.min(qy, y1 - 0.05);
        if (handle.includes('s')) y1 = Math.max(qy, y0 + 0.05);
        c = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      setA((p) => ({ ...p, crop: clampCrop(c) }));
    };
    const up = () => { doc.removeEventListener('mousemove', move); doc.removeEventListener('mouseup', up); };
    doc.addEventListener('mousemove', move);
    doc.addEventListener('mouseup', up);
  };

  const turn = (op: 'cw' | 'ccw' | 'flipH' | 'flipV') => setA((p) => ({
    ...p,
    rot: op === 'cw' ? rotateStep(p.rot, 1) : op === 'ccw' ? rotateStep(p.rot, -1) : p.rot,
    flipH: op === 'flipH' ? !p.flipH : p.flipH,
    flipV: op === 'flipV' ? !p.flipV : p.flipV,
    crop: turnCrop(p.crop, op),
  }));
  const cornerFree = () => {
    const g = geom();
    if (g) setA((p) => ({ ...p, crop: cornerFreeCrop(g.o.w, g.o.h, p.fine) }));
  };
  const out = (() => {
    const g = geom();
    return g ? `${Math.round(g.o.w * a.crop.w)} × ${Math.round(g.o.h * a.crop.h)}` : '';
  })();

  if (!v) return null;
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal adjust" role="dialog" aria-label="Adjust video">
        <h3>Adjust {v.name}</h3>
        <div className="adjust-tools">
          <button onClick={() => turn('ccw')} title="Rotate 90° counter-clockwise" aria-label="Rotate left">⟲ 90°</button>
          <button onClick={() => turn('cw')} title="Rotate 90° clockwise" aria-label="Rotate right">⟳ 90°</button>
          <button className={a.flipH ? 'on' : ''} onClick={() => turn('flipH')} title="Mirror left ↔ right" aria-label="Mirror">↔ Mirror</button>
          <button className={a.flipV ? 'on' : ''} onClick={() => turn('flipV')} title="Flip upside down" aria-label="Flip">↕ Flip</button>
          <label title="Straighten: turn the picture by a small angle (clockwise +)">Straighten
            <input type="range" min={-45} max={45} step={0.1} value={a.fine} onChange={(e) => setA({ ...a, fine: Number(e.target.value) })} aria-label="Straighten" />
            <input type="number" min={-45} max={45} step={0.1} value={a.fine} onChange={(e) => setA({ ...a, fine: Math.max(-45, Math.min(45, Number(e.target.value) || 0)) })} style={{ width: 58 }} aria-label="Straighten degrees" />°
          </label>
          <button onClick={cornerFree} disabled={!a.fine} title="Crop to the largest picture without the black corners the straightening leaves">Crop out corners</button>
          <button onClick={() => setA({ ...a, crop: FULL_CROP })} title="Show the whole picture">Reset crop</button>
        </div>
        <canvas ref={canvasRef} width={PW} height={PH} className="adjust-preview" onMouseDown={onDown} aria-label="Crop" />
        <div className="muted small">Drag the yellow box's edges or corners to crop, inside it to move it, or outside it to draw a new one. Output {out} px. The file isn't changed: this applies wherever the video is shown or exported.</div>
        <div className="modal-actions">
          <button onClick={() => setA(NO_ADJUST)} disabled={isIdentity(a)}>Reset all</button>
          <span className="muted" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => { setAdjust(id, a); onClose(); }}>Apply</button>
        </div>
      </div>
    </div>
  );
}
