import { afterEach, describe, expect, test } from 'bun:test';

import {
  AUDIO_PROMPT_LIMITS,
  compileCreativePrompt,
  promptForAudioVersion,
} from '../src/audioPromptSkill.ts';
import type { CreativeRequest } from '../src/creativeAudioStudio.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(overrides: Partial<CreativeRequest> = {}): CreativeRequest {
  return {
    mode: 'generate',
    kind: 'bgm',
    sourceMode: 'new',
    prompt: '黑暗奇幻 Boss 战，持续推进，最后进入高潮',
    direction: '减少鼓点、适合循环',
    durationSeconds: 60,
    loop: true,
    instrumental: true,
    variationCount: 2,
    projectId: 'demo',
    ...overrides,
  };
}

describe('ForgeaX game audio prompt skill', () => {
  test('compiles a BGM request through the host text gateway', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe('/__ce-api__/chat');
      expect(JSON.parse(String(init?.body))).toMatchObject({ maxTokens: 800 });
      return Response.json({
        success: true,
        text: JSON.stringify({
          prompt: 'Dark fantasy boss battle; tense orchestral-industrial, high energy; low brass and distorted strings; builds to a final climax; seamless instrumental loop; avoid vocals and muddy bass.',
        }),
      });
    }) as typeof fetch;

    const result = await compileCreativePrompt(request());
    expect(result.source).toBe('skill');
    expect(result.prompt.length).toBeLessThanOrEqual(AUDIO_PROMPT_LIMITS.bgm);
  });

  test('keeps VO script separate and unchanged', async () => {
    globalThis.fetch = (async () => Response.json({
      success: true,
      text: JSON.stringify({ prompt: 'Veteran commander; controlled anger; fast pace; close dry game VO; no added words.' }),
    })) as typeof fetch;
    const input = request({
      mode: 'voice',
      kind: 'voice',
      prompt: '守卫警告',
      direction: '坚定、克制',
      loop: false,
      instrumental: false,
      voice: {
        script: '封锁出口，一个都别放走！',
        roleId: 'guard',
        role: '守卫',
        emotion: '愤怒',
        language: 'zh',
        speed: 'fast',
      },
    });

    const result = await compileCreativePrompt(input);
    expect(result.prompt).not.toContain(input.voice!.script);
    expect(result.voiceText).toBe(input.voice!.script);
    expect(result.prompt.length).toBeLessThanOrEqual(AUDIO_PROMPT_LIMITS.voice);
  });

  test('falls back locally and enforces the SFX budget', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    const result = await compileCreativePrompt(request({
      kind: 'sfx',
      prompt: `火焰巨剑命中金属盔甲。${'厚重冲击与火星尾音，'.repeat(80)}`,
      direction: '写实、不要音乐、不要长混响',
      durationSeconds: 2,
      loop: false,
      instrumental: false,
    }));

    expect(result.source).toBe('fallback');
    expect(result.prompt.length).toBeLessThanOrEqual(AUDIO_PROMPT_LIMITS.sfx);
  });

  test('keeps variation guidance inside the provider budget', async () => {
    globalThis.fetch = (async () => Response.json({
      success: true,
      text: JSON.stringify({ prompt: 'A'.repeat(2_000) }),
    })) as typeof fetch;
    const compiled = await compileCreativePrompt(request());
    const prompt = promptForAudioVersion(request(), compiled, 2);
    expect(prompt.length).toBeLessThanOrEqual(AUDIO_PROMPT_LIMITS.bgm);
    expect(prompt).toContain('Alternative interpretation 3');
  });
});
