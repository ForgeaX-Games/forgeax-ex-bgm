import { describe, expect, test } from 'bun:test';
import {
  attenuationPreset,
  createMusicPlaylist,
  createMusicSegment,
  createRtpc,
  createStateGroup,
  createSwitchGroup,
  parseCsvValues,
} from '../src/audioDesignEntities.ts';

describe('audioDesignEntities', () => {
  test('parses chinese and ascii commas', () => {
    expect(parseCsvValues('grass, stone，wood\nwater')).toEqual(['grass', 'stone', 'wood', 'water']);
  });

  test('creates stable switch / rtpc / state drafts', () => {
    const sw = createSwitchGroup('Surface', ['grass', 'stone']);
    expect(sw.id).toBe('sw:surface');
    expect(sw.values).toEqual(['grass', 'stone']);
    expect(sw.defaultValue).toBe('grass');

    const zh = createSwitchGroup('地面材质', ['grass', 'stone']);
    expect(zh.id).toBe('sw:地面材质');

    const rtpc = createRtpc('玩家速度', 0, 10);
    expect(rtpc.min).toBe(0);
    expect(rtpc.max).toBe(10);
    expect(rtpc.scope).toBe('global');

    const state = createStateGroup('游戏阶段');
    expect(state.values).toContain('explore');
    expect(state.transitions).toEqual([]);
  });

  test('attenuation presets end at silence', () => {
    const melee = attenuationPreset('melee');
    const last = melee.curves.outputVolumeDb[melee.curves.outputVolumeDb.length - 1]!;
    expect(last.x).toBe(melee.maxDistance);
    expect(last.y).toBe(-96);
  });

  test('music drafts carry required fields', () => {
    const segment = createMusicSegment('combat_a', 120);
    expect(segment.tempo).toBe(120);
    expect(segment.tracks).toEqual([]);
    const playlist = createMusicPlaylist('combat', [segment.id]);
    expect(playlist.segmentIds).toEqual([segment.id]);
  });
});
