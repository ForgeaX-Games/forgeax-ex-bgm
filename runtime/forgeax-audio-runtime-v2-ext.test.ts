import { describe, expect, test } from 'bun:test';

import {
  createContainerResolver,
  createForgeaxAudioRuntime,
  createProfiler,
  evaluateAttenuation,
  nextBarAudioTime,
  resolveVoiceProperties,
  type AudioHandle,
  type AudioPlayRequest,
  type AudioPort,
  type RuntimeAudioBinding,
  type RuntimeAudioNode,
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

function asset(id: string) {
  return { assetId: id, file: `${id}.wav`, url: `asset:${id}`, name: id };
}

function binding(overrides: Partial<RuntimeAudioBinding> = {}): RuntimeAudioBinding {
  return {
    eventId: 'combat.hit',
    label: '命中',
    enabled: true,
    kind: 'sfx',
    assets: [asset('a')],
    variation: { mode: 'single' },
    trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
    playback: {
      volume: 1, bus: 'sfx', spatial: '2d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 40,
    },
    conditions: [],
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

/** Port with an audio clock, which is what unlocks sub-frame start times. */
class ClockPort extends RecordingPort {
  audioTime = 0;
  currentTime(): number { return this.audioTime; }
}

/** Trigger times as a 60 fps game firing at this interval would deliver them. */
function frameQuantised(intervalMs: number, count: number): number[] {
  const frame = 1 / 60;
  return Array.from(
    { length: count },
    (_, index) => Math.ceil((index * intervalMs / 1_000) / frame) * frame,
  );
}

function startGapsMs(port: ClockPort): number[] {
  const starts = port.requests.map((request) => request.startAudioTime ?? 0);
  const gaps: number[] = [];
  for (let index = 1; index < starts.length; index += 1) {
    gaps.push((starts[index]! - starts[index - 1]!) * 1_000);
  }
  return gaps;
}

describe('ForgeaX audio runtime v2 extensions', () => {
  test('container sequence/random/switch selection with scoped state', () => {
    const resolver = createContainerResolver();
    const sequence: RuntimeAudioNode = {
      kind: 'sequence',
      nodeKey: 'seq',
      loop: true,
      scope: 'gameObject',
      children: [
        { kind: 'sound', asset: asset('s0') },
        { kind: 'sound', asset: asset('s1') },
      ],
    };
    const ctxA = {
      gameObjectId: 'npc-a',
      getSwitch: () => undefined,
      getRtpc: () => 0,
      random: () => 0,
    };
    const ctxB = { ...ctxA, gameObjectId: 'npc-b' };
    expect(resolver.resolveNode(sequence, ctxA)?.assetId).toBe('s0');
    expect(resolver.resolveNode(sequence, ctxA)?.assetId).toBe('s1');
    expect(resolver.resolveNode(sequence, ctxB)?.assetId).toBe('s0');

    const switchNode: RuntimeAudioNode = {
      kind: 'switch',
      nodeKey: 'sw',
      groupId: 'surface',
      assignments: {
        dirt: { kind: 'sound', asset: asset('dirt') },
        metal: { kind: 'sound', asset: asset('metal') },
      },
      defaultNode: { kind: 'sound', asset: asset('default') },
    };
    expect(resolver.resolveNode(switchNode, {
      ...ctxA,
      getSwitch: (id) => (id === 'surface' ? 'metal' : undefined),
    })?.assetId).toBe('metal');

    let rolls = [0.1, 0.9, 0.2];
    const randomNode: RuntimeAudioNode = {
      kind: 'random',
      nodeKey: 'rnd',
      scope: 'global',
      avoidRepeatCount: 1,
      weights: [1, 1, 1],
      children: [
        { kind: 'sound', asset: asset('r0') },
        { kind: 'sound', asset: asset('r1') },
        { kind: 'sound', asset: asset('r2') },
      ],
    };
    const first = resolver.resolveNode(randomNode, {
      gameObjectId: '__global__',
      getSwitch: () => undefined,
      getRtpc: () => 0,
      random: () => rolls.shift() ?? 0,
    })?.assetId;
    const second = resolver.resolveNode(randomNode, {
      gameObjectId: '__global__',
      getSwitch: () => undefined,
      getRtpc: () => 0,
      random: () => rolls.shift() ?? 0,
    })?.assetId;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  test('RTPC curve moves volume', () => {
    const quiet = resolveVoiceProperties({
      baseVolumeDb: 0,
      rtpcBindings: [{
        rtpcId: 'intensity',
        target: 'volumeDb',
        curve: [
          { x: 0, y: -12, interp: 'linear' },
          { x: 1, y: 0, interp: 'linear' },
        ],
      }],
      rtpcValues: { intensity: 0 },
    });
    const loud = resolveVoiceProperties({
      baseVolumeDb: 0,
      rtpcBindings: [{
        rtpcId: 'intensity',
        target: 'volumeDb',
        curve: [
          { x: 0, y: -12, interp: 'linear' },
          { x: 1, y: 0, interp: 'linear' },
        ],
      }],
      rtpcValues: { intensity: 1 },
    });
    expect(quiet.volumeDb).toBeCloseTo(-12, 5);
    expect(loud.volumeDb).toBeCloseTo(0, 5);
    expect(loud.volumeDb).toBeGreaterThan(quiet.volumeDb);
  });

  test('attenuation reduces volume with distance', () => {
    const near = evaluateAttenuation({
      attenuation: {
        id: 'att',
        maxDistance: 100,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: 100, y: -60, interp: 'linear' },
          ],
        },
      },
      emitter: { x: 0, y: 0, z: 0 },
      listener: { position: { x: 0, y: 0, z: 0 } },
    });
    const far = evaluateAttenuation({
      attenuation: {
        id: 'att',
        maxDistance: 100,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: 100, y: -60, interp: 'linear' },
          ],
        },
      },
      emitter: { x: 0, y: 0, z: 0 },
      listener: { position: { x: 50, y: 0, z: 0 } },
    });
    expect(near.volumeDb).toBeCloseTo(0, 5);
    expect(far.volumeDb).toBeCloseTo(-30, 5);
    expect(far.volumeDb).toBeLessThan(near.volumeDb);

    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([
      binding({
        playback: {
          volume: 1, bus: 'sfx', spatial: '3d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0,
        },
      }),
    ], {
      bankFeatures: { attenuation: true },
      attenuations: [{
        id: 'att',
        maxDistance: 100,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: 100, y: -60, interp: 'linear' },
          ],
        },
      }],
    }), { port });

    runtime.emit('combat.hit', {
      emitter: { x: 0, y: 0, z: 0 },
      listener: { position: { x: 50, y: 0, z: 0 } },
    });
    expect(port.requests[0]?.volume).toBeLessThan(1);
  });

  test('each sound uses the attenuation curve it points at', () => {
    const curve = (id: string, farDb: number) => ({
      id,
      maxDistance: 100,
      curves: {
        outputVolumeDb: [
          { x: 0, y: 0, interp: 'linear' as const },
          { x: 100, y: farDb, interp: 'linear' as const },
        ],
      },
    });
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([
      binding({
        eventId: 'weapon.fire',
        playback: {
          volume: 1, bus: 'sfx', spatial: '3d', attenuationId: 'att:far', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0,
        },
      }),
      binding({
        eventId: 'combat.hit',
        playback: {
          volume: 1, bus: 'sfx', spatial: '3d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0,
        },
      }),
    ], {
      bankFeatures: { attenuation: true },
      // The first entry stays the fallback for bindings without an explicit id.
      attenuations: [curve('att:near', -6), curve('att:far', -60)],
    }), { port });

    const context = { emitter: { x: 0, y: 0, z: 0 }, listener: { position: { x: 50, y: 0, z: 0 } } };
    runtime.emit('weapon.fire', context);
    runtime.emit('combat.hit', context);

    const [pointed, fallback] = port.requests;
    expect(pointed?.volume).toBeLessThan(fallback!.volume);
    expect(fallback?.volume).toBeCloseTo(10 ** (-3 / 20), 3);
  });

  test('a published game object position spatialises emits that carry no coordinates', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([
      binding({
        playback: {
          volume: 1, bus: 'sfx', spatial: '3d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0,
        },
      }),
    ], {
      bankFeatures: { attenuation: true },
      attenuations: [{
        id: 'att',
        maxDistance: 100,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: 100, y: -60, interp: 'linear' },
          ],
        },
      }],
    }), { port });
    const listener = { position: { x: 0, y: 0, z: 0 } };

    runtime.emit('combat.hit', { gameObjectId: 'npc', listener });
    expect(port.requests[0]?.volume).toBeCloseTo(1, 5);

    runtime.setGameObjectTransform('npc', { x: 50, y: 0, z: 0 });
    runtime.emit('combat.hit', { gameObjectId: 'npc', listener });
    expect(port.requests[1]?.volume).toBeLessThan(1);

    runtime.unregisterGameObject('npc');
    runtime.emit('combat.hit', { gameObjectId: 'npc', listener });
    expect(port.requests[2]?.volume).toBeCloseTo(1, 5);
  });

  test('music nextBar quantisation (pure math)', () => {
    // 120 BPM, 4/4 → bar = 2.0s. Segment started at t=10.
    const next = nextBarAudioTime(10, 10.1, 120, [4, 4]);
    expect(next).toBeCloseTo(12, 5);
    const later = nextBarAudioTime(10, 11.9, 120, [4, 4]);
    expect(later).toBeCloseTo(12, 5);
    const afterBar = nextBarAudioTime(10, 12, 120, [4, 4]);
    expect(afterBar).toBeCloseTo(14, 5);
  });

  test('callbacks fire on emit', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding()]), { port });
    const phases: string[] = [];
    runtime.on('combat.hit', 'start', (detail) => {
      phases.push(`start:${detail.eventId}`);
    });
    expect(runtime.emit('combat.hit')).toBe(1);
    expect(phases).toEqual(['start:combat.hit']);
    expect(runtime.postEvent('combat.hit')).toBe(1);
  });

  test('evens out a burst the game triggers on frame boundaries', () => {
    const port = new ClockPort();
    const runtime = createForgeaxAudioRuntime(
      project([binding({ maxInstances: 8 })]),
      { port, now: () => port.audioTime * 1_000 },
    );

    for (const arrival of frameQuantised(85.7, 30)) {
      port.audioTime = arrival;
      runtime.emit('combat.hit');
    }

    const steady = startGapsMs(port).slice(10);
    for (const gap of steady) expect(Math.abs(gap - 85.7)).toBeLessThan(5);
    // Nothing may be scheduled before the trigger that caused it.
    for (const [index, request] of port.requests.entries()) {
      expect(request.startAudioTime).toBeGreaterThanOrEqual(frameQuantised(85.7, 30)[index]!);
    }
    runtime.dispose();
  });

  test('a zero rhythm lock leaves the game timing untouched', () => {
    const port = new ClockPort();
    const arrivals = frameQuantised(85.7, 30);
    const runtime = createForgeaxAudioRuntime(
      project([binding({
        maxInstances: 8,
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1, rhythmLockMs: 0 },
      })]),
      { port, now: () => port.audioTime * 1_000 },
    );

    for (const arrival of arrivals) {
      port.audioTime = arrival;
      runtime.emit('combat.hit');
    }

    expect(port.requests.map((request) => request.startAudioTime)).toEqual(arrivals);
    runtime.dispose();
  });

  test('profiler snapshot contains receipts', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding()]), { port });
    runtime.emit('combat.hit');
    const snapshot = runtime.getProfilerSnapshot();
    expect(snapshot.projectId).toBe('demo');
    expect(snapshot.receipts.some((item) => item.outcome === 'played')).toBe(true);
    expect(snapshot.counts.byOutcome.played).toBeGreaterThan(0);

    const standalone = createProfiler({ projectId: 'x', capacity: 2 });
    standalone.recordReceipt({
      eventId: 'a', bindingId: 'a', gameObjectId: '__global__', outcome: 'played',
    });
    const payload = standalone.toPostMessage();
    expect(payload.type).toBe('forgeax-audio-profiler');
    expect(payload.receipts).toHaveLength(1);
    expect(payload.counts.total).toBe(1);
  });

  test('profiler keeps cumulative counts after the receipt ring wraps', () => {
    const standalone = createProfiler({ projectId: 'x', capacity: 64 });
    for (let index = 0; index < 80; index++) {
      standalone.recordReceipt({
        eventId: index < 50 ? 'combat.hit' : 'combat.kill',
        bindingId: 'x',
        gameObjectId: '__global__',
        outcome: index % 2 === 0 ? 'played' : 'blocked_cooldown',
      });
    }
    const snapshot = standalone.getSnapshot();
    expect(snapshot.receipts).toHaveLength(64);
    expect(snapshot.counts.total).toBe(80);
    expect(snapshot.counts.byOutcome.played).toBe(40);
    expect(snapshot.counts.byOutcome.blocked_cooldown).toBe(40);
    expect(snapshot.counts.byEvent['combat.hit']?.total).toBe(50);
    expect(snapshot.counts.byEvent['combat.kill']?.total).toBe(30);
    snapshot.counts.total = 0;
    expect(standalone.getSnapshot().counts.total).toBe(80);
  });

  test('warmUp is callable', async () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding()]), { port });
    await expect(runtime.warmUp([])).resolves.toBeUndefined();
    await expect(runtime.warmUp()).resolves.toBeUndefined();
  });
});
