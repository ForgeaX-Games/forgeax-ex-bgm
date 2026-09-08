import { contextValue } from './conditions.ts';
import { clampNumber, interpolate, mergeShaping } from './shaping.ts';
import type {
  AudioEventContext,
  RuntimeAudioAsset,
  RuntimeAudioBinding,
  RuntimeFollowValue,
} from './types.ts';

export interface ResolvedPlayback {
  asset: RuntimeAudioAsset;
  volume: number;
}

export function chooseAsset(
  binding: RuntimeAudioBinding,
  assets: RuntimeAudioAsset[],
  poolKey: string,
  selection: Map<string, number>,
  random: () => number,
  scopeKey: string,
): RuntimeAudioAsset | undefined {
  if (assets.length === 0) return undefined;
  const selectionKey = `${scopeKey}:${binding.eventId}:${poolKey}`;
  const previous = selection.get(selectionKey) ?? -1;
  let index = 0;
  if (binding.variation.mode === 'sequential') {
    index = (previous + 1) % assets.length;
  } else if (binding.variation.mode === 'random-no-repeat') {
    index = Math.min(assets.length - 1, Math.floor(random() * assets.length));
    if (assets.length > 1 && index === previous) index = (index + 1) % assets.length;
  }
  selection.set(selectionKey, index);
  return assets[index];
}

export function resolvePlayback(
  binding: RuntimeAudioBinding,
  context: AudioEventContext,
  gameValues: Map<string, RuntimeFollowValue>,
  selection: Map<string, number>,
  random: () => number,
  scopeKey: string,
): ResolvedPlayback | undefined {
  let assets = binding.assets;
  let poolKey = 'default';
  let volumeScale = 1;
  let dynamicShaping: Partial<import('./types.ts').RuntimeAudioShaping> | undefined;
  const follow = binding.follow;
  let actual: RuntimeFollowValue | undefined;
  if (follow) {
    const local = contextValue(context, follow.field);
    if (typeof local === 'string' || typeof local === 'number' || typeof local === 'boolean') {
      actual = local;
    } else {
      actual = gameValues.get(`${scopeKey}:${follow.field}`) ?? gameValues.get(follow.field) ?? follow.defaultValue;
    }
  }
  if (follow?.cases) {
    const matched = follow.cases.find((item) => item.value === actual);
    if (matched) {
      assets = matched.assets;
      poolKey = `case:${typeof matched.value}:${String(matched.value)}`;
    }
  } else if (follow?.range) {
    const numeric = typeof actual === 'number' ? actual : Number(follow.defaultValue);
    const amount = clampNumber(
      (numeric - follow.range.min) / (follow.range.max - follow.range.min),
      0,
      1,
    );
    volumeScale = interpolate(follow.range.volumeStart, follow.range.volumeEnd, amount);
    dynamicShaping = {
      pitchSemitones: interpolate(follow.range.pitchStart, follow.range.pitchEnd, amount),
      lowpassHz: interpolate(follow.range.lowpassStart, follow.range.lowpassEnd, amount),
    };
    poolKey = 'range';
  }
  const asset = chooseAsset(binding, assets, poolKey, selection, random, scopeKey);
  if (!asset) return undefined;
  const shaping = mergeShaping(asset.shaping, binding.shaping, dynamicShaping);
  return {
    asset: { ...asset, ...(shaping ? { shaping } : {}) },
    volume: clampNumber(binding.playback.volume * volumeScale, 0, 4),
  };
}
