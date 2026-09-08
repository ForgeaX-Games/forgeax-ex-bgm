/**
 * forgeax-audio-project/2 — addressable entities with immutable ids.
 *
 * v1 documents are accepted at the boundary and migrated here. The audio studio
 * still edits a derived `bindings` view until the UI is rewritten; that view is
 * never the source of truth on disk.
 */
import { canonicalAudioFile } from './audio-file-path.ts';
import {
  AUDIO_PROJECT_SCHEMA_V1,
  audioBindingAssets,
  AudioProjectError,
  normalizeAudioProjectV1,
  type AudioAssetRef,
  type AudioBinding,
  type AudioCondition,
  type AudioFollowValue,
  type AudioHookProvenance,
  type AudioKind,
  type AudioProjectV1,
  type AudioShapingParams,
  type AudioSpatialMode,
  type AudioPlaybackMode,
} from './audio-project-v1.ts';

export const AUDIO_PROJECT_SCHEMA = 'forgeax-audio-project/2' as const;
export const AUDIO_ENGINE_VERSION = '2.0.0-dev' as const;

export type SelectionScope = 'global' | 'gameObject';
export type CurveInterp = 'linear' | 'log' | 'exp' | 'sCurve' | 'constant';

export interface CurvePoint {
  x: number;
  y: number;
  interp: CurveInterp;
}

export interface AudioBusNode {
  id: string;
  name: string;
  parentId?: string;
  volumeDb: number;
  effects: Array<{ id: string; type: string; params?: Record<string, number> }>;
  auxSends: Array<{ busId: string; levelDb: number }>;
  ducking: Array<{
    sourceBusId: string;
    volumeDb: number;
    attackMs: number;
    releaseMs: number;
    curve: 'linear' | 'sCurve';
  }>;
  voiceLimit?: number;
}

export interface StateGroup {
  id: string;
  name: string;
  values: string[];
  defaultValue: string;
  transitions: Array<{ from: '*' | string; to: '*' | string; timeMs: number }>;
}

export interface SwitchGroup {
  id: string;
  name: string;
  values: string[];
  defaultValue: string;
  rtpcId?: string;
}

export interface RtpcDefinition {
  id: string;
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  scope: SelectionScope;
  slewMsDefault: number;
}

export interface RtpcBinding {
  rtpcId: string;
  target: 'volumeDb' | 'pitchSemitones' | 'lowpassHz' | 'highpassHz' | 'auxSendDb';
  auxBusId?: string;
  curve: CurvePoint[];
}

export interface StateOffset {
  groupId: string;
  values: Record<string, { volumeDb?: number; pitchSemitones?: number; lowpassHz?: number }>;
}

export interface BlendLayer {
  node: AudioNode;
  rangeStart: number;
  rangeEnd: number;
  crossfadeCurve: CurvePoint[];
}

export type AudioNode =
  | { kind: 'sound'; asset: AudioAssetRef }
  | {
    kind: 'random';
    children: AudioNode[];
    weights: number[];
    avoidRepeatCount: number;
    scope: SelectionScope;
  }
  | { kind: 'sequence'; children: AudioNode[]; loop: boolean; scope: SelectionScope }
  | {
    kind: 'switch';
    groupId: string;
    assignments: Record<string, AudioNode>;
    onSwitchChange: 'restart' | 'continue';
    /** Assets used when the switch value is missing / default. */
    defaultNode?: AudioNode;
  }
  | { kind: 'blend'; rtpcId: string; layers: BlendLayer[] };

export interface AudioObject {
  id: string;
  name: string;
  node: AudioNode;
  outputBusId: string;
  spatial: AudioSpatialMode;
  attenuationId?: string;
  priority: number;
  limit: {
    maxInstances: number;
    scope: SelectionScope;
    onExceed: 'reject' | 'stealOldest' | 'stealQuietest';
  };
  virtualBehavior: 'fromBeginning' | 'fromElapsed' | 'resume' | 'kill';
  playback: {
    mode: AudioPlaybackMode;
    loopCount: number;
    fadeInMs: number;
    fadeOutMs: number;
    /** Linear gain retained from v1 for bake parity with the current runtime. */
    volume: number;
  };
  shaping?: AudioShapingParams;
  rtpcBindings: RtpcBinding[];
  stateOffsets: StateOffset[];
  conditions: AudioCondition[];
}

export type AudioAction =
  | {
    type: 'play';
    objectId: string;
    delayMs: number;
    probability: number;
    /** Carried from v1 trigger.cooldownMs for parity until voice limits replace it. */
    cooldownMs?: number;
    /** Repeat interval for evening out frame-quantised bursts; see v1 trigger. */
    rhythmLockMs?: number;
  }
  | { type: 'stop'; objectId: string; fadeOutMs: number; scope: SelectionScope }
  | { type: 'setSwitch'; groupId: string; value: string }
  | { type: 'setState'; groupId: string; value: string }
  | { type: 'setBusVolume'; busId: string; volumeDb: number; timeMs: number }
  | { type: 'postTrigger'; triggerId: string };

export interface AudioEvent {
  id: string;
  name: string;
  label: string;
  enabled: boolean;
  actions: AudioAction[];
  provenance?: AudioHookProvenance;
  /** Which kind of game beat this is; see shared/event-archetypes.ts. */
  archetype?: string;
  /** Clips the author said this event needs, so verify can check it got them. */
  plannedVariants?: number;
}

export interface AttenuationShareSet {
  id: string;
  name: string;
  maxDistance: number;
  curves: {
    outputVolumeDb: CurvePoint[];
    lowpassHz?: CurvePoint[];
    highpassHz?: CurvePoint[];
    auxSendDb?: CurvePoint[];
    spread?: CurvePoint[];
  };
  cone?: {
    innerAngleDeg: number;
    outerAngleDeg: number;
    outerVolumeDb: number;
    outerLowpassHz: number;
  };
}

export type MusicSyncPoint =
  | 'immediate'
  | 'nextGrid'
  | 'nextBeat'
  | 'nextBar'
  | 'nextCue'
  | 'exitCue'
  | { customCueId: string };

export interface MusicTrackClip {
  assetId: string;
  file: string;
  startMs: number;
  durationMs: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface MusicTrack {
  id: string;
  kind: 'normal' | 'randomStep' | 'sequenceStep' | 'switch';
  switchGroupId?: string;
  clips: MusicTrackClip[];
  rtpcBindings: RtpcBinding[];
}

export interface MusicSegment {
  id: string;
  name: string;
  tempo: number;
  timeSignature: [number, number];
  preEntryMs: number;
  entryCueMs: number;
  exitCueMs: number;
  postExitMs: number;
  customCues: Array<{ id: string; name: string; timeMs: number }>;
  tracks: MusicTrack[];
}

export interface MusicPlaylist {
  id: string;
  name: string;
  segmentIds: string[];
}

export interface MusicTransition {
  fromPlaylistId: '*' | string;
  toPlaylistId: '*' | string;
  exitAt: MusicSyncPoint;
  syncTo: 'entryCue' | 'sameTimeAsPlaying' | 'randomCue' | 'lastExitPosition';
  fadeOutMs: number;
  fadeInMs: number;
  transitionSegmentId?: string;
}

export interface MusicStinger {
  id: string;
  triggerId: string;
  segmentId: string;
  syncTo: MusicSyncPoint;
}

export interface MusicProject {
  segments: MusicSegment[];
  playlists: MusicPlaylist[];
  transitions: MusicTransition[];
  stingers: MusicStinger[];
}

export interface AudioProjectDocument {
  schemaVersion: typeof AUDIO_PROJECT_SCHEMA;
  projectId: string;
  revision: number;
  status: 'draft' | 'applied';
  updatedAt: string;
  engineVersion: string;
  buses: AudioBusNode[];
  gameSyncs: {
    states: StateGroup[];
    switches: SwitchGroup[];
    rtpcs: RtpcDefinition[];
  };
  attenuations: AttenuationShareSet[];
  objects: AudioObject[];
  events: AudioEvent[];
  music?: MusicProject;
  /**
   * The audio plan this revision was built from. Stored with the draft so the
   * plan stops being prose in a report nobody rechecks and becomes something
   * verification can hold the result against.
   */
  plan?: AudioPlan;
}

export interface AudioPlan {
  /** Overall feel this pass is going for. */
  tone?: string;
  /** Which beats must sound, what was split by which dimension, what is a gap. */
  notes?: string;
  /** When the plan was recorded, so a stale plan is recognisable. */
  recordedAt?: string;
}

/** Canonical project plus the derived v1 bindings view used by today's audio studio. */
export interface AudioProject extends AudioProjectDocument {
  bindings: AudioBinding[];
}

/**
 * What every migrated object used to get regardless of the event. Kept as the
 * "unset" marker so an old draft still round-trips through the v1 view.
 */
const LEGACY_VOICE_LIMIT = 8;
const LEGACY_PRIORITY = 50;

const BUS_MASTER = 'bus:master';
const BUS_BY_KIND: Record<AudioKind, string> = {
  sfx: 'bus:sfx',
  music: 'bus:music',
  voice: 'bus:voice',
};
const KIND_BY_BUS: Record<string, AudioKind> = {
  'bus:sfx': 'sfx',
  'bus:music': 'music',
  'bus:voice': 'voice',
};

export function defaultBuses(): AudioBusNode[] {
  const leaf = (id: string, name: string): AudioBusNode => ({
    id,
    name,
    parentId: BUS_MASTER,
    volumeDb: 0,
    effects: [],
    auxSends: [],
    ducking: [],
  });
  return [
    {
      id: BUS_MASTER,
      name: 'Master',
      volumeDb: 0,
      effects: [],
      auxSends: [],
      ducking: [],
    },
    leaf(BUS_BY_KIND.sfx, 'SFX'),
    leaf(BUS_BY_KIND.music, 'Music'),
    leaf(BUS_BY_KIND.voice, 'Voice'),
  ];
}

export function emptyMusicProject(): MusicProject {
  return { segments: [], playlists: [], transitions: [], stingers: [] };
}

export function emptyAudioProject(projectId: string): AudioProject {
  return attachLegacyBindings({
    schemaVersion: AUDIO_PROJECT_SCHEMA,
    projectId,
    revision: 0,
    status: 'draft',
    updatedAt: '',
    engineVersion: AUDIO_ENGINE_VERSION,
    buses: defaultBuses(),
    gameSyncs: { states: [], switches: [], rtpcs: [] },
    attenuations: [],
    objects: [],
    events: [],
  });
}

export function stableEntityId(kind: 'evt' | 'obj' | 'sw' | 'rtpc' | 'stop', key: string): string {
  return `${kind}:${key}`;
}

export function volumeToGainDb(volume: number): number {
  if (!(volume > 0)) return -24;
  return clamp(20 * Math.log10(volume), -24, 12);
}

export function gainDbToVolume(gainDb: number): number {
  return clamp(10 ** (gainDb / 20), 0, 4);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function assetsToNode(assets: AudioAssetRef[], variation: AudioBinding['variation']): AudioNode {
  // Empty asset lists are legal in drafts; keep a zero-child container so verify
  // can still report binding_assets_empty through the derived bindings view.
  const children = assets.map((asset): AudioNode => ({ kind: 'sound', asset }));
  if (variation.mode === 'sequential') {
    return { kind: 'sequence', children, loop: true, scope: 'global' };
  }
  if (variation.mode === 'random-no-repeat') {
    return {
      kind: 'random',
      children,
      weights: children.map(() => 1),
      avoidRepeatCount: 1,
      scope: 'global',
    };
  }
  if (assets.length === 0) {
    return { kind: 'random', children: [], weights: [], avoidRepeatCount: 0, scope: 'global' };
  }
  if (assets.length === 1) {
    return { kind: 'sound', asset: assets[0]! };
  }
  // v1 "single" with multiple assets only ever played the first one.
  return { kind: 'sound', asset: assets[0]! };
}

function followValueKey(value: AudioFollowValue): string {
  return `${typeof value}:${String(value)}`;
}

/**
 * Pure v1 → v2 migration. Stable ids are derived from eventId / follow.field so
 * re-running on the same document is idempotent.
 */
export function migrateV1ToV2(input: AudioProjectV1): AudioProjectDocument {
  const switches = new Map<string, SwitchGroup>();
  const rtpcs = new Map<string, RtpcDefinition>();
  const objects: AudioObject[] = [];
  const events = new Map<string, AudioEvent>();

  for (const binding of input.bindings) {
    const objectId = stableEntityId('obj', binding.eventId);
    const eventEntityId = stableEntityId('evt', binding.eventId);
    let node = assetsToNode(binding.assets, binding.variation);
    const rtpcBindings: RtpcBinding[] = [];

    if (binding.follow?.cases) {
      const groupId = stableEntityId('sw', binding.follow.field);
      if (!switches.has(groupId)) {
        switches.set(groupId, {
          id: groupId,
          name: binding.follow.label ?? binding.follow.field,
          values: binding.follow.cases.map((item) => String(item.value)),
          defaultValue: String(binding.follow.defaultValue),
        });
      }
      const assignments: Record<string, AudioNode> = {};
      for (const item of binding.follow.cases) {
        assignments[followValueKey(item.value)] = assetsToNode(item.assets, binding.variation);
      }
      node = {
        kind: 'switch',
        groupId,
        assignments,
        onSwitchChange: 'restart',
        defaultNode: assetsToNode(binding.assets, binding.variation),
      };
    } else if (binding.follow?.range) {
      const range = binding.follow.range;
      const rtpcId = stableEntityId('rtpc', binding.follow.field);
      if (!rtpcs.has(rtpcId)) {
        rtpcs.set(rtpcId, {
          id: rtpcId,
          name: binding.follow.label ?? binding.follow.field,
          min: range.min,
          max: range.max,
          defaultValue: typeof binding.follow.defaultValue === 'number'
            ? binding.follow.defaultValue
            : range.min,
          scope: 'global',
          slewMsDefault: 0,
        });
      }
      const linear = (y0: number, y1: number): CurvePoint[] => [
        { x: range.min, y: y0, interp: 'linear' },
        { x: range.max, y: y1, interp: 'linear' },
      ];
      rtpcBindings.push(
        {
          rtpcId,
          target: 'volumeDb',
          curve: linear(volumeToGainDb(range.volumeStart), volumeToGainDb(range.volumeEnd)),
        },
        {
          rtpcId,
          target: 'pitchSemitones',
          curve: linear(range.pitchStart, range.pitchEnd),
        },
        {
          rtpcId,
          target: 'lowpassHz',
          curve: linear(range.lowpassStart, range.lowpassEnd),
        },
      );
      node = {
        kind: 'blend',
        rtpcId,
        layers: [{
          node: assetsToNode(binding.assets, binding.variation),
          rangeStart: range.min,
          rangeEnd: range.max,
          crossfadeCurve: linear(1, 1),
        }],
      };
    }

    objects.push({
      id: objectId,
      name: binding.label,
      node,
      outputBusId: BUS_BY_KIND[binding.playback.bus] ?? BUS_BY_KIND[binding.kind],
      spatial: binding.playback.spatial,
      ...(binding.playback.attenuationId ? { attenuationId: binding.playback.attenuationId } : {}),
      // A blanket 8 voices and one priority for every event is what makes a
      // footstep able to evict music. Sized per event beat instead.
      priority: binding.playback.priority ?? LEGACY_PRIORITY,
      limit: {
        maxInstances: binding.playback.maxInstances ?? LEGACY_VOICE_LIMIT,
        scope: 'global',
        onExceed: 'stealOldest',
      },
      virtualBehavior: 'fromElapsed',
      playback: {
        mode: binding.playback.mode,
        loopCount: binding.playback.mode === 'loop' ? 0 : 1,
        fadeInMs: binding.playback.fadeInMs,
        fadeOutMs: binding.playback.fadeOutMs,
        volume: binding.playback.volume,
      },
      ...(binding.shaping ? { shaping: binding.shaping } : {}),
      rtpcBindings,
      stateOffsets: [],
      conditions: binding.conditions,
    });

    const playAction: AudioAction = {
      type: 'play',
      objectId,
      delayMs: binding.trigger.delayMs,
      probability: binding.trigger.probability,
      ...(binding.trigger.cooldownMs > 0 ? { cooldownMs: binding.trigger.cooldownMs } : {}),
      ...(binding.trigger.rhythmLockMs === undefined
        ? {}
        : { rhythmLockMs: binding.trigger.rhythmLockMs }),
    };
    events.set(eventEntityId, {
      id: eventEntityId,
      name: binding.eventId,
      label: binding.label,
      enabled: binding.enabled,
      actions: [playAction],
      ...(binding.provenance ? { provenance: binding.provenance } : {}),
      // Persisted so the numbers above stay auditable after the fact: without
      // it nothing downstream can tell a deliberate 0.5 from a 'defeat' whose
      // 0.1 default was silently overwritten.
      ...(binding.archetype ? { archetype: binding.archetype } : {}),
      ...(typeof binding.plannedVariants === 'number'
        ? { plannedVariants: binding.plannedVariants }
        : {}),
    });

    if (binding.playback.stopEventId) {
      const stopName = binding.playback.stopEventId;
      const stopId = stableEntityId('evt', stopName);
      const stopAction: AudioAction = {
        type: 'stop',
        objectId,
        fadeOutMs: binding.playback.fadeOutMs,
        scope: 'global',
      };
      const existing = events.get(stopId);
      if (existing) {
        existing.actions = [...existing.actions, stopAction];
      } else {
        events.set(stopId, {
          id: stopId,
          name: stopName,
          label: stopName,
          enabled: true,
          actions: [stopAction],
        });
      }
    }
  }

  return {
    schemaVersion: AUDIO_PROJECT_SCHEMA,
    projectId: input.projectId,
    revision: input.revision,
    status: input.status,
    updatedAt: input.updatedAt,
    engineVersion: AUDIO_ENGINE_VERSION,
    buses: defaultBuses(),
    gameSyncs: {
      states: [],
      switches: [...switches.values()],
      rtpcs: [...rtpcs.values()],
    },
    attenuations: [],
    objects,
    events: [...events.values()],
  };
}

function collectSoundAssets(node: AudioNode): AudioAssetRef[] {
  switch (node.kind) {
    case 'sound':
      return [node.asset];
    case 'random':
    case 'sequence':
      return node.children.flatMap(collectSoundAssets);
    case 'switch': {
      const fromAssignments = Object.values(node.assignments).flatMap(collectSoundAssets);
      return node.defaultNode
        ? [...collectSoundAssets(node.defaultNode), ...fromAssignments]
        : fromAssignments;
    }
    case 'blend':
      return node.layers.flatMap((layer) => collectSoundAssets(layer.node));
  }
}

function variationFromNode(node: AudioNode): AudioBinding['variation'] {
  if (node.kind === 'sequence') return { mode: 'sequential' };
  if (node.kind === 'random') return { mode: 'random-no-repeat' };
  if (node.kind === 'switch' || node.kind === 'blend') {
    const inner = node.kind === 'switch'
      ? (node.defaultNode ?? Object.values(node.assignments)[0])
      : node.layers[0]?.node;
    return inner ? variationFromNode(inner) : { mode: 'single' };
  }
  return { mode: 'single' };
}

function curveEnds(curve: CurvePoint[] | undefined, fallback: number): { start: number; end: number } {
  if (!curve || curve.length === 0) return { start: fallback, end: fallback };
  const sorted = [...curve].sort((a, b) => a.x - b.x);
  return { start: sorted[0]!.y, end: sorted[sorted.length - 1]!.y };
}

/**
 * Rebuild the v1 bindings view from a v2 document. Documents that originated
 * from migrateV1ToV2 round-trip; hand-authored nested containers may flatten.
 */
export function bindingsFromV2(project: AudioProjectDocument): AudioBinding[] {
  const objects = new Map(project.objects.map((object) => [object.id, object]));
  const switches = new Map(project.gameSyncs.switches.map((group) => [group.id, group]));
  const rtpcs = new Map(project.gameSyncs.rtpcs.map((rtpc) => [rtpc.id, rtpc]));
  const stopByObject = new Map<string, string>();

  for (const event of project.events) {
    for (const action of event.actions) {
      if (action.type === 'stop') stopByObject.set(action.objectId, event.name);
    }
  }

  const bindings: AudioBinding[] = [];
  for (const event of project.events) {
    const play = event.actions.find((action): action is Extract<AudioAction, { type: 'play' }> => action.type === 'play');
    if (!play) continue;
    const object = objects.get(play.objectId);
    if (!object) continue;

    const kind = KIND_BY_BUS[object.outputBusId] ?? 'sfx';
    const rootAssets = object.node.kind === 'switch' && object.node.defaultNode
      ? collectSoundAssets(object.node.defaultNode)
      : object.node.kind === 'blend' && object.node.layers[0]
        ? collectSoundAssets(object.node.layers[0].node)
        : collectSoundAssets(object.node);

    let follow: AudioBinding['follow'];
    if (object.node.kind === 'switch') {
      const group = switches.get(object.node.groupId);
      const field = group?.name && !group.id.endsWith(group.name)
        ? object.node.groupId.slice('sw:'.length)
        : object.node.groupId.replace(/^sw:/, '');
      follow = {
        field,
        ...(group?.name && group.name !== field ? { label: group.name } : {}),
        defaultValue: group?.defaultValue ?? '',
        cases: Object.entries(object.node.assignments).map(([key, child]) => {
          const separator = key.indexOf(':');
          const type = separator >= 0 ? key.slice(0, separator) : 'string';
          const raw = separator >= 0 ? key.slice(separator + 1) : key;
          let value: AudioFollowValue = raw;
          if (type === 'number') value = Number(raw);
          else if (type === 'boolean') value = raw === 'true';
          return { value, assets: collectSoundAssets(child) };
        }),
      };
    } else if (object.node.kind === 'blend') {
      const rtpc = rtpcs.get(object.node.rtpcId);
      const field = object.node.rtpcId.replace(/^rtpc:/, '');
      const volume = curveEnds(
        object.rtpcBindings.find((item) => item.target === 'volumeDb')?.curve,
        0,
      );
      const pitch = curveEnds(
        object.rtpcBindings.find((item) => item.target === 'pitchSemitones')?.curve,
        0,
      );
      const lowpass = curveEnds(
        object.rtpcBindings.find((item) => item.target === 'lowpassHz')?.curve,
        20_000,
      );
      follow = {
        field,
        ...(rtpc?.name && rtpc.name !== field ? { label: rtpc.name } : {}),
        defaultValue: rtpc?.defaultValue ?? rtpc?.min ?? 0,
        range: {
          min: rtpc?.min ?? 0,
          max: rtpc?.max ?? 1,
          volumeStart: gainDbToVolume(volume.start),
          volumeEnd: gainDbToVolume(volume.end),
          pitchStart: pitch.start,
          pitchEnd: pitch.end,
          lowpassStart: lowpass.start,
          lowpassEnd: lowpass.end,
        },
      };
    }

    bindings.push({
      eventId: event.name,
      label: event.label,
      enabled: event.enabled,
      kind,
      assets: rootAssets,
      variation: variationFromNode(object.node),
      trigger: {
        delayMs: play.delayMs,
        cooldownMs: play.cooldownMs ?? 0,
        probability: play.probability,
        ...(play.rhythmLockMs === undefined ? {} : { rhythmLockMs: play.rhythmLockMs }),
      },
      playback: {
        volume: object.playback.volume ?? 1,
        bus: kind,
        spatial: object.spatial,
        ...(object.attenuationId ? { attenuationId: object.attenuationId } : {}),
        mode: object.playback.mode,
        fadeInMs: object.playback.fadeInMs,
        fadeOutMs: object.playback.fadeOutMs,
        ...(stopByObject.get(object.id) ? { stopEventId: stopByObject.get(object.id) } : {}),
        // Only surface a deliberate value. These are required on a v2 object, so
        // echoing them unconditionally would turn "left at the default" into an
        // authored number on every read.
        ...(object.limit.maxInstances === LEGACY_VOICE_LIMIT
          ? {}
          : { maxInstances: object.limit.maxInstances }),
        ...(object.priority === LEGACY_PRIORITY ? {} : { priority: object.priority }),
      },
      ...(object.shaping ? { shaping: object.shaping } : {}),
      ...(follow ? { follow } : {}),
      conditions: object.conditions,
      ...(event.provenance ? { provenance: event.provenance } : {}),
      ...(event.archetype ? { archetype: event.archetype } : {}),
      ...(typeof event.plannedVariants === 'number'
        ? { plannedVariants: event.plannedVariants }
        : {}),
    });
  }
  return bindings;
}

export function attachLegacyBindings(document: AudioProjectDocument): AudioProject {
  return { ...document, bindings: bindingsFromV2(document) };
}

export function toProjectDocument(project: AudioProject | AudioProjectDocument): AudioProjectDocument {
  const {
    schemaVersion,
    projectId,
    revision,
    status,
    updatedAt,
    engineVersion,
    buses,
    gameSyncs,
    attenuations,
    objects,
    events,
    music,
    plan,
  } = project;
  return {
    schemaVersion,
    projectId,
    revision,
    status,
    updatedAt,
    engineVersion,
    buses,
    gameSyncs,
    attenuations,
    objects,
    events,
    ...(music ? { music } : {}),
    ...(plan ? { plan } : {}),
  };
}

function canonicalizeClipFile(file: string, path: string): string {
  try {
    return canonicalAudioFile(file);
  } catch {
    throw new AudioProjectError('invalid_project', `${path} must stay inside the game audio directory`);
  }
}

function canonicalizeMusicClips(music: MusicProject): MusicProject {
  return {
    ...music,
    segments: music.segments.map((segment, segmentIndex) => ({
      ...segment,
      tracks: (segment.tracks ?? []).map((track, trackIndex) => ({
        ...track,
        clips: (track.clips ?? []).map((clip, clipIndex) => ({
          ...clip,
          file: typeof clip.file === 'string'
            ? canonicalizeClipFile(
              clip.file,
              `music.segments[${segmentIndex}].tracks[${trackIndex}].clips[${clipIndex}].file`,
            )
            : clip.file,
        })),
      })),
    })),
  };
}

function assertUniqueIds(items: Array<{ id: string }>, path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new AudioProjectError('invalid_project', `duplicate ${path} id '${item.id}'`);
    }
    seen.add(item.id);
  }
}

export function normalizeAudioProjectV2(input: unknown, projectId: string): AudioProject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AudioProjectError('invalid_project', 'audio project must be an object');
  }
  const row = input as Record<string, unknown>;
  if (row.schemaVersion !== AUDIO_PROJECT_SCHEMA) {
    throw new AudioProjectError('invalid_project', `unsupported audio project schema: ${String(row.schemaVersion)}`);
  }
  // Re-normalize through migration of the derived bindings view when callers
  // hand us a partial/legacy-shaped object that already claims v2. Full structural
  // validation of nested containers lands with the verify pass; here we require
  // the document fields and rebuild the legacy view.
  const projectIdValue = typeof row.projectId === 'string' && row.projectId.trim()
    ? row.projectId.trim()
    : projectId;
  if (projectIdValue !== projectId) {
    throw new AudioProjectError('invalid_project', `audio project belongs to '${projectIdValue}', not '${projectId}'`);
  }
  const revision = typeof row.revision === 'number' && Number.isInteger(row.revision) && row.revision >= 0
    ? row.revision
    : 0;
  const buses = Array.isArray(row.buses) && row.buses.length > 0
    ? row.buses as AudioBusNode[]
    : defaultBuses();
  const gameSyncsRaw = row.gameSyncs && typeof row.gameSyncs === 'object'
    ? row.gameSyncs as AudioProjectDocument['gameSyncs']
    : { states: [], switches: [], rtpcs: [] };
  const musicRaw = row.music && typeof row.music === 'object' && !Array.isArray(row.music)
    ? row.music as Partial<MusicProject>
    : undefined;
  const music: MusicProject | undefined = musicRaw
    ? canonicalizeMusicClips({
      segments: Array.isArray(musicRaw.segments) ? musicRaw.segments as MusicSegment[] : [],
      playlists: Array.isArray(musicRaw.playlists) ? musicRaw.playlists as MusicPlaylist[] : [],
      transitions: Array.isArray(musicRaw.transitions) ? musicRaw.transitions as MusicTransition[] : [],
      stingers: Array.isArray(musicRaw.stingers) ? musicRaw.stingers as MusicStinger[] : [],
    })
    : undefined;
  const document: AudioProjectDocument = {
    schemaVersion: AUDIO_PROJECT_SCHEMA,
    projectId,
    revision,
    status: row.status === 'applied' ? 'applied' : 'draft',
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    engineVersion: typeof row.engineVersion === 'string' && row.engineVersion.trim()
      ? row.engineVersion.trim()
      : AUDIO_ENGINE_VERSION,
    buses,
    gameSyncs: {
      states: Array.isArray(gameSyncsRaw.states) ? gameSyncsRaw.states : [],
      switches: Array.isArray(gameSyncsRaw.switches) ? gameSyncsRaw.switches : [],
      rtpcs: Array.isArray(gameSyncsRaw.rtpcs) ? gameSyncsRaw.rtpcs : [],
    },
    attenuations: Array.isArray(row.attenuations) ? row.attenuations as AttenuationShareSet[] : [],
    objects: Array.isArray(row.objects) ? row.objects as AudioObject[] : [],
    events: Array.isArray(row.events) ? row.events as AudioEvent[] : [],
    ...(music ? { music } : {}),
    ...(row.plan && typeof row.plan === 'object' && !Array.isArray(row.plan)
      ? { plan: row.plan as AudioPlan }
      : {}),
  };
  assertUniqueIds(document.objects, 'object');
  assertUniqueIds(document.events, 'event');
  assertUniqueIds(document.buses, 'bus');
  if (document.music) {
    assertUniqueIds(document.music.segments, 'music.segment');
    assertUniqueIds(document.music.playlists, 'music.playlist');
    assertUniqueIds(document.music.stingers, 'music.stinger');
  }
  return attachLegacyBindings(document);
}

export function normalizeAudioProject(input: unknown, projectId: string): AudioProject {
  if (input === undefined || input === null) return emptyAudioProject(projectId);
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AudioProjectError('invalid_project', 'audio project must be an object');
  }
  const row = input as Record<string, unknown>;
  const schema = row.schemaVersion;

  if (schema === undefined || schema === AUDIO_PROJECT_SCHEMA_V1) {
    const v1 = normalizeAudioProjectV1(input, projectId);
    return attachLegacyBindings(migrateV1ToV2(v1));
  }
  if (schema === AUDIO_PROJECT_SCHEMA) {
    return normalizeAudioProjectV2(input, projectId);
  }
  throw new AudioProjectError('invalid_project', `unsupported audio project schema: ${String(schema)}`);
}

export function audioProjectAssets(project: AudioProjectDocument | AudioProject): AudioAssetRef[] {
  return project.objects.flatMap((object) => collectSoundAssets(object.node));
}

export { audioBindingAssets };
