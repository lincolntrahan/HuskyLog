import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Minimal ZIP reader/writer for .hlpack (DESIGN §11.2). No dependency.
 *  - Always ZIP64 (entries and packs larger than 4 GB), UTF-8 names.
 *  - Entries are streamed: sizes and CRC are patched into the local header
 *    afterwards, so multi-GB media never sits in memory.
 *  - "store" entries can be served straight out of the zip by byte range
 *    (open-in-place), so media is never extracted.
 *  - A SHA-256 per entry is computed in the same pass, for the manifest.
 */

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50, SIG_Z64_LOC = 0x07064b50;
const FLAG_UTF8 = 0x0800;
const VERSION = 45; // 4.5: ZIP64

export type Method = 'store' | 'deflate';
export interface ZipEntry {
  name: string;
  method: Method;
  crc: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
  /** Absolute offset of the entry data in the file (filled by readZip). */
  dataOffset: number;
  sha256?: string;
  mtime: Date;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
function fromDos(time: number, date: number): Date {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0xf) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** Streaming zip writer. Call add*() in sequence, then finish(). */
export class ZipWriter {
  private pos = 0;
  readonly entries: ZipEntry[] = [];
  private constructor(private fh: FileHandle, private keepCentral: ZipEntry[] = []) {}

  static async create(path: string): Promise<ZipWriter> {
    return new ZipWriter(await open(path, 'w'));
  }
  /** Opens an existing zip to append entries after everything already there. */
  static async append(path: string, keep: ZipEntry[]): Promise<ZipWriter> {
    const fh = await open(path, 'r+');
    const w = new ZipWriter(fh, keep);
    w.pos = (await fh.stat()).size;
    return w;
  }

  get bytesWritten(): number { return this.pos; }

  private async write(buf: Uint8Array, at = this.pos): Promise<void> {
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, at + off);
      off += bytesWritten;
    }
    if (at === this.pos) this.pos += buf.length;
  }

  /**
   * Adds an entry from an async source of chunks. `onBytes` reports
   * uncompressed bytes consumed (progress). Returns the entry.
   */
  async addStream(name: string, source: AsyncIterable<Uint8Array>, method: Method, onBytes?: (n: number) => void, mtime = new Date()): Promise<ZipEntry> {
    const nameBuf = Buffer.from(name, 'utf8');
    const headerOffset = this.pos;
    const { time, date } = dosTime(mtime);
    const h = Buffer.alloc(30 + nameBuf.length + 20);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(VERSION, 4);
    h.writeUInt16LE(FLAG_UTF8, 6);
    h.writeUInt16LE(method === 'store' ? 0 : 8, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(0, 14);                // crc, patched
    h.writeUInt32LE(0xffffffff, 18);       // sizes live in the ZIP64 extra
    h.writeUInt32LE(0xffffffff, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(20, 28);
    nameBuf.copy(h, 30);
    const ex = 30 + nameBuf.length;
    h.writeUInt16LE(0x0001, ex);
    h.writeUInt16LE(16, ex + 2);           // usize64, csize64 (patched)
    await this.write(h);
    const dataOffset = this.pos;

    let crc = 0, size = 0;
    const sha = createHash('sha256');
    if (method === 'store') {
      for await (const chunk of source) {
        crc = crc32(chunk, crc); size += chunk.length; sha.update(chunk);
        await this.write(chunk);
        onBytes?.(chunk.length);
      }
    } else {
      const deflate = createDeflateRaw({ level: 6 });
      const drain = (async () => { for await (const out of deflate) await this.write(out as Buffer); })();
      for await (const chunk of source) {
        crc = crc32(chunk, crc); size += chunk.length; sha.update(chunk);
        if (!deflate.write(chunk)) await new Promise<void>((r) => deflate.once('drain', () => r()));
        onBytes?.(chunk.length);
      }
      deflate.end();
      await drain;
    }
    const compressedSize = this.pos - dataOffset;
    const patch = Buffer.alloc(4);
    patch.writeUInt32LE(crc >>> 0, 0);
    await this.write(patch, headerOffset + 14);
    const sizes = Buffer.alloc(16);
    sizes.writeBigUInt64LE(BigInt(size), 0);
    sizes.writeBigUInt64LE(BigInt(compressedSize), 8);
    await this.write(sizes, headerOffset + ex + 4);
    const e: ZipEntry = { name, method, crc: crc >>> 0, compressedSize, size, headerOffset, dataOffset, sha256: sha.digest('hex'), mtime };
    this.entries.push(e);
    return e;
  }

  addBuffer(name: string, data: Uint8Array, method: Method = 'deflate'): Promise<ZipEntry> {
    return this.addStream(name, (async function* () { yield data; })(), method);
  }

  /** Adds a byte range of a file (or the whole file). */
  addFile(name: string, path: string, method: Method, onBytes?: (n: number) => void, range?: { start: number; end: number }): Promise<ZipEntry> {
    const s = createReadStream(path, { highWaterMark: 1 << 20, ...(range ? { start: range.start, end: range.end - 1 } : {}) });
    return this.addStream(name, s as AsyncIterable<Uint8Array>, method, onBytes);
  }

  /** Writes the central directory (kept entries first) and closes the file. */
  async finish(): Promise<ZipEntry[]> {
    const all = [...this.keepCentral, ...this.entries];
    const cdStart = this.pos;
    for (const e of all) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const { time, date } = dosTime(e.mtime);
      const c = Buffer.alloc(46 + nameBuf.length + 28);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt16LE(VERSION, 4);
      c.writeUInt16LE(VERSION, 6);
      c.writeUInt16LE(FLAG_UTF8, 8);
      c.writeUInt16LE(e.method === 'store' ? 0 : 8, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(0xffffffff, 20);
      c.writeUInt32LE(0xffffffff, 24);
      c.writeUInt16LE(nameBuf.length, 28);
      c.writeUInt16LE(28, 30);               // extra length
      c.writeUInt32LE(0xffffffff, 42);       // header offset in ZIP64 extra
      nameBuf.copy(c, 46);
      const ex = 46 + nameBuf.length;
      c.writeUInt16LE(0x0001, ex);
      c.writeUInt16LE(24, ex + 2);
      c.writeBigUInt64LE(BigInt(e.size), ex + 4);
      c.writeBigUInt64LE(BigInt(e.compressedSize), ex + 12);
      c.writeBigUInt64LE(BigInt(e.headerOffset), ex + 20);
      await this.write(c);
    }
    const cdSize = this.pos - cdStart;
    const z64At = this.pos;
    const z = Buffer.alloc(56 + 20 + 22);
    z.writeUInt32LE(SIG_Z64_EOCD, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(VERSION, 12);
    z.writeUInt16LE(VERSION, 14);
    z.writeBigUInt64LE(BigInt(all.length), 24);
    z.writeBigUInt64LE(BigInt(all.length), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdStart), 48);
    z.writeUInt32LE(SIG_Z64_LOC, 56);
    z.writeBigUInt64LE(BigInt(z64At), 64);
    z.writeUInt32LE(1, 72);
    z.writeUInt32LE(SIG_EOCD, 76);
    z.writeUInt16LE(0xffff, 84);
    z.writeUInt16LE(0xffff, 86);
    z.writeUInt32LE(0xffffffff, 88);
    z.writeUInt32LE(0xffffffff, 92);
    await this.write(z);
    await this.fh.truncate(this.pos);
    await this.fh.close();
    return all;
  }

  /** Abandons the file (caller deletes it). */
  async abort(): Promise<void> { await this.fh.close().catch(() => undefined); }
}

/** Reads the central directory of a zip (ZIP64 aware) and resolves data offsets. */
export async function readZip(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdStart = tail.readUInt32LE(eocd + 16);
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_Z64_LOC) {
      const z64At = Number(tail.readBigUInt64LE(eocd - 20 + 8));
      const z = Buffer.alloc(56);
      await fh.read(z, 0, 56, z64At);
      if (z.readUInt32LE(0) !== SIG_Z64_EOCD) throw new Error('Corrupt ZIP64 record');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdStart = Number(z.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdStart);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Corrupt central directory');
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12), date = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let lho = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      let x = p + 46 + nlen;
      const xend = x + xlen;
      while (x + 4 <= xend) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      p = xend + clen;
      if (method !== 0 && method !== 8) throw new Error(`Unsupported compression in ${name}`);
      out.push({ name, method: method === 0 ? 'store' : 'deflate', crc, compressedSize: csize, size: usize, headerOffset: lho, dataOffset: 0, mtime: fromDos(time, date) });
    }
    const lh = Buffer.alloc(30);
    for (const e of out) {
      await fh.read(lh, 0, 30, e.headerOffset);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Corrupt local header for ${e.name}`);
      e.dataOffset = e.headerOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Reads a (small) entry fully into memory. */
export async function readEntry(path: string, e: ZipEntry): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const raw = Buffer.alloc(e.compressedSize);
    await fh.read(raw, 0, e.compressedSize, e.dataOffset);
    if (e.method === 'store') return raw;
    const chunks: Buffer[] = [];
    const inf = createInflateRaw();
    inf.on('data', (c: Buffer) => chunks.push(c));
    await new Promise<void>((res, rej) => { inf.on('end', res); inf.on('error', rej); inf.end(raw); });
    return Buffer.concat(chunks);
  } finally {
    await fh.close();
  }
}

/** Extracts an entry to a file (streamed). */
export async function extractEntry(path: string, e: ZipEntry, dest: string): Promise<void> {
  if (e.size === 0 || e.compressedSize === 0) { await (await open(dest, 'w')).close(); return; }
  const src = createReadStream(path, { start: e.dataOffset, end: e.dataOffset + e.compressedSize - 1 });
  if (e.method === 'store') await pipeline(src, createWriteStream(dest));
  else await pipeline(src, createInflateRaw(), createWriteStream(dest));
}

/**
 * Replaces small entries of an existing zip without touching the others:
 * new copies are appended and a new central directory written after them, so
 * the offsets of stored media entries stay valid for anyone serving them.
 * The superseded bytes stay in the file as dead space (a few KB per save).
 */
export async function replaceEntries(path: string, files: Record<string, Uint8Array>): Promise<ZipEntry[]> {
  const old = await readZip(path);
  const keep = old.filter((e) => !(e.name in files));
  const w = await ZipWriter.append(path, keep);
  for (const [name, data] of Object.entries(files)) await w.addBuffer(name, data, 'deflate');
  return w.finish();
}
