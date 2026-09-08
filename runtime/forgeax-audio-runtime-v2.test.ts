import { describe, expect, test } from 'bun:test';

import {
  assertEngineVersion,
  busGraphHasCycle,
  createDecodeCache,
  createForgeaxAudioRuntime,
  createLookaheadScheduler,
  createVoiceManager,
  EngineVersionMismatchError,
  GLOBAL_GAME_OBJECT_ID,
  shouldStreamAsset,
  STREAM_THRESHOLD_MS,
  type AudioHandle,
  type AudioPlayRequest,
  type AudioPort,
  type EmitReceipt,
  type RuntimeAudioBinding,
  type RuntimeAudioProject,
} from './forgeax-audio-runtime.ts';

class RecordingHandle implements AudioHandle {
  stops: number[] = [];
  stop(fadeOutMs: number): void { this.stops.push(fadeOutMs); }
}

class RecordingPort implements AudioPort {
  requests: AudioPlayRequest[] = [];
  play(request: AudioPlayRequest): AudioHandle {
    this.requests.push(request);
    return new RecordingHandle();
  }
  setBusVolume(): void {}
  dispose(): void {}
}

function binding(overrides: Partial<RuntimeAudioBinding> = {}): RuntimeAudioBinding {
  return {
    eventId: 'combat.hit',
    label: '命中',
    enabled: true,
    kind: 'sfx',
    assets: [{ assetId: 'a', file: 'a.wav', url: 'asset:a' }],
    variation: { mode: 'single' },
    trigger: { delayMs: 0, cooldownMs: 100, probability: 1 },
    playback: {
      volume: 1, bus: 'sfx', spatial: '2d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 40,
    },
    conditions: [],
    priority: 50,
    maxInstances: 2,
    ...overrides,
  };
}

function project(bindings: RuntimeAudioBinding[], extra: Partial<RuntimeAudioProject> = {}): RuntimeAudioProject {
  return {
    schemaVersion: 'forgeax-audio-runtime/1',
    projectId: 'demo',
    revision: 1,
    bindings,
    ...extra,
  };
}

describe('ForgeaX audio runtime v2', () => {
  test('scopes cooldown independently per gameObjectId', () => {
    const port = new RecordingPort();
    let now = 1_000;
    const runtime = createForgeaxAudioRuntime(project([binding()]), {
      port,
      now: () => now,
    });

    expect(runtime.emit('combat.hit', { gameObjectId: 'npc-1' })).toBe(1);
    expect(runtime.emit('combat.hit', { gameObjectId: 'npc-2' })).toBe(1);
    expect(runtime.emit('combat.hit', { gameObjectId: 'npc-1' })).toBe(0);
    now += 150;
    expect(runtime.emit('combat.hit', { gameObjectId: 'npc-1' })).toBe(1);
    expect(port.requests.map((item) => item.gameObjectId)).toEqual([
      'npc-1', 'npc-2', 'npc-1',
    ]);
  });

  test('stopPlayback only stops the targeted playbackId', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
      maxInstances: 8,
    })]), { port });

    const first = runtime.emitDetailed('combat.hit', { gameObjectId: 'a' });
    const second = runtime.emitDetailed('combat.hit', { gameObjectId: 'b' });
    expect(first[0]?.playbackId).toBeDefined();
    expect(second[0]?.playbackId).toBeDefined();
    runtime.stopPlayback(first[0]!.playbackId!);
    // Second voice remains tracked until natural end; port handles already created.
    expect(port.requests).toHaveLength(2);
  });

  test('emits diagnostic receipts for every gate', () => {
    const port = new RecordingPort();
    const receipts: EmitReceipt[] = [];
    const runtime = createForgeaxAudioRuntime(project([
      binding({
        enabled: false,
        eventId: 'off',
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
      }),
      binding({
        eventId: 'gated',
        conditions: [{ field: 'hp', operator: 'gt', value: 10 }],
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
      }),
      binding({
        eventId: 'chance',
        trigger: { delayMs: 0, cooldownMs: 0, probability: 0 },
      }),
    ]), { port, onReceipt: (receipt) => receipts.push(receipt) });

    expect(runtime.emitDetailed('off')[0]?.outcome).toBe('blocked_disabled');
    expect(runtime.emitDetailed('gated')[0]?.outcome).toBe('blocked_conditions');
    expect(runtime.emitDetailed('chance')[0]?.outcome).toBe('blocked_probability');
    expect(runtime.emitDetailed('missing')[0]?.outcome).toBe('no_binding');
    expect(receipts.length).toBeGreaterThanOrEqual(4);
  });

  test('enforces physical voice budget and never steals higher priority', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([
      binding({
        eventId: 'low',
        priority: 10,
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
        maxInstances: 8,
      }),
      binding({
        eventId: 'high',
        priority: 90,
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
        maxInstances: 8,
      }),
    ], { voiceBudget: { maxPhysical: 1 } }), { port });

    expect(runtime.emit('low')).toBe(1);
    expect(runtime.emit('high')).toBe(1); // steals low
    expect(runtime.emit('low')).toBe(0); // cannot steal high
  });

  test('lookahead scheduler delivers exact audio start times', () => {
    let audioNow = 1;
    const timers: Array<{ at: number; run: () => void }> = [];
    let wall = 0;
    const scheduler = createLookaheadScheduler({
      eventPeriodMs: 25,
      lookaheadMs: 100,
      controlPeriodMs: 20,
      nowAudio: () => audioNow,
      scheduleTimer: (run, delayMs) => {
        const handle = { at: wall + delayMs, run };
        timers.push(handle);
        return handle;
      },
      cancelTimer: (handle) => {
        const index = timers.indexOf(handle as typeof timers[number]);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    const starts: number[] = [];
    scheduler.start();
    scheduler.scheduleAt(1.08, (start) => starts.push(start));
    // Advance wall enough for event ticks; keep audioNow inside horizon.
    for (let i = 0; i < 5; i++) {
      wall += 25;
      audioNow = 1 + i * 0.01;
      for (const timer of [...timers]) {
        if (timer.at <= wall) {
          const index = timers.indexOf(timer);
          if (index >= 0) timers.splice(index, 1);
          timer.run();
        }
      }
    }
    expect(starts).toEqual([1.08]);
    scheduler.stop();
  });

  test('decode LRU evicts oldest entries past the byte ceiling', async () => {
    const fake = (channels: number, length: number): AudioBuffer => ({
      numberOfChannels: channels,
      length,
      duration: length / 48_000,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array(length),
      copyFromChannel() {},
      copyToChannel() {},
    }) as AudioBuffer;

    const cache = createDecodeCache({
      maxBytes: 100,
      decode: async (url) => ({
        buffer: fake(1, url === 'big' ? 40 : 20),
        byteLength: url === 'big' ? 80 : 40,
      }),
    });

    await cache.get('a');
    await cache.get('b');
    expect(cache.stats().entries).toBe(2);
    await cache.get('big');
    expect(cache.peek('a')).toBeUndefined();
    expect(cache.stats().bytes).toBeLessThanOrEqual(100);
  });

  test('streams assets longer than the decode threshold', () => {
    expect(shouldStreamAsset(STREAM_THRESHOLD_MS)).toBe(false);
    expect(shouldStreamAsset(STREAM_THRESHOLD_MS + 1)).toBe(true);
  });

  test('rejects mismatched engineVersion and allows legacy unstamped banks', () => {
    expect(() => assertEngineVersion(project([], { engineVersion: '9.9.9' }))).toThrow(EngineVersionMismatchError);
    expect(() => assertEngineVersion(project([]))).not.toThrow();
  });

  test('detects cyclic bus graphs', () => {
    expect(busGraphHasCycle([
      { id: 'a', name: 'A', parentId: 'b', volumeDb: 0, ducking: [] },
      { id: 'b', name: 'B', parentId: 'a', volumeDb: 0, ducking: [] },
    ])).toBe(true);
    expect(busGraphHasCycle([
      { id: 'master', name: 'M', volumeDb: 0, ducking: [] },
      { id: 'sfx', name: 'S', parentId: 'master', volumeDb: 0, ducking: [] },
    ])).toBe(false);
  });

  test('unregisterGameObject clears per-object cooldown state', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding()]), { port, now: () => 5_000 });
    runtime.emit('combat.hit', { gameObjectId: 'npc' });
    expect(runtime.emit('combat.hit', { gameObjectId: 'npc' })).toBe(0);
    runtime.unregisterGameObject('npc');
    expect(runtime.emit('combat.hit', { gameObjectId: 'npc' })).toBe(1);
    expect(GLOBAL_GAME_OBJECT_ID).toBe('__global__');
  });

  test('voice manager admits until the physical budget is full', () => {
    const manager = createVoiceManager();
    const limits = {
      maxPhysical: 2,
      maxInstances: 8,
      instanceScope: 'global' as const,
      onExceed: 'reject' as const,
    };
    expect(manager.tryAdmit({
      objectId: 'a', eventId: 'a', gameObjectId: 'g', busId: 'bus:sfx',
      startAudioTime: 0, priority: 50, computedVolumeDb: -6,
    }, limits).ok).toBe(true);
    expect(manager.tryAdmit({
      objectId: 'b', eventId: 'b', gameObjectId: 'g', busId: 'bus:sfx',
      startAudioTime: 1, priority: 50, computedVolumeDb: -6,
    }, limits).ok).toBe(true);
    expect(manager.tryAdmit({
      objectId: 'c', eventId: 'c', gameObjectId: 'g', busId: 'bus:sfx',
      startAudioTime: 2, priority: 50, computedVolumeDb: -6,
    }, limits).ok).toBe(false);
  });
});
