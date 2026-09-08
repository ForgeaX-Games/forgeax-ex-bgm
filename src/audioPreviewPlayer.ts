/**
 * 绑定编辑器里的「就地试听」播放器。
 *
 * 全局只有一个 <audio>：声音清单和素材行会同时渲染播放按钮，同一时刻只允许
 * 一个在响，否则用户点几下就会听到几条音轨叠在一起。谁在播由 key（slug+file）
 * 标识，订阅者据此把对应按钮切成「停止」态。
 *
 * 播放走 AudioShapingEngine，参数由 runtime 的 mergeShaping 算出，滤波链常数
 * 也与 runtime 一致——试听听到的就是游戏里会响的那一版，否则调参数这件事在
 * 编辑区里根本无法验证。
 */

import { DEFAULT_AUDIO_SHAPING, type AudioShapingParams } from './audioShaping.ts';
import { AudioShapingEngine } from './audioShapingEngine.ts';
import { gameAudioUrl } from './proxyUrl.ts';

export interface PreviewRequest {
  slug: string;
  file: string;
  /** 已合并的 shaping；缺省表示按原始声音播放。 */
  shaping?: AudioShapingParams;
  /** 绑定的 playback.volume，叠加在 shaping 增益之外。 */
  volume?: number;
  onError?: (message: string) => void;
}

export type PreviewListener = (playingKey: string) => void;

const listeners = new Set<PreviewListener>();
let element: HTMLAudioElement | null = null;
let engine: AudioShapingEngine | null = null;
let playingKey = '';
let activeShaping: AudioShapingParams = { ...DEFAULT_AUDIO_SHAPING };
let activeVolume = 1;

export function previewKey(slug: string, file: string): string {
  return `${slug}\u0000${file}`;
}

export function currentPreviewKey(): string {
  return playingKey;
}

export function onPreviewChange(listener: PreviewListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setPlaying(key: string): void {
  if (playingKey === key) return;
  playingKey = key;
  for (const listener of listeners) listener(key);
}

function player(): HTMLAudioElement {
  if (element) return element;
  const node = new Audio();
  node.preload = 'none';
  node.addEventListener('ended', () => setPlaying(''));
  node.addEventListener('pause', () => setPlaying(''));
  node.addEventListener('error', () => setPlaying(''));
  element = node;
  engine = new AudioShapingEngine(node);
  return node;
}

/**
 * 调参数时实时改写正在播放的声音。没在播就只记下来，下次播放时生效。
 */
export function applyPreviewShaping(shaping?: AudioShapingParams, volume = 1): void {
  activeShaping = shaping ?? { ...DEFAULT_AUDIO_SHAPING };
  activeVolume = volume;
  if (!playingKey || !engine) return;
  engine.apply(activeShaping, false, activeVolume);
}

export function stopPreview(): void {
  if (!element) return;
  element.pause();
  element.removeAttribute('src');
  element.load();
  setPlaying('');
}

/**
 * 播放 <game>/audio/<file>；再点一次同一条则停止。失败原因（文件名写错、还没
 * 配入游戏）通过 onError 交回调用方提示，这里不直接弹 toast。
 */
export function togglePreview(request: PreviewRequest): void {
  const { slug, file, shaping, volume = 1, onError } = request;
  const key = previewKey(slug, file);
  if (playingKey === key) {
    stopPreview();
    return;
  }
  if (!slug || !file) {
    onError?.('未打开游戏工程，或声音文件名为空');
    return;
  }
  const node = player();
  node.pause();
  node.src = gameAudioUrl(slug, file);
  setPlaying(key);
  applyPreviewShaping(shaping, volume);
  void engine?.resume();
  void node.play().catch(() => {
    setPlaying('');
    onError?.(`无法播放 ${file}：请确认它已在游戏的 audio/ 或 assets/audio/ 目录`);
  });
}
