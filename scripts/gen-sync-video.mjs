// Synthetic "ground camera" clip with a KNOWN mapping to the reference log, for
// testing the Sync tab end to end. Dev-only (uses ffmpeg-static).
//
// Ground truth: master = A · local + B, with A = 1.0003 (camera clock 300 ppm
// fast) and B = 297.5 (recording started at log time 297.5 s).
// Events (master time): "Prop start" at 314.20 s → white flash + motor noise;
//                       "Wave"       at 400.00 s → white flash + 1 kHz beep.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const TRUTH = { A: 1.0003, B: 297.5, events: { 'Prop start': 314.2, Wave: 400.0 } };
const local = (m) => (m - TRUTH.B) / TRUTH.A;
const L1 = local(TRUTH.events['Prop start']), L2 = local(TRUTH.events.Wave);
const DUR = 112;

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const out = join(import.meta.dirname, '..', 'test-data', 'generated');
mkdirSync(out, { recursive: true });
const font = 'C\\:/Windows/Fonts/consola.ttf';
const flash = `between(t,${L1.toFixed(6)},${(L1 + 0.2).toFixed(6)})+between(t,${L2.toFixed(6)},${(L2 + 0.2).toFixed(6)})`;
const vf = [
  `drawtext=fontfile='${font}':fontsize=48:fontcolor=white:x=40:y=40:text='GROUND CAM  t=%{pts\\:flt}'`,
  `drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='${flash}'`,
].join(',');
const audio = `0.01*(random(0)-0.5)+if(between(t,${L1.toFixed(6)},${(L1 + 3).toFixed(6)}),0.5*sin(2*PI*180*t)+0.3*(random(1)-0.5),0)+if(between(t,${L2.toFixed(6)},${(L2 + 0.3).toFixed(6)}),0.8*sin(2*PI*1000*t),0)`;
const dst = join(out, 'ground_cam_sync.mp4');
execFileSync(ffmpeg, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `color=c=0x1d2a38:s=1280x720:r=30:d=${DUR}`,
  '-f', 'lavfi', '-i', `aevalsrc='${audio}':s=48000:d=${DUR}`,
  '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-shortest', dst,
], { stdio: 'inherit' });
writeFileSync(join(out, 'ground_cam_sync.truth.json'), JSON.stringify({ ...TRUTH, localEvents: { 'Prop start': L1, Wave: L2 } }, null, 2));
console.log('wrote', dst, `(flashes at local ${L1.toFixed(4)} s and ${L2.toFixed(4)} s)`);
