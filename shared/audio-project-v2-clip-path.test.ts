import { describe, expect, test } from 'bun:test';

import { AUDIO_PROJECT_SCHEMA, normalizeAudioProject } from './audio-project.ts';

describe('v2 music clip paths', () => {
  test('canonicalizes MusicTrackClip.file at the normalize boundary', () => {
    const normalized = normalizeAudioProject({
      schemaVersion: AUDIO_PROJECT_SCHEMA,
      projectId: 'demo',
      revision: 1,
      status: 'draft',
      music: {
        segments: [{
          id: 'seg:intro',
          name: 'Intro',
          tempo: 120,
          timeSignature: [4, 4],
          preEntryMs: 0,
          entryCueMs: 0,
          exitCueMs: 0,
          postExitMs: 0,
          customCues: [],
          tracks: [{
            id: 'trk:a',
            kind: 'normal',
            clips: [{
              assetId: 'theme',
              file: 'theme.wav',
              startMs: 0,
              durationMs: 1000,
              fadeInMs: 0,
              fadeOutMs: 0,
            }, {
              assetId: 'fresh',
              file: 'assets/audio/fresh.mp3',
              startMs: 0,
              durationMs: 1000,
              fadeInMs: 0,
              fadeOutMs: 0,
            }],
            rtpcBindings: [],
          }],
        }],
        playlists: [],
        transitions: [],
        stingers: [],
      },
    }, 'demo');

    expect(normalized.music?.segments[0]?.tracks[0]?.clips.map((clip) => clip.file)).toEqual([
      'audio/theme.wav',
      'assets/audio/fresh.mp3',
    ]);
  });
});
