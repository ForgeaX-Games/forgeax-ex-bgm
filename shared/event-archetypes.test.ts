import { describe, expect, test } from 'bun:test';

import {
  applyArchetypeDefaults,
  cooldownScopeWarning,
  inferArchetypeId,
  resolveArchetype,
} from './event-archetypes.ts';

describe('event archetypes', () => {
  test('infers the common gameplay ids', () => {
    expect(inferArchetypeId('combat.hit')).toBe('impact');
    expect(inferArchetypeId('combat.heavy_hit')).toBe('impact');
    expect(inferArchetypeId('impact.flesh')).toBe('impact');
    expect(inferArchetypeId('enemy.death')).toBe('defeat');
    expect(inferArchetypeId('enemy.stomp')).toBe('defeat');
    expect(inferArchetypeId('item.pickup')).toBe('pickup');
    expect(inferArchetypeId('coin.pickup')).toBe('pickup');
    expect(inferArchetypeId('reward.open')).toBe('rare-loot');
    expect(inferArchetypeId('ui.click')).toBe('ui');
    expect(inferArchetypeId('player.footstep')).toBe('footstep');
    expect(inferArchetypeId('weapon.fire')).toBe('weapon-fire');
    expect(inferArchetypeId('player.hurt')).toBe('hurt');
    expect(inferArchetypeId('player.jump')).toBe('jump');
    expect(inferArchetypeId('music.combat', 'sfx')).toBe('bgm-loop');
    expect(inferArchetypeId('ambience.day')).toBe('ambient-loop');
    expect(inferArchetypeId('boss.roar')).toBeUndefined();
  });

  test('fills missing numbers and leaves explicit ones alone', () => {
    const filled = applyArchetypeDefaults({
      eventId: 'enemy.death',
      kind: 'sfx',
      assets: [{ assetId: 'ko', file: 'assets/audio/ko.mp3' }],
    });
    expect(filled.archetype).toBe('defeat');
    expect(filled.trigger).toMatchObject({ delayMs: 0, cooldownMs: 0, probability: 1, rhythmLockMs: 0 });
    expect(filled.playback).toMatchObject({
      volume: 0.1,
      bus: 'sfx',
      spatial: '3d',
      mode: 'one-shot',
    });

    const kept = applyArchetypeDefaults({
      eventId: 'enemy.death',
      kind: 'sfx',
      trigger: { cooldownMs: 200 },
      playback: { volume: 0.9, spatial: '2d' },
    });
    expect(kept.trigger).toMatchObject({ cooldownMs: 200, delayMs: 0 });
    expect(kept.playback).toMatchObject({ volume: 0.9, spatial: '2d' });
  });

  test('an explicit archetype wins over the event id', () => {
    expect(resolveArchetype('rare-loot', 'item.pickup')?.id).toBe('rare-loot');
    const filled = applyArchetypeDefaults({
      eventId: 'item.pickup',
      kind: 'sfx',
      archetype: 'rare-loot',
    });
    expect(filled.trigger).toMatchObject({ cooldownMs: 800 });
    expect(filled.playback).toMatchObject({ volume: 0.45 });
  });

  test('warns when a 2D multi-instance event keeps a cooldown', () => {
    expect(cooldownScopeWarning({
      eventId: 'item.pickup',
      trigger: { cooldownMs: 200 },
      playback: { spatial: '2d' },
    })?.code).toBe('cooldown_needs_game_object');

    expect(cooldownScopeWarning({
      eventId: 'item.pickup',
      trigger: { cooldownMs: 0 },
      playback: { spatial: '2d' },
    })).toBeUndefined();

    expect(cooldownScopeWarning({
      eventId: 'combat.hit',
      trigger: { cooldownMs: 65 },
      playback: { spatial: '3d' },
    })).toBeUndefined();
  });
});
