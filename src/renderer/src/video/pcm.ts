/**
 * Uncompressed (PCM) audio in MOV/MP4: what some cameras record (e.g.
 * 'sowt' = 16-bit little-endian). Browser decoders don't take raw PCM, and
 * mp4box neither recognises the QuickTime sound description nor copes with
 * the sample table: it lists every audio frame as its own sample (14.5 M
 * entries, 3 GB of memory, for a 7.5 min clip). So the track is skipped by
 * mp4box and read here at chunk level.
 */

export const PCM_TYPES = new Set(['sowt', 'twos', 'lpcm', 'ipcm', 'fpcm', 'in24', 'in32', 'fl32', 'fl64', 'raw ', 'NONE']);

export interface PcmFormat {
  type: string;
  sampleRate: number;
  channels: number;
  bits: 8 | 16 | 24 | 32 | 64;
  float: boolean;
  little: boolean;
  unsigned: boolean;     // 'raw ' / 8-bit
  bytesPerFrame: number;
}
export interface PcmChunk { offset: number; frames: number; first: number /* index of its first frame */ }
export interface PcmTrack {
  fmt: PcmFormat;
  chunks: PcmChunk[];
  frames: number;
  /** Seconds per frame and time of frame 0 (edit list applied). */
  frameDur: number;
  start: number;
}

type Stbl = {
  stsd: { entries: { type: string; data?: Uint8Array | ArrayBuffer | number[] }[] };
  stco?: { chunk_offsets: number[] }; co64?: { chunk_offsets: number[] };
  stsc: { first_chunk: number[]; samples_per_chunk: number[] };
  stts?: { sample_counts: number[]; sample_deltas: number[] };
};

/**
 * The sound sample description (QuickTime v0/v1/v2 or ISO). `data` is the
 * entry body after data_reference_index, as mp4box keeps it for unknown types.
 */
export function parseSoundDescription(type: string, data: Uint8Array): PcmFormat | null {
  if (data.length < 20) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = dv.getUint16(0);
  let channels = dv.getUint16(8);
  let bits = dv.getUint16(10);
  let sampleRate = dv.getUint32(16) / 65536;
  let float = type === 'fl32' || type === 'fl64' || type === 'fpcm';
  let little = type === 'sowt';
  let bytesPerFrame = 0;
  if (version === 1 && data.length >= 36) {
    bytesPerFrame = dv.getUint32(28);
  } else if (version === 2 && data.length >= 56) {
    // v2: sizeOfStructOnly, audioSampleRate (f64), numAudioChannels, 0x7F000000,
    // constBitsPerChannel, formatSpecificFlags, constBytesPerAudioPacket, constLPCMFramesPerAudioPacket
    sampleRate = dv.getFloat64(24);
    channels = dv.getUint32(32);
    bits = dv.getUint32(40);
    const flags = dv.getUint32(44);
    float = (flags & 1) !== 0;
    little = (flags & 2) === 0; // kAudioFormatFlagIsBigEndian
    bytesPerFrame = dv.getUint32(48);
  }
  if (type === 'twos' || type === 'in24' || type === 'in32' || type === 'fl32' || type === 'fl64') little = false;
  if (type === 'in24') bits = 24;
  if (type === 'in32' || type === 'fl32') bits = 32;
  if (type === 'fl64') bits = 64;
  if (type === 'raw ') bits = 8;
  if (![8, 16, 24, 32, 64].includes(bits) || !channels || !(sampleRate > 0)) return null;
  if (!bytesPerFrame) bytesPerFrame = (channels * bits) / 8;
  return { type, sampleRate, channels, bits: bits as PcmFormat['bits'], float, little, unsigned: bits === 8, bytesPerFrame };
}

/** Chunk table of a PCM track (stco/co64 + stsc), counting frames per chunk. */
export function pcmChunks(stbl: Stbl): { chunks: PcmChunk[]; frames: number } {
  const offsets = (stbl.stco ?? stbl.co64)?.chunk_offsets ?? [];
  const fc = stbl.stsc.first_chunk, spc = stbl.stsc.samples_per_chunk;
  const chunks: PcmChunk[] = [];
  let frames = 0;
  for (let r = 0; r < fc.length; r++) {
    const from = fc[r]! - 1, to = (r + 1 < fc.length ? fc[r + 1]! - 1 : offsets.length);
    for (let c = from; c < to; c++) {
      chunks.push({ offset: offsets[c]!, frames: spc[r]!, first: frames });
      frames += spc[r]!;
    }
  }
  return { chunks, frames };
}

/** Decodes interleaved PCM bytes into one Float32Array per channel. */
export function decodePcm(bytes: Uint8Array, fmt: PcmFormat, frames = Math.floor(bytes.length / fmt.bytesPerFrame)): Float32Array[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const planes = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  const bps = fmt.bits / 8, le = fmt.little;
  for (let f = 0; f < frames; f++) {
    const base = f * fmt.bytesPerFrame;
    for (let c = 0; c < fmt.channels; c++) {
      const o = base + c * bps;
      let v: number;
      if (fmt.float) v = fmt.bits === 64 ? dv.getFloat64(o, le) : dv.getFloat32(o, le);
      else if (fmt.bits === 16) v = dv.getInt16(o, le) / 32768;
      else if (fmt.bits === 8) v = fmt.unsigned ? (dv.getUint8(o) - 128) / 128 : dv.getInt8(o) / 128;
      else if (fmt.bits === 24) {
        const b0 = dv.getUint8(o), b1 = dv.getUint8(o + 1), b2 = dv.getUint8(o + 2);
        let x = le ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
        if (x & 0x800000) x -= 0x1000000;
        v = x / 8388608;
      } else v = dv.getInt32(o, le) / 2147483648;
      planes[c]![f] = v;
    }
  }
  return planes;
}

/** Groups chunks into reads of nearby bytes (audio chunks sit between video chunks). */
export function pcmReadRuns(t: PcmTrack, firstFrame: number, lastFrame: number, maxBytes = 8 << 20, maxGap = 256 << 10): { start: number; end: number; chunks: PcmChunk[] }[] {
  const bpf = t.fmt.bytesPerFrame;
  const want = t.chunks.filter((c) => c.first + c.frames > firstFrame && c.first <= lastFrame);
  const runs: { start: number; end: number; chunks: PcmChunk[] }[] = [];
  for (const c of want) {
    const end = c.offset + c.frames * bpf;
    const r = runs[runs.length - 1];
    if (r && c.offset >= r.end && c.offset - r.end < maxGap && end - r.start < maxBytes) { r.end = end; r.chunks.push(c); }
    else runs.push({ start: c.offset, end, chunks: [c] });
  }
  return runs;
}
