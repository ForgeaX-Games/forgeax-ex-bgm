import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_PROJECT_SCHEMA,
  bindingsFromV2,
  migrateV1ToV2,
  normalizeAudioProject,
  stableEntityId,
} from './audio-project.ts';
import {
  AUDIO_PROJECT_SCHEMA_V1,
  normalizeAudioProjectV1,
  type AudioBinding,
  type AudioProjectV1,
} from './audio-project-v1.ts';

function binding(overrides: Partial<AudioBinding> & Pick<AudioBinding, 'eventId'>): AudioBinding {
  return {
    eventId: overrides.eventId,
    label: overrides.label ?? overrides.eventId,
    enabled: overrides.enabled ?? true,
    kind: overrides.kind ?? 'sfx',
    assets: overrides.assets ?? [{ assetId: `${overrides.eventId}-a`, file: `${overrides.eventId}.wav` }],
    variation: overrides.variation ?? { mode: 'single' },
    trigger: overrides.trigger ?? { delayMs: 0, cooldownMs: 0, probability: 1 },
    playback: {
      volume: 1,
      bus: 'sfx',
      spatial: '2d',
      mode: 'one-shot',
      fadeInMs: 0,
      fadeOutMs: 0,
      ...overrides.playback,
    },
    conditions: overrides.conditions ?? [],
    ...(overrides.shaping ? { shaping: overrides.shaping } : {}),
    ...(overrides.follow ? { follow: overrides.follow } : {}),
    ...(overrides.provenance ? { provenance: overrides.provenance } : {}),
  };
}

function v1Project(bindings: AudioBinding[]): AudioProjectV1 {
  return normalizeAudioProjectV1({
    schemaVersion: AUDIO_PROJECT_SCHEMA_V1,
    projectId: 'demo',
    revision: 3,
    status: 'draft',
    updatedAt: '2026-08-10T00:00:00.000Z',
    bindings,
  }, 'demo');
}

/** Drop fields the migrator intentionally does not preserve. */
function canonicalize(bindings: AudioBinding[]): unknown {
  return bindings.map((item) => ({
    ...item,
    assets: item.variation.mode === 'single' ? item.assets.slice(0, 1) : item.assets,
    follow: item.follow
      ? {
        ...item.follow,
        cases: item.follow.cases?.map(({ label: _label, ...rest }) => rest),
      }
      : undefined,
  }));
}

describe('migrateV1ToV2', () => {
  test('keeps the per-sound attenuation id in both directions', () => {
    const input = v1Project([binding({
      eventId: 'weapon.fire',
      playback: {
        volume: 1,
        bus: 'sfx',
        spatial: '3d',
        attenuationId: 'att:gunfire',
        mode: 'one-shot',
        fadeInMs: 0,
        fadeOutMs: 0,
      },
    })]);

    const migrated = migrateV1ToV2(input);
    expect(migrated.objects[0]?.attenuationId).toBe('att:gunfire');
    expect(bindingsFromV2(migrated)[0]?.playback.attenuationId).toBe('att:gunfire');
  });

  test('keeps an authored rhythm lock in both directions, absence included', () => {
    const locked = v1Project([binding({
      eventId: 'weapon.fire',
      trigger: { delayMs: 0, cooldownMs: 0, probability: 1, rhythmLockMs: 85 },
    })]);
    expect(bindingsFromV2(migrateV1ToV2(locked))[0]?.trigger.rhythmLockMs).toBe(85);

    // Off and "decide for me" are different answers, so neither may become the other.
    const off = v1Project([binding({
      eventId: 'weapon.fire',
      trigger: { delayMs: 0, cooldownMs: 0, probability: 1, rhythmLockMs: 0 },
    })]);
    expect(bindingsFromV2(migrateV1ToV2(off))[0]?.trigger.rhythmLockMs).toBe(0);

    const auto = v1Project([binding({ eventId: 'weapon.fire' })]);
    expect(bindingsFromV2(migrateV1ToV2(auto))[0]?.trigger.rhythmLockMs).toBeUndefined();
  });

  test('keeps hook provenance on the event in both directions', () => {
    const input = v1Project([binding({
      eventId: 'enemy.death',
      provenance: {
        status: 'wired',
        file: 'src/combat.ts',
        symbol: 'settleEnemyDefeat',
        reason: 'hp reaches zero once here',
      },
    })]);
    const migrated = migrateV1ToV2(input);
    expect(migrated.events[0]?.provenance?.symbol).toBe('settleEnemyDefeat');
    expect(bindingsFromV2(migrated)[0]?.provenance).toEqual({
      status: 'wired',
      file: 'src/combat.ts',
      symbol: 'settleEnemyDefeat',
      reason: 'hp reaches zero once here',
    });
  });

  test('plain binding becomes one object and one play event', () => {
    const input = v1Project([binding({
      eventId: 'player.jump',
      label: 'Jump',
      trigger: { delayMs: 10, cooldownMs: 200, probability: 0.5 },
      playback: { volume: 0.8, bus: 'sfx', spatial: '3d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 40 },
    })]);
    const migrated = migrateV1ToV2(input);

    expect(migrated.schemaVersion).toBe(AUDIO_PROJECT_SCHEMA);
    expect(migrated.buses.map((bus) => bus.id)).toEqual([
      'bus:master', 'bus:sfx', 'bus:music', 'bus:voice',
    ]);
    expect(migrated.objects).toHaveLength(1);
    expect(migrated.objects[0]).toMatchObject({
      id: stableEntityId('obj', 'player.jump'),
      outputBusId: 'bus:sfx',
      spatial: '3d',
      playback: { mode: 'one-shot', volume: 0.8, fadeOutMs: 40 },
    });
    expect(migrated.events).toEqual([{
      id: stableEntityId('evt', 'player.jump'),
      name: 'player.jump',
      label: 'Jump',
      enabled: true,
      actions: [{
        type: 'play',
        objectId: stableEntityId('obj', 'player.jump'),
        delayMs: 10,
        probability: 0.5,
        cooldownMs: 200,
      }],
    }]);
  });

  test('follow.cases becomes a switch node and SwitchGroup', () => {
    const input = v1Project([binding({
      eventId: 'footstep',
      assets: [{ assetId: 'dirt', file: 'dirt.wav' }],
      follow: {
        field: 'ground',
        label: 'Ground',
        defaultValue: 'dirt',
        cases: [
          { value: 'dirt', assets: [{ assetId: 'dirt', file: 'dirt.wav' }] },
          { value: 'stone', assets: [{ assetId: 'stone', file: 'stone.wav' }] },
        ],
      },
    })]);
    const migrated = migrateV1ToV2(input);
    expect(migrated.gameSyncs.switches).toEqual([{
      id: stableEntityId('sw', 'ground'),
      name: 'Ground',
      values: ['dirt', 'stone'],
      defaultValue: 'dirt',
    }]);
    expect(migrated.objects[0]?.node.kind).toBe('switch');
  });

  test('follow.range becomes a blend node and RtpcDefinition', () => {
    const input = v1Project([binding({
      eventId: 'engine',
      follow: {
        field: 'speed',
        defaultValue: 0,
        range: {
          min: 0,
          max: 100,
          volumeStart: 0.5,
          volumeEnd: 1,
          pitchStart: -2,
          pitchEnd: 4,
          lowpassStart: 8000,
          lowpassEnd: 18000,
        },
      },
    })]);
    const migrated = migrateV1ToV2(input);
    expect(migrated.gameSyncs.rtpcs[0]).toMatchObject({
      id: stableEntityId('rtpc', 'speed'),
      min: 0,
      max: 100,
      scope: 'global',
    });
    expect(migrated.objects[0]?.node.kind).toBe('blend');
    expect(migrated.objects[0]?.rtpcBindings).toHaveLength(3);
  });

  test('loop stopEventId creates a stop action event', () => {
    const input = v1Project([binding({
      eventId: 'music.explore',
      kind: 'music',
      playback: {
        volume: 1,
        bus: 'music',
        spatial: '2d',
        mode: 'loop',
        fadeInMs: 500,
        fadeOutMs: 800,
        stopEventId: 'music.explore.stop',
      },
    })]);
    const migrated = migrateV1ToV2(input);
    expect(migrated.events.map((event) => event.name).sort()).toEqual([
      'music.explore',
      'music.explore.stop',
    ]);
    const stop = migrated.events.find((event) => event.name === 'music.explore.stop');
    expect(stop?.actions).toEqual([{
      type: 'stop',
      objectId: stableEntityId('obj', 'music.explore'),
      fadeOutMs: 800,
      scope: 'global',
    }]);
  });

  test('variation modes map to sequence and random containers', () => {
    const sequential = migrateV1ToV2(v1Project([binding({
      eventId: 'ui.click',
      assets: [
        { assetId: 'a', file: 'a.wav' },
        { assetId: 'b', file: 'b.wav' },
      ],
      variation: { mode: 'sequential' },
    })]));
    expect(sequential.objects[0]?.node).toMatchObject({ kind: 'sequence', loop: true });

    const random = migrateV1ToV2(v1Project([binding({
      eventId: 'ui.hover',
      assets: [
        { assetId: 'a', file: 'a.wav' },
        { assetId: 'b', file: 'b.wav' },
      ],
      variation: { mode: 'random-no-repeat' },
    })]));
    expect(random.objects[0]?.node).toMatchObject({ kind: 'random', avoidRepeatCount: 1 });
  });

  const corpus: Array<{ name: string; bindings: AudioBinding[] }> = [
    { name: 'no-follow', bindings: [binding({ eventId: 'a.hit' })] },
    {
      name: 'follow-cases',
      bindings: [binding({
        eventId: 'a.step',
        follow: {
          field: 'surface',
          defaultValue: 'wood',
          cases: [
            { value: 'wood', assets: [{ assetId: 'wood', file: 'wood.wav' }] },
            { value: 'metal', assets: [{ assetId: 'metal', file: 'metal.wav' }] },
          ],
        },
      })],
    },
    {
      name: 'follow-range',
      bindings: [binding({
        eventId: 'a.engine',
        follow: {
          field: 'rpm',
          defaultValue: 800,
          range: {
            min: 800, max: 6000,
            volumeStart: 0.4, volumeEnd: 1,
            pitchStart: -1, pitchEnd: 3,
            lowpassStart: 6000, lowpassEnd: 16000,
          },
        },
      })],
    },
    {
      name: 'conditions',
      bindings: [binding({
        eventId: 'a.crit',
        conditions: [{ field: 'damage', operator: 'gte', value: 50 }],
      })],
    },
    {
      name: 'loop-with-stop',
      bindings: [binding({
        eventId: 'bgm.main',
        kind: 'music',
        playback: {
          volume: 0.7, bus: 'music', spatial: '2d', mode: 'loop',
          fadeInMs: 200, fadeOutMs: 400, stopEventId: 'bgm.main.stop',
        },
      })],
    },
    {
      name: 'sequential-assets',
      bindings: [binding({
        eventId: 'ui.ok',
        assets: [
          { assetId: '1', file: '1.wav' },
          { assetId: '2', file: '2.wav' },
        ],
        variation: { mode: 'sequential' },
      })],
    },
    {
      name: 'random-no-repeat',
      bindings: [binding({
        eventId: 'ui.tick',
        assets: [
          { assetId: '1', file: '1.wav' },
          { assetId: '2', file: '2.wav' },
          { assetId: '3', file: '3.wav' },
        ],
        variation: { mode: 'random-no-repeat' },
      })],
    },
  ];

  for (const fixture of corpus) {
    test(`round-trips synthetic corpus: ${fixture.name}`, () => {
      const input = v1Project(fixture.bindings);
      const migrated = migrateV1ToV2(input);
      const roundTrip = normalizeAudioProjectV1({
        ...input,
        bindings: bindingsFromV2(migrated).filter((item) => fixture.bindings.some((b) => b.eventId === item.eventId)),
      }, 'demo');
      expect(canonicalize(roundTrip.bindings)).toEqual(canonicalize(input.bindings));
    });
  }

  test('normalizeAudioProject accepts v1 and returns v2 with bindings view', () => {
    const normalized = normalizeAudioProject(v1Project([binding({ eventId: 'x.y' })]), 'demo');
    expect(normalized.schemaVersion).toBe(AUDIO_PROJECT_SCHEMA);
    expect(normalized.objects).toHaveLength(1);
    expect(normalized.bindings[0]?.eventId).toBe('x.y');
  });

  test('migrates the real paopaotang project without losing playable events', async () => {
    // 取自 games/paopaotang 的真实工程，收在插件自己的 fixture 里:插件仓单独跑 CI 时
    // 没有 games 子模块，读隔壁目录会让这条覆盖直接消失。
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      '__fixtures__/paopaotang-project.v1.json',
    );
    const raw = JSON.parse(await readFile(fixture, 'utf8')) as unknown;
    const v1 = normalizeAudioProjectV1(raw, 'paopaotang');
    const migrated = migrateV1ToV2(v1);
    const playEvents = migrated.events.filter((event) => event.actions.some((action) => action.type === 'play'));
    expect(playEvents).toHaveLength(v1.bindings.length);
    expect(migrated.objects).toHaveLength(v1.bindings.length);
    const roundTrip = bindingsFromV2(migrated).filter((item) => (
      v1.bindings.some((binding) => binding.eventId === item.eventId)
    ));
    expect(canonicalize(roundTrip)).toEqual(canonicalize(v1.bindings));
  });
});
