import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extractEntry, readEntry, readZip, replaceEntries, ZipWriter } from './zip';

const dir = mkdtempSync(join(tmpdir(), 'hlzip-'));

describe('zip', () => {
  it('round-trips stored and deflated entries with ZIP64 headers', async () => {
    const media = randomBytes(5 << 20);
    const text = Buffer.from('{"hello":"wörld"}'.repeat(5000));
    const src = join(dir, 'media.bin');
    writeFileSync(src, media);
    const path = join(dir, 'a.hlpack');
    const w = await ZipWriter.create(path);
    let seen = 0;
    const m = await w.addFile('streams/vid1/clip ü.mp4', src, 'store', (n) => { seen += n; });
    await w.addBuffer('workspace.hlws', text);
    await w.addFile('streams/vid1/part.bin', src, 'deflate', undefined, { start: 100, end: 1100 });
    await w.finish();
    expect(seen).toBe(media.length);
    expect(m.sha256).toBe(createHash('sha256').update(media).digest('hex'));

    const entries = await readZip(path);
    expect(entries.map((e) => e.name)).toEqual(['streams/vid1/clip ü.mp4', 'workspace.hlws', 'streams/vid1/part.bin']);
    const e0 = entries[0]!;
    expect(e0.method).toBe('store');
    expect(e0.size).toBe(media.length);
    // Stored entries can be read straight out of the file by offset (open-in-place).
    const raw = readFileSync(path).subarray(e0.dataOffset, e0.dataOffset + 1000);
    expect(Buffer.compare(raw, media.subarray(0, 1000))).toBe(0);
    expect((await readEntry(path, entries[1]!)).toString()).toBe(text.toString());
    expect(entries[1]!.compressedSize).toBeLessThan(text.length / 10);
    expect(Buffer.compare(await readEntry(path, entries[2]!), media.subarray(100, 1100))).toBe(0);
    const out = join(dir, 'x.bin');
    await extractEntry(path, entries[2]!, out);
    expect(readFileSync(out).length).toBe(1000);
  });

  it('replaces small entries without moving the media', async () => {
    const path = join(dir, 'b.hlpack');
    const media = randomBytes(300_000);
    const w = await ZipWriter.create(path);
    await w.addBuffer('manifest.json', Buffer.from('{"v":1}'));
    await w.addBuffer('streams/v.mp4', media, 'store');
    await w.addBuffer('workspace.hlws', Buffer.from('old'));
    await w.finish();
    const before = await readZip(path);
    await replaceEntries(path, { 'workspace.hlws': Buffer.from('new workspace'), 'manifest.json': Buffer.from('{"v":2}') });
    const after = await readZip(path);
    expect(after.map((e) => e.name).sort()).toEqual(['manifest.json', 'streams/v.mp4', 'workspace.hlws']);
    const mv = (l: typeof after) => l.find((e) => e.name === 'streams/v.mp4')!;
    expect(mv(after).dataOffset).toBe(mv(before).dataOffset);
    expect((await readEntry(path, after.find((e) => e.name === 'workspace.hlws')!)).toString()).toBe('new workspace');
    expect((await readEntry(path, after.find((e) => e.name === 'manifest.json')!)).toString()).toBe('{"v":2}');
  });

  it.runIf(process.platform === 'win32')('is readable by Windows tools (tar and Expand-Archive)', async () => {
    const path = join(dir, 'interop.zip');
    const w = await ZipWriter.create(path);
    await w.addBuffer('a/readme.txt', Buffer.from('hello pack '.repeat(100)));
    await w.addBuffer('b/data.bin', Buffer.alloc(70000, 7), 'store');
    await w.finish();
    const out1 = mkdtempSync(join(dir, 'tar-'));
    // Windows' own bsdtar (Git's GNU tar may be first on PATH).
    execFileSync(join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'tar.exe'), ['-xf', path, '-C', out1]);
    expect(readFileSync(join(out1, 'a', 'readme.txt'), 'utf8')).toBe('hello pack '.repeat(100));
    const out2 = mkdtempSync(join(dir, 'ps-'));
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${path}' -DestinationPath '${out2}'`]);
    expect(readFileSync(join(out2, 'b', 'data.bin')).length).toBe(70000);
  }, 30000);

  it('rejects files that are not zips', async () => {
    const p = join(dir, 'not.zip');
    writeFileSync(p, 'hello');
    await expect(readZip(p)).rejects.toThrow(/Not a zip/);
  });
});
