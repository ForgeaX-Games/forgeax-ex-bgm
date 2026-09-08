export type CreativeMode = 'voice' | 'generate';
export type GeneratedAudioKind = 'voice' | 'bgm' | 'sfx';

export interface CreativeRequest {
  mode: CreativeMode;
  kind: GeneratedAudioKind;
  sourceMode: 'new';
  prompt: string;
  direction: string;
  durationSeconds: number;
  loop: boolean;
  instrumental: boolean;
  variationCount: number;
  projectId: string;
  voice?: {
    script: string;
    roleId: string;
    role: string;
    emotion: string;
    language: string;
    speed: string;
  };
}

export interface CreativeVersion {
  id: string;
  label: string;
  title: string;
  summary: string;
  tags: string[];
  durationSeconds: number;
  kind: GeneratedAudioKind;
  derivedFrom?: string;
  /** Real API audio. Optional only for legacy/offline fixtures. */
  base64?: string;
  mimeType?: string;
  dataUrl?: string;
  provider?: string;
  model?: string;
  traceId?: string;
  fileSizeBytes?: number;
  latencyMs?: number;
  /** Player wording retained for reproducibility. */
  originalRequest?: string;
  /** Compact prompt actually sent to the generation provider. */
  compiledPrompt?: string;
  /** Whether the text model compiled the prompt or the local safe template did. */
  promptSource?: 'skill' | 'fallback';
  /** FilesPanel path after 配入, e.g. `.forgeax/games/<slug>/assets/audio/foo.mp3`. */
  projectPath?: string;
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * 唯一的必填规则。状态位只想知道「能不能点」时也走这里,免得再抄一份判断——
 * 它只看一段文本,不读 DOM、不碰时长等可选项。
 */
export function creativeRequestBlocker(
  kind: GeneratedAudioKind,
  text: string,
): string | null {
  if (!compact(text)) {
    return kind === 'voice' ? '请先输入要说的台词' : '请先描述想生成的声音';
  }
  return null;
}

export function validateCreativeRequest(request: CreativeRequest): string | null {
  return creativeRequestBlocker(
    request.kind,
    request.kind === 'voice' ? request.voice?.script ?? '' : request.prompt,
  );
}

export function creativeRequestSummary(request: CreativeRequest): string {
  if (request.kind === 'voice') {
    const voice = request.voice;
    return [
      voice?.script ? `“${compact(voice.script)}”` : '',
      voice?.role,
      voice?.emotion,
      compact(request.direction),
    ].filter(Boolean).join(' · ');
  }
  return [
    compact(request.prompt),
    compact(request.direction),
    request.loop ? '可循环' : '自然结束',
    request.kind === 'bgm' && request.instrumental ? '纯音乐' : '',
  ].filter(Boolean).join(' · ');
}

export const DURATION_RANGE = {
  sfx: { min: 1, max: 30, default: 4, presets: [1, 2, 4, 8, 15] },
  bgm: { min: 5, max: 120, default: 30, presets: [15, 30, 45, 60, 90, 120] },
} as const;

export function durationRangeFor(kind: GeneratedAudioKind): (typeof DURATION_RANGE)['sfx'] | (typeof DURATION_RANGE)['bgm'] {
  return kind === 'sfx' ? DURATION_RANGE.sfx : DURATION_RANGE.bgm;
}

export function clampCreativeDuration(kind: GeneratedAudioKind, seconds: number): number {
  const range = durationRangeFor(kind);
  const value = Number.isFinite(seconds) ? Math.round(seconds) : range.default;
  return Math.min(range.max, Math.max(range.min, value));
}

export function formatCreativeDuration(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (safe < 10 && safe > 0 && !Number.isInteger(safe)) {
    return `${safe.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}s`;
  }
  const rounded = Math.max(0, Math.round(safe));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
