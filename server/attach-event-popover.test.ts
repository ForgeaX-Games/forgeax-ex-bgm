import { describe, expect, test } from 'bun:test';

import { isSafeAudioEventId } from '../shared/audio-project.ts';
import { bindingFileFrom, eventKeyFrom } from '../src/attachEventPopover.ts';
import type { CreativeVersion } from '../src/creativeAudioStudio.ts';

function version(overrides: Partial<CreativeVersion> = {}): CreativeVersion {
  return {
    id: 'take-9f3ab21c',
    kind: 'bgm',
    label: 'A',
    title: '主方案',
    ...overrides,
  } as CreativeVersion;
}

describe('配入 popover event ids', () => {
  test('keeps the default id ASCII so the schema accepts it', () => {
    // A CJK title used to leak straight through (`bgm.主方案`) and the patch was
    // rejected with `bindings[n].eventId contains unsafe characters`.
    const id = eventKeyFrom(version());
    expect(id).toBe('bgm.3ab21c');
    expect(isSafeAudioEventId(id)).toBe(true);
  });

  test('slugs an ASCII title instead of falling back to the take id', () => {
    const id = eventKeyFrom(version({ title: 'Main Theme' }));
    expect(id).toBe('bgm.main-theme');
    expect(isSafeAudioEventId(id)).toBe(true);
  });

  test('every generated default passes the schema validator', () => {
    for (const title of ['主方案', 'Boss 战 v2', '　', '!!!', 'ok']) {
      for (const kind of ['bgm', 'sfx', 'voice'] as const) {
        const id = eventKeyFrom(version({ title, kind }));
        expect(isSafeAudioEventId(id)).toBe(true);
      }
    }
  });
});

describe('配入 popover binding file', () => {
  test('uses the canonical game-relative file from the save tool', () => {
    expect(bindingFileFrom({ file: 'assets/audio/bgm.mp3', path: '.forgeax/games/demo/assets/audio/bgm.mp3' }, 'demo'))
      .toBe('assets/audio/bgm.mp3');
  });

  test('falls back by stripping the project prefix rather than emitting it', () => {
    // The old helper only stripped a leading `audio/`, so a project-relative
    // path landed in project.json verbatim and the compiler reported it missing.
    expect(bindingFileFrom({ path: '.forgeax/games/demo/assets/audio/bgm.mp3' }, 'demo'))
      .toBe('assets/audio/bgm.mp3');
    expect(bindingFileFrom({ path: '.forgeax/games/demo/audio/generated/old.mp3' }, 'demo'))
      .toBe('audio/generated/old.mp3');
  });

  test('returns empty when nothing usable came back', () => {
    expect(bindingFileFrom({}, 'demo')).toBe('');
    expect(bindingFileFrom({ path: '.forgeax/games/other/audio/x.mp3' }, 'demo')).toBe('');
  });
});
