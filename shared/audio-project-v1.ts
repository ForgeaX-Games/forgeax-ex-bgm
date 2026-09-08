import { canonicalAudioFile } from './audio-file-path.ts';

export const AUDIO_PROJECT_SCHEMA_V1 = 'forgeax-audio-project/1' as const;

export type AudioKind = 'sfx' | 'music' | 'voice';
export type AudioBus = AudioKind;
export type AudioVariationMode = 'single' | 'sequential' | 'random-no-repeat';
export type AudioSpatialMode = '2d' | '3d';
export type AudioPlaybackMode = 'one-shot' | 'loop';
export type AudioConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
export type AudioConditionValue = string | number | boolean | Array<string | number | boolean>;
export type AudioFollowValue = string | number | boolean;
export type AudioHookStatus = 'wired' | 'gap';

export interface AudioHookProvenance {
  /** `wired` means the emit is in game code; `gap` means we could not find a settle point. */
  status: AudioHookStatus;
  /** Why this file/symbol is the settle point, or why it is a gap. */
  reason: string;
  /** Game-relative source file, required when status is `wired`. */
  file?: string;
  /** Function or method that owns the settle point. */
  symbol?: string;
}

export interface AudioShapingParams {
  gainDb: number;
  pitchSemitones: number;
  highpassHz: number;
  lowpassHz: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
}

export interface AudioAssetRef {
  assetId: string;
  file: string;
  name?: string;
  shaping?: AudioShapingParams;
}

export interface AudioCondition {
  field: string;
  operator: AudioConditionOperator;
  value: AudioConditionValue;
}

export interface AudioFollowCase {
  value: AudioFollowValue;
  label?: string;
  assets: AudioAssetRef[];
}

export interface AudioFollowRange {
  min: number;
  max: number;
  volumeStart: number;
  volumeEnd: number;
  pitchStart: number;
  pitchEnd: number;
  lowpassStart: number;
  lowpassEnd: number;
}

export interface AudioFollowRule {
  field: string;
  label?: string;
  defaultValue: AudioFollowValue;
  cases?: AudioFollowCase[];
  range?: AudioFollowRange;
}

export interface AudioBinding {
  eventId: string;
  label: string;
  enabled: boolean;
  kind: AudioKind;
  assets: AudioAssetRef[];
  variation: { mode: AudioVariationMode };
  trigger: {
    delayMs: number;
    cooldownMs: number;
    probability: number;
  /**
   * Interval, in ms, of a repeating one-shot such as full-auto fire. Absent
   * lets the runtime read the rate off the triggers themselves; 0 turns the
   * evening-out off. See runtime/core/rhythm-lock.ts.
   */
  rhythmLockMs?: number;
  };
  playback: {
    volume: number;
    bus: AudioBus;
    spatial: AudioSpatialMode;
    /** v2 AttenuationShareSet id; only meaningful when spatial is '3d'. */
    attenuationId?: string;
    mode: AudioPlaybackMode;
    fadeInMs: number;
    fadeOutMs: number;
    stopEventId?: string;
    /** Concurrent voices for this event; absent falls back to the engine budget. */
    maxInstances?: number;
    /** Higher survives when the voice budget is full. */
    priority?: number;
  };
  shaping?: AudioShapingParams;
  follow?: AudioFollowRule;
  conditions: AudioCondition[];
  provenance?: AudioHookProvenance;
  /**
   * Which kind of game beat this is. Kept on the binding so the numbers above
   * stay auditable: a 'defeat' carrying a 0.5 volume is visible as a deviation
   * instead of looking like a considered choice.
   */
  archetype?: string;
  /**
   * Clips the audio plan said this event needs. Recorded so the plan becomes an
   * acceptance criterion instead of prose in a report nobody rechecks.
   */
  plannedVariants?: number;
}

export interface AudioProjectV1 {
  schemaVersion: typeof AUDIO_PROJECT_SCHEMA_V1;
  projectId: string;
  revision: number;
  status: 'draft' | 'applied';
  updatedAt: string;
  bindings: AudioBinding[];
}

export type AudioProjectErrorCode = 'bad_input' | 'invalid_project' | 'revision_conflict';

export class AudioProjectError extends Error {
  readonly code: AudioProjectErrorCode;
  readonly actualRevision?: number;

  constructor(code: AudioProjectErrorCode, message: string, actualRevision?: number) {
    super(message);
    this.name = 'AudioProjectError';
    this.code = code;
    this.actualRevision = actualRevision;
  }
}

type JsonObject = Record<string, unknown>;

/**
 * Event ids are ASCII-only: they end up as literal `gameAudio.emit('...')`
 * arguments in generated game source, so the audio studio must not mint ids the
 * schema will reject. Exported so the UI can validate before it patches.
 */
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSafeAudioEventId(value: string): boolean {
  return EVENT_ID_RE.test(value);
}
const CONDITION_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const KINDS: readonly AudioKind[] = ['sfx', 'music', 'voice'];
const VARIATIONS: readonly AudioVariationMode[] = ['single', 'sequential', 'random-no-repeat'];
const SPATIAL_MODES: readonly AudioSpatialMode[] = ['2d', '3d'];
const PLAYBACK_MODES: readonly AudioPlaybackMode[] = ['one-shot', 'loop'];
const CONDITION_OPERATORS: readonly AudioConditionOperator[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in'];
const HOOK_STATUSES: readonly AudioHookStatus[] = ['wired', 'gap'];

function objectValue(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AudioProjectError('invalid_project', `${path} must be an object`);
  }
  return value as JsonObject;
}

function textValue(value: unknown, path: string, fallback?: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized) return normalized;
  if (fallback !== undefined) return fallback;
  throw new AudioProjectError('invalid_project', `${path} must be a non-empty string`);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  fallback: T,
): T {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'string' || !allowed.includes(candidate as T)) {
    throw new AudioProjectError('invalid_project', `${path} must be one of ${allowed.join(', ')}`);
  }
  return candidate as T;
}

function numberValue(
  value: unknown,
  path: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < min || candidate > max) {
    throw new AudioProjectError('invalid_project', `${path} must be between ${min} and ${max}`);
  }
  return candidate;
}

function eventIdValue(value: unknown, path: string): string {
  const eventId = textValue(value, path);
  if (!EVENT_ID_RE.test(eventId)) {
    throw new AudioProjectError('invalid_project', `${path} contains unsafe characters`);
  }
  return eventId;
}

function safeAssetFile(value: unknown, path: string): string {
  const input = textValue(value, path);
  try {
    // Canonical form is game-relative with a directory prefix:
    // audio/hit.wav, audio/generated/x.mp3, assets/audio/x.mp3.
    // Bare values are upgraded at the read boundary (hit.wav → audio/hit.wav).
    return canonicalAudioFile(input);
  } catch {
    throw new AudioProjectError('invalid_project', `${path} must stay inside the game audio directory`);
  }
}

function normalizeShaping(value: unknown, path: string): AudioShapingParams {
  const shaping = objectValue(value, path);
  return {
    gainDb: numberValue(shaping.gainDb, `${path}.gainDb`, 0, -24, 12),
    pitchSemitones: numberValue(shaping.pitchSemitones, `${path}.pitchSemitones`, 0, -12, 12),
    highpassHz: numberValue(shaping.highpassHz, `${path}.highpassHz`, 20, 20, 2_000),
    lowpassHz: numberValue(shaping.lowpassHz, `${path}.lowpassHz`, 20_000, 1_000, 20_000),
    eqLowDb: numberValue(shaping.eqLowDb, `${path}.eqLowDb`, 0, -12, 12),
    eqMidDb: numberValue(shaping.eqMidDb, `${path}.eqMidDb`, 0, -12, 12),
    eqHighDb: numberValue(shaping.eqHighDb, `${path}.eqHighDb`, 0, -12, 12),
  };
}

function normalizeAsset(value: unknown, path: string): AudioAssetRef {
  const item = objectValue(value, path);
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined;
  return {
    assetId: textValue(item.assetId, `${path}.assetId`),
    file: safeAssetFile(item.file, `${path}.file`),
    ...(name ? { name } : {}),
    ...(item.shaping === undefined ? {} : { shaping: normalizeShaping(item.shaping, `${path}.shaping`) }),
  };
}

function followScalar(value: unknown, path: string, fallback: AudioFollowValue): AudioFollowValue {
  const candidate = value === undefined ? fallback : value;
  if (!['string', 'number', 'boolean'].includes(typeof candidate)) {
    throw new AudioProjectError('invalid_project', `${path} must be a string, number, or boolean`);
  }
  if (typeof candidate === 'number' && !Number.isFinite(candidate)) {
    throw new AudioProjectError('invalid_project', `${path} must be finite`);
  }
  return candidate as AudioFollowValue;
}

function normalizeFollow(value: unknown, path: string): AudioFollowRule {
  const row = objectValue(value, path);
  const field = textValue(row.field, `${path}.field`);
  if (!CONDITION_FIELD_RE.test(field)) {
    throw new AudioProjectError('invalid_project', `${path}.field is not a safe game value path`);
  }
  const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : undefined;
  const hasCases = row.cases !== undefined;
  const hasRange = row.range !== undefined;
  if (hasCases === hasRange) {
    throw new AudioProjectError('invalid_project', `${path} must define either cases or range`);
  }
  if (hasCases) {
    if (!Array.isArray(row.cases) || row.cases.length === 0 || row.cases.length > 32) {
      throw new AudioProjectError('invalid_project', `${path}.cases must contain 1 to 32 mappings`);
    }
    const seen = new Set<string>();
    const cases = row.cases.map((candidate, index): AudioFollowCase => {
      const item = objectValue(candidate, `${path}.cases[${index}]`);
      const caseValue = followScalar(item.value, `${path}.cases[${index}].value`, '');
      const key = `${typeof caseValue}:${String(caseValue)}`;
      if (seen.has(key)) throw new AudioProjectError('invalid_project', `${path}.cases contains duplicate value '${String(caseValue)}'`);
      seen.add(key);
      if (!Array.isArray(item.assets) || item.assets.length === 0) {
        throw new AudioProjectError('invalid_project', `${path}.cases[${index}].assets must not be empty`);
      }
      const caseLabel = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : undefined;
      return {
        value: caseValue,
        ...(caseLabel ? { label: caseLabel } : {}),
        assets: item.assets.map((asset, assetIndex) => normalizeAsset(asset, `${path}.cases[${index}].assets[${assetIndex}]`)),
      };
    });
    return {
      field,
      ...(label ? { label } : {}),
      defaultValue: followScalar(row.defaultValue, `${path}.defaultValue`, ''),
      cases,
    };
  }
  const range = objectValue(row.range, `${path}.range`);
  const min = numberValue(range.min, `${path}.range.min`, 0, -1_000_000, 1_000_000);
  const max = numberValue(range.max, `${path}.range.max`, 1, -1_000_000, 1_000_000);
  if (max <= min) throw new AudioProjectError('invalid_project', `${path}.range.max must be greater than min`);
  return {
    field,
    ...(label ? { label } : {}),
    defaultValue: followScalar(row.defaultValue, `${path}.defaultValue`, min),
    range: {
      min,
      max,
      volumeStart: numberValue(range.volumeStart, `${path}.range.volumeStart`, 1, 0, 4),
      volumeEnd: numberValue(range.volumeEnd, `${path}.range.volumeEnd`, 1, 0, 4),
      pitchStart: numberValue(range.pitchStart, `${path}.range.pitchStart`, 0, -12, 12),
      pitchEnd: numberValue(range.pitchEnd, `${path}.range.pitchEnd`, 0, -12, 12),
      lowpassStart: numberValue(range.lowpassStart, `${path}.range.lowpassStart`, 20_000, 1_000, 20_000),
      lowpassEnd: numberValue(range.lowpassEnd, `${path}.range.lowpassEnd`, 20_000, 1_000, 20_000),
    },
  };
}

function normalizeCondition(value: unknown, index: number): AudioCondition {
  const row = objectValue(value, `conditions[${index}]`);
  const field = textValue(row.field, `conditions[${index}].field`);
  if (!CONDITION_FIELD_RE.test(field)) {
    throw new AudioProjectError('invalid_project', `conditions[${index}].field is not a safe context path`);
  }
  const operator = enumValue(
    row.operator,
    CONDITION_OPERATORS,
    `conditions[${index}].operator`,
    'eq',
  );
  const conditionValue = row.value;
  const scalar = typeof conditionValue === 'string'
    || typeof conditionValue === 'number'
    || typeof conditionValue === 'boolean';
  const scalarArray = Array.isArray(conditionValue)
    && conditionValue.every((item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean');
  if (!scalar && !scalarArray) {
    throw new AudioProjectError('invalid_project', `conditions[${index}].value must be a scalar or scalar array`);
  }
  if (operator === 'in' && !scalarArray) {
    throw new AudioProjectError('invalid_project', `conditions[${index}].value must be an array for operator in`);
  }
  return { field, operator, value: conditionValue as AudioConditionValue };
}

function normalizeProvenance(value: unknown, path: string): AudioHookProvenance {
  const row = objectValue(value, path);
  const status = enumValue(row.status, HOOK_STATUSES, `${path}.status`, 'wired');
  if (row.status === undefined) {
    throw new AudioProjectError('invalid_project', `${path}.status must be wired or gap`);
  }
  const reason = textValue(row.reason, `${path}.reason`);
  const fileRaw = row.file === undefined || row.file === '' ? '' : textValue(row.file, `${path}.file`);
  const file = fileRaw.replace(/\\/g, '/');
  if (file && (file.startsWith('/') || file.split('/').some((part) => part === '..' || part === ''))) {
    throw new AudioProjectError('invalid_project', `${path}.file must be a relative game source path`);
  }
  if (status === 'wired' && !file) {
    throw new AudioProjectError('invalid_project', `${path}.file is required when status is wired`);
  }
  const symbol = row.symbol === undefined || row.symbol === ''
    ? undefined
    : textValue(row.symbol, `${path}.symbol`);
  return {
    status,
    reason,
    ...(file ? { file } : {}),
    ...(symbol ? { symbol } : {}),
  };
}

function normalizeBinding(value: unknown, index: number): AudioBinding {
  const row = objectValue(value, `bindings[${index}]`);
  const eventId = eventIdValue(row.eventId, `bindings[${index}].eventId`);
  const kind = enumValue(row.kind, KINDS, `bindings[${index}].kind`, 'sfx');
  const rawAssets = row.assets === undefined ? [] : row.assets;
  if (!Array.isArray(rawAssets)) {
    throw new AudioProjectError('invalid_project', `bindings[${index}].assets must be an array`);
  }
  const assets = rawAssets.map((asset, assetIndex) => normalizeAsset(asset, `bindings[${index}].assets[${assetIndex}]`));

  const variation = row.variation === undefined ? {} : objectValue(row.variation, `bindings[${index}].variation`);
  const trigger = row.trigger === undefined ? {} : objectValue(row.trigger, `bindings[${index}].trigger`);
  const playback = row.playback === undefined ? {} : objectValue(row.playback, `bindings[${index}].playback`);
  const stopEventId = playback.stopEventId === undefined || playback.stopEventId === ''
    ? undefined
    : eventIdValue(playback.stopEventId, `bindings[${index}].playback.stopEventId`);
  const attenuationId = playback.attenuationId === undefined || playback.attenuationId === ''
    ? undefined
    : textValue(playback.attenuationId, `bindings[${index}].playback.attenuationId`);
  const rawConditions = row.conditions === undefined ? [] : row.conditions;
  if (!Array.isArray(rawConditions)) {
    throw new AudioProjectError('invalid_project', `bindings[${index}].conditions must be an array`);
  }

  return {
    eventId,
    label: textValue(row.label, `bindings[${index}].label`, eventId),
    enabled: row.enabled === undefined ? true : Boolean(row.enabled),
    kind,
    assets,
    variation: {
      mode: enumValue(variation.mode, VARIATIONS, `bindings[${index}].variation.mode`, 'single'),
    },
    trigger: {
      delayMs: numberValue(trigger.delayMs, `bindings[${index}].trigger.delayMs`, 0, 0, 3_600_000),
      cooldownMs: numberValue(trigger.cooldownMs, `bindings[${index}].trigger.cooldownMs`, 0, 0, 3_600_000),
      probability: numberValue(trigger.probability, `bindings[${index}].trigger.probability`, 1, 0, 1),
      // Absent and zero mean different things here, so an absent value must
      // survive normalisation rather than be filled in with a default.
      ...(trigger.rhythmLockMs === undefined ? {} : {
        rhythmLockMs: numberValue(
          trigger.rhythmLockMs,
          `bindings[${index}].trigger.rhythmLockMs`,
          0,
          0,
          10_000,
        ),
      }),
    },
    playback: {
      volume: numberValue(playback.volume, `bindings[${index}].playback.volume`, 1, 0, 4),
      bus: enumValue(playback.bus, KINDS, `bindings[${index}].playback.bus`, kind),
      spatial: enumValue(playback.spatial, SPATIAL_MODES, `bindings[${index}].playback.spatial`, '2d'),
      ...(attenuationId ? { attenuationId } : {}),
      mode: enumValue(playback.mode, PLAYBACK_MODES, `bindings[${index}].playback.mode`, 'one-shot'),
      fadeInMs: numberValue(playback.fadeInMs, `bindings[${index}].playback.fadeInMs`, 0, 0, 60_000),
      fadeOutMs: numberValue(playback.fadeOutMs, `bindings[${index}].playback.fadeOutMs`, 0, 0, 60_000),
      ...(stopEventId ? { stopEventId } : {}),
      // Absent means "use the engine budget", so it must not be defaulted here.
      ...(playback.maxInstances === undefined ? {} : {
        maxInstances: numberValue(
          playback.maxInstances,
          `bindings[${index}].playback.maxInstances`,
          8,
          1,
          64,
        ),
      }),
      ...(playback.priority === undefined ? {} : {
        priority: numberValue(playback.priority, `bindings[${index}].playback.priority`, 50, 0, 100),
      }),
    },
    ...(row.shaping === undefined ? {} : { shaping: normalizeShaping(row.shaping, `bindings[${index}].shaping`) }),
    ...(row.follow === undefined ? {} : { follow: normalizeFollow(row.follow, `bindings[${index}].follow`) }),
    conditions: rawConditions.map(normalizeCondition),
    ...(row.provenance === undefined
      ? {}
      : { provenance: normalizeProvenance(row.provenance, `bindings[${index}].provenance`) }),
    ...(row.archetype === undefined
      ? {}
      : { archetype: textValue(row.archetype, `bindings[${index}].archetype`) }),
    ...(row.plannedVariants === undefined ? {} : {
      plannedVariants: numberValue(
        row.plannedVariants,
        `bindings[${index}].plannedVariants`,
        1,
        1,
        16,
      ),
    }),
  };
}

export function audioBindingAssets(binding: AudioBinding): AudioAssetRef[] {
  return [
    ...binding.assets,
    ...(binding.follow?.cases ?? []).flatMap((item) => item.assets),
  ];
}

export function normalizeAudioProjectV1(input: unknown, projectId: string): AudioProjectV1 {
  const expectedProjectId = textValue(projectId, 'projectId');
  const row = input === undefined || input === null ? {} : objectValue(input, 'audio project');
  if (row.schemaVersion !== undefined && row.schemaVersion !== AUDIO_PROJECT_SCHEMA_V1) {
    throw new AudioProjectError('invalid_project', `unsupported audio project schema: ${String(row.schemaVersion)}`);
  }
  if (row.projectId !== undefined && row.projectId !== expectedProjectId) {
    throw new AudioProjectError('invalid_project', `audio project belongs to '${String(row.projectId)}', not '${expectedProjectId}'`);
  }
  const revision = numberValue(row.revision, 'revision', 0, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(revision)) {
    throw new AudioProjectError('invalid_project', 'revision must be an integer');
  }
  const rawBindings = row.bindings === undefined ? [] : row.bindings;
  if (!Array.isArray(rawBindings)) {
    throw new AudioProjectError('invalid_project', 'bindings must be an array');
  }
  const bindings = rawBindings.map(normalizeBinding);
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (seen.has(binding.eventId)) {
      throw new AudioProjectError('invalid_project', `duplicate audio eventId '${binding.eventId}'`);
    }
    seen.add(binding.eventId);
  }
  return {
    schemaVersion: AUDIO_PROJECT_SCHEMA_V1,
    projectId: expectedProjectId,
    revision,
    status: row.status === 'applied' ? 'applied' : 'draft',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    bindings,
  };
}
