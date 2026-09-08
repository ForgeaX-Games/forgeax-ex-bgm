import { describe, expect, test } from 'bun:test';

import {
  HIGH_FREQUENCY_DURATION_WARN_MS,
  encodeSilenceWav,
  highFrequencyDurationWarning,
  measureAudioDurationMs,
  measureMp3DurationMs,
  measureOggDurationMs,
  measureWavDurationMs,
} from './audio-duration.ts';

/** Ogg page carrying `data`, with the page's elapsed-sample count in the header. */
function oggPage(data: Buffer, options: { granule: bigint; serial?: number }): Buffer {
  const segments: number[] = [];
  let remaining = data.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);
  const page = Buffer.alloc(27 + segments.length + data.length);
  page.write('OggS', 0);
  page.writeBigUInt64LE(options.granule, 6);
  page.writeUInt32LE(options.serial ?? 1, 14);
  page[26] = segments.length;
  for (const [index, size] of segments.entries()) page[27 + index] = size;
  data.copy(page, 27 + segments.length);
  return page;
}

function vorbisIdentification(sampleRate: number): Buffer {
  const packet = Buffer.alloc(30);
  packet[0] = 0x01;
  packet.write('vorbis', 1, 'ascii');
  packet.writeUInt8(2, 11);
  packet.writeUInt32LE(sampleRate, 12);
  return packet;
}

function cbrMp3(frames: number): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frameSize = Math.floor((1152 / 8) * 128000 / 44100);
  const bytes = Buffer.alloc(frameSize * frames);
  for (let index = 0; index < frames; index++) {
    header.copy(bytes, index * frameSize);
  }
  return bytes;
}

describe('measureWavDurationMs', () => {
  test('reads PCM length from the header', () => {
    const bytes = encodeSilenceWav({ durationMs: 250, sampleRate: 44100, channels: 1 });
    expect(measureWavDurationMs(bytes)).toBe(250);
    expect(measureAudioDurationMs(bytes, 'audio/wav')).toBe(250);
  });

  test('ignores a truncated RIFF stub', () => {
    expect(measureWavDurationMs(Buffer.from('RIFF'))).toBeUndefined();
  });
});

describe('measureOggDurationMs', () => {
  test('reads elapsed samples from the last page of a Vorbis stream', () => {
    const bytes = Buffer.concat([
      oggPage(vorbisIdentification(48000), { granule: 0n }),
      oggPage(Buffer.alloc(64), { granule: 24000n }),
      oggPage(Buffer.alloc(64), { granule: 96000n }),
    ]);
    expect(measureOggDurationMs(bytes)).toBe(2000);
    expect(measureAudioDurationMs(bytes, 'audio/ogg')).toBe(2000);
  });

  test('ignores pages whose packet does not finish there', () => {
    const bytes = Buffer.concat([
      oggPage(vorbisIdentification(44100), { granule: 0n }),
      oggPage(Buffer.alloc(32), { granule: 44100n }),
      oggPage(Buffer.alloc(32), { granule: 0xffffffffffffffffn }),
    ]);
    expect(measureOggDurationMs(bytes)).toBe(1000);
  });

  test('skips a foreign stream multiplexed into the same container', () => {
    const bytes = Buffer.concat([
      oggPage(vorbisIdentification(48000), { granule: 0n, serial: 7 }),
      oggPage(Buffer.alloc(16), { granule: 48000n, serial: 7 }),
      oggPage(Buffer.alloc(16), { granule: 999999n, serial: 9 }),
    ]);
    expect(measureOggDurationMs(bytes)).toBe(1000);
  });

  test('discounts the Opus pre-skip, which is not audible audio', () => {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.writeUInt16LE(312, 10);
    const bytes = Buffer.concat([
      oggPage(head, { granule: 0n }),
      oggPage(Buffer.alloc(16), { granule: 48312n }),
    ]);
    expect(measureOggDurationMs(bytes)).toBe(1000);
  });

  test('returns nothing for bytes that are not an Ogg container', () => {
    expect(measureOggDurationMs(Buffer.from('not ogg at all'))).toBeUndefined();
    expect(measureOggDurationMs(Buffer.from('OggS'))).toBeUndefined();
  });
});

describe('measureMp3DurationMs', () => {
  test('estimates CBR duration from bitrate and payload size', () => {
    const bytes = cbrMp3(10);
    expect(measureMp3DurationMs(bytes)).toBe(Math.round((bytes.length * 8) / 128));
  });

  test('prefers a Xing frame count when present', () => {
    const bytes = cbrMp3(2);
    bytes.write('Xing', 36);
    bytes.writeUInt32BE(0x1, 40);
    bytes.writeUInt32BE(100, 44);
    expect(measureMp3DurationMs(bytes)).toBe(Math.round((100 * 1152 / 44100) * 1000));
  });
});

describe('highFrequencyDurationWarning', () => {
  test('flags a long pickup and leaves rare-loot alone', () => {
    expect(highFrequencyDurationWarning({
      durationMs: HIGH_FREQUENCY_DURATION_WARN_MS + 400,
      kind: 'sfx',
      eventId: 'item.pickup',
    })).toMatch(/1500ms/);
    expect(highFrequencyDurationWarning({
      durationMs: 2900,
      kind: 'sfx',
      eventId: 'chest.epic-loot',
    })).toBeUndefined();
    expect(highFrequencyDurationWarning({
      durationMs: 800,
      kind: 'sfx',
      eventId: 'combat.hit',
    })).toBeUndefined();
  });
});
