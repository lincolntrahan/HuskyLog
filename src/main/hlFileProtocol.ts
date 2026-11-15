import { protocol } from 'electron';
import { createReadStream, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { OpenedFile } from '../shared/ipc';

/**
 * hl-file:// serves local files the user has explicitly opened, with HTTP range
 * support so <video>, fetch() and WebCodecs demuxing can read multi-GB files
 * without loading them whole. Later phases add entries inside an open .hlpack.
 *
 * URL form: hl-file://local/<encodeURIComponent(absolute path)>
 */

const allowed = new Set<string>();
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.csv': 'text/csv', '.json': 'application/json',
};

const norm = (p: string) => resolve(p).toLowerCase();

export function allowFile(path: string): OpenedFile {
  const abs = resolve(path);
  allowed.add(norm(abs));
  const st = statSync(abs);
  return { path: abs, name: basename(abs), size: st.size, url: `hl-file://local/${encodeURIComponent(abs)}` };
}

export function registerHlFileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'hl-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

export function handleHlFile(): void {
  protocol.handle('hl-file', async (req) => {
    const url = new URL(req.url);
    const abs = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!allowed.has(norm(abs))) return new Response('Forbidden', { status: 403 });
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.get('range');
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      let start: number, end: number;
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
        end = size - 1;
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1),
        },
      });
    }
    const body = Readable.toWeb(createReadStream(abs)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) },
    });
  });
}
