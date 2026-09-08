import { afterEach, describe, expect, test } from 'bun:test';

import {
  fetchAudioGenerationStatus,
  generateCreativeVersions,
  saveCreativeVersionToGame,
} from '../src/creativeAudioApi.ts';
import type { CreativeRequest, CreativeVersion } from '../src/creativeAudioStudio.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function voiceRequest(): CreativeRequest {
  return {
    mode: 'voice',
    kind: 'voice',
    sourceMode: 'new',
    prompt: '守卫警告',
    direction: '坚定、克制',
    durationSeconds: 0,
    loop: false,
    instrumental: false,
    variationCount: 1,
    projectId: 'demo',
    voice: {
      script: '前方禁止通行。',
      roleId: 'guard',
      role: '守卫',
      emotion: '严肃',
      language: 'zh',
      speed: 'slow',
    },
  };
}

describe('creative audio host API client', () => {
  test('reads capability status without receiving credentials', async () => {
    let sentBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('/api/tools/call');
      sentBody = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        result: { seed: { configured: true, model: 'seed-audio-1.0' } },
      });
    }) as typeof fetch;

    const result = await fetchAudioGenerationStatus();
    expect(sentBody.toolId).toBe('get-audio-provider-status');
    expect(result.tts.providers).toEqual(['seed-audio (seed-audio-1.0)']);
    // One credential serves all three kinds.
    expect(result.music.configured).toBe(true);
    expect(result.sfx.configured).toBe(true);
  });

  test('reports every kind as unconfigured when Seed has no key', async () => {
    globalThis.fetch = (async () =>
      Response.json({ ok: true, result: { seed: { configured: false, model: 'seed-audio-1.0' } } })) as typeof fetch;

    const result = await fetchAudioGenerationStatus();
    expect(result.tts.configured).toBe(false);
    expect(result.sfx.providers).toEqual([]);
  });

  test('generates a playable voice version through the Seed preview tool', async () => {
    let sentBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      if (String(input) === '/__ce-api__/chat') {
        return Response.json({
          success: true,
          text: JSON.stringify({ prompt: 'Game guard; serious restrained delivery; slow pace; close dry game VO.' }),
        });
      }
      expect(String(input)).toBe('/api/tools/call');
      sentBody = JSON.parse(String(init?.body));
      return Response.json({
        ok: true,
        result: {
          base64: 'AQIDBA==',
          mimeType: 'audio/mpeg',
          provider: 'seed-audio',
          model: 'seed-audio-1.0',
        },
      });
    }) as typeof fetch;

    const versions = await generateCreativeVersions(voiceRequest(), 'voice-request');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.dataUrl).toBe('data:audio/mpeg;base64,AQIDBA==');
    expect(versions[0]?.provider).toBe('seed-audio');
    expect(sentBody.toolId).toBe('generate-audio-preview');
    expect(sentBody.args.kind).toBe('voice');
    // Seed has a single prompt field, so the line has to ride along with the direction.
    expect(sentBody.args.prompt).toContain('前方禁止通行。');
    expect(sentBody.args.prompt).toContain('Game guard');
    expect(sentBody.args.speed).toBe(0.82);
  });

  test('maps bgm shape onto the Seed preview arguments', async () => {
    let sentBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      if (String(input) === '/__ce-api__/chat') {
        return Response.json({ success: true, text: JSON.stringify({ prompt: 'Calm exploration loop.' }) });
      }
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true, result: { base64: 'BQYH', mimeType: 'audio/mpeg' } });
    }) as typeof fetch;

    await generateCreativeVersions(
      {
        ...voiceRequest(),
        mode: 'generate',
        kind: 'bgm',
        prompt: '探索关卡',
        durationSeconds: 30,
        loop: true,
        instrumental: true,
        voice: undefined,
      },
      'bgm-request',
    );
    expect(sentBody.args).toMatchObject({
      kind: 'bgm',
      instrumental: true,
      durationSeconds: 30,
      loop: true,
    });
  });

  test('keeps successful alternatives when one generation request fails', async () => {
    let calls = 0;
    const progress: string[] = [];
    globalThis.fetch = (async (input) => {
      if (String(input) === '/__ce-api__/chat') {
        return Response.json({
          success: true,
          text: JSON.stringify({ prompt: 'Heavy metal sword impact on armor; short, forceful and dry; avoid music and long reverb.' }),
        });
      }
      calls += 1;
      if (calls === 1) return Response.json({ ok: false, error: 'busy' });
      return Response.json({
        ok: true,
        result: { base64: 'BQYH', mimeType: 'audio/mpeg', provider: 'seed-audio' },
      });
    }) as typeof fetch;
    const request: CreativeRequest = {
      ...voiceRequest(),
      mode: 'generate',
      kind: 'sfx',
      prompt: '金属剑命中盔甲',
      direction: '短促',
      durationSeconds: 2,
      variationCount: 2,
      voice: undefined,
    };

    const versions = await generateCreativeVersions(request, 'sfx-request', (done, total) => {
      progress.push(`${done}/${total}`);
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.label).toBe('B');
    expect(progress).toEqual(['1/2', '2/2']);
  });

  test('clamps a typed BGM duration onto the Seed preview arguments', async () => {
    let sentBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      if (String(input) === '/__ce-api__/chat') {
        return Response.json({ success: true, text: JSON.stringify({ prompt: 'Calm exploration loop.' }) });
      }
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true, result: { base64: 'BQYH', mimeType: 'audio/mpeg' } });
    }) as typeof fetch;

    await generateCreativeVersions(
      {
        ...voiceRequest(),
        mode: 'generate',
        kind: 'bgm',
        prompt: '探索关卡',
        durationSeconds: 200,
        loop: true,
        instrumental: true,
        voice: undefined,
      },
      'bgm-long',
    );
    expect(sentBody.args.durationSeconds).toBe(120);
  });

  test('lets a second job start while the first is still spinning', async () => {
    const releases: Array<() => void> = [];
    globalThis.fetch = (async (input) => {
      if (String(input) === '/__ce-api__/chat') {
        return Response.json({ success: true, text: JSON.stringify({ prompt: 'Short metal hit.' }) });
      }
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return Response.json({ ok: true, result: { base64: 'BQYH', mimeType: 'audio/mpeg' } });
    }) as typeof fetch;
    const request: CreativeRequest = {
      ...voiceRequest(),
      mode: 'generate',
      kind: 'sfx',
      prompt: '金属剑命中盔甲',
      durationSeconds: 2,
      variationCount: 1,
      voice: undefined,
    };
    const first = generateCreativeVersions(request, 'job-1');
    const second = generateCreativeVersions(request, 'job-2');
    for (let attempt = 0; attempt < 20 && releases.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releases.length).toBe(2);
    for (const release of releases) release();
    expect((await first)).toHaveLength(1);
    expect((await second)).toHaveLength(1);
  });

  test('keeps a third Seed preview queued until a slot frees', async () => {
    const releases: Array<() => void> = [];
    globalThis.fetch = (async (input) => {
      if (String(input) === '/__ce-api__/chat') {
        return Response.json({ success: true, text: JSON.stringify({ prompt: 'Short metal hit.' }) });
      }
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return Response.json({ ok: true, result: { base64: 'BQYH', mimeType: 'audio/mpeg' } });
    }) as typeof fetch;
    const request: CreativeRequest = {
      ...voiceRequest(),
      mode: 'generate',
      kind: 'sfx',
      prompt: '金属剑命中盔甲',
      durationSeconds: 2,
      variationCount: 1,
      voice: undefined,
    };
    const jobs = [
      generateCreativeVersions(request, 'job-1'),
      generateCreativeVersions(request, 'job-2'),
      generateCreativeVersions(request, 'job-3'),
    ];
    for (let attempt = 0; attempt < 30 && releases.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releases.length).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases.length).toBe(2);
    releases[0]!();
    for (let attempt = 0; attempt < 30 && releases.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releases.length).toBe(3);
    for (const release of releases) release();
    for (const job of jobs) expect((await job)).toHaveLength(1);
  });

  test('saves the selected generated bytes through the extension tool', async () => {
    let sentBody: Record<string, any> = {};
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('/api/tools/call');
      sentBody = JSON.parse(String(init?.body));
      return Response.json({ ok: true, result: { slug: 'demo', path: 'assets/audio/voice.mp3' } });
    }) as typeof fetch;
    const version: CreativeVersion = {
      id: 'voice-request:1',
      label: 'A',
      title: '自然演绎',
      summary: '守卫语音',
      tags: ['角色语音'],
      durationSeconds: 2,
      kind: 'voice',
      base64: 'AQIDBA==',
      mimeType: 'audio/mpeg',
      provider: 'litellm',
      model: 'doubao-tts',
      compiledPrompt: '台词：站住！\n坚定、克制',
    };

    const result = await saveCreativeVersionToGame(version, 'demo', {
      gainDb: 1,
      pitchSemitones: 0,
      highpassHz: 20,
      lowpassHz: 16_000,
      eqLowDb: 0,
      eqMidDb: 0,
      eqHighDb: -1,
    });
    expect(result.slug).toBe('demo');
    expect(sentBody.toolId).toBe('save-generated-audio');
    expect(sentBody.args.kind).toBe('voice');
    expect(sentBody.args.base64).toBe('AQIDBA==');
    expect(sentBody.args.provider).toBe('litellm');
    expect(sentBody.args.shaping).toMatchObject({ eqHighDb: -1 });
    // Reaches the clip's provenance sidecar, so a take can be traced to its prompt.
    expect(sentBody.args.prompt).toBe('台词：站住！\n坚定、克制');
  });
});
