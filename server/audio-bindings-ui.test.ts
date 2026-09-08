import { describe, expect, test } from 'bun:test';

import {
  applyBindingEdit,
  buildAudioProjectPatch,
  createBindingDraft,
  parseConditionValue,
  removeBindingFromDraft,
  upsertBindingInDraft,
} from '../src/audioBindingsEditor.ts';
import { callAudioProjectTool } from '../src/audioProjectApi.ts';
import type { AudioProject } from '../shared/audio-project.ts';

function project(): AudioProject {
  return {
    schemaVersion: 'forgeax-audio-project/1',
    projectId: 'demo',
    revision: 3,
    status: 'draft',
    updatedAt: '2026-08-03T00:00:00.000Z',
    bindings: [createBindingDraft('combat.hit', '命中')],
  };
}

describe('no-code audio binding editor', () => {
  test('creates and edits every player-facing binding control without engine fields', () => {
    const binding = applyBindingEdit(createBindingDraft('combat.boss', 'Boss 战'), {
      enabled: false,
      kind: 'music',
      assets: [
        { assetId: 'boss-a', file: 'boss-a.mp3', name: 'Boss A' },
        { assetId: 'boss-b', file: 'boss-b.mp3', name: 'Boss B' },
      ],
      variationMode: 'random-no-repeat',
      delayMs: 250,
      cooldownMs: 8000,
      probabilityPercent: 75,
      volumePercent: 65,
      bus: 'music',
      spatial: '3d',
      playbackMode: 'loop',
      fadeInMs: 1000,
      fadeOutMs: 600,
      stopEventId: 'combat.end',
      conditions: [{ field: 'phase', operator: 'gte', value: 2 }],
    });

    expect(binding).toMatchObject({
      eventId: 'combat.boss',
      enabled: false,
      kind: 'music',
      assets: [{ assetId: 'boss-a' }, { assetId: 'boss-b' }],
      variation: { mode: 'random-no-repeat' },
      trigger: { delayMs: 250, cooldownMs: 8000, probability: 0.75 },
      playback: {
        volume: 0.65,
        bus: 'music',
        spatial: '3d',
        mode: 'loop',
        fadeInMs: 1000,
        fadeOutMs: 600,
        stopEventId: 'combat.end',
      },
      conditions: [{ field: 'phase', operator: 'gte', value: 2 }],
    });
    expect(Object.keys(binding)).not.toContain('engine');
  });

  test('builds one revision-safe patch for additions, edits, and removals', () => {
    const original = project();
    const edited = applyBindingEdit(original.bindings[0]!, { volumePercent: 40 });
    const added = createBindingDraft('player.jump', '跳跃');
    const next = removeBindingFromDraft(
      upsertBindingInDraft(upsertBindingInDraft(original.bindings, edited), added),
      'combat.hit',
    );

    expect(buildAudioProjectPatch(original, next)).toEqual({
      expectedRevision: 3,
      upsertBindings: [added],
      removeEventIds: ['combat.hit'],
    });
  });

  test('parses simple no-code condition values predictably', () => {
    expect(parseConditionValue('true')).toBe(true);
    expect(parseConditionValue('12.5')).toBe(12.5);
    expect(parseConditionValue('["night", "cave"]')).toEqual(['night', 'cave']);
    expect(parseConditionValue('boss')).toBe('boss');
  });

  test('edits one simplified game-value rule and event-level EQ without engine fields', () => {
    const base = createBindingDraft('player.footstep', '脚步');
    const grass = { assetId: 'grass-step', file: 'grass.wav', name: '草地脚步' };
    const edited = applyBindingEdit(base, {
      assets: [{ assetId: 'default-step', file: 'default.wav', name: '默认脚步' }],
      shaping: {
        gainDb: 0,
        pitchSemitones: 0,
        highpassHz: 20,
        lowpassHz: 16_000,
        eqLowDb: 2,
        eqMidDb: 0,
        eqHighDb: -1,
      },
      follow: {
        field: 'surface.material',
        defaultValue: '',
        cases: [{ value: 'grass', assets: [grass] }],
      },
    });

    expect(edited).toMatchObject({
      shaping: { eqLowDb: 2, eqHighDb: -1, lowpassHz: 16_000 },
      follow: { field: 'surface.material', cases: [{ value: 'grass', assets: [{ assetId: 'grass-step' }] }] },
    });
    expect(applyBindingEdit(edited, { shaping: null, follow: null })).not.toHaveProperty('shaping');
    expect(applyBindingEdit(edited, { shaping: null, follow: null })).not.toHaveProperty('follow');
  });

  test('calls the shared plugin tool as a user rather than bypassing the registry', async () => {
    let request: Record<string, unknown> | undefined;
    const result = await callAudioProjectTool<{ projectId: string }>(
      'get-audio-project',
      { slug: 'demo' },
      async (_input, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true, result: { projectId: 'demo' } }));
      },
    );

    expect(result).toEqual({ projectId: 'demo' });
    expect(request).toEqual({
      toolId: 'get-audio-project',
      args: { slug: 'demo' },
      caller: { kind: 'user' },
    });
  });
});
