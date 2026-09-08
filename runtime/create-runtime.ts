import { evaluateAttenuation } from './attenuation.ts';
import { createCallbackBus } from './callbacks.ts';
import { bindingMatches } from './conditions.ts';
import { createDiagnostics } from './diagnostics.ts';
import { assertEngineVersion, ENGINE_VERSION } from './engine-version.ts';
import { busIdForKind, createBusGraph, defaultRuntimeBuses } from './core/graph.ts';
import { createGameObjectRegistry, GLOBAL_GAME_OBJECT_ID } from './core/gameobjects.ts';
import { resolveVoiceProperties } from './core/properties.ts';
import { createRhythmLock, type RhythmLockConfig } from './core/rhythm-lock.ts';
import { createLookaheadScheduler } from './core/scheduler.ts';
import { createGameSyncs } from './core/syncs.ts';
import { createVoiceManager } from './core/voices.ts';
import { createBrowserAudioPort } from './port/browser-port.ts';
import { createProfiler } from './profiler.ts';
import { createAudioReadiness } from './readiness.ts';
import { resolvePlayback } from './resolve.ts';
import { mergeShaping } from './shaping.ts';
import type {
  AudioEmitterTransform,
  AudioEventContext,
  AudioHandle,
  AudioListenerTransform,
  AudioPlayRequest,
  EmitReceipt,
  ForgeaxAudioRuntime,
  ForgeaxAudioRuntimeOptions,
  GameObjectId,
  PlaybackId,
  RuntimeAttenuation,
  RuntimeAudioAsset,
  RuntimeAudioBinding,
  RuntimeAudioProject,
  RuntimeFollowValue,
} from './types.ts';

function scopeKey(gameObjectId: GameObjectId, bindingEventId: string): string {
  return `${gameObjectId}:${bindingEventId}`;
}

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

function linearToDb(linear: number): number {
  return 20 * Math.log10(Math.max(1e-4, linear));
}

export function createForgeaxAudioRuntime(
  project: RuntimeAudioProject,
  options: ForgeaxAudioRuntimeOptions = {},
): ForgeaxAudioRuntime {
  assertEngineVersion(project, options.engineVersion ?? ENGINE_VERSION);

  const port = options.port ?? createBrowserAudioPort();
  const nowWall = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const scheduleTimer = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const cancelTimer = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const diagnostics = createDiagnostics(options.onReceipt, options.diagnostics !== false);
  const readiness = createAudioReadiness(port);
  const gameObjects = createGameObjectRegistry();
  const graph = createBusGraph(project.buses ?? defaultRuntimeBuses());
  const voices = createVoiceManager();
  const callbacks = createCallbackBus();
  const profiler = createProfiler({ projectId: project.projectId });
  const syncs = createGameSyncs({
    states: project.gameSyncs?.states,
    switches: project.gameSyncs?.switches,
    rtpcs: project.gameSyncs?.rtpcs,
  });
  const maxPhysical = project.voiceBudget?.maxPhysical ?? 64;
  const hasAudioClock = typeof port.currentTime === 'function';
  const attenuationEnabled = Boolean(
    project.bankFeatures?.attenuation
    || (project.attenuations && project.attenuations.length > 0),
  );
  const attenuationById = new Map((project.attenuations ?? []).map((item) => [item.id, item]));
  const defaultAttenuation = project.attenuations?.[0];
  const attenuationFor = (binding: RuntimeAudioBinding): RuntimeAttenuation | undefined => (
    binding.playback.attenuationId
      ? attenuationById.get(binding.playback.attenuationId)
      : defaultAttenuation
  );

  let registeredListener: AudioListenerTransform | undefined;
  const obstructionByObject = new Map<GameObjectId, number>();
  const emitterByObject = new Map<GameObjectId, AudioEmitterTransform>();
  let lastControlAudioTime: number | undefined;

  const nowAudio = (): number => {
    if (port.currentTime) return port.currentTime();
    return nowWall() / 1_000;
  };

  const scheduler = createLookaheadScheduler({
    nowAudio,
    scheduleTimer,
    cancelTimer,
  });
  if (hasAudioClock) {
    scheduler.onControlFrame((audioTime) => {
      const previous = lastControlAudioTime ?? audioTime;
      syncs.tick(Math.max(0, audioTime - previous));
      lastControlAudioTime = audioTime;
      const gains = graph.tickDucking(audioTime);
      for (const [busId, linear] of gains) {
        if (busId === 'bus:master') continue;
        port.setBusVolume(busId, linear);
      }
      voices.tick(audioTime);
      profiler.setVoices(voices.active().map((voice) => ({
        playbackId: voice.playbackId,
        eventId: voice.eventId,
        gameObjectId: voice.gameObjectId,
        computedVolumeDb: voice.computedVolumeDb,
        state: voice.state,
      })));
    });
    scheduler.start();
  }

  const bindings = new Map<string, RuntimeAudioBinding[]>();
  const stopping = new Map<string, RuntimeAudioBinding[]>();
  for (const binding of project.bindings) {
    const list = bindings.get(binding.eventId) ?? [];
    list.push(binding);
    bindings.set(binding.eventId, list);
    if (binding.playback.stopEventId) {
      const stopList = stopping.get(binding.playback.stopEventId) ?? [];
      stopList.push(binding);
      stopping.set(binding.playback.stopEventId, stopList);
    }
  }

  const rhythm = createRhythmLock();
  const lastPlayedAt = new Map<string, number>();
  const selection = new Map<string, number>();
  const loopHandles = new Map<string, Set<AudioHandle>>();
  const activeLoopContexts = new Map<string, AudioEventContext>();
  const scheduledIds = new Map<string, Set<string>>();
  const wallHandles = new Map<string, Set<unknown>>();
  const stopEpoch = new Map<string, number>();
  const playbackBinding = new Map<PlaybackId, string>();
  const playbackMeta = new Map<PlaybackId, { eventId: string; gameObjectId: GameObjectId; durationMs?: number }>();

  const applySpatialAttenuation = (
    binding: RuntimeAudioBinding,
    context: AudioEventContext,
    gameObjectId: GameObjectId,
    resolved: { asset: RuntimeAudioAsset; volume: number },
  ): { asset: RuntimeAudioAsset; volume: number } => {
    if (!attenuationEnabled) return resolved;
    if (binding.playback.spatial !== '3d') return resolved;
    const attenuation = attenuationFor(binding);
    if (!attenuation) return resolved;
    const emitter = context.emitter ?? emitterByObject.get(gameObjectId);
    const listener = context.listener ?? registeredListener;
    if (!emitter || !listener) return resolved;

    const evaluated = evaluateAttenuation({
      attenuation,
      emitter,
      listener,
      obstruction: obstructionByObject.get(gameObjectId) ?? 0,
    });
    const props = resolveVoiceProperties({
      baseVolumeDb: linearToDb(resolved.volume),
      attenuation: {
        volumeDb: evaluated.volumeDb,
        lowpassHz: evaluated.lowpassHz,
        highpassHz: evaluated.highpassHz,
      },
    });
    const shaping = mergeShaping(resolved.asset.shaping, {
      gainDb: 0,
      pitchSemitones: props.pitchSemitones,
      highpassHz: props.highpassHz ?? 20,
      lowpassHz: props.lowpassHz ?? 20_000,
      eqLowDb: 0,
      eqMidDb: 0,
      eqHighDb: 0,
    });
    return {
      asset: { ...resolved.asset, ...(shaping ? { shaping } : {}) },
      volume: Math.max(0, dbToLinear(props.volumeDb)),
    };
  };

  const rememberHandle = (
    key: string,
    playbackId: PlaybackId,
    binding: RuntimeAudioBinding,
    result: ReturnType<typeof port.play>,
    epoch: number,
    gameObjectId: GameObjectId,
  ): void => {
    if (!result) return;
    const add = (handle: AudioHandle | undefined): void => {
      if (!handle) return;
      if ((stopEpoch.get(key) ?? 0) !== epoch) {
        handle.stop(binding.playback.fadeOutMs);
        voices.stop(playbackId, 0);
        return;
      }
      graph.noteVoiceStart(busIdForKind(binding.playback.bus));
      let stopped = false;
      const originalStop = handle.stop.bind(handle);
      const stopOnce = (fadeOutMs: number): void => {
        if (stopped) return;
        stopped = true;
        originalStop(fadeOutMs);
        graph.noteVoiceStop(busIdForKind(binding.playback.bus));
        callbacks.fire(binding.eventId, 'stop', { playbackId, gameObjectId });
        playbackMeta.delete(playbackId);
      };
      handle.stop = stopOnce;
      voices.attachHandle(playbackId, stopOnce);
      callbacks.fire(binding.eventId, 'start', { playbackId, gameObjectId });

      const durationMs = binding.assets[0]?.durationMs;
      if (binding.playback.mode !== 'loop' && typeof durationMs === 'number' && durationMs > 0) {
        const endHandle = scheduleTimer(() => {
          if ((stopEpoch.get(key) ?? 0) !== epoch) return;
          if (!playbackMeta.has(playbackId)) return;
          callbacks.fire(binding.eventId, 'end', { playbackId, gameObjectId });
          playbackMeta.delete(playbackId);
        }, durationMs);
        const walls = wallHandles.get(key) ?? new Set<unknown>();
        walls.add(endHandle);
        wallHandles.set(key, walls);
      }

      if (binding.playback.mode !== 'loop') return;
      const handles = loopHandles.get(key) ?? new Set<AudioHandle>();
      handles.add(handle);
      loopHandles.set(key, handles);
    };
    if (typeof (result as Promise<AudioHandle | undefined>).then === 'function') {
      void (result as Promise<AudioHandle | undefined>).then(add).catch(() => undefined);
    } else {
      add(result as AudioHandle);
    }
  };

  const stopScoped = (binding: RuntimeAudioBinding, gameObjectId: GameObjectId | undefined, clearActive = true): void => {
    const keys = gameObjectId
      ? [scopeKey(gameObjectId, binding.eventId)]
      : [...stopEpoch.keys()].filter((key) => key.endsWith(`:${binding.eventId}`)).concat(
        scopeKey(GLOBAL_GAME_OBJECT_ID, binding.eventId),
      );
    const unique = new Set(keys);
    for (const key of unique) {
      if (clearActive) activeLoopContexts.delete(key);
      stopEpoch.set(key, (stopEpoch.get(key) ?? 0) + 1);
      const pending = scheduledIds.get(key);
      if (pending) {
        for (const id of pending) scheduler.cancel(id);
        pending.clear();
        scheduledIds.delete(key);
      }
      rhythm.forget(key);
      const walls = wallHandles.get(key);
      if (walls) {
        for (const handle of walls) cancelTimer(handle);
        walls.clear();
        wallHandles.delete(key);
      }
      const handles = loopHandles.get(key);
      if (handles) {
        for (const handle of handles) handle.stop(binding.playback.fadeOutMs);
        handles.clear();
        loopHandles.delete(key);
      }
      voices.stopBy({
        objectId: binding.eventId,
        ...(gameObjectId ? { gameObjectId } : {}),
      }, binding.playback.fadeOutMs);
    }
  };

  const RHYTHM_AUTO: RhythmLockConfig = { mode: 'auto' };
  const RHYTHM_OFF: RhythmLockConfig = { mode: 'off' };

  /**
   * Absent means auto: a game that repeats a one-shot on its frame loop gets an
   * even beat without anyone authoring anything. Zero opts out, and a positive
   * value states the interval outright.
   */
  const rhythmConfig = (binding: RuntimeAudioBinding): RhythmLockConfig => {
    if (binding.playback.mode !== 'one-shot') return RHYTHM_OFF;
    const authored = binding.trigger.rhythmLockMs;
    if (authored === undefined) return RHYTHM_AUTO;
    return authored > 0 ? { mode: 'fixed', intervalMs: authored } : RHYTHM_OFF;
  };

  const playAt = (
    binding: RuntimeAudioBinding,
    context: AudioEventContext,
    gameObjectId: GameObjectId,
    resolved: { asset: RuntimeAudioAsset; volume: number },
    startAudioTime: number,
    playbackId: PlaybackId,
  ): void => {
    const key = scopeKey(gameObjectId, binding.eventId);
    const epoch = stopEpoch.get(key) ?? 0;
    const spatial = applySpatialAttenuation(binding, context, gameObjectId, resolved);
    const mergedContext: AudioEventContext = {
      ...context,
      gameObjectId,
      ...(registeredListener && !context.listener ? { listener: registeredListener } : {}),
    };
    const request: AudioPlayRequest = {
      bindingId: binding.eventId,
      eventId: binding.eventId,
      playbackId,
      gameObjectId,
      asset: spatial.asset,
      volume: spatial.volume,
      bus: binding.playback.bus,
      loop: binding.playback.mode === 'loop',
      fadeInMs: binding.playback.fadeInMs,
      fadeOutMs: binding.playback.fadeOutMs,
      spatial: binding.playback.spatial,
      context: mergedContext,
      startAudioTime,
    };
    playbackBinding.set(playbackId, key);
    playbackMeta.set(playbackId, {
      eventId: binding.eventId,
      gameObjectId,
      durationMs: spatial.asset.durationMs,
    });
    const result = port.play(request);
    rememberHandle(key, playbackId, binding, result, epoch, gameObjectId);
  };

  const evaluate = (eventId: string, context: AudioEventContext = {}): EmitReceipt[] => {
    const gameObjectId = gameObjects.resolveId(context);
    const receipts: EmitReceipt[] = [];
    const effectiveContext: AudioEventContext = {
      ...context,
      ...(registeredListener && !context.listener ? { listener: registeredListener } : {}),
    };

    for (const binding of stopping.get(eventId) ?? []) {
      stopScoped(binding, gameObjectId);
    }

    const matches = bindings.get(eventId) ?? [];
    if (matches.length === 0) {
      const receipt: EmitReceipt = {
        eventId,
        bindingId: eventId,
        gameObjectId,
        outcome: 'no_binding',
      };
      diagnostics.emit(receipt);
      profiler.recordReceipt(receipt);
      receipts.push(receipt);
      return receipts;
    }

    for (const binding of matches) {
      const key = scopeKey(gameObjectId, binding.eventId);
      const base = { eventId, bindingId: binding.eventId, gameObjectId };

      if (!binding.enabled) {
        const receipt = { ...base, outcome: 'blocked_disabled' as const };
        diagnostics.emit(receipt);
        profiler.recordReceipt(receipt);
        receipts.push(receipt);
        continue;
      }
      if (!bindingMatches(binding, effectiveContext)) {
        const receipt = { ...base, outcome: 'blocked_conditions' as const };
        diagnostics.emit(receipt);
        profiler.recordReceipt(receipt);
        receipts.push(receipt);
        continue;
      }
      if (binding.trigger.probability <= 0
        || (binding.trigger.probability < 1 && random() >= binding.trigger.probability)) {
        const receipt = { ...base, outcome: 'blocked_probability' as const };
        diagnostics.emit(receipt);
        profiler.recordReceipt(receipt);
        receipts.push(receipt);
        continue;
      }

      const timestamp = nowWall();
      const previous = lastPlayedAt.get(key);
      if (previous !== undefined && timestamp - previous < binding.trigger.cooldownMs) {
        const receipt = { ...base, outcome: 'blocked_cooldown' as const };
        diagnostics.emit(receipt);
        profiler.recordReceipt(receipt);
        receipts.push(receipt);
        continue;
      }

      const resolved = resolvePlayback(
        binding,
        effectiveContext,
        gameObjects.valuesView(),
        selection,
        random,
        gameObjectId,
      );
      if (!resolved) {
        const receipt = { ...base, outcome: 'no_asset' as const };
        diagnostics.emit(receipt);
        profiler.recordReceipt(receipt);
        receipts.push(receipt);
        continue;
      }

      if (!readiness.isReady() && port.unlock && port.isReady && !port.isReady()) {
        // Auto-attempt unlock; if still locked, report and skip physical start.
        void readiness.tryUnlock();
        if (!readiness.isReady() && port.isReady && !port.isReady()) {
          const receipt = { ...base, outcome: 'context_locked' as const };
          diagnostics.emit(receipt);
          profiler.recordReceipt(receipt);
          receipts.push(receipt);
          continue;
        }
      }

      const spatialized = applySpatialAttenuation(binding, effectiveContext, gameObjectId, resolved);
      const admit = voices.tryAdmit({
        objectId: binding.eventId,
        eventId: binding.eventId,
        gameObjectId,
        busId: busIdForKind(binding.playback.bus),
        startAudioTime: nowAudio() + binding.trigger.delayMs / 1_000,
        priority: binding.priority ?? 50,
        computedVolumeDb: linearToDb(spatialized.volume),
      }, {
        maxPhysical,
        maxInstances: binding.maxInstances ?? 8,
        instanceScope: 'gameObject',
        onExceed: 'stealOldest',
      });

      if (!admit.ok) {
        const receipt = { ...base, outcome: 'rejected_voice_limit' as const };
        diagnostics.emit(receipt);
        profiler.recordReceipt(receipt);
        receipts.push(receipt);
        continue;
      }

      lastPlayedAt.set(key, timestamp);
      if (binding.playback.mode === 'loop') {
        activeLoopContexts.set(key, { ...effectiveContext, gameObjectId });
      }

      const delayMs = Math.max(0, binding.trigger.delayMs);
      // Only a real audio clock can hold a start to sub-frame precision; test
      // ports fall back to the raw time and the wall-timer contract below.
      const beat = hasAudioClock
        ? rhythm.schedule(key, nowAudio(), rhythmConfig(binding))
        : nowAudio();
      const due = beat + delayMs / 1_000;
      if (delayMs === 0) {
        playAt(binding, effectiveContext, gameObjectId, resolved, due, admit.voice.playbackId);
      } else if (!hasAudioClock) {
        // Injectable test ports have no AudioContext clock. Keep the v1
        // wall-timer contract so existing schedule/cancel tests stay valid.
        const epoch = stopEpoch.get(key) ?? 0;
        let handle: unknown;
        handle = scheduleTimer(() => {
          wallHandles.get(key)?.delete(handle);
          if ((stopEpoch.get(key) ?? 0) !== epoch) return;
          playAt(binding, effectiveContext, gameObjectId, resolved, nowAudio(), admit.voice.playbackId);
        }, delayMs);
        const walls = wallHandles.get(key) ?? new Set<unknown>();
        walls.add(handle);
        wallHandles.set(key, walls);
      } else {
        const schedId = scheduler.scheduleAt(due, (startAudioTime) => {
          const pending = scheduledIds.get(key);
          pending?.delete(schedId);
          if (pending?.size === 0) scheduledIds.delete(key);
          playAt(binding, effectiveContext, gameObjectId, resolved, startAudioTime, admit.voice.playbackId);
        });
        const pending = scheduledIds.get(key) ?? new Set<string>();
        pending.add(schedId);
        scheduledIds.set(key, pending);
      }

      const receipt: EmitReceipt = {
        ...base,
        playbackId: admit.voice.playbackId,
        outcome: 'played',
        audioTime: due,
      };
      diagnostics.emit(receipt);
      profiler.recordReceipt(receipt);
      receipts.push(receipt);
    }
    profiler.setVoices(voices.active().map((voice) => ({
      playbackId: voice.playbackId,
      eventId: voice.eventId,
      gameObjectId: voice.gameObjectId,
      computedVolumeDb: voice.computedVolumeDb,
      state: voice.state,
    })));
    return receipts;
  };

  const emit = (eventId: string, context: AudioEventContext = {}): number => (
    evaluate(eventId, context).filter((item) => item.outcome === 'played').length
  );

  return {
    emit,
    postEvent: emit,
    emitDetailed(eventId, context = {}) {
      return evaluate(eventId, context);
    },
    setGameValue(field, value, gameObjectId = GLOBAL_GAME_OBJECT_ID) {
      if (!field) return;
      const previous = gameObjects.getValue(gameObjectId, field);
      if (previous === value) return;
      gameObjects.setValue(gameObjectId, field, value);
      for (const binding of project.bindings) {
        if (!binding.enabled || binding.follow?.field !== field || binding.playback.mode !== 'loop') continue;
        const key = scopeKey(gameObjectId, binding.eventId);
        const context = activeLoopContexts.get(key);
        if (!context) continue;
        if (binding.follow.range) {
          const resolved = resolvePlayback(
            binding,
            context,
            gameObjects.valuesView(),
            selection,
            random,
            gameObjectId,
          );
          if (!resolved) continue;
          const request: AudioPlayRequest = {
            bindingId: binding.eventId,
            eventId: binding.eventId,
            gameObjectId,
            asset: resolved.asset,
            volume: resolved.volume,
            bus: binding.playback.bus,
            loop: true,
            fadeInMs: binding.playback.fadeInMs,
            fadeOutMs: binding.playback.fadeOutMs,
            spatial: binding.playback.spatial,
            context,
          };
          for (const handle of loopHandles.get(key) ?? []) handle.update?.(request);
        } else {
          stopScoped(binding, gameObjectId, false);
          evaluate(binding.eventId, context);
        }
      }
    },
    setState(groupId, value) {
      syncs.setState(groupId, value, nowAudio());
    },
    setSwitch(groupId, value, gameObjectId = GLOBAL_GAME_OBJECT_ID) {
      syncs.setSwitch(groupId, value, gameObjectId);
    },
    setRTPC(rtpcId, value, gameObjectId, slewMs) {
      syncs.setRTPC(rtpcId, value, gameObjectId, slewMs);
    },
    setListener(transform) {
      registeredListener = { ...transform, position: { ...transform.position } };
    },
    setObstruction(gameObjectId, value) {
      obstructionByObject.set(gameObjectId, Math.min(1, Math.max(0, value)));
    },
    setGameObjectTransform(gameObjectId, transform) {
      emitterByObject.set(gameObjectId, {
        x: transform.x,
        y: transform.y,
        z: transform.z,
        ...(transform.forward ? { forward: { ...transform.forward } } : {}),
      });
    },
    on(eventId, phase, callback) {
      callbacks.on(eventId, phase, callback);
    },
    off(eventId, phase, callback) {
      callbacks.off(eventId, phase, callback);
    },
    async warmUp(urls) {
      // Best-effort: unlock if possible, never block forever on a locked test port.
      try { await readiness.tryUnlock(); } catch { /* ignore */ }
      const targets = urls ?? project.bindings.flatMap((binding) => binding.assets.map((asset) => asset.url));
      await Promise.all(targets.map(async (url) => {
        if (!url || typeof fetch !== 'function') return;
        try { await fetch(url, { method: 'GET', mode: 'no-cors' }).catch(() => undefined); } catch { /* ignore */ }
      }));
    },
    getProfilerSnapshot() {
      return profiler.getSnapshot();
    },
    registerGameObject(gameObjectId) {
      gameObjects.ensure(gameObjectId);
    },
    unregisterGameObject(gameObjectId) {
      voices.stopBy({ gameObjectId }, 0);
      syncs.clearScope(gameObjectId);
      obstructionByObject.delete(gameObjectId);
      emitterByObject.delete(gameObjectId);
      gameObjects.clearScopeState(gameObjectId, [
        rhythm.state(),
        lastPlayedAt as Map<string, unknown>,
        selection as Map<string, unknown>,
        stopEpoch as Map<string, unknown>,
        activeLoopContexts as Map<string, unknown>,
        loopHandles as Map<string, unknown>,
        scheduledIds as Map<string, unknown>,
      ]);
      for (const key of [...loopHandles.keys()]) {
        if (key.startsWith(`${gameObjectId}:`)) {
          for (const handle of loopHandles.get(key) ?? []) handle.stop(0);
          loopHandles.delete(key);
        }
      }
      gameObjects.unregister(gameObjectId);
    },
    stop(eventId, gameObjectId) {
      if (eventId) {
        for (const binding of bindings.get(eventId) ?? []) stopScoped(binding, gameObjectId);
        return;
      }
      for (const list of bindings.values()) {
        for (const binding of list) stopScoped(binding, gameObjectId);
      }
    },
    stopPlayback(playbackId, fadeOutMs = 0) {
      // stopOnce (attached via voices) fires the 'stop' callback and clears meta.
      voices.stop(playbackId, fadeOutMs);
      playbackBinding.delete(playbackId);
      playbackMeta.delete(playbackId);
    },
    setBusVolume(bus, volume) {
      port.setBusVolume(bus, volume);
      const id = String(bus).startsWith('bus:') ? String(bus) : `bus:${bus}`;
      graph.setVolumeDb(id, 20 * Math.log10(Math.max(1e-4, volume)));
    },
    whenReady() {
      return readiness.whenReady();
    },
    isReady() {
      return readiness.isReady();
    },
    dispose() {
      scheduler.stop();
      voices.dispose();
      graph.dispose();
      gameObjects.dispose();
      syncs.dispose();
      callbacks.dispose();
      profiler.dispose();
      loopHandles.clear();
      activeLoopContexts.clear();
      scheduledIds.clear();
      obstructionByObject.clear();
      emitterByObject.clear();
      rhythm.clear();
      port.dispose();
    },
  };
}

export { ENGINE_VERSION };
export type { RuntimeFollowValue };
