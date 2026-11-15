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

/** Entries inside an open .hlpack, served straight from the zip (stored, not compressed). */
interface Virtual { file: string; offset: number; size: number; name: string }
const virtuals = new Map<string, Virtual>();

/** Allow-lists a byte range of a file (a pack entry) under a virtual path `<pack>!/<entry>`. */
export function allowVirtual(path: string, file: string, offset: number, size: number): OpenedFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  virtuals.set(path.toLowerCase(), { file, offset, size, name });
  return { path, name, size, url: `hl-file://local/${encodeURIComponent(path)}` };
}

/** Byte range behind a virtual path (for copying a pack entry into a new pack). */
export function virtualSource(path: string): Virtual | undefined {
  return virtuals.get(path.toLowerCase());
}

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
    { scheme: 'hl-tiles', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

export function handleHlFile(): void {
  protocol.handle('hl-file', async (req) => {
    const url = new URL(req.url);
    const abs = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const v = virtuals.get(abs.toLowerCase());
    if (!v && !allowed.has(norm(abs))) return new Response('Forbidden', { status: 403 });
    let size: number;
    const file = v ? v.file : abs, base = v ? v.offset : 0;
    try {
      size = v ? v.size : statSync(abs).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[extname(v ? v.name : abs).toLowerCase()] ?? 'application/octet-stream';
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
      const body = Readable.toWeb(createReadStream(file, { start: base + start, end: base + end })) as ReadableStream;
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1),
        },
      });
    }
    const body = size === 0 ? null : (Readable.toWeb(createReadStream(file, { start: base, end: base + size - 1 })) as ReadableStream);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) },
    });
  });
}
