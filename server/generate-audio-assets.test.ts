import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import toolHandlers from './tool-handlers.ts';

const originalFetch = globalThis.fetch;
const roots: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('generate-audio-assets tool', () => {
  test('continues after item failure and saves successful Seed audio without returning base64', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-seed-assets-'));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, '.forgeax/games/demo/audio'), { recursive: true });
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.text_prompt.includes('reject this')) {
        return Response.json({ code: 400, message: 'unsafe prompt' }, { status: 400 });
      }
      return Response.json({ code: 0, audio: 'UklGRg==' }, {
        headers: { 'x-tt-logid': 'seed-sfx-trace' },
      });
    }) as typeof fetch;

    const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;
    const result = await handlers['generate-audio-assets']!({
      slug: 'demo',
      concurrency: 2,
      items: [
        { eventId: 'combat.hit', name: 'Heavy hit', kind: 'sfx', prompt: 'heavy metal hit', format: 'wav' },
        { eventId: 'combat.bad', name: 'Rejected', kind: 'sfx', prompt: 'reject this' },
      ],
    }, {
      caller: { kind: 'ai' },
      toolId: 'generate-audio-assets',
      projectRoot,
      game: 'demo',
      env: {
        FORGEAX_PROJECT_ROOT: projectRoot,
        SEED_AUDIO_API_KEY: 'seed-secret',
        SEED_AUDIO_ENDPOINT: 'https://seed.test/create',
        SEED_AUDIO_MODEL: 'seed-audio-1.0',
      },
    });

    expect(result).toMatchObject({
      ok: false,
      slug: 'demo',
      summary: { total: 2, generated: 1, failed: 1 },
      results: [
        {
          ok: true,
          eventId: 'combat.hit',
          kind: 'sfx',
          bytes: 4,
          traceId: 'seed-sfx-trace',
          model: 'seed-audio-1.0',
        },
        {
          ok: false,
          eventId: 'combat.bad',
          code: 'seed-generation-failed',
          error: 'unsafe prompt',
        },
      ],
    });
    expect(result.gameDir).toBe(join(projectRoot, '.forgeax/games/demo'));
    expect(result.nextStep).toContain('patch-audio-project');
    expect(result.nextStep).toContain('do not stat, hash, glob or read');
    expect(result.nextStep).toContain('combat.bad');
    expect(JSON.stringify(result)).not.toContain('UklGRg');
    expect(result.results[0].assetId).toMatch(/^seed-sfx-[a-f0-9]{20}$/);
    expect(result.results[0].file).toStartWith('assets/audio/');
    expect(await readFile(join(projectRoot, '.forgeax/games/demo', result.results[0].file), 'utf8')).toBe('RIFF');

    const manifest = JSON.parse(await readFile(
      join(projectRoot, '.forgeax/games/demo/audio/manifest.json'),
      'utf8',
    ));
    expect(manifest.tracks).toEqual([
      expect.objectContaining({
        assetId: result.results[0].assetId,
        file: result.results[0].file,
        kind: 'sfx',
        source: 'generated:seed-audio',
        addedBy: 'ai',
      }),
    ]);
  });
});
