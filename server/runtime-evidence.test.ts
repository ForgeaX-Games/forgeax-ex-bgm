import { describe, expect, test } from 'bun:test';

import { evaluateRuntimeEvidence, parseRuntimeEvidence } from './runtime-evidence.ts';

function counts(overrides: Record<string, unknown> = {}) {
  return {
    total: 10,
    byOutcome: { played: 10 },
    byEvent: {
      'combat.hit': { total: 10, byOutcome: { played: 10 } },
    },
    ...overrides,
  };
}

describe('parseRuntimeEvidence', () => {
  test('reads cumulative counts off a profiler snapshot', () => {
    const parsed = parseRuntimeEvidence({
      type: 'forgeax-audio-profiler',
      projectId: 'demo',
      receipts: [],
      counts: counts(),
    });
    expect(parsed.projectId).toBe('demo');
    expect(parsed.truncated).toBe(false);
    expect(parsed.counts.byOutcome.played).toBe(10);
  });

  test('rebuilds counts from receipts when the dump predates cumulative tallies', () => {
    const receipts = Array.from({ length: 64 }, (_, index) => ({
      eventId: 'combat.hit',
      bindingId: 'combat.hit',
      gameObjectId: '__global__',
      outcome: index < 4 ? 'played' : 'blocked_cooldown',
    }));
    const parsed = parseRuntimeEvidence({ receipts });
    expect(parsed.truncated).toBe(true);
    expect(parsed.counts.total).toBe(64);
    expect(parsed.counts.byOutcome.played).toBe(4);
  });
});

describe('evaluateRuntimeEvidence', () => {
  test('accepts a session where events actually played', () => {
    const result = evaluateRuntimeEvidence(parseRuntimeEvidence({ counts: counts() }));
    expect(result.errors).toEqual([]);
  });

  test('fails when nothing played', () => {
    const result = evaluateRuntimeEvidence(parseRuntimeEvidence({
      counts: counts({
        byOutcome: { blocked_disabled: 10 },
        byEvent: { 'combat.hit': { total: 10, byOutcome: { blocked_disabled: 10 } } },
      }),
    }));
    expect(result.errors.map((item) => item.code)).toContain('runtime_silent');
    expect(result.errors.map((item) => item.code)).toContain('runtime_event_silent');
  });

  test('fails when AudioContext stayed locked', () => {
    const result = evaluateRuntimeEvidence(parseRuntimeEvidence({
      counts: counts({
        byOutcome: { context_locked: 8, played: 2 },
        byEvent: {
          'combat.hit': { total: 10, byOutcome: { context_locked: 8, played: 2 } },
        },
      }),
    }));
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'runtime_context_locked' }),
    ]);
  });

  test('fails when cooldown swallowed a burst', () => {
    const result = evaluateRuntimeEvidence(parseRuntimeEvidence({
      counts: counts({
        total: 8,
        byOutcome: { played: 1, blocked_cooldown: 7 },
        byEvent: {
          'combat.hit': { total: 8, byOutcome: { played: 1, blocked_cooldown: 7 } },
        },
      }),
    }));
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'runtime_cooldown_swallowed', eventId: 'combat.hit' }),
    ]);
  });
});
