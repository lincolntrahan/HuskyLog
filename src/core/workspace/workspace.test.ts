import { describe, expect, it } from 'vitest';
import { candidatePaths, contentKey, packEntryName, parseWorkspace, relativePath, stringifyWorkspace, WORKSPACE_VERSION, type Workspace } from './workspace';

const base = (): Workspace => ({
  format: 'huskylog-workspace', version: 1, app: '0.0.1', saved: '2026-11-15T00:00:00Z',
  streams: [{ id: 'log1', kind: 'log', name: 'flight', file: { name: 'flight.bin', size: 10, path: 'C:\\data\\flight.bin', rel: 'flight.bin' } }],
  sync: { events: [], markers: {}, options: {}, reference: null }, layout: { grid: 1 }, expressions: { p: 'BAT.Volt*BAT.Curr' },
  cameras: {}, mapAreas: [], ui: { t: 12, range: null, speed: 1, tab: 'review' },
});

describe('workspace', () => {
  it('round-trips and fills defaults', () => {
    const w = parseWorkspace(stringifyWorkspace(base()));
    expect(w.streams[0]!.id).toBe('log1');
    const sparse = parseWorkspace(JSON.stringify({ format: 'huskylog-workspace', version: 1 }));
    expect(sparse.sync.events).toEqual([]);
    expect(sparse.ui.speed).toBe(1);
  });
  it('rejects other files and newer versions', () => {
    expect(() => parseWorkspace('nope')).toThrow(/not JSON/);
    expect(() => parseWorkspace('{"format":"x","version":1}')).toThrow(/not a HuskyLog/);
    expect(() => parseWorkspace(JSON.stringify({ format: 'huskylog-workspace', version: WORKSPACE_VERSION + 1 }))).toThrow(/newer/);
  });
  it('ignores the playhead and save time for unsaved-changes', () => {
    const a = base(), b = { ...base(), saved: 'later', ui: { ...base().ui, t: 99 } };
    expect(contentKey(a)).toBe(contentKey(b));
    expect(contentKey(a)).not.toBe(contentKey({ ...a, expressions: {} }));
  });
  it('computes relative paths and candidates', () => {
    expect(relativePath('C:\\work\\session', 'C:\\work\\session\\logs\\a.bin')).toBe('logs/a.bin');
    expect(relativePath('C:\\work\\session', 'C:\\work\\videos\\a.mp4')).toBe('../videos/a.mp4');
    expect(relativePath('C:\\work', 'D:\\a.mp4')).toBeUndefined();
    expect(relativePath('c:\\Work', 'C:\\work\\A.bin')).toBe('A.bin');
    const c = candidatePaths({ name: 'a.mp4', size: 1, rel: '../videos/a.mp4', path: 'E:\\old\\a.mp4' }, 'D:\\usb\\session');
    expect(c).toEqual(['D:\\usb\\videos\\a.mp4', 'E:\\old\\a.mp4', 'D:\\usb\\session\\a.mp4']);
  });
  it('makes safe pack entry names', () => {
    expect(packEntryName({ id: 'vid1' }, 'GX01:23?.MP4')).toBe('streams/vid1/GX01_23_.MP4');
  });
});
