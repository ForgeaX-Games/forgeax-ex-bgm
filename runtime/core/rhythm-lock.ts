/**
 * Re-times repeated one-shots (gunfire, footsteps) onto an even grid.
 *
 * Games trigger these from their frame loop, so a burst the game logic spaces
 * perfectly evenly reaches the audio layer quantised to frame boundaries —
 * 83/100/117 ms instead of 100/100/100 at 60 fps. That is well above the ~10 ms
 * at which the ear hears a rhythm as ragged, which is why full-auto fire sounds
 * stuttery even when the weapon code is correct.
 *
 * Sound can be delayed but never advanced, so the grid has to sit at the latest
 * trigger of the run and every earlier one waits for it: evening out jitter of
 * width w costs exactly w of latency, no less. Half of w buys nothing at all —
 * every hit just ends up shifted by the same half and spaced as before. So the
 * lock measures w, spends that much and no more, and leaves alone any run whose
 * w exceeds `maxJitterMs` rather than pay unbounded latency for it.
 */

export type RhythmLockConfig =
  | { mode: 'off' }
  | { mode: 'auto' }
  | { mode: 'fixed'; intervalMs: number };

export interface RhythmLockOptions {
  /** Widest jitter worth absorbing; also the ceiling on the latency it adds. */
  maxJitterMs?: number;
  /** Gaps outside this band are paced by a human, not by a repeat timer. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

export interface RhythmLock {
  /** Audio-clock time to start at. Call once per emit that will actually play. */
  schedule(key: string, nowAudioTime: number, config: RhythmLockConfig): number;
  forget(key: string): void;
  /** Per-run state keyed the same way as the runtime's, for scope teardown. */
  state(): Map<string, unknown>;
  clear(): void;
}

/**
 * One frame at 60 fps plus a little slack: covers the frame quantisation of a
 * game holding its frame rate, and stops short of the ~20 ms where the delay
 * itself starts to be felt. Choppier games keep their raw timing.
 */
const DEFAULT_MAX_JITTER_MS = 18;
const DEFAULT_MIN_INTERVAL_MS = 40;
const DEFAULT_MAX_INTERVAL_MS = 600;
/** Gaps needed before the lock will act. Three is the shortest history that can expose the jitter. */
const GAP_WINDOW = 3;
/**
 * Gaps kept for reading the rate. Quantisation error is shared over the span,
 * so a short history reads a run of 85.7 ms triggers as 83.3 ms — a grid that
 * slow slides behind its own triggers and never gets to correct anything.
 */
const RATE_WINDOW = 4;
/** Hits of uninterrupted slack before the grid gives latency back. Long enough
 * that a run cycling through its frame offsets is not mistaken for a faster one. */
const DECAY_WINDOW = 16;
/** Slack below which trimming the grid is not worth the disturbance. */
const SLACK_EPSILON_MS = 0.5;
/** Rebuilds tolerated before a run is judged: fewer would misread a slow start. */
const MIN_RESTARTS_TO_JUDGE = 3;
/** A healthy run rebuilds at most once in this many hits. */
const RESTART_HIT_RATIO = 4;

interface Track {
  arrivals: number[];
  anchor?: number;
  /** Rate the grid runs at, frozen while locked so it cannot wobble per hit. */
  intervalSec?: number;
  /** How much each recent hit waited, used to trim latency down to the minimum. */
  waits: number[];
  /** Set once a run proves too jittery to fix; sticky, so the lock never flickers. */
  blocked: boolean;
  /** Times the beat had to be rebuilt. Each rebuild costs one uneven hit. */
  restarts: number;
  /** Hits in this run, to judge whether rebuilds are occasional or constant. */
  hits?: number;
}

/** How far gaps may stray from their mean and still count as one steady run. */
function inferenceSpreadMs(meanMs: number): number {
  return Math.min(Math.max(meanMs * 0.3, 12), 34);
}

/** How far a trigger may stray from its grid slot before the run counts as broken. */
function gridToleranceMs(intervalMs: number): number {
  return Math.min(Math.max(intervalMs * 0.35, 15), 40);
}

function gapsMs(arrivals: number[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < arrivals.length; index += 1) {
    gaps.push((arrivals[index]! - arrivals[index - 1]!) * 1_000);
  }
  return gaps;
}

/**
 * Rate over the whole window rather than a mean of gaps: quantisation error is
 * shared across the span, so the estimate lands within a fraction of a frame of
 * the interval the game actually intends.
 */
function spanIntervalMs(arrivals: number[]): number {
  const span = arrivals[arrivals.length - 1]! - arrivals[0]!;
  return (span * 1_000) / (arrivals.length - 1);
}

function isSteadyRun(gaps: number[], intervalMs: number, minMs: number, maxMs: number): boolean {
  if (intervalMs < minMs || intervalMs > maxMs) return false;
  const spread = inferenceSpreadMs(intervalMs);
  return gaps.every((gap) => Math.abs(gap - intervalMs) <= spread);
}

export function createRhythmLock(options: RhythmLockOptions = {}): RhythmLock {
  const maxJitterMs = options.maxJitterMs ?? DEFAULT_MAX_JITTER_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const tracks = new Map<string, Track>();

  return {
    schedule(key, nowAudioTime, config) {
      if (config.mode === 'off') {
        tracks.delete(key);
        return nowAudioTime;
      }

      const track = tracks.get(key) ?? { arrivals: [], waits: [], blocked: false, restarts: 0 };
      tracks.set(key, track);
      const last = track.arrivals[track.arrivals.length - 1];
      // A pause long enough to end the run also clears any verdict about it.
      if (last !== undefined && (nowAudioTime - last) * 1_000 > maxIntervalMs) {
        track.arrivals.length = 0;
        track.waits.length = 0;
        track.anchor = undefined;
        track.blocked = false;
        track.restarts = 0;
        track.hits = 0;
      }
      track.hits = (track.hits ?? 0) + 1;
      // Judgements read raw trigger times, never corrected ones, or the lock
      // would end up measuring its own output.
      track.arrivals.push(nowAudioTime);
      if (track.arrivals.length > RATE_WINDOW + 1) track.arrivals.shift();
      if (track.blocked) return nowAudioTime;

      const gaps = gapsMs(track.arrivals);
      // Even an authored interval waits for the full window. Both things the
      // grid needs — the rate, and how wide this game's jitter runs — can only
      // be read off the triggers, and a short history reads the rate several
      // milliseconds off, which is enough for the grid to slide off the run.
      if (gaps.length < RATE_WINDOW) {
        track.anchor = undefined;
        return nowAudioTime;
      }

      const measured = spanIntervalMs(track.arrivals);
      if (!isSteadyRun(gaps, measured, minIntervalMs, maxIntervalMs)) {
        track.anchor = undefined;
        track.waits.length = 0;
        return nowAudioTime;
      }
      const jitterMs = Math.max(...gaps) - Math.min(...gaps);
      if (jitterMs > maxJitterMs) {
        track.blocked = true;
        track.anchor = undefined;
        return nowAudioTime;
      }
      const intervalSec = (config.mode === 'fixed' && config.intervalMs > 0
        ? config.intervalMs
        : measured) / 1_000;
      const restart = (): number => {
        if (track.anchor !== undefined) track.restarts += 1;
        // Rebuilding now and then is how the grid tracks the run. Rebuilding
        // constantly means this run has no beat to find, and each attempt costs
        // an uneven hit, so stop trying for the rest of it.
        if (track.restarts >= MIN_RESTARTS_TO_JUDGE
          && track.restarts * RESTART_HIT_RATIO > (track.hits ?? 0)) {
          track.blocked = true;
          track.anchor = undefined;
          return nowAudioTime;
        }
        track.anchor = nowAudioTime;
        track.waits = [0];
        return nowAudioTime;
      };

      // The grid starts costing nothing and only gives ground when a trigger
      // proves it must: no slot may sit before its trigger, so each overrun
      // steps the whole grid up. Within a few hits it settles on the latest
      // frame of the run, which is the one offset that can serve them all, and
      // the latency stops there instead of at some guessed worst case.
      if (track.anchor === undefined) return restart();

      const ideal = track.anchor + intervalSec;
      if (ideal < nowAudioTime) return restart();
      // Either the rate changed under us or the grid has drifted far enough
      // ahead to break the latency promise. Rebuild the beat around this hit.
      const ceilingMs = Math.min(gridToleranceMs(intervalSec * 1_000), maxJitterMs);
      if ((ideal - nowAudioTime) * 1_000 > ceilingMs) return restart();

      track.anchor = ideal;
      track.waits.push(ideal - nowAudioTime);
      if (track.waits.length > DECAY_WINDOW) track.waits.shift();
      // A run this long where nothing ever arrived late has settled behind a
      // frame it no longer needs — usually the frame rate recovered. Give the
      // shared wait back; an overrun would simply step the grid up again.
      if (track.waits.length === DECAY_WINDOW) {
        const slack = Math.min(...track.waits);
        if (slack * 1_000 > SLACK_EPSILON_MS) {
          track.anchor -= slack;
          track.waits = track.waits.map((wait) => wait - slack);
        }
      }
      return ideal;
    },
    forget(key) {
      tracks.delete(key);
    },
    state() {
      return tracks as Map<string, unknown>;
    },
    clear() {
      tracks.clear();
    },
  };
}
