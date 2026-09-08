export type RuntimeAudioBus = 'sfx' | 'music' | 'voice';
export type RuntimeConditionValue = string | number | boolean | Array<string | number | boolean>;
export type RuntimeFollowValue = string | number | boolean;
export type PlaybackId = number;
export type GameObjectId = string;
export type RuntimeSelectionScope = 'global' | 'gameObject';
export type RuntimeCurveInterp = 'linear' | 'log' | 'exp' | 'sCurve' | 'constant';
export type AudioCallbackPhase = 'start' | 'end' | 'stop';

export interface AudioPoint { x: number; y: number; z: number }

/** Where a sound comes from; `forward` only matters for cone attenuation. */
export type AudioEmitterTransform = AudioPoint & { forward?: AudioPoint };

export interface AudioListenerTransform {
  position: AudioPoint;
  forward?: AudioPoint;
  up?: AudioPoint;
}

export interface AudioEventContext {
  emitter?: AudioPoint;
  listener?: AudioListenerTransform;
  gameObjectId?: GameObjectId;
  [key: string]: unknown;
}

export interface RuntimeCurvePoint {
  x: number;
  y: number;
  interp: RuntimeCurveInterp;
}

export interface RuntimeBlendLayer {
  node: RuntimeAudioNode;
  rangeStart: number;
  rangeEnd: number;
  crossfadeCurve?: RuntimeCurvePoint[];
}

/** Runtime-local AudioNode tree — mirrors shared AudioNode without pulling server code. */
export type RuntimeAudioNode =
  | { kind: 'sound'; asset: RuntimeAudioAsset; nodeKey?: string }
  | {
    kind: 'random';
    children: RuntimeAudioNode[];
    weights: number[];
    avoidRepeatCount: number;
    scope: RuntimeSelectionScope;
    nodeKey?: string;
  }
  | {
    kind: 'sequence';
    children: RuntimeAudioNode[];
    loop: boolean;
    scope: RuntimeSelectionScope;
    nodeKey?: string;
  }
  | {
    kind: 'switch';
    groupId: string;
    assignments: Record<string, RuntimeAudioNode>;
    onSwitchChange?: 'restart' | 'continue';
    defaultNode?: RuntimeAudioNode;
    nodeKey?: string;
  }
  | {
    kind: 'blend';
    rtpcId: string;
    layers: RuntimeBlendLayer[];
    nodeKey?: string;
  };

export interface RuntimeAttenuation {
  id: string;
  name?: string;
  maxDistance: number;
  curves: {
    outputVolumeDb: RuntimeCurvePoint[];
    lowpassHz?: RuntimeCurvePoint[];
    highpassHz?: RuntimeCurvePoint[];
    auxSendDb?: RuntimeCurvePoint[];
    spread?: RuntimeCurvePoint[];
  };
  cone?: {
    innerAngleDeg: number;
    outerAngleDeg: number;
    outerVolumeDb: number;
    outerLowpassHz: number;
  };
}

export interface RuntimeMusicSegment {
  id: string;
  name: string;
  tempo: number;
  timeSignature: [number, number];
  preEntryMs?: number;
  entryCueMs?: number;
  exitCueMs?: number;
  postExitMs?: number;
  durationMs?: number;
  assetUrl?: string;
}

export interface RuntimeMusicPlaylist {
  id: string;
  name: string;
  segmentIds: string[];
}

export type RuntimeMusicSyncPoint = 'immediate' | 'nextBeat' | 'nextBar';

export interface RuntimeMusicTransition {
  fromPlaylistId: '*' | string;
  toPlaylistId: '*' | string;
  exitAt: RuntimeMusicSyncPoint;
  fadeOutMs?: number;
  fadeInMs?: number;
}

export interface RuntimeMusicProject {
  segments: RuntimeMusicSegment[];
  playlists: RuntimeMusicPlaylist[];
  transitions: RuntimeMusicTransition[];
}

export interface RuntimeBankFeatures {
  music?: boolean;
  attenuation?: boolean;
  gameSyncs?: boolean;
}

export interface RuntimeGameSyncDefs {
  states?: Array<{
    id: string;
    name: string;
    values: string[];
    defaultValue: string;
    transitions: Array<{ from: '*' | string; to: '*' | string; timeMs: number }>;
  }>;
  switches?: Array<{
    id: string;
    name: string;
    values: string[];
    defaultValue: string;
    rtpcId?: string;
  }>;
  rtpcs?: Array<{
    id: string;
    name: string;
    min: number;
    max: number;
    defaultValue: number;
    scope: RuntimeSelectionScope;
    slewMsDefault: number;
  }>;
}

export interface RuntimeRtpcBinding {
  rtpcId: string;
  target: 'volumeDb' | 'pitchSemitones' | 'lowpassHz' | 'highpassHz' | 'auxSendDb';
  auxBusId?: string;
  curve: RuntimeCurvePoint[];
}

export interface RuntimeStateOffset {
  groupId: string;
  values: Record<string, { volumeDb?: number; pitchSemitones?: number; lowpassHz?: number }>;
}

export type AudioEventCallback = (detail: {
  eventId: string;
  phase: AudioCallbackPhase;
  playbackId?: PlaybackId;
  gameObjectId?: GameObjectId;
}) => void;

export interface RuntimeAudioShaping {
  gainDb: number;
  pitchSemitones: number;
  highpassHz: number;
  lowpassHz: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
}

export interface RuntimeAudioAsset {
  assetId: string;
  file: string;
  url: string;
  /** Engine asset GUID of the clip, carried over from the event pack. */
  guid?: string;
  name?: string;
  shaping?: RuntimeAudioShaping;
  durationMs?: number;
}

export interface RuntimeAudioBinding {
  eventId: string;
  /** GUID of the event asset this was compiled from, in events.pack.json. */
  guid?: string;
  label: string;
  enabled: boolean;
  kind: RuntimeAudioBus;
  assets: RuntimeAudioAsset[];
  variation: { mode: 'single' | 'sequential' | 'random-no-repeat' };
  trigger: {
    delayMs: number;
    cooldownMs: number;
    probability: number;
    /** Repeat interval in ms; absent means measure it, 0 means leave timing alone. */
    rhythmLockMs?: number;
  };
  playback: {
    volume: number;
    bus: RuntimeAudioBus;
    spatial: '2d' | '3d';
    /** Attenuation share set to evaluate for this sound; falls back to the first one. */
    attenuationId?: string;
    mode: 'one-shot' | 'loop';
    fadeInMs: number;
    fadeOutMs: number;
    stopEventId?: string;
  };
  shaping?: RuntimeAudioShaping;
  follow?: {
    field: string;
    label?: string;
    defaultValue: RuntimeFollowValue;
    cases?: Array<{
      value: RuntimeFollowValue;
      label?: string;
      assets: RuntimeAudioAsset[];
    }>;
    range?: {
      min: number;
      max: number;
      volumeStart: number;
      volumeEnd: number;
      pitchStart: number;
      pitchEnd: number;
      lowpassStart: number;
      lowpassEnd: number;
    };
  };
  conditions: Array<{
    field: string;
    operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';
    value: RuntimeConditionValue;
  }>;
  priority?: number;
  maxInstances?: number;
}

export interface RuntimeDuckRule {
  sourceBusId: string;
  volumeDb: number;
  attackMs: number;
  releaseMs: number;
  curve: 'linear' | 'sCurve';
}

export interface RuntimeBusNode {
  id: string;
  name: string;
  parentId?: string;
  volumeDb: number;
  ducking: RuntimeDuckRule[];
  voiceLimit?: number;
}

export interface RuntimeAudioProject {
  schemaVersion: 'forgeax-audio-runtime/1';
  projectId: string;
  revision: number;
  engineVersion?: string;
  bindings: RuntimeAudioBinding[];
  buses?: RuntimeBusNode[];
  voiceBudget?: { maxPhysical: number };
  /** Optional v2 bank extras — ignored by the legacy bindings path when absent. */
  bankFeatures?: RuntimeBankFeatures;
  gameSyncs?: RuntimeGameSyncDefs;
  attenuations?: RuntimeAttenuation[];
  music?: RuntimeMusicProject;
}

export interface AudioPlayRequest {
  bindingId: string;
  eventId: string;
  playbackId?: PlaybackId;
  gameObjectId?: GameObjectId;
  asset: RuntimeAudioAsset;
  volume: number;
  bus: RuntimeAudioBus | string;
  loop: boolean;
  fadeInMs: number;
  fadeOutMs: number;
  spatial: '2d' | '3d';
  context: AudioEventContext;
  startAudioTime?: number;
}

export interface AudioHandle {
  stop(fadeOutMs: number): void;
  update?(request: AudioPlayRequest): void;
}

export interface AudioPort {
  play(request: AudioPlayRequest): AudioHandle | Promise<AudioHandle | undefined> | undefined;
  setBusVolume(bus: RuntimeAudioBus | string, volume: number): void;
  unlock?(): Promise<void>;
  isReady?(): boolean;
  currentTime?(): number;
  dispose(): void;
}

export type EmitOutcome =
  | 'played'
  | 'blocked_disabled'
  | 'blocked_conditions'
  | 'blocked_probability'
  | 'blocked_cooldown'
  | 'no_asset'
  | 'rejected_voice_limit'
  | 'context_locked'
  | 'no_binding';

export interface EmitReceipt {
  eventId: string;
  bindingId: string;
  gameObjectId: GameObjectId;
  playbackId?: PlaybackId;
  outcome: EmitOutcome;
  audioTime?: number;
  detail?: string;
}

export type EmitOutcomeCounts = Partial<Record<EmitOutcome, number>>;

export interface ProfilerEventCounts {
  total: number;
  byOutcome: EmitOutcomeCounts;
}

/**
 * Cumulative emit tallies. The receipt ring is capped; these are not.
 * Audit/verify read this to decide whether a session actually sounded.
 */
export interface ProfilerCounts {
  total: number;
  byOutcome: EmitOutcomeCounts;
  byEvent: Record<string, ProfilerEventCounts>;
}

export interface ProfilerSnapshot {
  projectId: string;
  receipts: EmitReceipt[];
  voices: Array<{
    playbackId: PlaybackId;
    eventId: string;
    gameObjectId: GameObjectId;
    computedVolumeDb: number;
    state: string;
  }>;
  counts: ProfilerCounts;
}

export interface ProfilerPostMessage {
  type: 'forgeax-audio-profiler';
  projectId: string;
  receipts: EmitReceipt[];
  voices: ProfilerSnapshot['voices'];
  counts: ProfilerCounts;
}

export interface ForgeaxAudioRuntime {
  emit(eventId: string, context?: AudioEventContext): number;
  /** Alias for emit — Wwise-style naming used by authored game code. */
  postEvent(eventId: string, context?: AudioEventContext): number;
  /** Same as emit, but returns one receipt per evaluated binding / miss. */
  emitDetailed(eventId: string, context?: AudioEventContext): EmitReceipt[];
  setGameValue(field: string, value: RuntimeFollowValue, gameObjectId?: GameObjectId): void;
  setState(groupId: string, value: string): void;
  setSwitch(groupId: string, value: string, gameObjectId?: GameObjectId): void;
  setRTPC(rtpcId: string, value: number, gameObjectId?: GameObjectId, slewMs?: number): void;
  setListener(transform: AudioListenerTransform): void;
  setObstruction(gameObjectId: GameObjectId, value: number): void;
  /**
   * Publish where a game object is. Emits tagged with the same id then spatialize without
   * passing coordinates at every call site.
   */
  setGameObjectTransform(gameObjectId: GameObjectId, transform: AudioEmitterTransform): void;
  on(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
  off(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
  warmUp(urls?: string[]): Promise<void>;
  getProfilerSnapshot(): ProfilerSnapshot;
  registerGameObject(gameObjectId: GameObjectId): void;
  unregisterGameObject(gameObjectId: GameObjectId): void;
  stop(eventId?: string, gameObjectId?: GameObjectId): void;
  stopPlayback(playbackId: PlaybackId, fadeOutMs?: number): void;
  setBusVolume(bus: RuntimeAudioBus | string, volume: number): void;
  whenReady(): Promise<void>;
  isReady(): boolean;
  dispose(): void;
}

export interface ForgeaxAudioRuntimeOptions {
  port?: AudioPort;
  now?: () => number;
  random?: () => number;
  schedule?: (run: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onReceipt?: (receipt: EmitReceipt) => void;
  engineVersion?: string;
  /** Disable diagnostics allocation when quiet. Default true. */
  diagnostics?: boolean;
}
