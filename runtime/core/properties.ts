import { evaluateCurve, type CurvePoint } from '../curves.ts';
import type { RuntimeCurvePoint, RuntimeRtpcBinding, RuntimeStateOffset } from '../types.ts';

export interface AttenuationProps {
  volumeDb: number;
  lowpassHz?: number;
  highpassHz?: number;
}

export interface VoicePropertyInput {
  baseVolumeDb: number;
  basePitchSemitones?: number;
  /** Active state offsets, already weighted by transition progress when needed. */
  stateOffsets?: Array<{ volumeDb?: number; pitchSemitones?: number; lowpassHz?: number }>;
  stateOffsetDefs?: RuntimeStateOffset[];
  activeStates?: Record<string, { value: string; from?: string; progress?: number }>;
  rtpcBindings?: RuntimeRtpcBinding[];
  rtpcValues?: Record<string, number>;
  attenuation?: AttenuationProps;
  fadeGainDb?: number;
  mute?: boolean;
}

export interface ResolvedVoiceProperties {
  volumeDb: number;
  pitchSemitones: number;
  lowpassHz?: number;
  highpassHz?: number;
}

function asCurve(points: RuntimeCurvePoint[] | CurvePoint[] | undefined): CurvePoint[] | undefined {
  return points as CurvePoint[] | undefined;
}

/**
 * finalVolumeDb / pitch stack:
 * base + state offsets + rtpc curves + distance + cone + fade
 */
export function resolveVoiceProperties(input: VoicePropertyInput): ResolvedVoiceProperties {
  let volumeDb = input.baseVolumeDb;
  let pitchSemitones = input.basePitchSemitones ?? 0;
  let lowpassHz: number | undefined;
  let highpassHz: number | undefined;

  if (input.stateOffsets) {
    for (const offset of input.stateOffsets) {
      volumeDb += offset.volumeDb ?? 0;
      pitchSemitones += offset.pitchSemitones ?? 0;
      if (offset.lowpassHz !== undefined) {
        lowpassHz = lowpassHz === undefined
          ? offset.lowpassHz
          : Math.min(lowpassHz, offset.lowpassHz);
      }
    }
  }

  if (input.stateOffsetDefs && input.activeStates) {
    for (const def of input.stateOffsetDefs) {
      const active = input.activeStates[def.groupId];
      if (!active) continue;
      const to = def.values[active.value];
      const from = active.from ? def.values[active.from] : undefined;
      const progress = active.progress ?? 1;
      const mix = (a: number | undefined, b: number | undefined): number | undefined => {
        if (a === undefined && b === undefined) return undefined;
        if (a === undefined) return b;
        if (b === undefined) return a;
        return a + (b - a) * progress;
      };
      const volume = mix(from?.volumeDb, to?.volumeDb);
      const pitch = mix(from?.pitchSemitones, to?.pitchSemitones);
      const lowpass = mix(from?.lowpassHz, to?.lowpassHz);
      if (volume !== undefined) volumeDb += volume;
      if (pitch !== undefined) pitchSemitones += pitch;
      if (lowpass !== undefined) {
        lowpassHz = lowpassHz === undefined ? lowpass : Math.min(lowpassHz, lowpass);
      }
    }
  }

  if (input.rtpcBindings && input.rtpcValues) {
    for (const binding of input.rtpcBindings) {
      const value = input.rtpcValues[binding.rtpcId];
      if (value === undefined) continue;
      const y = evaluateCurve(asCurve(binding.curve), value, 0);
      switch (binding.target) {
        case 'volumeDb':
          volumeDb += y;
          break;
        case 'pitchSemitones':
          pitchSemitones += y;
          break;
        case 'lowpassHz':
          lowpassHz = lowpassHz === undefined ? y : Math.min(lowpassHz, y);
          break;
        case 'highpassHz':
          highpassHz = highpassHz === undefined ? y : Math.max(highpassHz, y);
          break;
        default:
          break;
      }
    }
  }

  if (input.attenuation) {
    volumeDb += input.attenuation.volumeDb;
    if (input.attenuation.lowpassHz !== undefined) {
      lowpassHz = lowpassHz === undefined
        ? input.attenuation.lowpassHz
        : Math.min(lowpassHz, input.attenuation.lowpassHz);
    }
    if (input.attenuation.highpassHz !== undefined) {
      highpassHz = highpassHz === undefined
        ? input.attenuation.highpassHz
        : Math.max(highpassHz, input.attenuation.highpassHz);
    }
  }

  if (input.fadeGainDb !== undefined) volumeDb += input.fadeGainDb;
  if (input.mute) volumeDb = -96;

  return { volumeDb, pitchSemitones, lowpassHz, highpassHz };
}
