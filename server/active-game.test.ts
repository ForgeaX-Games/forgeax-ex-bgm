import { describe, expect, test } from 'bun:test';

import {
  activeGameFromEnvelope,
  fetchActiveGameSlug,
  normalizeSlug,
} from '../src/activeGame.ts';

describe('active game follow', () => {
  test("treats the shell's placeholder slug as no project", () => {
    expect(normalizeSlug('default')).toBe('');
    expect(normalizeSlug('  ')).toBe('');
    expect(normalizeSlug(null)).toBe('');
    expect(normalizeSlug(' untitled-1 ')).toBe('untitled-1');
  });

  test('reads the authority when the frame has no slug on its URL', async () => {
    const fetcher = (async (input: any) => {
      expect(String(input)).toBe('/api/projects/active');
      return Response.json({ activeSlug: 'untitled-1', runtime: { status: 'ready' } });
    }) as typeof fetch;

    expect(await fetchActiveGameSlug(fetcher)).toBe('untitled-1');
  });

  test('reports no project rather than throwing when the authority is unreachable', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const notFound = (async () => new Response('nope', { status: 500 })) as typeof fetch;

    expect(await fetchActiveGameSlug(failing)).toBe('');
    expect(await fetchActiveGameSlug(notFound)).toBe('');
  });

  test('parses a switch out of the event envelope', () => {
    expect(activeGameFromEnvelope(JSON.stringify({ payload: { activeSlug: 'other-game' } }))).toBe('other-game');
    // A cleared project is a real transition to "no project".
    expect(activeGameFromEnvelope(JSON.stringify({ payload: { activeSlug: null } }))).toBe('');
  });

  test('ignores envelopes it cannot read instead of clearing the workspace', () => {
    expect(activeGameFromEnvelope('not json')).toBeNull();
    expect(activeGameFromEnvelope(JSON.stringify({ payload: {} }))).toBeNull();
    expect(activeGameFromEnvelope(JSON.stringify({ payload: { activeSlug: 7 } }))).toBeNull();
  });
});
