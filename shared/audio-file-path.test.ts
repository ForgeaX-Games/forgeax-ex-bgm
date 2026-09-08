import { describe, expect, test } from 'bun:test';

import {
  AudioFilePathError,
  audioImportSpecifier,
  canonicalAudioFile,
  generatedAudioGameFile,
  projectPathForGameAudio,
} from './audio-file-path.ts';

describe('canonicalAudioFile', () => {
  test('upgrades a bare name and keeps both directory prefixes', () => {
    expect(canonicalAudioFile('hit.wav')).toBe('audio/hit.wav');
    expect(canonicalAudioFile('generated/footstep.mp3')).toBe('audio/generated/footstep.mp3');
    expect(canonicalAudioFile('audio/hit.wav')).toBe('audio/hit.wav');
    expect(canonicalAudioFile('audio/generated/footstep.mp3')).toBe('audio/generated/footstep.mp3');
    expect(canonicalAudioFile('assets/audio/bgm-main-abc123.mp3')).toBe('assets/audio/bgm-main-abc123.mp3');
  });

  test('rejects traversal, backslashes and a leading slash', () => {
    expect(() => canonicalAudioFile('../secret.wav')).toThrow(AudioFilePathError);
    expect(() => canonicalAudioFile('audio/../secret.wav')).toThrow(AudioFilePathError);
    expect(() => canonicalAudioFile('foo\\bar.wav')).toThrow(AudioFilePathError);
    expect(() => canonicalAudioFile('/hit.wav')).toThrow(AudioFilePathError);
    expect(() => canonicalAudioFile('audio//hit.wav')).toThrow(AudioFilePathError);
    expect(() => canonicalAudioFile('audio/./hit.wav')).toThrow(AudioFilePathError);
    expect(() => canonicalAudioFile('hit.wav\0')).toThrow(AudioFilePathError);
  });
});

describe('generated audio helpers', () => {
  test('writes new media under assets/audio and builds a game-root import', () => {
    expect(generatedAudioGameFile('guard-warning.mp3')).toBe('assets/audio/guard-warning.mp3');
    expect(audioImportSpecifier('assets/audio/guard-warning.mp3')).toBe('../../assets/audio/guard-warning.mp3');
    expect(audioImportSpecifier('audio/generated/footstep.mp3')).toBe('../../audio/generated/footstep.mp3');
  });

  test('maps a binding file onto the FilesPanel project path', () => {
    expect(projectPathForGameAudio('demo', 'generated/footstep.mp3'))
      .toBe('.forgeax/games/demo/audio/generated/footstep.mp3');
    expect(projectPathForGameAudio('demo', 'audio/generated/footstep.mp3'))
      .toBe('.forgeax/games/demo/audio/generated/footstep.mp3');
    expect(projectPathForGameAudio('demo', 'assets/audio/guard-warning.mp3'))
      .toBe('.forgeax/games/demo/assets/audio/guard-warning.mp3');
    expect(projectPathForGameAudio('demo', '../secret.wav')).toBe('');
  });
});
