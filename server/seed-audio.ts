import { randomUUID } from 'node:crypto';

const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/create';
const DEFAULT_MODEL = 'seed-audio-1.0';

export type SeedAudioKind = 'bgm' | 'sfx' | 'voice';

export interface SeedAudioConfig {
  headerValue: string;
  endpoint: string;
  model: string;
}

export interface SeedAudioRequest {
  kind: SeedAudioKind;
  prompt: string;
  durationSeconds?: number;
  instrumental?: boolean;
  loop?: boolean;
  speed?: number;
  format?: 'mp3' | 'wav' | 'pcm';
  sampleRate?: 16000 | 24000 | 32000 | 44100 | 48000;
}

export interface SeedAudioResult {
  bytes: Buffer;
  mimeType: string;
  model: string;
  requestId: string;
  traceId: string;
}

export function seedConfigFromEnv(env: Record<string, string | undefined> = {}): SeedAudioConfig {
  return {
    headerValue: (env.SEED_AUDIO_API_KEY ?? '').trim(),
    endpoint: (env.SEED_AUDIO_ENDPOINT ?? '').trim() || DEFAULT_ENDPOINT,
    model: (env.SEED_AUDIO_MODEL ?? '').trim() || DEFAULT_MODEL,
  };
}

function duration(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function speechRate(request: SeedAudioRequest): number {
  if (request.kind !== 'voice' || typeof request.speed !== 'number' || !Number.isFinite(request.speed)) return 0;
  return Math.min(100, Math.max(-50, Math.round((request.speed - 1) * 100)));
}

function promptFor(request: SeedAudioRequest): string {
  const rules: string[] = [];
  if (request.kind === 'bgm') {
    rules.push('生成游戏或影视配乐。');
    if (request.instrumental !== false) rules.push('只生成纯音乐，不要人声、对白或歌词演唱。');
  } else if (request.kind === 'sfx') {
    rules.push('只生成干净、独立的游戏音效，不要背景音乐、对白或旁白。');
  } else {
    rules.push('只生成单人角色对白或旁白，不要背景音乐、环境声或额外角色。');
  }
  const seconds = duration(request.durationSeconds);
  if (seconds) rules.push(`目标时长约 ${seconds} 秒。`);
  if (request.loop) rules.push('首尾应可自然无缝循环。');
  return [request.prompt.trim(), ...rules].filter(Boolean).join('\n');
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function mimeFor(format: 'mp3' | 'wav' | 'pcm'): string {
  if (format === 'wav') return 'audio/wav';
  if (format === 'pcm') return 'audio/pcm';
  return 'audio/mpeg';
}

export async function generateSeedAudio(
  config: SeedAudioConfig,
  request: SeedAudioRequest,
): Promise<SeedAudioResult> {
  if (!config.headerValue) throw Object.assign(new Error('SEED_AUDIO_API_KEY is not configured'), { code: 'seed-not-configured' });
  if (!request.prompt?.trim()) throw Object.assign(new Error('Seed audio prompt is required'), { code: 'invalid-prompt' });

  const requestId = randomUUID();
  const format = request.format ?? 'mp3';
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': config.headerValue,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify({
      model: config.model,
      text_prompt: promptFor(request),
      audio_config: {
        format,
        sample_rate: request.sampleRate ?? 48000,
        pitch_rate: 0,
        speech_rate: speechRate(request),
        loudness_rate: 0,
      },
    }),
  });
  const raw = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error(`Seed Audio returned non-JSON HTTP ${response.status}`), { code: 'seed-bad-response' });
  }
  const code = typeof payload.code === 'number' ? payload.code : undefined;
  if (!response.ok || (code !== undefined && code !== 0)) {
    throw Object.assign(
      new Error(text(payload.message) || text(payload.msg) || `Seed Audio HTTP ${response.status}`),
      { code: 'seed-generation-failed' },
    );
  }

  let bytes: Buffer;
  const encoded = text(payload.audio) || text(payload.data);
  if (encoded) {
    bytes = Buffer.from(encoded.replace(/^data:[^;]+;base64,/, ''), 'base64');
  } else {
    const url = text(payload.url);
    if (!url) throw Object.assign(new Error('Seed Audio response contained no audio'), { code: 'seed-empty-response' });
    const download = await fetch(url);
    if (!download.ok) throw Object.assign(new Error(`Seed audio download HTTP ${download.status}`), { code: 'seed-download-failed' });
    bytes = Buffer.from(await download.arrayBuffer());
  }
  if (!bytes.length) throw Object.assign(new Error('Seed Audio generated 0 bytes'), { code: 'seed-empty-audio' });

  return {
    bytes,
    mimeType: mimeFor(format),
    model: config.model,
    requestId,
    traceId: response.headers.get('x-tt-logid') || response.headers.get('x-request-id') || requestId,
  };
}
