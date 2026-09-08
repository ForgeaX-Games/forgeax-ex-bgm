import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { resolveGameAudioFile } from './audio-file-resolve.ts';

const gameDir = resolve('/tmp/forgeax-audio-resolve/demo');

describe('resolveGameAudioFile', () => {
  test('resolves both allowed prefixes into the matching directory', () => {
    expect(resolveGameAudioFile(gameDir, 'audio/hit.wav'))
      .toBe(resolve(gameDir, 'audio/hit.wav'));
    expect(resolveGameAudioFile(gameDir, 'hit.wav'))
      .toBe(resolve(gameDir, 'audio/hit.wav'));
    expect(resolveGameAudioFile(gameDir, 'audio/generated/footstep.mp3'))
      .toBe(resolve(gameDir, 'audio/generated/footstep.mp3'));
    expect(resolveGameAudioFile(gameDir, 'assets/audio/bgm-main.mp3'))
      .toBe(resolve(gameDir, 'assets/audio/bgm-main.mp3'));
  });

  test('returns null for traversal and values that escape the allowed roots', () => {
    expect(resolveGameAudioFile(gameDir, '../secret.wav')).toBeNull();
    expect(resolveGameAudioFile(gameDir, 'audio/../secret.wav')).toBeNull();
    expect(resolveGameAudioFile(gameDir, 'assets/audio/../../secret.wav')).toBeNull();
    expect(resolveGameAudioFile(gameDir, '/etc/passwd')).toBeNull();
    expect(resolveGameAudioFile(gameDir, 'design/notes.txt')).toBe(resolve(gameDir, 'audio/design/notes.txt'));
  });
});
