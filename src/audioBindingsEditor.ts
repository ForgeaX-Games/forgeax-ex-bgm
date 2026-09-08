import { applyArchetypeDefaults } from '../shared/event-archetypes.ts';
import type {
  AudioAssetRef,
  AudioBinding,
  AudioBus,
  AudioCondition,
  AudioConditionOperator,
  AudioConditionValue,
  AudioFollowRule,
  AudioKind,
  AudioPlaybackMode,
  AudioProject,
  AudioSpatialMode,
  AudioShapingParams,
  AudioVariationMode,
} from '../shared/audio-project.ts';

export interface AudioBindingEdit {
  label?: string;
  enabled?: boolean;
  kind?: AudioKind;
  assets?: AudioAssetRef[];
  variationMode?: AudioVariationMode;
  delayMs?: number;
  cooldownMs?: number;
  probabilityPercent?: number;
  /** 'auto' measures the rate, 'off' keeps the game's timing, a number states the interval. */
  rhythmLock?: 'auto' | 'off' | number;
  volumePercent?: number;
  bus?: AudioBus;
  spatial?: AudioSpatialMode;
  attenuationId?: string;
  playbackMode?: AudioPlaybackMode;
  fadeInMs?: number;
  fadeOutMs?: number;
  stopEventId?: string;
  conditions?: AudioCondition[];
  shaping?: AudioShapingParams | null;
  follow?: AudioFollowRule | null;
}

export interface AudioProjectPatch {
  expectedRevision: number;
  upsertBindings: AudioBinding[];
  removeEventIds: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function cloneBinding(binding: AudioBinding): AudioBinding {
  return structuredClone(binding);
}

export function createBindingDraft(eventId: string, label = eventId): AudioBinding {
  const id = eventId.trim();
  const filled = applyArchetypeDefaults({
    eventId: id,
    kind: 'sfx',
  });
  const trigger = (filled.trigger ?? {}) as Record<string, number>;
  const playback = (filled.playback ?? {}) as Record<string, unknown>;
  const bus = playback.bus === 'music' || playback.bus === 'voice' ? playback.bus : 'sfx';
  return {
    eventId: id,
    label: label.trim() || id,
    enabled: true,
    kind: bus,
    assets: [],
    variation: { mode: 'single' },
    trigger: {
      delayMs: trigger.delayMs ?? 0,
      cooldownMs: trigger.cooldownMs ?? 0,
      probability: trigger.probability ?? 1,
      ...(trigger.rhythmLockMs === undefined ? {} : { rhythmLockMs: trigger.rhythmLockMs }),
    },
    playback: {
      volume: typeof playback.volume === 'number' ? playback.volume : 1,
      bus,
      spatial: playback.spatial === '3d' ? '3d' : '2d',
      mode: playback.mode === 'loop' ? 'loop' : 'one-shot',
      fadeInMs: typeof playback.fadeInMs === 'number' ? playback.fadeInMs : 0,
      fadeOutMs: typeof playback.fadeOutMs === 'number' ? playback.fadeOutMs : 0,
    },
    conditions: [],
  };
}

export function applyBindingEdit(binding: AudioBinding, edit: AudioBindingEdit): AudioBinding {
  const next = cloneBinding(binding);
  if (edit.label !== undefined) next.label = edit.label.trim() || next.eventId;
  if (edit.enabled !== undefined) next.enabled = edit.enabled;
  if (edit.kind !== undefined) next.kind = edit.kind;
  if (edit.assets !== undefined) next.assets = structuredClone(edit.assets);
  if (edit.variationMode !== undefined) next.variation.mode = edit.variationMode;
  if (edit.delayMs !== undefined) next.trigger.delayMs = clamp(edit.delayMs, 0, 3_600_000);
  if (edit.cooldownMs !== undefined) next.trigger.cooldownMs = clamp(edit.cooldownMs, 0, 3_600_000);
  if (edit.probabilityPercent !== undefined) {
    next.trigger.probability = clamp(edit.probabilityPercent, 0, 100) / 100;
  }
  if (edit.rhythmLock !== undefined) {
    if (edit.rhythmLock === 'auto') delete next.trigger.rhythmLockMs;
    else if (edit.rhythmLock === 'off') next.trigger.rhythmLockMs = 0;
    else next.trigger.rhythmLockMs = clamp(edit.rhythmLock, 1, 10_000);
  }
  if (edit.volumePercent !== undefined) next.playback.volume = clamp(edit.volumePercent, 0, 400) / 100;
  if (edit.bus !== undefined) next.playback.bus = edit.bus;
  if (edit.spatial !== undefined) next.playback.spatial = edit.spatial;
  if (edit.attenuationId !== undefined) {
    const attenuationId = edit.attenuationId.trim();
    if (attenuationId) next.playback.attenuationId = attenuationId;
    else delete next.playback.attenuationId;
  }
  if (edit.playbackMode !== undefined) next.playback.mode = edit.playbackMode;
  if (edit.fadeInMs !== undefined) next.playback.fadeInMs = clamp(edit.fadeInMs, 0, 60_000);
  if (edit.fadeOutMs !== undefined) next.playback.fadeOutMs = clamp(edit.fadeOutMs, 0, 60_000);
  if (edit.stopEventId !== undefined) {
    const stopEventId = edit.stopEventId.trim();
    if (stopEventId) next.playback.stopEventId = stopEventId;
    else delete next.playback.stopEventId;
  }
  if (edit.conditions !== undefined) next.conditions = structuredClone(edit.conditions);
  if (edit.shaping !== undefined) {
    if (edit.shaping === null) delete next.shaping;
    else next.shaping = structuredClone(edit.shaping);
  }
  if (edit.follow !== undefined) {
    if (edit.follow === null) delete next.follow;
    else next.follow = structuredClone(edit.follow);
  }
  return next;
}

export function upsertBindingInDraft(bindings: AudioBinding[], binding: AudioBinding): AudioBinding[] {
  const next = bindings.map(cloneBinding);
  const index = next.findIndex((item) => item.eventId === binding.eventId);
  if (index >= 0) next[index] = cloneBinding(binding);
  else next.push(cloneBinding(binding));
  return next;
}

export function removeBindingFromDraft(bindings: AudioBinding[], eventId: string): AudioBinding[] {
  return bindings.filter((binding) => binding.eventId !== eventId).map(cloneBinding);
}

export function buildAudioProjectPatch(project: AudioProject, draft: AudioBinding[]): AudioProjectPatch {
  const original = new Map(project.bindings.map((binding) => [binding.eventId, binding]));
  const next = new Map(draft.map((binding) => [binding.eventId, binding]));
  const upsertBindings = draft
    .filter((binding) => JSON.stringify(original.get(binding.eventId)) !== JSON.stringify(binding))
    .map(cloneBinding);
  const removeEventIds = project.bindings
    .filter((binding) => !next.has(binding.eventId))
    .map((binding) => binding.eventId);
  return { expectedRevision: project.revision, upsertBindings, removeEventIds };
}

export function parseConditionValue(raw: string): AudioConditionValue {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        Array.isArray(parsed)
        && parsed.every((item) => ['string', 'number', 'boolean'].includes(typeof item))
      ) {
        return parsed as Array<string | number | boolean>;
      }
    } catch {
      // Keep malformed JSON as a literal string so the user can correct it.
    }
  }
  return value;
}

export function conditionFromFields(
  field: string,
  operator: AudioConditionOperator,
  value: string,
): AudioCondition | null {
  const normalizedField = field.trim();
  if (!normalizedField) return null;
  return { field: normalizedField, operator, value: parseConditionValue(value) };
}
