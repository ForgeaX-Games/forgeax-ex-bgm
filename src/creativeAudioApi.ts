import {
  clampCreativeDuration,
  creativeRequestSummary,
  type CreativeRequest,
  type CreativeVersion,
  type GeneratedAudioKind,
} from './creativeAudioStudio.ts';
import type { AudioShapingParams } from './audioShaping.ts';
import { filenameForCreativeVersion } from './assetPath.ts';
import {
  compileCreativePrompt,
  promptForAudioVersion,
  type CompiledAudioPrompt,
} from './audioPromptSkill.ts';

/** `generate-audio-preview` result. Errors travel in the tool-call envelope. */
interface SeedPreviewResult {
  base64?: string;
  mimeType?: string;
  provider?: string;
  model?: string;
  traceId?: string;
  durationMs?: number;
  fileSizeBytes?: number;
}

export interface AudioGenerationCapability {
  configured: boolean;
  providers: string[];
}

export interface AudioGenerationStatus {
  tts: AudioGenerationCapability;
  music: AudioGenerationCapability;
  sfx: AudioGenerationCapability;
}

function speedRatio(speed: string | undefined): number {
  if (speed === 'slow') return 0.82;
  if (speed === 'fast') return 1.18;
  return 1;
}

/**
 * Seed Audio takes a single `text_prompt`, so a VO take has to carry its line
 * inside the prompt. The compiled prompt is performance direction only — the
 * skill strips the script on purpose — hence the explicit line here.
 */
function seedPrompt(
  request: CreativeRequest,
  compiled: CompiledAudioPrompt,
  versionIndex: number,
): string {
  const direction = promptForAudioVersion(request, compiled, versionIndex);
  if (request.kind !== 'voice') return direction;
  const script = (compiled.voiceText ?? request.voice?.script ?? '').trim();
  return [script ? `台词：${script}` : '', direction].filter(Boolean).join('\n');
}

function seedArgs(
  request: CreativeRequest,
  compiled: CompiledAudioPrompt,
  versionIndex: number,
): Record<string, unknown> {
  const prompt = seedPrompt(request, compiled, versionIndex);
  if (request.kind === 'voice') {
    return { kind: 'voice', prompt, speed: speedRatio(request.voice?.speed) };
  }
  if (request.kind === 'bgm') {
    return {
      kind: 'bgm',
      prompt,
      instrumental: request.instrumental,
      durationSeconds: clampCreativeDuration('bgm', request.durationSeconds),
      loop: request.loop,
    };
  }
  return {
    kind: 'sfx',
    prompt,
    durationSeconds: clampCreativeDuration('sfx', request.durationSeconds),
    loop: request.loop,
  };
}

function versionTitle(kind: GeneratedAudioKind, index: number): string {
  const titles = kind === 'voice'
    ? ['自然演绎', '备选音色', '情绪备选', '角色化版本']
    : kind === 'bgm'
      ? ['主方案', '氛围备选', '节奏备选', '结构备选']
      : ['主方案', '质感备选', '力度备选', '时序备选'];
  return titles[index] ?? `版本 ${index + 1}`;
}

function durationOf(request: CreativeRequest, response: SeedPreviewResult): number {
  if (typeof response.durationMs === 'number' && response.durationMs > 0) {
    return response.durationMs / 1000;
  }
  if (request.kind === 'voice') {
    return Math.max(1, Math.ceil((request.voice?.script.length ?? 4) / 4));
  }
  return request.kind === 'sfx'
    ? Math.min(30, request.durationSeconds)
    : request.durationSeconds;
}

async function generateOne(
  request: CreativeRequest,
  compiled: CompiledAudioPrompt,
  requestId: string,
  index: number,
  signal?: AbortSignal,
  labelOffset = 0,
): Promise<CreativeVersion> {
  const args = seedArgs(request, compiled, index);
  const startedAt = Date.now();
  const response = await fetch('/api/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toolId: 'generate-audio-preview',
      args,
      caller: { kind: 'user' },
    }),
    signal,
  });
  const envelope = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    result?: SeedPreviewResult;
  };
  const payload = envelope.result;
  if (!response.ok || !envelope.ok || !payload?.base64) {
    throw new Error(envelope.error || `音频生成失败（HTTP ${response.status}）`);
  }
  const mimeType = payload.mimeType || 'audio/mpeg';
  const label = String.fromCharCode(65 + Math.min(labelOffset + index, 25));
  return {
    id: `${requestId}:${index + 1}`,
    label,
    title: versionTitle(request.kind, index),
    summary: creativeRequestSummary(request),
    tags: [
      request.kind === 'voice' ? '角色语音' : request.kind === 'bgm' ? 'BGM' : '音效',
      '从零生成',
      request.loop ? '循环' : '',
      request.kind === 'bgm' && request.instrumental ? '纯音乐' : '',
      request.voice?.emotion ?? '',
      payload.provider ?? '',
    ].filter(Boolean),
    durationSeconds: durationOf(request, payload),
    kind: request.kind,
    derivedFrom: undefined,
    base64: payload.base64,
    mimeType,
    dataUrl: `data:${mimeType};base64,${payload.base64}`,
    provider: payload.provider || 'seed-audio',
    model: payload.model,
    traceId: payload.traceId,
    fileSizeBytes: payload.fileSizeBytes,
    latencyMs: Date.now() - startedAt,
    originalRequest: compiled.originalRequest,
    compiledPrompt: String(args.prompt ?? ''),
    promptSource: compiled.source,
  };
}

/**
 * Every kind is served by Seed Audio, so one credential decides all three.
 * The per-kind shape is kept because the UI reports the missing capability
 * for the pane the user is actually in.
 */
export async function fetchAudioGenerationStatus(): Promise<AudioGenerationStatus> {
  const response = await fetch('/api/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toolId: 'get-audio-provider-status',
      args: {},
      caller: { kind: 'user' },
    }),
  });
  const envelope = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: { seed?: { configured?: boolean; model?: string } };
  };
  if (!response.ok || !envelope.ok || !envelope.result?.seed) {
    throw new Error('无法读取音频生成服务状态');
  }
  const { configured = false, model } = envelope.result.seed;
  const capability: AudioGenerationCapability = {
    configured,
    providers: configured ? [model ? `seed-audio (${model})` : 'seed-audio'] : [],
  };
  return { tts: capability, music: capability, sfx: capability };
}

/**
 * Seed accounts typically allow a couple of concurrent creates. Cap the whole
 * audio studio — overlapping player jobs included — so a second click queues
 * instead of 429ing the first one.
 */
const MAX_PREVIEW_IN_FLIGHT = 2;
let previewInFlight = 0;
const previewWaiters: Array<() => void> = [];

function wakeNextPreviewWaiter(): void {
  previewWaiters[0]?.();
}

function acquirePreviewSlot(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const dropFromQueue = () => {
      const index = previewWaiters.indexOf(tryAcquire);
      if (index >= 0) previewWaiters.splice(index, 1);
      return index;
    };
    const tryAcquire = () => {
      if (settled) return;
      if (signal?.aborted) {
        dropFromQueue();
        finish(() => reject(new DOMException('音频生成已取消', 'AbortError')));
        wakeNextPreviewWaiter();
        return;
      }
      const queued = previewWaiters.includes(tryAcquire);
      const isHead = previewWaiters[0] === tryAcquire;
      const canGo = previewInFlight < MAX_PREVIEW_IN_FLIGHT && (!queued && previewWaiters.length === 0 || isHead);
      if (!canGo) {
        if (!queued) previewWaiters.push(tryAcquire);
        return;
      }
      if (isHead) previewWaiters.shift();
      previewInFlight += 1;
      finish(() => resolve());
    };
    signal?.addEventListener('abort', () => {
      const index = dropFromQueue();
      finish(() => reject(new DOMException('音频生成已取消', 'AbortError')));
      if (index === 0) wakeNextPreviewWaiter();
    }, { once: true });
    tryAcquire();
  });
}

function withPreviewSlot<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  return acquirePreviewSlot(signal).then((_) =>
    work().finally(() => {
      previewInFlight = Math.max(0, previewInFlight - 1);
      wakeNextPreviewWaiter();
    }));
}

export interface GenerateCreativeOptions {
  onVersion?: (version: CreativeVersion) => void;
  labelOffset?: number;
}

export async function generateCreativeVersions(
  request: CreativeRequest,
  requestId: string,
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal,
  options?: GenerateCreativeOptions,
): Promise<CreativeVersion[]> {
  const total = Math.max(1, Math.min(4, Math.round(request.variationCount || 1)));
  const compiled = await compileCreativePrompt(request, fetch, signal);
  const versions: CreativeVersion[] = [];
  const errors: string[] = [];
  let completed = 0;
  const labelOffset = Math.max(0, options?.labelOffset ?? 0);

  await Promise.all(Array.from({ length: total }, async (_, index) => {
    try {
      const version = await withPreviewSlot(signal, () =>
        generateOne(request, compiled, requestId, index, signal, labelOffset));
      versions.push(version);
      options?.onVersion?.(version);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`版本 ${String.fromCharCode(65 + Math.min(labelOffset + index, 25))}：${error instanceof Error ? error.message : String(error)}`);
    }
    completed += 1;
    onProgress?.(completed, total);
  }));

  if (signal?.aborted) throw new DOMException('音频生成已取消', 'AbortError');
  if (!versions.length) throw new Error(errors.join('；') || '音频生成失败');
  return versions.sort((left, right) => left.label.localeCompare(right.label));
}

export function filenameFor(version: CreativeVersion): string {
  return filenameForCreativeVersion(version);
}

export function downloadCreativeVersion(version: CreativeVersion): void {
  if (!version.dataUrl) throw new Error('当前版本没有真实音频');
  const anchor = document.createElement('a');
  anchor.href = version.dataUrl;
  anchor.download = filenameFor(version);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function saveCreativeVersionToGame(
  version: CreativeVersion,
  slug: string,
  shaping?: AudioShapingParams,
): Promise<{ slug?: string; file?: string; path?: string }> {
  if (!version.base64) throw new Error('当前版本没有真实音频');
  const kind = version.kind;
  const response = await fetch('/api/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      toolId: 'save-generated-audio',
      args: {
        slug,
        assetId: `generated:${version.id}`,
        name: `${version.kind === 'voice' ? '语音' : version.kind === 'bgm' ? 'BGM' : '音效'} · ${version.title}`,
        kind,
        base64: version.base64,
        mimeType: version.mimeType,
        filename: filenameFor(version),
        provider: version.provider,
        model: version.model,
        ...(version.compiledPrompt ? { prompt: version.compiledPrompt } : {}),
        ...(shaping ? { shaping } : {}),
      },
      caller: { kind: 'user' },
    }),
  });
  const envelope = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    result?: { slug?: string; file?: string; path?: string };
  };
  if (!response.ok || !envelope.ok) {
    throw new Error(envelope.error || `保存失败（HTTP ${response.status}）`);
  }
  return envelope.result ?? {};
}
