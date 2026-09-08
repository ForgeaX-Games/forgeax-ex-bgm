import { afterEach, describe, expect, test } from 'bun:test';

import toolHandlers from './tool-handlers.ts';

const originalFetch = globalThis.fetch;
const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;

const seedEnv = {
  SEED_AUDIO_API_KEY: 'seed-secret',
  SEED_AUDIO_ENDPOINT: 'https://seed.test/create',
  SEED_AUDIO_MODEL: 'seed-audio-1.0',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('generate-audio-preview tool', () => {
  test('returns Seed bytes for audition without touching any game', async () => {
    let sentBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://seed.test/create');
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ code: 0, audio: 'UklGRg==' }, { headers: { 'x-tt-logid': 'seed-trace' } });
    }) as typeof fetch;

    const result = await handlers['generate-audio-preview']!(
      { kind: 'sfx', prompt: 'heavy metal hit', durationSeconds: 2, loop: false },
      { caller: { kind: 'user' }, toolId: 'generate-audio-preview', env: seedEnv },
    );

    expect(result).toMatchObject({
      kind: 'sfx',
      base64: 'UklGRg==',
      mimeType: 'audio/mpeg',
      provider: 'seed-audio',
      model: 'seed-audio-1.0',
      traceId: 'seed-trace',
    });
    expect(sentBody.text_prompt).toContain('heavy metal hit');
  });

  test('rejects an unknown kind before spending quota', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ code: 0, audio: 'UklGRg==' });
    }) as typeof fetch;

    await expect(
      handlers['generate-audio-preview']!(
        { kind: 'ambience', prompt: 'rain' },
        { caller: { kind: 'user' }, toolId: 'generate-audio-preview', env: seedEnv },
      ),
    ).rejects.toThrow(/kind must be/);
    expect(called).toBe(false);
  });

  test('surfaces the missing-key state instead of calling Seed', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ code: 0, audio: 'UklGRg==' });
    }) as typeof fetch;

    await expect(
      handlers['generate-audio-preview']!(
        { kind: 'bgm', prompt: 'calm loop' },
        { caller: { kind: 'user' }, toolId: 'generate-audio-preview', env: {} },
      ),
    ).rejects.toThrow(/SEED_AUDIO_API_KEY/);
    expect(called).toBe(false);
  });
});

describe('get-audio-provider-status tool', () => {
  test('reports configured Seed without leaking the key', async () => {
    const result = await handlers['get-audio-provider-status']!(
      {},
      { caller: { kind: 'user' }, toolId: 'get-audio-provider-status', env: seedEnv },
    );

    expect(result).toEqual({ seed: { configured: true, model: 'seed-audio-1.0' } });
    expect(JSON.stringify(result)).not.toContain('seed-secret');
  });

  test('reports unconfigured Seed when no key is present', async () => {
    const result = await handlers['get-audio-provider-status']!(
      {},
      { caller: { kind: 'user' }, toolId: 'get-audio-provider-status', env: {} },
    );

    expect(result.seed.configured).toBe(false);
  });
});
