/**
 * Default playback numbers for a kind of game event.
 *
 * Agents should name the archetype (or let us infer it from the event id)
 * instead of inventing cooldown and volume. Explicit fields on the binding
 * always win.
 */
export const EVENT_ARCHETYPE_IDS = [
  'impact',
  'defeat',
  'pickup',
  'rare-loot',
  'ui',
  'footstep',
  'weapon-fire',
  'attack',
  'hurt',
  'jump',
  'bgm-loop',
  'ambient-loop',
] as const;

export type EventArchetypeId = (typeof EVENT_ARCHETYPE_IDS)[number];

export interface EventArchetype {
  id: EventArchetypeId;
  cooldownMs: number;
  volume: number;
  spatial: '2d' | '3d';
  mode: 'one-shot' | 'loop';
  bus: 'sfx' | 'music' | 'voice';
  /**
   * `undefined` leaves rhythm lock on auto (runtime measures the burst).
   * `0` turns it off. A positive value is a fixed interval.
   */
  rhythmLockMs?: number;
  /** Same event can fire from many objects in one frame. */
  multiInstance: boolean;
  /**
   * How many clips to generate so a repeat does not reuse the same sample.
   * An event that fires hundreds of times a run needs several; a death sting
   * needs one. Without this the generation flow produces one clip per event and
   * a high-frequency sound becomes recognisably the same take every time.
   */
  variants: number;
  /**
   * Concurrent voices allowed for this event. Sized against how many can
   * legitimately overlap: dozens of enemies dying together, one jump.
   */
  maxInstances: number;
  /**
   * Higher wins when the voice budget is full. Music and rare beats must not be
   * evicted by whatever fired most recently.
   */
  priority: number;
}

export const EVENT_ARCHETYPES: Record<EventArchetypeId, EventArchetype> = {
  impact: {
    id: 'impact',
    cooldownMs: 65,
    volume: 0.38,
    spatial: '3d',
    mode: 'one-shot',
    bus: 'sfx',
    multiInstance: true,
    variants: 3,
    maxInstances: 12,
    priority: 30,
  },
  defeat: {
    id: 'defeat',
    cooldownMs: 0,
    volume: 0.1,
    spatial: '3d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: true,
    variants: 2,
    maxInstances: 8,
    priority: 30,
  },
  pickup: {
    id: 'pickup',
    cooldownMs: 0,
    volume: 0.22,
    spatial: '2d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: true,
    variants: 2,
    maxInstances: 8,
    priority: 30,
  },
  'rare-loot': {
    id: 'rare-loot',
    cooldownMs: 800,
    volume: 0.45,
    spatial: '2d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: false,
    variants: 1,
    maxInstances: 3,
    priority: 70,
  },
  ui: {
    id: 'ui',
    cooldownMs: 30,
    volume: 0.45,
    spatial: '2d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: false,
    variants: 2,
    maxInstances: 2,
    priority: 60,
  },
  footstep: {
    id: 'footstep',
    cooldownMs: 0,
    volume: 0.35,
    spatial: '3d',
    mode: 'one-shot',
    bus: 'sfx',
    multiInstance: true,
    variants: 4,
    maxInstances: 6,
    priority: 20,
  },
  'weapon-fire': {
    id: 'weapon-fire',
    cooldownMs: 0,
    volume: 0.5,
    spatial: '3d',
    mode: 'one-shot',
    bus: 'sfx',
    multiInstance: true,
    variants: 3,
    maxInstances: 4,
    priority: 50,
  },
  attack: {
    id: 'attack',
    cooldownMs: 0,
    volume: 0.32,
    spatial: '2d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: false,
    variants: 3,
    maxInstances: 4,
    priority: 50,
  },
  hurt: {
    id: 'hurt',
    cooldownMs: 80,
    volume: 0.4,
    spatial: '3d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: true,
    variants: 3,
    maxInstances: 4,
    priority: 60,
  },
  jump: {
    id: 'jump',
    cooldownMs: 0,
    volume: 0.4,
    spatial: '2d',
    mode: 'one-shot',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: false,
    variants: 2,
    maxInstances: 1,
    priority: 50,
  },
  'bgm-loop': {
    id: 'bgm-loop',
    cooldownMs: 0,
    volume: 0.7,
    spatial: '2d',
    mode: 'loop',
    bus: 'music',
    rhythmLockMs: 0,
    multiInstance: false,
    variants: 1,
    maxInstances: 1,
    priority: 90,
  },
  'ambient-loop': {
    id: 'ambient-loop',
    cooldownMs: 0,
    volume: 0.4,
    spatial: '2d',
    mode: 'loop',
    bus: 'sfx',
    rhythmLockMs: 0,
    multiInstance: false,
    variants: 1,
    maxInstances: 2,
    priority: 80,
  },
};

export function isEventArchetypeId(value: unknown): value is EventArchetypeId {
  return typeof value === 'string' && EVENT_ARCHETYPE_IDS.includes(value as EventArchetypeId);
}

export function inferArchetypeId(eventId: string, kind?: string): EventArchetypeId | undefined {
  const id = eventId.trim().toLowerCase();
  if (!id) return undefined;
  if (kind === 'music' || id.startsWith('music.')) return 'bgm-loop';
  if (id.startsWith('ambience.') || id.startsWith('ambient.') || id.includes('ambience')) {
    return 'ambient-loop';
  }
  if (id.startsWith('ui.')) return 'ui';
  if (id.includes('footstep')) return 'footstep';
  if (id.includes('jump')) return 'jump';
  if (id.includes('hurt')) return 'hurt';
  if (/(^|[.-])(fire|shoot)($|[.-])/.test(id) || id.includes('weapon.fire')) return 'weapon-fire';
  if (id.includes('death') || id.includes('defeat') || id.includes('stomp')) return 'defeat';
  if (id.includes('loot') || id.includes('reward') || id.includes('level.up') || id.includes('epic')) {
    return 'rare-loot';
  }
  if (id.includes('pickup') || id.includes('collect') || id.includes('coin')) return 'pickup';
  if (id.includes('impact') || /(^|[._-])hit$/.test(id) || id.includes('.hit') || id.includes('flesh')) {
    return 'impact';
  }
  if (id.includes('attack') || id.includes('swing') || id.includes('melee') || id.includes('slash')) {
    return 'attack';
  }
  return undefined;
}

export function resolveArchetype(
  explicit: unknown,
  eventId: string,
  kind?: string,
): EventArchetype | undefined {
  if (isEventArchetypeId(explicit)) return EVENT_ARCHETYPES[explicit];
  const inferred = inferArchetypeId(eventId, kind);
  return inferred ? EVENT_ARCHETYPES[inferred] : undefined;
}

function objectCopy(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

/**
 * Fill missing trigger/playback fields from the resolved archetype.
 * Present values, including explicit zeros, are left alone.
 */
export function applyArchetypeDefaults(raw: Record<string, unknown>): Record<string, unknown> {
  const eventId = typeof raw.eventId === 'string' ? raw.eventId : '';
  const kind = typeof raw.kind === 'string' ? raw.kind : undefined;
  const archetype = resolveArchetype(raw.archetype, eventId, kind);
  if (!archetype) return { ...raw };

  const trigger = objectCopy(raw.trigger);
  const playback = objectCopy(raw.playback);
  if (trigger.delayMs === undefined) trigger.delayMs = 0;
  if (trigger.cooldownMs === undefined) trigger.cooldownMs = archetype.cooldownMs;
  if (trigger.probability === undefined) trigger.probability = 1;
  if (trigger.rhythmLockMs === undefined && archetype.rhythmLockMs !== undefined) {
    trigger.rhythmLockMs = archetype.rhythmLockMs;
  }
  if (playback.volume === undefined) playback.volume = archetype.volume;
  if (playback.bus === undefined) playback.bus = archetype.bus;
  if (playback.spatial === undefined) playback.spatial = archetype.spatial;
  if (playback.mode === undefined) playback.mode = archetype.mode;
  if (playback.fadeInMs === undefined) playback.fadeInMs = 0;
  if (playback.fadeOutMs === undefined) playback.fadeOutMs = 0;
  if (playback.maxInstances === undefined) playback.maxInstances = archetype.maxInstances;
  if (playback.priority === undefined) playback.priority = archetype.priority;

  return { ...raw, archetype: archetype.id, trigger, playback };
}

/**
 * The archetype the author put on the binding, ignoring name inference.
 * Auditing is only fair against a declaration.
 */
export function declaredArchetype(value: unknown): EventArchetype | undefined {
  return isEventArchetypeId(value) ? EVENT_ARCHETYPES[value] : undefined;
}

/** Clips this event should carry so a repeat is not the same take. */
export function expectedVariantCount(
  eventId: string,
  kind?: string,
  explicitArchetype?: unknown,
): number | undefined {
  return resolveArchetype(explicitArchetype, eventId, kind)?.variants;
}

export interface VarietyShortfall {
  code: 'variety_below_archetype';
  eventId: string;
  archetype: EventArchetypeId;
  assets: number;
  expected: number;
  message: string;
}

/**
 * Coverage says an event has a sound; it says nothing about a player hearing
 * the same 200 ms sample four hundred times. Reported as a finding rather than
 * an error: one clip is a legitimate choice, it just should be a deliberate one.
 */
export function varietyShortfall(binding: {
  eventId: string;
  archetype?: unknown;
  assets: unknown[];
  follow?: { cases?: unknown[] } | undefined;
}): VarietyShortfall | undefined {
  const archetype = declaredArchetype(binding.archetype);
  if (!archetype || archetype.variants <= 1) return undefined;
  // Per-case clips are variety of a different kind — the sound already changes
  // with game state, so a single clip per case is not repetitive.
  if (binding.follow?.cases?.length) return undefined;
  const assets = binding.assets.length;
  if (assets >= archetype.variants) return undefined;
  return {
    code: 'variety_below_archetype',
    eventId: binding.eventId,
    archetype: archetype.id,
    assets,
    expected: archetype.variants,
    message:
      `event '${binding.eventId}' is a '${archetype.id}' with ${assets} clip(s); this fires often `
      + `enough that ${archetype.variants} variants keep it from sounding like one repeated sample. `
      + 'Generate more takes, or split by game value with follow.cases.',
  };
}

export interface ArchetypeVolumeDrift {
  code: 'archetype_volume_drift';
  eventId: string;
  archetype: EventArchetypeId;
  volume: number;
  expected: number;
  message: string;
}

/**
 * The archetype table already carries volumes tuned against how often a beat
 * fires — a defeat at 0.1 sits under the mix, a level-up at 0.58 lands. Those
 * defaults only apply to fields left empty, so a caller writing its own number
 * silently opts out. Surfacing the deviation is what makes that choice reviewable.
 */
export function archetypeVolumeDrift(binding: {
  eventId: string;
  archetype?: unknown;
  playback: { volume: number };
}): ArchetypeVolumeDrift | undefined {
  // Only judge against a declared archetype. Inferring one from the event name
  // and then calling the author's number wrong would be second-guessing a
  // project that never opted into these defaults.
  const archetype = declaredArchetype(binding.archetype);
  if (!archetype) return undefined;
  const volume = binding.playback.volume;
  const expected = archetype.volume;
  if (expected <= 0) return undefined;
  const ratio = volume / expected;
  if (ratio >= 0.5 && ratio <= 1.5) return undefined;
  return {
    code: 'archetype_volume_drift',
    eventId: binding.eventId,
    archetype: archetype.id,
    volume,
    expected,
    message:
      `event '${binding.eventId}' is a '${archetype.id}' at volume ${volume}, against the `
      + `${expected} this beat is tuned to (${ratio > 1 ? 'louder' : 'quieter'} by `
      + `${Math.round(Math.abs(ratio - 1) * 100)}%). A '${archetype.id}' fires often enough that `
      + 'this changes the whole mix — keep the default unless the deviation is deliberate.',
  };
}

export interface CooldownScopeWarning {
  code: 'cooldown_needs_game_object';
  eventId: string;
  message: string;
}

export function cooldownScopeWarning(binding: {
  eventId: string;
  kind?: string;
  archetype?: unknown;
  trigger: { cooldownMs: number };
  playback: { spatial: string };
}): CooldownScopeWarning | undefined {
  const archetype = resolveArchetype(binding.archetype, binding.eventId, binding.kind);
  if (!archetype?.multiInstance) return undefined;
  if (binding.trigger.cooldownMs <= 0) return undefined;
  if (binding.playback.spatial !== '2d') return undefined;
  return {
    code: 'cooldown_needs_game_object',
    eventId: binding.eventId,
    message:
      `event '${binding.eventId}' can fire from many objects in one frame, but it is 2D with `
      + `cooldownMs ${binding.trigger.cooldownMs}. Without gameObjectId on emit they share one `
      + 'gate and later hits are swallowed. Pass gameObjectId, or set cooldownMs to 0.',
  };
}
