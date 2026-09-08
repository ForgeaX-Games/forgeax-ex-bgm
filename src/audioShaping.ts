export interface AudioShapingParams {
  gainDb: number;
  pitchSemitones: number;
  highpassHz: number;
  lowpassHz: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
}

export interface AudioShapingPreset {
  id: string;
  label: string;
  description: string;
  params: AudioShapingParams;
}

export const DEFAULT_AUDIO_SHAPING: AudioShapingParams = Object.freeze({
  gainDb: 0,
  pitchSemitones: 0,
  highpassHz: 20,
  lowpassHz: 20_000,
  eqLowDb: 0,
  eqMidDb: 0,
  eqHighDb: 0,
});

export const AUDIO_SHAPING_PRESETS: readonly AudioShapingPreset[] = Object.freeze([
  {
    id: 'original',
    label: '原始',
    description: '不改变原始声音',
    params: { ...DEFAULT_AUDIO_SHAPING },
  },
  {
    id: 'heavy',
    label: '更厚重',
    description: '降低音调并增强低频冲击',
    params: {
      gainDb: 2,
      pitchSemitones: -2,
      highpassHz: 30,
      lowpassHz: 16_000,
      eqLowDb: 4,
      eqMidDb: 1,
      eqHighDb: -1,
    },
  },
  {
    id: 'crisp',
    label: '更清脆',
    description: '减少浑浊并突出高频细节',
    params: {
      gainDb: 0,
      pitchSemitones: 1,
      highpassHz: 120,
      lowpassHz: 20_000,
      eqLowDb: -2,
      eqMidDb: 2,
      eqHighDb: 4,
    },
  },
  {
    id: 'distant',
    label: '更遥远',
    description: '降低音量并收掉高频',
    params: {
      gainDb: -4,
      pitchSemitones: 0,
      highpassHz: 150,
      lowpassHz: 4_500,
      eqLowDb: 0,
      eqMidDb: -1,
      eqHighDb: -6,
    },
  },
  {
    id: 'mysterious',
    label: '更神秘',
    description: '降低音调并柔化中高频',
    params: {
      gainDb: -1,
      pitchSemitones: -3,
      highpassHz: 60,
      lowpassHz: 9_000,
      eqLowDb: 2,
      eqMidDb: -2,
      eqHighDb: 1,
    },
  },
  {
    id: 'mechanical',
    label: '机械质感',
    description: '突出中频与金属细节',
    params: {
      gainDb: 1,
      pitchSemitones: -1,
      highpassHz: 100,
      lowpassHz: 14_000,
      eqLowDb: 1,
      eqMidDb: 4,
      eqHighDb: 2,
    },
  },
]);

const LIMITS: Record<keyof AudioShapingParams, readonly [number, number]> = {
  gainDb: [-24, 12],
  pitchSemitones: [-12, 12],
  highpassHz: [20, 2_000],
  lowpassHz: [1_000, 20_000],
  eqLowDb: [-12, 12],
  eqMidDb: [-12, 12],
  eqHighDb: [-12, 12],
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sanitizeAudioShapingParams(value: unknown): AudioShapingParams {
  const input = value && typeof value === 'object'
    ? value as Partial<Record<keyof AudioShapingParams, unknown>>
    : {};
  const output = { ...DEFAULT_AUDIO_SHAPING };
  for (const key of Object.keys(LIMITS) as Array<keyof AudioShapingParams>) {
    const [min, max] = LIMITS[key];
    output[key] = clamp(finiteOr(input[key], DEFAULT_AUDIO_SHAPING[key]), min, max);
  }
  if (output.highpassHz >= output.lowpassHz) {
    output.highpassHz = Math.min(output.highpassHz, output.lowpassHz - 100);
  }
  return output;
}

export function audioShapingEquals(
  left: AudioShapingParams,
  right: AudioShapingParams,
): boolean {
  return (Object.keys(DEFAULT_AUDIO_SHAPING) as Array<keyof AudioShapingParams>)
    .every((key) => Math.abs(left[key] - right[key]) < 0.001);
}

export function isDefaultAudioShaping(params: AudioShapingParams): boolean {
  return audioShapingEquals(params, DEFAULT_AUDIO_SHAPING);
}

export function gainDbToLinear(gainDb: number): number {
  return 10 ** (gainDb / 20);
}

export function pitchSemitonesToRate(semitones: number): number {
  return 2 ** (semitones / 12);
}

export function matchingAudioShapingPreset(
  params: AudioShapingParams,
): AudioShapingPreset | undefined {
  return AUDIO_SHAPING_PRESETS.find((preset) =>
    audioShapingEquals(preset.params, params),
  );
}

