import { describe, expect, test } from 'bun:test';

import {
  createForgeaxAudioRuntime,
  mergeShaping,
  type AudioHandle,
  type AudioPlayRequest,
  type AudioPort,
  type RuntimeAudioBinding,
  type RuntimeAudioProject,
} from './forgeax-audio-runtime.ts';

class RecordingHandle implements AudioHandle {
  stops: number[] = [];
  updates: AudioPlayRequest[] = [];
  stop(fadeOutMs: number): void { this.stops.push(fadeOutMs); }
  update(request: AudioPlayRequest): void { this.updates.push(request); }
}

class RecordingPort implements AudioPort {
  requests: AudioPlayRequest[] = [];
  handles: RecordingHandle[] = [];
  busVolumes: Array<[string, number]> = [];
  disposed = false;

  play(request: AudioPlayRequest): AudioHandle {
    this.requests.push(request);
    const handle = new RecordingHandle();
    this.handles.push(handle);
    return handle;
  }

  setBusVolume(bus: string, volume: number): void {
    this.busVolumes.push([bus, volume]);
  }

  dispose(): void { this.disposed = true; }
}

function binding(overrides: Partial<RuntimeAudioBinding> = {}): RuntimeAudioBinding {
  return {
    eventId: 'combat.hit',
    label: '命中',
    enabled: true,
    kind: 'sfx',
    assets: [
      { assetId: 'a', file: 'a.wav', url: 'asset:a' },
      { assetId: 'b', file: 'b.wav', url: 'asset:b' },
    ],
    variation: { mode: 'single' },
    trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
    playback: {
      volume: 0.8,
      bus: 'sfx',
      spatial: '2d',
      mode: 'one-shot',
      fadeInMs: 0,
      fadeOutMs: 60,
    },
    conditions: [],
    ...overrides,
  };
}

function project(bindings: RuntimeAudioBinding[]): RuntimeAudioProject {
  return {
    schemaVersion: 'forgeax-audio-runtime/1',
    projectId: 'demo',
    revision: 3,
    bindings,
  };
}

describe('ForgeaX game audio runtime', () => {
  // 编辑区的试听按钮直接调用 mergeShaping，靠它保证「调完参数听到的」等于
  // 「游戏里会响的」，所以叠加口径本身是对外契约。
  test('layers shaping by summing gains and taking the narrower filter band', () => {
    const merged = mergeShaping(
      { gainDb: 3, pitchSemitones: 1, eqLowDb: 2, highpassHz: 200, lowpassHz: 20_000 },
      { gainDb: -1, pitchSemitones: 2, eqLowDb: 1, highpassHz: 80, lowpassHz: 6_000 },
    );

    expect(merged).toEqual({
      gainDb: 2,
      pitchSemitones: 3,
      highpassHz: 200,
      lowpassHz: 6_000,
      eqLowDb: 3,
      eqMidDb: 0,
      eqHighDb: 0,
    });
  });

  test('keeps layered shaping inside engine limits and never inverts the filter band', () => {
    const merged = mergeShaping(
      { gainDb: 12, pitchSemitones: 10, eqHighDb: 10 },
      { gainDb: 12, pitchSemitones: 10, eqHighDb: 10, highpassHz: 2_000, lowpassHz: 1_200 },
    );

    expect(merged?.gainDb).toBe(12);
    expect(merged?.pitchSemitones).toBe(12);
    expect(merged?.eqHighDb).toBe(12);
    expect(merged?.lowpassHz).toBeGreaterThan(merged!.highpassHz);
  });

  test('reports no shaping when nothing is configured, so the raw asset plays untouched', () => {
    expect(mergeShaping(undefined, undefined)).toBeUndefined();
  });

  test('plays only when every context condition matches', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      conditions: [
        { field: 'target.material', operator: 'eq', value: 'metal' },
        { field: 'damage', operator: 'gte', value: 10 },
      ],
    })]), { port });

    expect(runtime.emit('combat.hit', { target: { material: 'wood' }, damage: 20 })).toBe(0);
    expect(runtime.emit('combat.hit', { target: { material: 'metal' }, damage: 10 })).toBe(1);
    expect(port.requests).toHaveLength(1);
  });

  test('enforces probability and cooldown before asking the audio port to play', () => {
    let now = 1_000;
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([
      binding({ eventId: 'never', trigger: { delayMs: 0, cooldownMs: 0, probability: 0 } }),
      binding({ eventId: 'cooldown', trigger: { delayMs: 0, cooldownMs: 500, probability: 1 } }),
    ]), { port, now: () => now, random: () => 0.5 });

    expect(runtime.emit('never')).toBe(0);
    expect(runtime.emit('cooldown')).toBe(1);
    now = 1_200;
    expect(runtime.emit('cooldown')).toBe(0);
    now = 1_500;
    expect(runtime.emit('cooldown')).toBe(1);
    expect(port.requests.map((request) => request.eventId)).toEqual(['cooldown', 'cooldown']);
  });

  test('schedules delayed playback without playing early', () => {
    const port = new RecordingPort();
    const scheduled: Array<{ delay: number; run: () => void }> = [];
    const runtime = createForgeaxAudioRuntime(project([
      binding({ trigger: { delayMs: 125, cooldownMs: 0, probability: 1 } }),
    ]), {
      port,
      schedule: (run, delay) => { scheduled.push({ run, delay }); return scheduled.length; },
      cancel: () => undefined,
    });

    expect(runtime.emit('combat.hit')).toBe(1);
    expect(port.requests).toEqual([]);
    expect(scheduled.map((item) => item.delay)).toEqual([125]);
    scheduled[0]!.run();
    expect(port.requests).toHaveLength(1);
  });

  test('cancels delayed playback when the event is stopped before it starts', () => {
    const port = new RecordingPort();
    const scheduled: Array<{ delay: number; run: () => void }> = [];
    const cancelled: unknown[] = [];
    const runtime = createForgeaxAudioRuntime(project([
      binding({ trigger: { delayMs: 125, cooldownMs: 0, probability: 1 } }),
    ]), {
      port,
      schedule: (run, delay) => { scheduled.push({ run, delay }); return scheduled.length; },
      cancel: (handle) => { cancelled.push(handle); },
    });

    runtime.emit('combat.hit');
    runtime.stop('combat.hit');
    scheduled[0]!.run();

    expect(cancelled).toEqual([1]);
    expect(port.requests).toEqual([]);
  });

  test('stops an async loop handle that resolves after its stop event', async () => {
    const handle = new RecordingHandle();
    let resolvePlay!: (value: AudioHandle) => void;
    const port: AudioPort = {
      play: () => new Promise<AudioHandle>((resolve) => { resolvePlay = resolve; }),
      setBusVolume: () => undefined,
      dispose: () => undefined,
    };
    const runtime = createForgeaxAudioRuntime(project([binding({
      playback: {
        volume: 0.8,
        bus: 'music',
        spatial: '2d',
        mode: 'loop',
        fadeInMs: 0,
        fadeOutMs: 250,
        stopEventId: 'combat.end',
      },
    })]), { port });

    runtime.emit('combat.hit');
    runtime.emit('combat.end');
    resolvePlay(handle);
    await Promise.resolve();

    expect(handle.stops).toEqual([250]);
  });

  test('supports sequential and random-no-repeat asset variation', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([
      binding({ eventId: 'sequence', variation: { mode: 'sequential' } }),
      binding({ eventId: 'random', variation: { mode: 'random-no-repeat' } }),
    ]), { port, random: () => 0 });

    runtime.emit('sequence');
    runtime.emit('sequence');
    runtime.emit('sequence');
    runtime.emit('random');
    runtime.emit('random');

    expect(port.requests.map((request) => request.asset.url)).toEqual([
      'asset:a', 'asset:b', 'asset:a', 'asset:a', 'asset:b',
    ]);
  });

  test('stops loop bindings when their stop event fires', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      playback: {
        volume: 0.8,
        bus: 'music',
        spatial: '2d',
        mode: 'loop',
        fadeInMs: 250,
        fadeOutMs: 400,
        stopEventId: 'combat.end',
      },
    })]), { port });

    runtime.emit('combat.hit');
    expect(port.handles).toHaveLength(1);
    expect(runtime.emit('combat.end')).toBe(0);
    expect(port.handles[0]!.stops).toEqual([400]);
  });

  test('passes 3D emitter and listener data and forwards bus/dispose controls', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      playback: {
        volume: 0.6,
        bus: 'voice',
        spatial: '3d',
        mode: 'one-shot',
        fadeInMs: 10,
        fadeOutMs: 20,
      },
    })]), { port });
    const context = {
      emitter: { x: 1, y: 2, z: 3 },
      listener: { position: { x: 4, y: 5, z: 6 } },
    };

    runtime.emit('combat.hit', context);
    runtime.setBusVolume('voice', 0.4);
    runtime.dispose();

    expect(port.requests[0]).toMatchObject({ spatial: '3d', context, volume: 0.6, bus: 'voice' });
    expect(port.busVolumes).toEqual([['voice', 0.4]]);
    expect(port.disposed).toBe(true);
  });

  test('uses a matching game-value sound and safely falls back to the default assets', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      follow: {
        field: 'surface.material',
        label: '地面材质',
        defaultValue: '',
        cases: [
          { value: 'grass', assets: [{ assetId: 'grass', file: 'grass.wav', url: 'asset:grass' }] },
          { value: 'stone', assets: [{ assetId: 'stone', file: 'stone.wav', url: 'asset:stone' }] },
        ],
      },
    })]), { port });

    runtime.emit('combat.hit', { surface: { material: 'grass' } });
    runtime.emit('combat.hit', { surface: { material: 'snow' } });

    expect(port.requests.map((request) => request.asset.url)).toEqual(['asset:grass', 'asset:a']);
  });

  test('changes an active loop when a persistent game value changes', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      playback: {
        volume: 0.8,
        bus: 'music',
        spatial: '2d',
        mode: 'loop',
        fadeInMs: 300,
        fadeOutMs: 300,
      },
      follow: {
        field: 'game.phase',
        defaultValue: 'explore',
        cases: [
          { value: 'explore', assets: [{ assetId: 'town', file: 'town.mp3', url: 'asset:town' }] },
          { value: 'combat', assets: [{ assetId: 'combat', file: 'combat.mp3', url: 'asset:combat' }] },
        ],
      },
    })]), { port });

    runtime.emit('combat.hit');
    runtime.setGameValue('game.phase', 'combat');

    expect(port.requests.map((request) => request.asset.url)).toEqual(['asset:town', 'asset:combat']);
    expect(port.handles[0]!.stops).toEqual([300]);
  });

  test('combines event EQ with continuous game-value shaping and updates an active loop', () => {
    const port = new RecordingPort();
    const runtime = createForgeaxAudioRuntime(project([binding({
      playback: {
        volume: 0.8,
        bus: 'sfx',
        spatial: '2d',
        mode: 'loop',
        fadeInMs: 0,
        fadeOutMs: 0,
      },
      shaping: {
        gainDb: 0,
        pitchSemitones: 0,
        highpassHz: 20,
        lowpassHz: 20_000,
        eqLowDb: 3,
        eqMidDb: -1,
        eqHighDb: 2,
      },
      follow: {
        field: 'player.speed',
        defaultValue: 0,
        range: {
          min: 0,
          max: 10,
          volumeStart: 0.5,
          volumeEnd: 1,
          pitchStart: -2,
          pitchEnd: 2,
          lowpassStart: 8_000,
          lowpassEnd: 20_000,
        },
      },
    })]), { port });

    runtime.setGameValue('player.speed', 5);
    runtime.emit('combat.hit');
    expect(port.requests[0]!.volume).toBeCloseTo(0.6);
    expect(port.requests[0]!.asset).toMatchObject({
      shaping: { pitchSemitones: 0, lowpassHz: 14_000, eqLowDb: 3, eqMidDb: -1, eqHighDb: 2 },
    });

    runtime.setGameValue('player.speed', 10);
    expect(port.handles[0]!.updates).toHaveLength(1);
  });
});
