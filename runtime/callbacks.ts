import type {
  AudioCallbackPhase,
  AudioEventCallback,
  GameObjectId,
  PlaybackId,
} from './types.ts';

export interface CallbackBus {
  on(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
  off(eventId: string, phase: AudioCallbackPhase, callback: AudioEventCallback): void;
  fire(
    eventId: string,
    phase: AudioCallbackPhase,
    detail?: { playbackId?: PlaybackId; gameObjectId?: GameObjectId },
  ): void;
  dispose(): void;
}

function keyOf(eventId: string, phase: AudioCallbackPhase): string {
  return `${eventId}::${phase}`;
}

export function createCallbackBus(): CallbackBus {
  const listeners = new Map<string, Set<AudioEventCallback>>();

  return {
    on(eventId, phase, callback) {
      const key = keyOf(eventId, phase);
      const set = listeners.get(key) ?? new Set();
      set.add(callback);
      listeners.set(key, set);
    },
    off(eventId, phase, callback) {
      listeners.get(keyOf(eventId, phase))?.delete(callback);
    },
    fire(eventId, phase, detail = {}) {
      const set = listeners.get(keyOf(eventId, phase));
      if (!set || set.size === 0) return;
      for (const callback of [...set]) {
        try {
          callback({
            eventId,
            phase,
            playbackId: detail.playbackId,
            gameObjectId: detail.gameObjectId,
          });
        } catch {
          // Game callbacks must not break the audio engine.
        }
      }
    },
    dispose() {
      listeners.clear();
    },
  };
}
