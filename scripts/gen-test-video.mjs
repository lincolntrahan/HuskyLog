// Generates synthetic test clips with the frame number and PTS burned in, so
// frame-accurate seeking can be verified by eye and by the e2e harness.
// Dev-only: uses the ffmpeg-static binary (not shipped with the app).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const out = join(import.meta.dirname, '..', 'test-data', 'generated');
mkdirSync(out, { recursive: true });

const font = 'C\\:/Windows/Fonts/consola.ttf';
const text = (extra = '') =>
  `drawtext=fontfile='${font}':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.7:x=40:y=40:` +
  `text='frame %{n}  t=%{pts\\:flt}${extra}'`;
const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60:duration=10'];

const clips = [
  // H.264 with B-frames (frames are stored out of display order), GOP 2 s.
  ['h264_60fps_bframes.mp4', [...src, '-vf', text(), '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '120', '-pix_fmt', 'yuv420p']],
  // HEVC tagged hvc1, like iPhone footage.
  ['hevc_60fps.mp4', [...src, '-vf', text(), '-c:v', 'libx265', '-preset', 'fast', '-x265-params', 'keyint=60:log-level=error', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p']],
  // Variable frame rate: drop every 5th frame and keep original timestamps.
  ['h264_vfr.mp4', [...src, '-vf', `select='mod(n\\,5)',${text()}`, '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p']],
];

for (const [name, args] of clips) {
  const dst = join(out, name);
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, dst], { stdio: 'inherit' });
  console.log('wrote', dst);
}
