import type { GameObjectId, PlaybackId } from '../types.ts';

export type VoiceState = 'physical' | 'virtual' | 'stopped';

export interface Voice {
  playbackId: PlaybackId;
  objectId: string;
  eventId: string;
  gameObjectId: GameObjectId;
  busId: string;
  startAudioTime: number;
  priority: number;
  computedVolumeDb: number;
  state: VoiceState;
}

export interface VoiceLimits {
  maxPhysical: number;
  maxInstances: number;
  instanceScope: 'global' | 'gameObject';
  onExceed: 'reject' | 'stealOldest' | 'stealQuietest';
  busVoiceLimit?: number;
}

export interface VoiceManager {
  nextPlaybackId(): PlaybackId;
  tryAdmit(
    candidate: Omit<Voice, 'playbackId' | 'state'>,
    limits: VoiceLimits,
  ): { ok: true; voice: Voice; stolen?: Voice } | { ok: false; reason: 'rejected_voice_limit' };
  attachHandle(playbackId: PlaybackId, stop: (fadeOutMs: number) => void): void;
  stop(playbackId: PlaybackId, fadeOutMs: number): void;
  stopBy(filter: { eventId?: string; gameObjectId?: GameObjectId; objectId?: string }, fadeOutMs: number): void;
  active(): readonly Voice[];
  physicalCount(): number;
  tick(_audioTime: number): void;
  dispose(): void;
}

export function createVoiceManager(): VoiceManager {
  let seq = 0;
  const voices = new Map<PlaybackId, Voice>();
  const stops = new Map<PlaybackId, (fadeOutMs: number) => void>();

  const physical = (): Voice[] => [...voices.values()].filter((voice) => voice.state === 'physical');

  const matchesInstance = (voice: Voice, candidate: Omit<Voice, 'playbackId' | 'state'>, scope: VoiceLimits['instanceScope']): boolean => {
    if (voice.objectId !== candidate.objectId || voice.state === 'stopped') return false;
    if (scope === 'gameObject') return voice.gameObjectId === candidate.gameObjectId;
    return true;
  };

  return {
    nextPlaybackId() {
      return ++seq;
    },
    tryAdmit(candidate, limits) {
      const playbackId = ++seq;
      const instancePeers = physical().filter((voice) => matchesInstance(voice, candidate, limits.instanceScope));
      if (instancePeers.length >= limits.maxInstances) {
        if (limits.onExceed === 'reject') return { ok: false, reason: 'rejected_voice_limit' };
        const victim = limits.onExceed === 'stealQuietest'
          ? instancePeers.reduce((a, b) => (a.computedVolumeDb <= b.computedVolumeDb ? a : b))
          : instancePeers.reduce((a, b) => (a.startAudioTime <= b.startAudioTime ? a : b));
        if (victim.priority > candidate.priority) return { ok: false, reason: 'rejected_voice_limit' };
        this.stop(victim.playbackId, 20);
      }

      const live = physical();
      if (limits.busVoiceLimit !== undefined) {
        const onBus = live.filter((voice) => voice.busId === candidate.busId);
        if (onBus.length >= limits.busVoiceLimit) {
          const victim = onBus.reduce((a, b) => (a.priority === b.priority
            ? (a.startAudioTime <= b.startAudioTime ? a : b)
            : (a.priority < b.priority ? a : b)));
          if (victim.priority > candidate.priority) return { ok: false, reason: 'rejected_voice_limit' };
          this.stop(victim.playbackId, 20);
        }
      }

      const afterBus = physical();
      if (afterBus.length >= limits.maxPhysical) {
        // A higher (or equal) priority voice is never stolen by a lower one.
        const victims = afterBus
          .filter((voice) => voice.priority < candidate.priority)
          .sort((a, b) => (a.priority - b.priority) || (a.startAudioTime - b.startAudioTime));
        const victim = victims[0];
        if (!victim) {
          return { ok: false, reason: 'rejected_voice_limit' };
        }
        this.stop(victim.playbackId, 20);
      }

      const voice: Voice = { ...candidate, playbackId, state: 'physical' };
      voices.set(playbackId, voice);
      return { ok: true, voice };
    },
    attachHandle(playbackId, stop) {
      stops.set(playbackId, stop);
    },
    stop(playbackId, fadeOutMs) {
      const voice = voices.get(playbackId);
      if (!voice || voice.state === 'stopped') return;
      voice.state = 'stopped';
      stops.get(playbackId)?.(fadeOutMs);
      stops.delete(playbackId);
      voices.delete(playbackId);
    },
    stopBy(filter, fadeOutMs) {
      for (const voice of [...voices.values()]) {
        if (filter.eventId && voice.eventId !== filter.eventId) continue;
        if (filter.gameObjectId && voice.gameObjectId !== filter.gameObjectId) continue;
        if (filter.objectId && voice.objectId !== filter.objectId) continue;
        this.stop(voice.playbackId, fadeOutMs);
      }
    },
    active() {
      return [...voices.values()];
    },
    physicalCount() {
      return physical().length;
    },
    tick() {
      // Virtualisation decisions land with attenuation; reserved for control frames.
    },
    dispose() {
      for (const id of [...voices.keys()]) this.stop(id, 0);
      voices.clear();
      stops.clear();
    },
  };
}
