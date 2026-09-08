import { createDecodeCache, shouldStreamAsset } from './decode-cache.ts';
import type {
  AudioHandle,
  AudioPlayRequest,
  AudioPort,
  RuntimeAudioBus,
} from '../types.ts';

interface BrowserSource {
  source: AudioBufferSourceNode | MediaElementAudioSourceNode;
  element?: HTMLAudioElement;
  gain: GainNode;
  panner?: PannerNode;
  filters?: {
    highpass: BiquadFilterNode;
    lowShelf: BiquadFilterNode;
    midPeak: BiquadFilterNode;
    highShelf: BiquadFilterNode;
    lowpass: BiquadFilterNode;
  };
  context: AudioContext;
  stopped: boolean;
  nodes: AudioNode[];
}

class BrowserAudioHandle implements AudioHandle {
  constructor(private readonly value: BrowserSource) {}

  stop(fadeOutMs: number): void {
    if (this.value.stopped) return;
    this.value.stopped = true;
    const { context, source, gain, element } = this.value;
    const now = context.currentTime;
    const stopAt = now + Math.max(0, fadeOutMs) / 1_000;
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      if (fadeOutMs > 0) gain.gain.linearRampToValueAtTime(0, stopAt);
      else gain.gain.setValueAtTime(0, now);
      if ('stop' in source) (source as AudioBufferSourceNode).stop(stopAt);
      if (element) {
        const ms = Math.max(0, fadeOutMs);
        setTimeout(() => {
          element.pause();
          element.src = '';
        }, ms);
      }
    } catch {
      // already ended
    }
  }

  update(request: AudioPlayRequest): void {
    if (this.value.stopped) return;
    const shaping = request.asset.shaping;
    const now = this.value.context.currentTime;
    if ('playbackRate' in this.value.source) {
      (this.value.source as AudioBufferSourceNode).playbackRate.setTargetAtTime(
        shaping ? 2 ** (shaping.pitchSemitones / 12) : 1,
        now,
        0.03,
      );
    }
    const targetVolume = Math.max(0, request.volume) * (shaping ? 10 ** (shaping.gainDb / 20) : 1);
    this.value.gain.gain.setTargetAtTime(targetVolume, now, 0.03);
    if (shaping && this.value.filters) {
      this.value.filters.highpass.frequency.setTargetAtTime(shaping.highpassHz, now, 0.03);
      this.value.filters.lowShelf.gain.setTargetAtTime(shaping.eqLowDb, now, 0.03);
      this.value.filters.midPeak.gain.setTargetAtTime(shaping.eqMidDb, now, 0.03);
      this.value.filters.highShelf.gain.setTargetAtTime(shaping.eqHighDb, now, 0.03);
      this.value.filters.lowpass.frequency.setTargetAtTime(shaping.lowpassHz, now, 0.03);
    }
    const emitter = request.context.emitter;
    if (emitter && this.value.panner) {
      this.value.panner.positionX.setTargetAtTime(emitter.x, now, 0.03);
      this.value.panner.positionY.setTargetAtTime(emitter.y, now, 0.03);
      this.value.panner.positionZ.setTargetAtTime(emitter.z, now, 0.03);
    }
  }
}

export function createBrowserAudioPort(options?: {
  cacheMaxBytes?: number;
  streamThresholdMs?: number;
}): AudioPort {
  let context: AudioContext | undefined;
  let master: GainNode | undefined;
  const buses = new Map<string, GainNode>();
  const busVolumes = new Map<string, number>([
    ['sfx', 1], ['music', 1], ['voice', 1],
    ['bus:sfx', 1], ['bus:music', 1], ['bus:voice', 1],
  ]);
  const sources = new Set<BrowserSource>();
  let ready = false;

  const ensureContext = (): AudioContext | undefined => {
    if (context) return context;
    const scope = globalThis as typeof globalThis & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Constructor) return undefined;
    try {
      context = new Constructor();
      master = context.createGain();
      master.connect(context.destination);
      return context;
    } catch {
      return undefined;
    }
  };

  const cache = createDecodeCache({
    maxBytes: options?.cacheMaxBytes ?? 48 * 1024 * 1024,
    decode: async (url) => {
      const ctx = ensureContext();
      if (!ctx) throw new Error('AudioContext unavailable');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`audio HTTP ${response.status}`);
      const raw = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(raw.slice(0));
      return { buffer, byteLength: buffer.numberOfChannels * buffer.length * 4 };
    },
  });

  const busNode = (bus: string): GainNode | undefined => {
    const ctx = ensureContext();
    if (!ctx || !master) return undefined;
    const key = bus.startsWith('bus:') ? bus.slice(4) : bus;
    const current = buses.get(key) ?? buses.get(bus);
    if (current) return current;
    const gain = ctx.createGain();
    const volume = busVolumes.get(key) ?? busVolumes.get(bus) ?? 1;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.connect(master);
    buses.set(key, gain);
    return gain;
  };

  const syncSpatial = (
    ctx: AudioContext,
    request: AudioPlayRequest,
    panner: PannerNode,
  ): void => {
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.refDistance = 1;
    panner.maxDistance = 10_000;
    panner.rolloffFactor = 0;
    const emitter = request.context.emitter ?? { x: 0, y: 0, z: 0 };
    panner.positionX.value = emitter.x;
    panner.positionY.value = emitter.y;
    panner.positionZ.value = emitter.z;
    const listener = request.context.listener;
    if (listener) {
      const l = ctx.listener;
      l.positionX?.setValueAtTime(listener.position.x, ctx.currentTime);
      l.positionY?.setValueAtTime(listener.position.y, ctx.currentTime);
      l.positionZ?.setValueAtTime(listener.position.z, ctx.currentTime);
    }
  };

  return {
    async unlock() {
      const ctx = ensureContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') await ctx.resume();
      ready = ctx.state === 'running';
    },
    isReady() {
      return ready || context?.state === 'running';
    },
    currentTime() {
      return ensureContext()?.currentTime ?? 0;
    },
    async play(request) {
      const ctx = ensureContext();
      const bus = busNode(String(request.bus));
      if (!ctx || !bus) return undefined;
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* autoplay policy */ }
      }
      ready = ctx.state === 'running';

      const shaping = request.asset.shaping;
      const gain = ctx.createGain();
      const startAt = request.startAudioTime ?? ctx.currentTime;
      const fadeIn = Math.max(0, request.fadeInMs) / 1_000;
      const targetVolume = Math.max(0, request.volume) * (shaping ? 10 ** (shaping.gainDb / 20) : 1);
      gain.gain.setValueAtTime(fadeIn > 0 ? 0 : targetVolume, startAt);
      if (fadeIn > 0) gain.gain.linearRampToValueAtTime(targetVolume, startAt + fadeIn);

      const shapingNodes: AudioNode[] = [];
      let filters: BrowserSource['filters'];
      let input: AudioNode = gain;
      if (shaping) {
        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = shaping.highpassHz;
        const lowShelf = ctx.createBiquadFilter();
        lowShelf.type = 'lowshelf';
        lowShelf.frequency.value = 250;
        lowShelf.gain.value = shaping.eqLowDb;
        const midPeak = ctx.createBiquadFilter();
        midPeak.type = 'peaking';
        midPeak.frequency.value = 1_000;
        midPeak.Q.value = 1;
        midPeak.gain.value = shaping.eqMidDb;
        const highShelf = ctx.createBiquadFilter();
        highShelf.type = 'highshelf';
        highShelf.frequency.value = 4_000;
        highShelf.gain.value = shaping.eqHighDb;
        const lowpass = ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = shaping.lowpassHz;
        highpass.connect(lowShelf);
        lowShelf.connect(midPeak);
        midPeak.connect(highShelf);
        highShelf.connect(lowpass);
        lowpass.connect(gain);
        shapingNodes.push(highpass, lowShelf, midPeak, highShelf, lowpass);
        filters = { highpass, lowShelf, midPeak, highShelf, lowpass };
        input = highpass;
      }

      let panner: PannerNode | undefined;
      const connectOut = (node: AudioNode): void => {
        if (request.spatial === '3d') {
          panner = ctx.createPanner();
          syncSpatial(ctx, request, panner);
          node.connect(panner);
          panner.connect(bus);
        } else {
          node.connect(bus);
        }
      };

      try {
        if (shouldStreamAsset(request.asset.durationMs, options?.streamThresholdMs)) {
          const element = new Audio(request.asset.url);
          element.loop = request.loop;
          element.crossOrigin = 'anonymous';
          const source = ctx.createMediaElementSource(element);
          source.connect(input);
          connectOut(gain);
          const active: BrowserSource = {
            source, element, gain, panner, filters, context: ctx, stopped: false, nodes: shapingNodes,
          };
          sources.add(active);
          element.onended = () => {
            if (request.loop) return;
            active.stopped = true;
            sources.delete(active);
          };
          const delayMs = Math.max(0, (startAt - ctx.currentTime) * 1_000);
          setTimeout(() => { void element.play().catch(() => undefined); }, delayMs);
          return new BrowserAudioHandle(active);
        }

        const buffer = await cache.get(request.asset.url);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = request.loop;
        source.playbackRate.value = shaping ? 2 ** (shaping.pitchSemitones / 12) : 1;
        source.connect(input);
        connectOut(gain);
        const active: BrowserSource = {
          source, gain, panner, filters, context: ctx, stopped: false, nodes: shapingNodes,
        };
        sources.add(active);
        source.onended = () => {
          active.stopped = true;
          source.disconnect();
          gain.disconnect();
          for (const node of shapingNodes) node.disconnect();
          panner?.disconnect();
          sources.delete(active);
        };
        source.start(Math.max(startAt, ctx.currentTime));
        return new BrowserAudioHandle(active);
      } catch {
        return undefined;
      }
    },
    setBusVolume(bus, volume) {
      const safe = Math.max(0, Math.min(4, volume));
      const key = String(bus).startsWith('bus:') ? String(bus).slice(4) : String(bus);
      busVolumes.set(key, safe);
      busVolumes.set(String(bus), safe);
      const node = buses.get(key) ?? buses.get(String(bus));
      const ctx = context;
      if (node && ctx) node.gain.setTargetAtTime(safe, ctx.currentTime, 0.02);
      else if (node) node.gain.value = safe;
    },
    dispose() {
      for (const source of sources) new BrowserAudioHandle(source).stop(0);
      sources.clear();
      cache.clear();
      if (context) void context.close().catch(() => undefined);
      context = undefined;
      master = undefined;
      buses.clear();
      ready = false;
    },
  };
}

/** @deprecated alias kept for older call sites */
export class BrowserAudioPort implements AudioPort {
  private readonly port = createBrowserAudioPort();
  play(request: AudioPlayRequest) { return this.port.play(request); }
  setBusVolume(bus: RuntimeAudioBus | string, volume: number) { this.port.setBusVolume(bus, volume); }
  unlock() { return this.port.unlock?.() ?? Promise.resolve(); }
  isReady() { return this.port.isReady?.() ?? false; }
  currentTime() { return this.port.currentTime?.() ?? 0; }
  dispose() { this.port.dispose(); }
}
