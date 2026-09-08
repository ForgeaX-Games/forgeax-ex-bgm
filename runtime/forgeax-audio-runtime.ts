/**
 * Compatibility surface for existing imports.
 * Implementation lives in modular runtime/* files and is bundled from index.ts.
 */
export { createForgeaxAudioRuntime, ENGINE_VERSION } from './create-runtime.ts';
export { mergeShaping } from './shaping.ts';
export { EngineVersionMismatchError, assertEngineVersion } from './engine-version.ts';
export { createDecodeCache, shouldStreamAsset, STREAM_THRESHOLD_MS } from './port/decode-cache.ts';
export { createBrowserAudioPort, BrowserAudioPort } from './port/browser-port.ts';
export { busGraphHasCycle, createBusGraph, defaultRuntimeBuses } from './core/graph.ts';
export { GLOBAL_GAME_OBJECT_ID } from './core/gameobjects.ts';
export { createLookaheadScheduler } from './core/scheduler.ts';
export { createVoiceManager } from './core/voices.ts';
export { createGameSyncs } from './core/syncs.ts';
export { resolveVoiceProperties } from './core/properties.ts';
export { createContainerResolver } from './containers/resolver.ts';
export { evaluateAttenuation } from './attenuation.ts';
export { createCallbackBus } from './callbacks.ts';
export { createProfiler } from './profiler.ts';
export {
  createMusicEngine,
  nextBarAudioTime,
  nextBeatAudioTime,
  quantizeExitTime,
  beatDurationSeconds,
  barDurationSeconds,
} from './music/engine.ts';

export type {
  AudioEventContext,
  AudioHandle,
  AudioPlayRequest,
  AudioPoint,
  AudioPort,
  AudioListenerTransform,
  AudioCallbackPhase,
  AudioEventCallback,
  EmitOutcome,
  EmitReceipt,
  ForgeaxAudioRuntime,
  ForgeaxAudioRuntimeOptions,
  GameObjectId,
  PlaybackId,
  ProfilerCounts,
  ProfilerEventCounts,
  ProfilerSnapshot,
  ProfilerPostMessage,
  EmitOutcomeCounts,
  RuntimeAudioAsset,
  RuntimeAudioBinding,
  RuntimeAudioBus,
  RuntimeAudioNode,
  RuntimeAudioProject,
  RuntimeAudioShaping,
  RuntimeAttenuation,
  RuntimeBankFeatures,
  RuntimeBusNode,
  RuntimeConditionValue,
  RuntimeDuckRule,
  RuntimeFollowValue,
  RuntimeMusicProject,
  RuntimeMusicSyncPoint,
} from './types.ts';
