import { afterEach, describe, expect, test } from 'bun:test';

import { generateSeedAudio, seedConfigFromEnv } from './seed-audio.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('forgeax-bgm Seed Audio client', () => {
  test('uses only the explicitly supplied environment and returns decoded audio', async () => {
    const config = seedConfigFromEnv({
      SEED_AUDIO_API_KEY: 'seed-secret',
      SEED_AUDIO_ENDPOINT: 'https://seed.test/create',
      SEED_AUDIO_MODEL: 'seed-audio-1.0',
    });
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('https://seed.test/create');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Api-Key')).toBe('seed-secret');
      const body = JSON.parse(String(init?.body));
      expect(body.text_prompt).toContain('boss battle');
      expect(body.text_prompt).toContain('纯音乐');
      expect(body.text_prompt).toContain('无缝循环');
      return Response.json({ code: 0, audio: 'AQIDBA==' }, {
        headers: { 'x-tt-logid': 'seed-trace-1' },
      });
    }) as typeof fetch;

    const result = await generateSeedAudio(config, {
      kind: 'bgm',
      prompt: 'boss battle',
      instrumental: true,
      loop: true,
    });

    expect(result.bytes).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.traceId).toBe('seed-trace-1');
  });

  test('requires a scoped API key before making a request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({ code: 0, audio: 'AQI=' });
    }) as typeof fetch;

    await expect(generateSeedAudio(seedConfigFromEnv({}), {
      kind: 'sfx',
      prompt: 'impact',
    })).rejects.toMatchObject({ code: 'seed-not-configured' });
    expect(called).toBe(false);
  });

  test('maps voice speed and surfaces upstream failures without credentials', async () => {
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.audio_config.speech_rate).toBe(-20);
      expect(body.text_prompt).toContain('单人角色对白');
      return Response.json({ code: 400, message: 'prompt rejected' }, { status: 400 });
    }) as typeof fetch;

    await expect(generateSeedAudio({
      headerValue: 'not-in-error', endpoint: 'https://seed.test/create', model: 'seed-audio-1.0',
    }, {
      kind: 'voice', prompt: '收到。', speed: 0.8,
    })).rejects.toMatchObject({ code: 'seed-generation-failed', message: 'prompt rejected' });
  });
});
