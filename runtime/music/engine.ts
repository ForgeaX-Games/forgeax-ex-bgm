import type {
  RuntimeMusicProject,
  RuntimeMusicSegment,
  RuntimeMusicSyncPoint,
} from '../types.ts';

export interface MusicEngineOptions {
  music?: RuntimeMusicProject;
  scheduleAt: (audioTime: number, run: (startAudioTime: number) => void) => string;
  nowAudio: () => number;
  onPlaySegment?: (segment: RuntimeMusicSegment, startAudioTime: number) => void;
}

export interface MusicEngine {
  playPlaylist(playlistId: string): void;
  transitionTo(playlistId: string, exitAt?: RuntimeMusicSyncPoint): void;
  stop(): void;
  currentPlaylistId(): string | undefined;
  currentSegmentId(): string | undefined;
  dispose(): void;
}

/** Seconds per beat given tempo in BPM. */
export function beatDurationSeconds(tempo: number): number {
  return 60 / Math.max(1e-6, tempo);
}

/** Seconds per bar given tempo and time signature numerator (beats per bar). */
export function barDurationSeconds(tempo: number, beatsPerBar: number): number {
  return beatDurationSeconds(tempo) * Math.max(1, beatsPerBar);
}

/**
 * Quantise `audioTime` to the next beat boundary relative to `segmentStartAudioTime`.
 * If already exactly on a beat, returns the following beat (strictly next).
 */
export function nextBeatAudioTime(
  segmentStartAudioTime: number,
  audioTime: number,
  tempo: number,
): number {
  const beat = beatDurationSeconds(tempo);
  const elapsed = Math.max(0, audioTime - segmentStartAudioTime);
  const nextIndex = Math.floor(elapsed / beat) + 1;
  return segmentStartAudioTime + nextIndex * beat;
}

/**
 * Quantise `audioTime` to the next bar boundary relative to `segmentStartAudioTime`.
 */
export function nextBarAudioTime(
  segmentStartAudioTime: number,
  audioTime: number,
  tempo: number,
  timeSignature: [number, number],
): number {
  const bar = barDurationSeconds(tempo, timeSignature[0]);
  const elapsed = Math.max(0, audioTime - segmentStartAudioTime);
  const nextIndex = Math.floor(elapsed / bar) + 1;
  return segmentStartAudioTime + nextIndex * bar;
}

export function quantizeExitTime(
  sync: RuntimeMusicSyncPoint,
  segmentStartAudioTime: number,
  audioTime: number,
  segment: Pick<RuntimeMusicSegment, 'tempo' | 'timeSignature'>,
): number {
  if (sync === 'immediate') return audioTime;
  if (sync === 'nextBeat') {
    return nextBeatAudioTime(segmentStartAudioTime, audioTime, segment.tempo);
  }
  return nextBarAudioTime(
    segmentStartAudioTime,
    audioTime,
    segment.tempo,
    segment.timeSignature,
  );
}

/**
 * Minimal interactive music engine. Tree-shake friendly: games without music
 * never import this module. Stub-safe when `music` is absent.
 */
export function createMusicEngine(options: MusicEngineOptions): MusicEngine {
  const music = options.music;
  if (!music) {
    return {
      playPlaylist() {},
      transitionTo() {},
      stop() {},
      currentPlaylistId: () => undefined,
      currentSegmentId: () => undefined,
      dispose() {},
    };
  }

  const segments = new Map(music.segments.map((item) => [item.id, item]));
  const playlists = new Map(music.playlists.map((item) => [item.id, item]));
  let currentPlaylistId: string | undefined;
  let currentSegmentId: string | undefined;
  let segmentStartAudioTime = 0;
  let playlistCursor = 0;
  let pendingTransition: string | undefined;

  const startSegment = (segmentId: string, at: number): void => {
    const segment = segments.get(segmentId);
    if (!segment) return;
    currentSegmentId = segmentId;
    segmentStartAudioTime = at;
    options.scheduleAt(at, (startAudioTime) => {
      options.onPlaySegment?.(segment, startAudioTime);
    });
  };

  const advancePlaylist = (at: number): void => {
    if (!currentPlaylistId) return;
    const playlist = playlists.get(currentPlaylistId);
    if (!playlist || playlist.segmentIds.length === 0) return;
    const segmentId = playlist.segmentIds[playlistCursor % playlist.segmentIds.length]!;
    playlistCursor += 1;
    startSegment(segmentId, at);
  };

  return {
    playPlaylist(playlistId) {
      const playlist = playlists.get(playlistId);
      if (!playlist) return;
      currentPlaylistId = playlistId;
      playlistCursor = 0;
      pendingTransition = undefined;
      advancePlaylist(options.nowAudio());
    },
    transitionTo(playlistId, exitAt = 'nextBar') {
      if (!playlists.has(playlistId)) return;
      const segment = currentSegmentId ? segments.get(currentSegmentId) : undefined;
      if (!segment || !currentPlaylistId) {
        currentPlaylistId = playlistId;
        playlistCursor = 0;
        advancePlaylist(options.nowAudio());
        return;
      }
      const rule = music.transitions.find((item) => (
        (item.fromPlaylistId === '*' || item.fromPlaylistId === currentPlaylistId)
        && (item.toPlaylistId === '*' || item.toPlaylistId === playlistId)
      ));
      const sync = exitAt ?? rule?.exitAt ?? 'nextBar';
      const exitTime = quantizeExitTime(sync, segmentStartAudioTime, options.nowAudio(), segment);
      pendingTransition = playlistId;
      options.scheduleAt(exitTime, (startAudioTime) => {
        if (pendingTransition !== playlistId) return;
        currentPlaylistId = playlistId;
        playlistCursor = 0;
        pendingTransition = undefined;
        advancePlaylist(startAudioTime);
      });
    },
    stop() {
      pendingTransition = undefined;
      currentPlaylistId = undefined;
      currentSegmentId = undefined;
    },
    currentPlaylistId: () => currentPlaylistId,
    currentSegmentId: () => currentSegmentId,
    dispose() {
      this.stop();
    },
  };
}
