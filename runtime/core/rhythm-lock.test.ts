import { describe, expect, test } from 'bun:test';

import { createRhythmLock } from './rhythm-lock.ts';

/** Trigger times as a game at this frame rate would deliver them. */
function frameQuantised(intervalMs: number, count: number, fps = 60): number[] {
  const frame = 1 / fps;
  return Array.from(
    { length: count },
    (_, index) => Math.ceil((index * intervalMs / 1_000) / frame) * frame,
  );
}

function gapsMs(times: number[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < times.length; index += 1) {
    gaps.push((times[index]! - times[index - 1]!) * 1_000);
  }
  return gaps;
}

function worstDeviationMs(times: number[], intervalMs: number): number {
  return Math.max(...gapsMs(times).map((gap) => Math.abs(gap - intervalMs)));
}

function runLock(arrivals: number[], config = { mode: 'auto' } as const): number[] {
  const lock = createRhythmLock();
  return arrivals.map((now) => lock.schedule('gun', now, config));
}

describe('rhythm lock', () => {
  test('evens out a frame-quantised burst it was never told about', () => {
    const arrivals = frameQuantised(85.7, 30);
    const starts = runLock(arrivals);

    // 83/100/83 ms out of the game, plainly ragged.
    expect(worstDeviationMs(arrivals, 85.7)).toBeGreaterThan(12);
    // Steady state, once the run has shown its rate: well under the ~10 ms the
    // ear picks up as a stumble.
    expect(worstDeviationMs(starts.slice(10), 85.7)).toBeLessThan(5);
  });

  test('never plays a hit early, nor later than the jitter it is absorbing', () => {
    const arrivals = frameQuantised(85.7, 30);
    const starts = runLock(arrivals);
    for (const [index, start] of starts.entries()) {
      const waitMs = (start - arrivals[index]!) * 1_000;
      expect(waitMs).toBeGreaterThanOrEqual(0);
      expect(waitMs).toBeLessThanOrEqual(18);
    }
  });

  test('an authored interval is used in place of the measured rate', () => {
    const arrivals = frameQuantised(85.7, 30);
    const starts = runLock(arrivals, { mode: 'fixed', intervalMs: 85.7 });
    expect(worstDeviationMs(starts.slice(10), 85.7)).toBeLessThan(2);
  });

  test('leaves a run alone when fixing it would cost more delay than allowed', () => {
    // A 30 fps game jitters by a full 33 ms frame; evening that out would mean
    // holding every shot that long, which is worse than the stutter.
    const arrivals = frameQuantised(85.7, 30, 30);
    expect(runLock(arrivals)).toEqual(arrivals);
  });

  test('leaves human-paced triggers alone', () => {
    const arrivals = [0, 0.31, 0.52, 0.98, 1.12, 1.44, 1.6];
    expect(runLock(arrivals)).toEqual(arrivals);
  });

  test('mode off never delays', () => {
    const arrivals = frameQuantised(85.7, 12);
    expect(runLock(arrivals, { mode: 'off' })).toEqual(arrivals);
  });

  test('a pause ends the run, so the next burst is judged afresh', () => {
    const lock = createRhythmLock();
    // Too jittery to help: the lock gives up on this burst.
    for (const now of frameQuantised(85.7, 12, 30)) {
      lock.schedule('gun', now, { mode: 'auto' });
    }
    const later = frameQuantised(85.7, 30).map((now) => now + 10);
    const starts = later.map((now) => lock.schedule('gun', now, { mode: 'auto' }));
    expect(worstDeviationMs(starts.slice(10), 85.7)).toBeLessThan(5);
  });

  test('forget drops the run so the next hit starts clean', () => {
    const lock = createRhythmLock();
    const arrivals = frameQuantised(85.7, 12);
    for (const now of arrivals) lock.schedule('gun', now, { mode: 'auto' });
    lock.forget('gun');
    const next = arrivals[arrivals.length - 1]! + 0.0857;
    expect(lock.schedule('gun', next, { mode: 'auto' })).toBe(next);
  });

  test('separate keys keep separate beats', () => {
    const lock = createRhythmLock();
    const arrivals = frameQuantised(85.7, 12);
    for (const now of arrivals) lock.schedule('gun', now, { mode: 'auto' });
    // The rifle has only just started firing and must not inherit the pistol's beat.
    expect(lock.schedule('rifle', arrivals[11]!, { mode: 'auto' })).toBe(arrivals[11]!);
  });
});
