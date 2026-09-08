import type { RuntimeAudioShaping } from './types.ts';

const DEFAULT_SHAPING: RuntimeAudioShaping = {
  gainDb: 0,
  pitchSemitones: 0,
  highpassHz: 20,
  lowpassHz: 20_000,
  eqLowDb: 0,
  eqMidDb: 0,
  eqHighDb: 0,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * Layer shaping: gains sum, filters take the stricter side, then clamp.
 * The audio studio preview imports this so audition matches in-game audio.
 */
export function mergeShaping(
  ...layers: Array<RuntimeAudioShaping | Partial<RuntimeAudioShaping> | undefined>
): RuntimeAudioShaping | undefined {
  const active = layers.filter((layer): layer is RuntimeAudioShaping | Partial<RuntimeAudioShaping> => Boolean(layer));
  if (active.length === 0) return undefined;
  const result = { ...DEFAULT_SHAPING };
  for (const layer of active) {
    result.gainDb += layer.gainDb ?? 0;
    result.pitchSemitones += layer.pitchSemitones ?? 0;
    result.eqLowDb += layer.eqLowDb ?? 0;
    result.eqMidDb += layer.eqMidDb ?? 0;
    result.eqHighDb += layer.eqHighDb ?? 0;
    if (layer.highpassHz !== undefined) result.highpassHz = Math.max(result.highpassHz, layer.highpassHz);
    if (layer.lowpassHz !== undefined) result.lowpassHz = Math.min(result.lowpassHz, layer.lowpassHz);
  }
  result.gainDb = clamp(result.gainDb, -24, 12);
  result.pitchSemitones = clamp(result.pitchSemitones, -12, 12);
  result.eqLowDb = clamp(result.eqLowDb, -12, 12);
  result.eqMidDb = clamp(result.eqMidDb, -12, 12);
  result.eqHighDb = clamp(result.eqHighDb, -12, 12);
  result.highpassHz = clamp(result.highpassHz, 20, 2_000);
  result.lowpassHz = clamp(result.lowpassHz, Math.max(1_000, result.highpassHz + 100), 20_000);
  return result;
}

export function clampNumber(value: number, min: number, max: number): number {
  return clamp(value, min, max);
}

export function interpolate(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}
