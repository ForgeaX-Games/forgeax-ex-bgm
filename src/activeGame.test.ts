import { describe, expect, test } from 'bun:test';
import { fetchActiveGameSlug } from './activeGame.ts';

describe('active project authority', () => {
  test('reads the current project from the Projects API', async () => {
    const paths: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return new Response(JSON.stringify({ activeSlug: 'sound-stage' }), { status: 200 });
    }) as typeof fetch;

    await expect(fetchActiveGameSlug(fetcher)).resolves.toBe('sound-stage');
    expect(paths).toEqual(['/api/projects/active']);
  });
});
