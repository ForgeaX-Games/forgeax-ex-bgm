import { describe, expect, test } from 'bun:test';

import {
  filenameForCreativeVersion,
  filenameFromPath,
  normalizeProjectPath,
  projectPathForGameAudio,
} from './assetPath.ts';

describe('assetPath', () => {
  test('maps a binding file onto the FilesPanel project path', () => {
    expect(projectPathForGameAudio('demo', 'generated/footstep.mp3'))
      .toBe('.forgeax/games/demo/audio/generated/footstep.mp3');
    expect(projectPathForGameAudio('demo', 'audio/generated/footstep.mp3'))
      .toBe('.forgeax/games/demo/audio/generated/footstep.mp3');
    expect(projectPathForGameAudio('demo', 'assets/audio/guard-warning.mp3'))
      .toBe('.forgeax/games/demo/assets/audio/guard-warning.mp3');
  });

  test('keeps download names aligned with the save filename', () => {
    expect(filenameForCreativeVersion({
      kind: 'bgm',
      title: '主方案',
      id: 'take-abc123',
      mimeType: 'audio/mpeg',
    })).toBe('bgm-主方案-take-abc123.mp3');
  });

  test('normalizes save-tool paths from the host', () => {
    expect(normalizeProjectPath('.forgeax/games/demo/audio/generated/a.mp3'))
      .toBe('.forgeax/games/demo/audio/generated/a.mp3');
    expect(filenameFromPath('.forgeax/games/demo/audio/generated/a.mp3')).toBe('a.mp3');
  });
});
