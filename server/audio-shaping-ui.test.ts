import { describe, expect, test } from 'bun:test';

import {
  AUDIO_SHAPING_PRESETS,
  DEFAULT_AUDIO_SHAPING,
  audioShapingEquals,
  gainDbToLinear,
  isDefaultAudioShaping,
  matchingAudioShapingPreset,
  pitchSemitonesToRate,
  sanitizeAudioShapingParams,
} from '../src/audioShaping.ts';

describe('audio shaping parameters', () => {
  test('uses audio-domain conversions for gain and pitch', () => {
    expect(gainDbToLinear(0)).toBe(1);
    expect(gainDbToLinear(6)).toBeCloseTo(1.995, 2);
    expect(pitchSemitonesToRate(12)).toBe(2);
    expect(pitchSemitonesToRate(-12)).toBe(0.5);
  });

  test('sanitizes persisted values and keeps filters in a valid order', () => {
    const params = sanitizeAudioShapingParams({
      gainDb: 999,
      pitchSemitones: -999,
      highpassHz: 2_000,
      lowpassHz: 1_000,
      eqLowDb: Number.NaN,
    });
    expect(params.gainDb).toBe(12);
    expect(params.pitchSemitones).toBe(-12);
    expect(params.highpassHz).toBeLessThan(params.lowpassHz);
    expect(params.eqLowDb).toBe(0);
  });

  test('provides distinct, recognizable presets including the original', () => {
    const ids = AUDIO_SHAPING_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(matchingAudioShapingPreset(DEFAULT_AUDIO_SHAPING)?.id).toBe('original');
    expect(isDefaultAudioShaping(DEFAULT_AUDIO_SHAPING)).toBe(true);
    expect(audioShapingEquals(
      AUDIO_SHAPING_PRESETS.find((preset) => preset.id === 'heavy')!.params,
      DEFAULT_AUDIO_SHAPING,
    )).toBe(false);
  });
});
