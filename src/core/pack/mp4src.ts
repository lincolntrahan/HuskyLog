import type { SrcTrack } from './mp4mux';

/**
 * Track tables of a parsed mp4box file, in the form the muxer wants.
 * The raw stsd box is not copied here: its byte range is returned so the
 * caller can read the exact original bytes (`stsdRange`).
 */
interface Mp4Sample { offset: number; size: number; dts: number; cts: number; duration: number; is_sync: boolean }
interface Mp4Trak {
  samples: Mp4Sample[];
  mdia: { mdhd: { timescale: number }; minf: { stbl: { stsd: { start: number; size: number } } } };
  tkhd: { matrix: ArrayLike<number>; width: number; height: number };
  edts?: { elst?: { entries: { segment_duration: number; media_time: number }[] } };
}
export interface Mp4Like {
  getTrackById(id: number): unknown;
  moov?: { mvhd?: { timescale: number } };
}
export interface TrackInfo { id: number; kind: 'video' | 'audio' }

export function editShift(file: Mp4Like, trak: Pick<Mp4Trak, 'mdia' | 'edts'>): number {
  const movieTs = file.moov?.mvhd?.timescale ?? 1000;
  let shift = 0;
  for (const e of trak.edts?.elst?.entries ?? []) {
    if (e.media_time === -1) shift += e.segment_duration / movieTs;
    else { shift -= e.media_time / trak.mdia.mdhd.timescale; break; }
  }
  return shift;
}

export function srcTrack(file: Mp4Like, t: TrackInfo): { track: Omit<SrcTrack, 'stsd'>; stsdRange: { start: number; size: number } } {
  const trak = file.getTrackById(t.id) as Mp4Trak;
  const stsd = trak.mdia.minf.stbl.stsd;
  return {
    track: {
      kind: t.kind,
      timescale: trak.mdia.mdhd.timescale,
      samples: trak.samples.map((s) => ({ offset: s.offset, size: s.size, dts: s.dts, cts: s.cts, duration: s.duration, sync: t.kind === 'audio' ? true : s.is_sync })),
      shift: editShift(file, trak),
      ...(t.kind === 'video' ? { width: trak.tkhd.width / 65536 || undefined, height: trak.tkhd.height / 65536 || undefined, matrix: Array.from(trak.tkhd.matrix) } : {}),
    },
    stsdRange: { start: stsd.start, size: stsd.size },
  };
}
