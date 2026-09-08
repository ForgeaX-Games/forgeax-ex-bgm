/**
 * Measure clip length from bytes. WAV is exact from the header; MP3 is a
 * CBR/Xing estimate; Ogg is exact from the last page's granule position.
 * Loudness stays out of Node — no ffmpeg here.
 */

import { inferArchetypeId, isEventArchetypeId, type EventArchetypeId } from '../shared/event-archetypes.ts';

/** High-frequency one-shots that must stay short. Epic tails belong on rare-loot. */
export const HIGH_FREQUENCY_ARCHETYPES: readonly EventArchetypeId[] = [
  'impact',
  'defeat',
  'pickup',
  'ui',
  'footstep',
  'weapon-fire',
  'attack',
  'hurt',
  'jump',
];

export const HIGH_FREQUENCY_DURATION_WARN_MS = 1500;

const MPEG1_L3_BITRATE = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATE = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MPEG1_RATES = [44100, 48000, 32000];
const MPEG2_RATES = [22050, 24000, 16000];
const MPEG25_RATES = [11025, 12000, 8000];

function fourCC(bytes: Buffer, offset: number): string {
  return bytes.toString('ascii', offset, offset + 4);
}

export function measureWavDurationMs(bytes: Buffer): number | undefined {
  if (bytes.length < 12) return undefined;
  if (fourCC(bytes, 0) !== 'RIFF' || fourCC(bytes, 8) !== 'WAVE') return undefined;
  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (offset + 8 <= bytes.length) {
    const id = fourCC(bytes, offset);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && size >= 16 && start + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(start + 8);
    } else if (id === 'data') {
      dataSize = size;
    }
    const next = start + size + (size % 2);
    if (next <= offset) break;
    offset = next;
  }
  if (!byteRate || byteRate <= 0 || dataSize === undefined || dataSize < 0) return undefined;
  return Math.max(0, Math.round((dataSize / byteRate) * 1000));
}

function skipId3v2(bytes: Buffer): number {
  if (bytes.length < 10 || fourCC(bytes, 0).slice(0, 3) !== 'ID3') return 0;
  const size = ((bytes[6]! & 0x7f) << 21)
    | ((bytes[7]! & 0x7f) << 14)
    | ((bytes[8]! & 0x7f) << 7)
    | (bytes[9]! & 0x7f);
  return Math.min(bytes.length, 10 + size);
}

interface Mp3Frame {
  bitrateKbps: number;
  sampleRate: number;
  frameSize: number;
  samplesPerFrame: number;
  mpeg1: boolean;
  channels: number;
}

function parseMp3Frame(bytes: Buffer, offset: number): Mp3Frame | undefined {
  if (offset + 4 > bytes.length) return undefined;
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) return undefined;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  const versionBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  if (layerBits !== 1) return undefined;
  const bitrateIndex = (b2 >> 4) & 0xf;
  const rateIndex = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  let mpeg1 = false;
  let sampleRate: number | undefined;
  if (versionBits === 3) {
    mpeg1 = true;
    sampleRate = MPEG1_RATES[rateIndex];
  } else if (versionBits === 2) {
    sampleRate = MPEG2_RATES[rateIndex];
  } else if (versionBits === 0) {
    sampleRate = MPEG25_RATES[rateIndex];
  }
  const bitrateKbps = mpeg1 ? MPEG1_L3_BITRATE[bitrateIndex] : MPEG2_L3_BITRATE[bitrateIndex];
  if (!bitrateKbps || !sampleRate) return undefined;
  const samplesPerFrame = mpeg1 ? 1152 : 576;
  const frameSize = Math.floor((samplesPerFrame / 8) * bitrateKbps * 1000 / sampleRate) + padding;
  if (frameSize < 4) return undefined;
  const channelMode = (b3 >> 6) & 0x3;
  return {
    bitrateKbps,
    sampleRate,
    frameSize,
    samplesPerFrame,
    mpeg1,
    channels: channelMode === 3 ? 1 : 2,
  };
}

function xingFrames(bytes: Buffer, headerOffset: number, frame: Mp3Frame): number | undefined {
  const sideInfo = frame.mpeg1 ? (frame.channels === 1 ? 17 : 32) : (frame.channels === 1 ? 9 : 17);
  const tagOffset = headerOffset + 4 + sideInfo;
  if (tagOffset + 8 > bytes.length) return undefined;
  const tag = fourCC(bytes, tagOffset);
  if (tag !== 'Xing' && tag !== 'Info') return undefined;
  const flags = bytes.readUInt32BE(tagOffset + 4);
  if ((flags & 0x1) === 0 || tagOffset + 12 > bytes.length) return undefined;
  const frames = bytes.readUInt32BE(tagOffset + 8);
  return frames > 0 ? frames : undefined;
}

export function measureMp3DurationMs(bytes: Buffer): number | undefined {
  const start = skipId3v2(bytes);
  let offset = start;
  let frame: Mp3Frame | undefined;
  while (offset + 4 <= bytes.length) {
    frame = parseMp3Frame(bytes, offset);
    if (frame) break;
    offset += 1;
  }
  if (!frame) return undefined;
  const frames = xingFrames(bytes, offset, frame);
  if (frames) {
    return Math.round((frames * frame.samplesPerFrame / frame.sampleRate) * 1000);
  }
  const payload = Math.max(0, bytes.length - start);
  return Math.round((payload * 8) / frame.bitrateKbps);
}

/** Granule position on a page whose packet does not complete there. */
const OGG_GRANULE_NONE = 0xffffffffffffffffn;

interface OggPage {
  granulePosition: bigint;
  serial: number;
  dataStart: number;
  dataLength: number;
  next: number;
}

function readOggPage(bytes: Buffer, offset: number): OggPage | undefined {
  if (offset + 27 > bytes.length || fourCC(bytes, offset) !== 'OggS') return undefined;
  const segments = bytes[offset + 26]!;
  const tableEnd = offset + 27 + segments;
  if (tableEnd > bytes.length) return undefined;
  let dataLength = 0;
  for (let index = 0; index < segments; index += 1) dataLength += bytes[tableEnd - segments + index]!;
  const next = tableEnd + dataLength;
  if (next > bytes.length || next <= offset) return undefined;
  return {
    granulePosition: bytes.readBigUInt64LE(offset + 6),
    serial: bytes.readUInt32LE(offset + 14),
    dataStart: tableEnd,
    dataLength,
    next,
  };
}

/**
 * Ogg carries elapsed samples in every page header, so walking the pages gives
 * an exact length for Vorbis and Opus without decoding. Opus granules are
 * always 48 kHz and include the encoder's pre-skip, which is not audio.
 */
export function measureOggDurationMs(bytes: Buffer): number | undefined {
  let offset = 0;
  let sampleRate: number | undefined;
  let streamSerial: number | undefined;
  let preSkip = 0;
  let lastGranule: bigint | undefined;

  while (offset < bytes.length) {
    const page = readOggPage(bytes, offset);
    if (!page) break;
    if (sampleRate === undefined && page.dataLength >= 19) {
      const start = page.dataStart;
      if (bytes[start] === 0x01 && bytes.toString('ascii', start + 1, start + 7) === 'vorbis') {
        sampleRate = bytes.readUInt32LE(start + 12);
        streamSerial = page.serial;
      } else if (bytes.toString('ascii', start, start + 8) === 'OpusHead') {
        preSkip = bytes.readUInt16LE(start + 10);
        sampleRate = 48000;
        streamSerial = page.serial;
      }
    }
    if (
      (streamSerial === undefined || page.serial === streamSerial)
      && page.granulePosition !== OGG_GRANULE_NONE
    ) {
      lastGranule = page.granulePosition;
    }
    offset = page.next;
  }

  if (!sampleRate || sampleRate <= 0 || lastGranule === undefined) return undefined;
  const samples = Number(lastGranule) - preSkip;
  if (!Number.isFinite(samples) || samples <= 0) return undefined;
  return Math.round((samples / sampleRate) * 1000);
}

export function measureAudioDurationMs(bytes: Buffer, mimeType?: string): number | undefined {
  const mime = String(mimeType ?? '').toLowerCase();
  if (mime.includes('wav') || (bytes.length >= 12 && fourCC(bytes, 0) === 'RIFF')) {
    const wav = measureWavDurationMs(bytes);
    if (wav !== undefined) return wav;
  }
  if (mime.includes('ogg') || mime.includes('opus') || fourCC(bytes, 0) === 'OggS') {
    const ogg = measureOggDurationMs(bytes);
    if (ogg !== undefined) return ogg;
  }
  if (mime.includes('mpeg') || mime.includes('mp3') || bytes[0] === 0xff || fourCC(bytes, 0).startsWith('ID3')) {
    return measureMp3DurationMs(bytes);
  }
  return undefined;
}

export function highFrequencyDurationWarning(input: {
  durationMs?: number;
  kind?: string;
  eventId?: string;
  archetype?: unknown;
}): string | undefined {
  const durationMs = input.durationMs;
  if (typeof durationMs !== 'number' || durationMs <= HIGH_FREQUENCY_DURATION_WARN_MS) return undefined;
  const kind = String(input.kind ?? '').toLowerCase();
  if (kind === 'bgm' || kind === 'music' || kind === 'voice') return undefined;
  const explicit = isEventArchetypeId(input.archetype) ? input.archetype : undefined;
  const inferred = input.eventId ? inferArchetypeId(input.eventId, kind) : undefined;
  const archetype = explicit ?? inferred;
  if (archetype && !HIGH_FREQUENCY_ARCHETYPES.includes(archetype)) return undefined;
  if (!archetype && kind !== 'sfx') return undefined;
  return (
    `clip is ${durationMs}ms; high-frequency SFX should stay under `
    + `${HIGH_FREQUENCY_DURATION_WARN_MS}ms (epic tails belong on rare-loot)`
  );
}

/** Minimal PCM WAV for tests. */
export function encodeSilenceWav(options: {
  durationMs: number;
  sampleRate?: number;
  channels?: number;
}): Buffer {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 1;
  const bitsPerSample = 16;
  const frameCount = Math.max(0, Math.round(sampleRate * options.durationMs / 1000));
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = frameCount * blockAlign;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}
