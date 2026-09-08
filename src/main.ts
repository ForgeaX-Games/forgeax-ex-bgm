import './style.css';
import './gen3.css';

import {
  AUDIO_SHAPING_PRESETS,
  DEFAULT_AUDIO_SHAPING,
  isDefaultAudioShaping,
  matchingAudioShapingPreset,
  sanitizeAudioShapingParams,
  type AudioShapingParams,
} from './audioShaping.ts';
import { AudioShapingEngine } from './audioShapingEngine.ts';
import { initAudioBindingsUi } from './audioBindingsUi.ts';
import { initAudioDesignUi } from './audioDesignUi.ts';
import {
  clampCreativeDuration,
  creativeRequestSummary,
  creativeRequestBlocker,
  durationRangeFor,
  formatCreativeDuration,
  validateCreativeRequest,
  type CreativeRequest,
  type CreativeVersion,
  type GeneratedAudioKind,
} from './creativeAudioStudio.ts';
import {
  TASK_STATE_LABEL,
  taskStateText,
  type TaskSnapshot,
} from './taskState.ts';
import {
  downloadCreativeVersion,
  fetchAudioGenerationStatus,
  generateCreativeVersions,
  saveCreativeVersionToGame,
} from './creativeAudioApi.ts';
import {
  filenameForCreativeVersion,
  normalizeProjectPath,
  projectPathForGameAudio,
} from './assetPath.ts';
import { showAssetContextMenu } from './assetContextMenu.ts';
import { resolveActiveGameSlug, subscribeActiveGame } from './activeGame.ts';
import { openAttachEventPopover } from './attachEventPopover.ts';
import {
  HUMAN_SEARCH_SCHEMA,
  type PlayerAudioStudioMode,
} from './humanSearchTypes.ts';
import { PlatformBridge } from './platform/Bridge.ts';
import { showToast } from './utils.ts';
import { AudioStudioChannel } from './audioStudioChannel.ts';
import type { DesignWorkspace } from './audioDesignEntities.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const htmlPane = document.documentElement.dataset.pane ?? 'standalone';
const hasLeftPane = htmlPane === 'left' || htmlPane === 'standalone';
const hasCenterPane = htmlPane === 'center' || htmlPane === 'standalone';
const bridge = new PlatformBridge();
const bus = new AudioStudioChannel();
const storagePrefix = `forgeax:bgm:human:${bus.projectId}:${bus.instanceId}`;

let mode: PlayerAudioStudioMode = 'voice';
let latestCreativeRequestId = '';
const creativeGenerationControllers = new Map<string, AbortController>();
const inflightCreativeIds = new Set<string>();
let shapingEngine: AudioShapingEngine | null = null;
let shapingParams: AudioShapingParams = { ...DEFAULT_AUDIO_SHAPING };
let shapingBypassed = false;
const shapingDrafts = new Map<string, { params: AudioShapingParams; saved: boolean }>();
let creativeKind: GeneratedAudioKind = 'bgm';
let selectedVoiceEmotion = '平静';
let activeCreativeRequest: CreativeRequest | null = null;
let creativeVersions: CreativeVersion[] = [];
let selectedCreativeVersion: CreativeVersion | null = null;
/** Set once the design workspace exists. The variant menu writes takes into the
 *  same game 配入游戏事件 targets, so both must read one slug. */
let workspaceSlug: (() => string) | null = null;
/** 规范七态里的「已取消」需要留痕:中止只是清空在途,不留痕就会被读成「未开始」。
 *  下一次生成开始时清掉。 */
let roundCancelled = false;

interface PendingTake {
  id: string;
  requestId: string;
  label: string;
  title: string;
  summary: string;
  status: 'queued' | 'failed';
  error?: string;
}

let pendingTakes: PendingTake[] = [];

type AudioShapingKey = keyof AudioShapingParams;

const SHAPING_CONTROLS: Array<{
  inputId: string;
  outputId: string;
  key: AudioShapingKey;
}> = [
  { inputId: 'shapingGain', outputId: 'shapingGainValue', key: 'gainDb' },
  { inputId: 'shapingPitch', outputId: 'shapingPitchValue', key: 'pitchSemitones' },
  { inputId: 'shapingHighpass', outputId: 'shapingHighpassValue', key: 'highpassHz' },
  { inputId: 'shapingLowpass', outputId: 'shapingLowpassValue', key: 'lowpassHz' },
  { inputId: 'shapingEqLow', outputId: 'shapingEqLowValue', key: 'eqLowDb' },
  { inputId: 'shapingEqMid', outputId: 'shapingEqMidValue', key: 'eqMidDb' },
  { inputId: 'shapingEqHigh', outputId: 'shapingEqHighValue', key: 'eqHighDb' },
];

const QUICK_CHOICES: Record<'bgm' | 'sfx', string[]> = {
  bgm: ['更紧张', '更宏大', '更轻松', '加强节奏', '减少鼓点', '去掉人声', '高潮更明显', '适合循环'],
  sfx: ['更有力', '更轻一些', '更短促', '尾音更长', '减少混响', '更近', '更远', '更真实'],
};

function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `human-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abortAllCreativeJobs(): void {
  const hadWork = inflightCreativeIds.size > 0 || pendingTakes.length > 0;
  for (const controller of creativeGenerationControllers.values()) controller.abort();
  creativeGenerationControllers.clear();
  inflightCreativeIds.clear();
  pendingTakes = [];
  if (hadWork) roundCancelled = true;
}

function selectedGenerationCount(): number {
  const selected = document.querySelector<HTMLButtonElement>('#generationVariationCount button.is-selected');
  const value = Number(selected?.dataset.count);
  return Number.isFinite(value) && value >= 1 ? Math.min(4, value) : 2;
}

function syncGenerationDuration(raw: number): number {
  const seconds = clampCreativeDuration(creativeKind === 'sfx' ? 'sfx' : 'bgm', raw);
  const range = durationRangeFor(creativeKind === 'sfx' ? 'sfx' : 'bgm');
  const number = $<HTMLInputElement>('generationDuration');
  const slider = $<HTMLInputElement>('generationDurationRange');
  number.min = String(range.min);
  number.max = String(range.max);
  slider.min = String(range.min);
  slider.max = String(range.max);
  number.value = String(seconds);
  slider.value = String(seconds);
  $('generationDurationHint').textContent = `${range.min}–${range.max} 秒，可自己填`;
  document.querySelectorAll<HTMLButtonElement>('#generationDurationPresets .creative-choice').forEach((button) => {
    button.classList.toggle('is-selected', Number(button.dataset.seconds) === seconds);
  });
  return seconds;
}

function renderDurationPresets(): void {
  if (!hasLeftPane) return;
  const range = durationRangeFor(creativeKind === 'sfx' ? 'sfx' : 'bgm');
  const container = $('generationDurationPresets');
  container.innerHTML = '';
  for (const seconds of range.presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'creative-choice';
    button.dataset.seconds = String(seconds);
    button.textContent = seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
    button.addEventListener('click', () => syncGenerationDuration(seconds));
    container.appendChild(button);
  }
}

function saveLeftState(): void {
  if (!hasLeftPane) return;
  try {
    sessionStorage.setItem(`${storagePrefix}:mode`, mode);
  } catch {
    // Mode remains usable when storage is unavailable.
  }
}

function restoreLeftState(): void {
  if (!hasLeftPane) return;
  try {
    const storedMode = sessionStorage.getItem(`${storagePrefix}:mode`);
    if (storedMode === 'voice' || storedMode === 'generate') mode = storedMode;
  } catch {
    mode = 'voice';
  }
}

function postWorkspace(workspace: DesignWorkspace): void {
  bus.post({
    schemaVersion: HUMAN_SEARCH_SCHEMA,
    type: 'bindings.workspace',
    requestId: requestId(),
    projectId: bus.projectId,
    workspace,
  });
}

function setMode(next: PlayerAudioStudioMode, broadcast = true): void {
  mode = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.audio-mode-btn')) {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  if (hasLeftPane) {
    $('voiceCreationForm').classList.toggle('hidden', mode !== 'voice');
    $('audioGenerationForm').classList.toggle('hidden', mode !== 'generate');
    updateCreativeForm();
  }
  saveLeftState();
  if (broadcast) {
    bus.post({
      schemaVersion: HUMAN_SEARCH_SCHEMA,
      type: 'view.mode',
      requestId: requestId(),
      projectId: bus.projectId,
      mode,
    });
    postWorkspace('audio');
  }
}

function setExclusiveChoice(container: Element, selected: HTMLButtonElement): void {
  container.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.classList.toggle('is-selected', button === selected);
  });
}

function renderGenerationQuickChoices(): void {
  if (!hasLeftPane) return;
  const container = $('generationQuickChoices');
  container.innerHTML = '';
  const kind = creativeKind === 'sfx' ? 'sfx' : 'bgm';
  for (const label of QUICK_CHOICES[kind]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'creative-choice';
    button.textContent = label;
    button.addEventListener('click', () => button.classList.toggle('is-selected'));
    container.appendChild(button);
  }
}

function updateCreativeForm(): void {
  if (!hasLeftPane) return;
  document.querySelectorAll<HTMLButtonElement>('[data-generation-kind]').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.generationKind === creativeKind);
  });
  const sfx = creativeKind === 'sfx';
  $('generationPromptLabel').innerHTML = sfx
    ? '想生成什么 <b>必填</b>'
    : '想生成什么音乐 <b>必填</b>';
  $<HTMLTextAreaElement>('generationPrompt').placeholder = sfx
    ? '例如：沉重的火焰剑砍中金属盔甲，短促、有冲击力'
    : '例如：黑暗奇幻 Boss 战音乐，持续推进，最后进入高潮';
  $('instrumentalField').classList.toggle('hidden', sfx);
  renderGenerationQuickChoices();
  renderDurationPresets();
  const range = durationRangeFor(sfx ? 'sfx' : 'bgm');
  const current = Number($<HTMLInputElement>('generationDuration').value);
  syncGenerationDuration(Number.isFinite(current) ? current : range.default);
  updateCreativeAction();
}

/** 当前一轮生成的状态快照，喂给规范 §07 的七态。只读输入，不改 DOM。 */
function creativeTaskSnapshot(): TaskSnapshot {
  const voice = mode === 'voice';
  const blocker = creativeRequestBlocker(
    voice ? 'voice' : creativeKind === 'sfx' ? 'sfx' : 'bgm',
    voice
      ? $<HTMLTextAreaElement>('voiceScript').value
      : $<HTMLTextAreaElement>('generationPrompt').value,
  );
  return {
    ready: blocker === null,
    inflight: inflightCreativeIds.size,
    results: creativeVersions.length,
    failures: pendingTakes.filter((take) => take.status === 'failed').length,
    cancelled: roundCancelled,
  };
}

function updateCreativeAction(): void {
  if (!hasLeftPane) return;
  const button = $<HTMLButtonElement>('runCreativeBtn');
  button.disabled = false;
  const voice = mode === 'voice';
  const count = voice
    ? Number($<HTMLSelectElement>('voiceVariationCount').value) || 3
    : selectedGenerationCount();
  const unit = voice ? '个语音版本' : '个版本';
  button.textContent = inflightCreativeIds.size
    ? `再生成 ${count} ${unit}`
    : `生成 ${count} ${unit}`;
  $('creativeStatus').textContent = taskStateText(creativeTaskSnapshot(), {
    emptyInput: voice ? '填写台词后生成' : '填写需求后生成',
  });
}

function selectedQuickDirections(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('#generationQuickChoices .is-selected')]
    .map((button) => button.textContent?.trim() ?? '')
    .filter(Boolean);
}

function makeCreativeRequest(): CreativeRequest {
  if (mode === 'voice') {
    const roleSelect = $<HTMLSelectElement>('voiceRole');
    return {
      mode: 'voice',
      kind: 'voice',
      sourceMode: 'new',
      prompt: $<HTMLTextAreaElement>('voiceScript').value.trim(),
      direction: $<HTMLTextAreaElement>('voiceDirection').value.trim(),
      durationSeconds: 0,
      loop: false,
      instrumental: false,
      variationCount: Number($<HTMLSelectElement>('voiceVariationCount').value) || 3,
      projectId: bus.projectId,
      voice: {
        script: $<HTMLTextAreaElement>('voiceScript').value.trim(),
        roleId: roleSelect.value,
        role: roleSelect.selectedOptions[0]?.textContent?.trim() || roleSelect.value,
        emotion: selectedVoiceEmotion,
        language: $<HTMLSelectElement>('voiceLanguage').value,
        speed: $<HTMLSelectElement>('voiceSpeed').value,
      },
    };
  }
  return {
    mode: 'generate',
    kind: creativeKind === 'sfx' ? 'sfx' : 'bgm',
    sourceMode: 'new',
    prompt: $<HTMLTextAreaElement>('generationPrompt').value.trim(),
    direction: selectedQuickDirections().join('、'),
    durationSeconds: syncGenerationDuration(Number($<HTMLInputElement>('generationDuration').value)),
    loop: $<HTMLInputElement>('generationLoop').checked,
    instrumental: $<HTMLInputElement>('generationInstrumental').checked,
    variationCount: selectedGenerationCount(),
    projectId: bus.projectId,
  };
}

function dispatchCreativeRequest(): void {
  const payload = makeCreativeRequest();
  const error = validateCreativeRequest(payload);
  if (error) {
    showToast(error, 'warning');
    return;
  }
  latestCreativeRequestId = requestId();
  inflightCreativeIds.add(latestCreativeRequestId);
  updateCreativeAction();
  bus.post({
    schemaVersion: HUMAN_SEARCH_SCHEMA,
    type: 'creative.request',
    requestId: latestCreativeRequestId,
    projectId: bus.projectId,
    payload,
  });
  postWorkspace('audio');
}

async function refreshAudioGenerationStatus(): Promise<void> {
  const note = hasLeftPane
    ? $('creativeApiNote').querySelector('span:last-child')
    : null;
  try {
    const status = await fetchAudioGenerationStatus();
    const missing: string[] = [];
    if (mode === 'voice' && !status.tts.configured) missing.push('语音');
    if (mode === 'generate' && creativeKind === 'bgm' && !status.music.configured) missing.push('BGM');
    if (mode === 'generate' && creativeKind === 'sfx' && !status.sfx.configured) missing.push('音效');
    if (note) {
      note.textContent = missing.length
        ? `${missing.join('、')}生成未配置：请在 .env 设置 SEED_AUDIO_API_KEY。`
        : `Seed Audio 已连接${status.sfx.providers[0] ? `（${status.sfx.providers[0]}）` : ''}`;
    }
    if (hasLeftPane) $('creativeApiBadge').textContent = missing.length ? 'Seed 待配置' : 'Seed 已连接';
    if (hasCenterPane) {
      const badge = document.getElementById('creativeApiBadge');
      if (badge) badge.textContent = missing.length ? 'Seed 待配置' : 'Seed 已连接';
    }
  } catch {
    if (note) note.textContent = '无法读取音频生成服务状态';
    if (hasLeftPane) $('creativeApiBadge').textContent = '服务未连接';
  }
}

function selectedShapingKey(): string {
  return selectedCreativeVersion?.id ?? '';
}

function shapingValueLabel(key: AudioShapingKey, value: number): string {
  if (key === 'pitchSemitones') {
    return `${value > 0 ? '+' : ''}${value} 半音`;
  }
  if (key === 'highpassHz' || key === 'lowpassHz') {
    if (value >= 1_000) {
      const khz = value / 1_000;
      return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1)} kHz`;
    }
    return `${Math.round(value)} Hz`;
  }
  return `${value > 0 ? '+' : ''}${value} dB`;
}

function setShapingEnabled(enabled: boolean): void {
  if (!hasCenterPane) return;
  for (const control of SHAPING_CONTROLS) {
    $<HTMLInputElement>(control.inputId).disabled = !enabled;
  }
  $<HTMLButtonElement>('shapingSaveBtn').disabled = !enabled;
  $<HTMLButtonElement>('shapingResetBtn').disabled = !enabled;
  $<HTMLButtonElement>('shapingCompareBtn').disabled = !enabled || isDefaultAudioShaping(shapingParams);
}

function applyShapingToEngine(): void {
  shapingEngine?.apply(shapingParams, shapingBypassed);
}

function renderShapingPresets(): void {
  if (!hasCenterPane) return;
  const list = $('shapingPresetList');
  list.innerHTML = '';
  const matched = matchingAudioShapingPreset(shapingParams);
  for (const preset of AUDIO_SHAPING_PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `audio-preset-btn${matched?.id === preset.id ? ' is-selected' : ''}`;
    button.textContent = preset.label;
    button.title = preset.description;
    button.addEventListener('click', () => {
      shapingParams = { ...preset.params };
      shapingBypassed = false;
      const key = selectedShapingKey();
      if (key) shapingDrafts.set(key, { params: { ...shapingParams }, saved: false });
      renderShapingControls();
    });
    list.appendChild(button);
  }
}

function renderShapingControls(): void {
  if (!hasCenterPane) return;
  const enabled = Boolean(selectedCreativeVersion);
  setShapingEnabled(enabled);
  for (const control of SHAPING_CONTROLS) {
    const input = $<HTMLInputElement>(control.inputId);
    const value = shapingParams[control.key];
    input.value = String(value);
    $<HTMLOutputElement>(control.outputId).value = shapingValueLabel(control.key, value);
  }
  const draft = selectedShapingKey() ? shapingDrafts.get(selectedShapingKey()) : undefined;
  $('shapingStatus').textContent = !enabled
    ? '选择一个变体再塑形'
    : shapingBypassed
      ? '正在对比原声'
      : isDefaultAudioShaping(shapingParams)
        ? '原始声音'
        : draft?.saved
          ? '已保存，仅作用于当前变体'
          : '实时试听，尚未保存';
  $<HTMLButtonElement>('shapingCompareBtn').classList.toggle('is-selected', shapingBypassed);
  applyShapingToEngine();
  renderShapingPresets();
}

function loadShapingFor(version: CreativeVersion | null): void {
  const key = version?.id ?? '';
  const stored = key ? shapingDrafts.get(key) : undefined;
  shapingParams = stored ? { ...stored.params } : { ...DEFAULT_AUDIO_SHAPING };
  shapingBypassed = false;
  renderShapingControls();
}

function storeCurrentShaping(): boolean {
  const key = selectedShapingKey();
  if (!key) return false;
  shapingDrafts.set(key, { params: { ...shapingParams }, saved: true });
  return true;
}

function waveformBars(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const bars = Array.from({ length: 28 }, (_, index) => {
    hash = (hash * 1103515245 + 12345) | 0;
    const height = 18 + Math.abs(hash % 82);
    return `<i style="height:${height}%"></i>`;
  });
  return `<span class="creative-variant-wave">${bars.join('')}</span>`;
}

/**
 * Writes a take into the current game's `assets/audio/` so cite and locate have
 * a real file to point at. Deliberately does NOT bind an event — 配入游戏事件
 * still owns that step; this only makes the clip a project asset.
 */
async function persistVersionToGame(version: CreativeVersion): Promise<string> {
  const slug = (workspaceSlug?.() ?? '').trim() || await resolveActiveGameSlug();
  if (!slug) throw new Error('当前没有打开的游戏工程。先在 IDE 打开一个游戏，再引用或定位。');
  // Shaping belongs to the version the panel is on, not to any right-clicked card.
  const shaping = version === selectedCreativeVersion && !isDefaultAudioShaping(shapingParams)
    ? { ...shapingParams }
    : undefined;
  const saved = await saveCreativeVersionToGame(version, slug, shaping);
  const file = saved.file ?? '';
  const path = saved.path ? normalizeProjectPath(saved.path) : projectPathForGameAudio(slug, file);
  if (!path) throw new Error('已写入游戏，但没有拿到文件路径');
  version.projectPath = path;
  showToast(`已写入 ${file.split('/').pop() || file}`, 'success');
  return path;
}

function showVariantMenu(event: MouseEvent, version: CreativeVersion): void {
  showAssetContextMenu(event, {
    title: `变体 ${version.label} · ${version.title}`,
    filename: filenameForCreativeVersion(version),
    dataUrl: version.dataUrl,
    projectPath: version.projectPath,
    ...(version.base64 ? { ensureProjectPath: () => persistVersionToGame(version) } : {}),
    missingReason: '当前版本没有真实音频',
  });
}

function loadVersionIntoPlayer(version: CreativeVersion | null): void {
  if (!hasCenterPane) return;
  const player = $<HTMLAudioElement>('creativeAudioPlayer');
  player.pause();
  if (!version?.dataUrl) {
    player.removeAttribute('src');
    player.load();
    return;
  }
  player.src = version.dataUrl;
  player.load();
}

function renderCreativeWave(version: CreativeVersion): void {
  const container = $('creativeMockWave');
  container.innerHTML = '';
  const seed = [...version.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  for (let index = 0; index < 72; index += 1) {
    const bar = document.createElement('span');
    const envelope = Math.sin((index / 71) * Math.PI);
    const texture = 0.35 + (((seed * (index + 3)) % 61) / 100);
    bar.style.height = `${Math.max(8, Math.round(envelope * texture * 92))}%`;
    container.appendChild(bar);
  }
}

function fillCreativePreview(version: CreativeVersion): void {
  $('creativePreviewEmpty').classList.add('hidden');
  $('creativePreviewContent').classList.remove('hidden');
  $('creativeVersionName').textContent = `版本 ${version.label} · ${version.title}`;
  $('creativeVersionSummary').textContent = version.summary;
  $('creativePromptSummary').textContent = version.promptSource === 'fallback'
    ? '查看专业提示词（本地模板）'
    : '查看专业提示词（Skill）';
  $('creativeCompiledPrompt').textContent = version.compiledPrompt || '未记录提示词';
  $('creativeKindBadge').textContent =
    version.kind === 'voice' ? '语音' : version.kind === 'bgm' ? 'BGM' : '音效';
  $('creativeMockDuration').textContent = formatCreativeDuration(version.durationSeconds);
  $('creativeCurrentTime').textContent = '00:00';
  ($('creativeProgress').querySelector('i') as HTMLElement).style.width = '0%';
  const playButton = $('creativeMockPlay');
  playButton.classList.remove('is-playing');
  playButton.textContent = '▶';
  const tags = $('creativeVersionTags');
  tags.innerHTML = '';
  for (const tag of version.tags) {
    const span = document.createElement('span');
    span.textContent = tag;
    tags.appendChild(span);
  }
  renderCreativeWave(version);
  loadVersionIntoPlayer(version);
}

function selectCreativeVersion(version: CreativeVersion): void {
  selectedCreativeVersion = version;
  fillCreativePreview(version);
  loadShapingFor(version);
  renderVariantCards();
}

function renderVariantCards(): void {
  if (!hasCenterPane) return;
  const row = $('creativeVariantRow');
  row.innerHTML = '';
  for (const version of creativeVersions) {
    const selected = selectedCreativeVersion?.id === version.id;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `creative-variant-card${selected ? ' is-selected' : ''}`;
    card.innerHTML = `
      <span class="creative-variant-card-head">
        <strong>变体 ${version.label}</strong>
        <em>${formatCreativeDuration(version.durationSeconds)}</em>
      </span>
      ${waveformBars(version.id)}
      <span class="creative-variant-card-prompt">${version.summary}</span>
    `;
    card.addEventListener('click', () => selectCreativeVersion(version));
    card.addEventListener('contextmenu', (event) => showVariantMenu(event, version));
    row.appendChild(card);
  }
  for (const take of pendingTakes) {
    const card = document.createElement('button');
    card.type = 'button';
    card.disabled = take.status !== 'failed';
    card.className = `creative-variant-card ${take.status === 'failed' ? 'is-failed' : 'is-pending'}`;
    card.innerHTML = `
      <span class="creative-variant-card-head">
        <strong>变体 ${take.label}</strong>
        <em>${take.status === 'failed' ? TASK_STATE_LABEL.failed : TASK_STATE_LABEL.running}</em>
      </span>
      <span class="creative-variant-wave">${take.status === 'failed' ? '' : '<span class="audio-spinner"></span>'}</span>
      <span class="creative-variant-card-prompt">${take.error || take.summary}</span>
    `;
    row.appendChild(card);
  }
}

function hasCreativeResults(): boolean {
  return creativeVersions.length > 0 || pendingTakes.length > 0;
}

function showCreativeLane(): void {
  if (!hasCenterPane) return;
  $('creativePreviewEmpty').classList.toggle('hidden', hasCreativeResults());
  $('creativePreviewContent').classList.toggle('hidden', !selectedCreativeVersion);
  renderVariantCards();
}

function resetCreativePreview(): void {
  if (!hasCenterPane) return;
  const player = document.getElementById('creativeAudioPlayer') as HTMLAudioElement | null;
  if (player) {
    player.pause();
    player.removeAttribute('src');
    player.load();
  }
  activeCreativeRequest = null;
  creativeVersions = [];
  selectedCreativeVersion = null;
  pendingTakes = [];
  shapingDrafts.clear();
  shapingParams = { ...DEFAULT_AUDIO_SHAPING };
  $('creativeVariantRow').innerHTML = '';
  $('creativePreviewEmpty').classList.remove('hidden');
  $('creativePreviewEmpty').querySelector('strong')!.textContent = '从左侧描述你想要的声音';
  $('creativePreviewEmpty').querySelector('p')!.textContent =
    '生成后这里会转圈出结果。转圈时左边还能继续生成下一条。';
  $('creativePreviewContent').classList.add('hidden');
  $('creativeCurrentTime').textContent = '00:00';
  const progress = document.querySelector('#creativeProgress i') as HTMLElement | null;
  if (progress) progress.style.width = '0%';
  renderShapingControls();
}

function downloadSelectedCreativeVersion(): void {
  if (!selectedCreativeVersion) return;
  try {
    downloadCreativeVersion(selectedCreativeVersion);
    showToast('生成音频已下载', 'success');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function handleCreativeRequest(payload: CreativeRequest, id: string): Promise<void> {
  latestCreativeRequestId = id;
  roundCancelled = false;
  const controller = new AbortController();
  creativeGenerationControllers.get(id)?.abort();
  creativeGenerationControllers.set(id, controller);
  activeCreativeRequest = payload;
  const takeCount = Math.max(1, Math.min(4, Math.round(payload.variationCount || 1)));
  const labelOffset = creativeVersions.length + pendingTakes.length;
  const summary = creativeRequestSummary(payload);
  const placeholders: PendingTake[] = Array.from({ length: takeCount }, (_, index) => ({
    id: `${id}:${index + 1}`,
    requestId: id,
    label: String.fromCharCode(65 + Math.min(labelOffset + index, 25)),
    title: TASK_STATE_LABEL.running,
    summary,
    status: 'queued',
  }));
  pendingTakes.push(...placeholders);
  showCreativeLane();
  bus.post({
    schemaVersion: HUMAN_SEARCH_SCHEMA,
    type: 'creative.status',
    requestId: id,
    projectId: bus.projectId,
    status: 'loading',
  });
  try {
    await generateCreativeVersions(payload, id, undefined, controller.signal, {
      labelOffset,
      onVersion: (version) => {
        pendingTakes = pendingTakes.filter((take) => take.id !== version.id);
        if (!creativeVersions.some((item) => item.id === version.id)) {
          creativeVersions = [...creativeVersions, version];
        }
        if (!selectedCreativeVersion) selectCreativeVersion(version);
        else showCreativeLane();
        updateCreativeAction();
      },
    });
    pendingTakes = pendingTakes.map((take) => (
      take.requestId === id
        ? { ...take, status: 'failed' as const, error: '这个版本没生成出来' }
        : take
    ));
    showCreativeLane();
    bus.post({
      schemaVersion: HUMAN_SEARCH_SCHEMA,
      type: 'creative.status',
      requestId: id,
      projectId: bus.projectId,
      status: 'done',
      count: creativeVersions.filter((version) => version.id.startsWith(`${id}:`)).length,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      pendingTakes = pendingTakes.filter((take) => take.requestId !== id);
      roundCancelled = true;
      showCreativeLane();
      updateCreativeAction();
      return;
    }
    pendingTakes = pendingTakes.map((take) => (
      take.requestId === id
        ? { ...take, status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }
        : take
    ));
    showCreativeLane();
    if (!creativeVersions.length && pendingTakes.every((take) => take.status === 'failed')) {
      $('creativePreviewEmpty').classList.remove('hidden');
      $('creativePreviewEmpty').querySelector('strong')!.textContent = TASK_STATE_LABEL.failed;
      $('creativePreviewEmpty').querySelector('p')!.textContent =
        error instanceof Error ? error.message : String(error);
    }
    bus.post({
      schemaVersion: HUMAN_SEARCH_SCHEMA,
      type: 'creative.status',
      requestId: id,
      projectId: bus.projectId,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (creativeGenerationControllers.get(id) === controller) {
      creativeGenerationControllers.delete(id);
    }
    updateCreativeAction();
  }
}

function initLeftPane(): void {
  restoreLeftState();
  document.querySelectorAll<HTMLButtonElement>('.audio-mode-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.mode;
      if (next === 'voice' || next === 'generate') setMode(next);
    });
  });
  $('runCreativeBtn').addEventListener('click', dispatchCreativeRequest);
  $('voiceCreationForm').addEventListener('submit', (event) => event.preventDefault());
  $('audioGenerationForm').addEventListener('submit', (event) => event.preventDefault());
  // 未开始 ↔ 可执行 由必填文本决定，得随输入翻转，不能等到点生成才更新。
  for (const id of ['voiceScript', 'generationPrompt']) {
    $(id).addEventListener('input', updateCreativeAction);
  }
  $('voiceEmotionChoices').querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      selectedVoiceEmotion = button.dataset.value || '平静';
      setExclusiveChoice($('voiceEmotionChoices'), button);
    });
  });
  $<HTMLSelectElement>('voiceVariationCount').addEventListener('change', updateCreativeAction);
  $('generationVariationCount').querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      setExclusiveChoice($('generationVariationCount'), button);
      updateCreativeAction();
    });
  });
  const durationNumber = $<HTMLInputElement>('generationDuration');
  const durationRange = $<HTMLInputElement>('generationDurationRange');
  durationNumber.addEventListener('input', () => syncGenerationDuration(Number(durationNumber.value)));
  durationNumber.addEventListener('change', () => syncGenerationDuration(Number(durationNumber.value)));
  durationRange.addEventListener('input', () => syncGenerationDuration(Number(durationRange.value)));
  document.querySelectorAll<HTMLButtonElement>('[data-generation-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextKind = button.dataset.generationKind === 'sfx' ? 'sfx' : 'bgm';
      if (nextKind !== creativeKind) {
        creativeKind = nextKind;
        $<HTMLInputElement>('generationDuration').value = String(durationRangeFor(nextKind).default);
      }
      updateCreativeForm();
      void refreshAudioGenerationStatus();
    });
  });

  bus.subscribe((message) => {
    if (message.type === 'view.mode') {
      setMode(message.mode, false);
      return;
    }
    if (message.type === 'creative.reset') {
      inflightCreativeIds.clear();
      updateCreativeAction();
      return;
    }
    if (message.type === 'creative.status') {
      if (message.status === 'done' || message.status === 'error') {
        inflightCreativeIds.delete(message.requestId);
      }
      updateCreativeAction();
      if (message.status === 'error') showToast(message.error || '生成失败', 'error');
    }
  });

  updateCreativeForm();
  void refreshAudioGenerationStatus();
  setMode(mode, false);
}

function initCenterPane(): void {
  const bindings = initAudioBindingsUi(
    bus.projectId,
    ({ slug, revision }) => {
      bridge.postChat(
        `请完成游戏“${slug}”的音频事件接入：音频项目 v${revision} 已由用户在声音设计界面应用。请读取 audio/project.json 和 src/forgeax-audio，仅在事件真正成立的位置最小化插入 gameAudio.emit 字面量调用，保留用户现有逻辑，然后运行 verify-audio-project、typecheck 和现有测试。无需再次询问是否应用音频项目。`,
      );
    },
    (state) => {
      bus.post({
        schemaVersion: HUMAN_SEARCH_SCHEMA,
        type: 'bindings.state',
        requestId: requestId(),
        projectId: bus.projectId,
        slug: state.slug,
        revisionLabel: state.revisionLabel,
        bindingCount: state.bindingCount,
        busy: state.busy,
      });
    },
    (prompt) => bridge.postChat(prompt),
  );
  const design = initAudioDesignUi(bus.projectId, {
    bindings,
    onApplied: ({ slug, revision }) => {
      bridge.postChat(
        `请完成游戏“${slug}”的音频事件接入：音频项目 v${revision} 已由用户在声音设计界面应用。请读取 audio/project.json 和 src/forgeax-audio，仅在事件真正成立的位置最小化插入 gameAudio.emit 字面量调用，保留用户现有逻辑，然后运行 verify-audio-project、typecheck 和现有测试。无需再次询问是否应用音频项目。`,
      );
    },
    onStateChange: (state) => {
      bus.post({
        schemaVersion: HUMAN_SEARCH_SCHEMA,
        type: 'bindings.state',
        requestId: requestId(),
        projectId: bus.projectId,
        slug: state.slug,
        revisionLabel: state.revisionLabel,
        bindingCount: state.bindingCount,
        busy: state.busy,
        workspace: state.workspace,
      });
      const scanBtn = document.getElementById('bindingEventsScanBtn') as HTMLButtonElement | null;
      if (scanBtn) scanBtn.disabled = state.busy || !state.slug;
    },
  });
  workspaceSlug = () => design.currentSlug();

  // The workspace follows the Studio's active project. `bus.projectId` already
  // carries the iframe's `?slug=`; this covers a frame opened before a project
  // was active, and keeps a long-lived frame in sync across switches.
  if (!design.currentSlug()) {
    void resolveActiveGameSlug().then((slug) => {
      if (slug && !design.currentSlug()) design.selectGame(slug);
    });
  }
  subscribeActiveGame(() => design.currentSlug(), (slug) => {
    if (slug) design.selectGame(slug);
  });

  $('bindingEventsScanBtn').addEventListener('click', () => {
    design.scan();
  });

  const player = $<HTMLAudioElement>('creativeAudioPlayer');
  shapingEngine = new AudioShapingEngine(player);
  const playButton = $('creativeMockPlay');
  const syncCreativePlayback = (): void => {
    const duration = Number.isFinite(player.duration)
      ? player.duration
      : selectedCreativeVersion?.durationSeconds ?? 0;
    const progress = duration > 0 ? (player.currentTime / duration) * 100 : 0;
    $('creativeCurrentTime').textContent = formatCreativeDuration(player.currentTime);
    ($('creativeProgress').querySelector('i') as HTMLElement).style.width = `${Math.min(100, progress)}%`;
  };
  playButton.addEventListener('click', () => {
    if (!selectedCreativeVersion?.dataUrl) {
      showToast('当前版本没有可播放的真实音频', 'warning');
      return;
    }
    if (player.paused) void player.play();
    else player.pause();
  });
  player.addEventListener('play', () => {
    void shapingEngine?.resume();
    playButton.classList.add('is-playing');
    playButton.textContent = 'Ⅱ';
    $('creativeMockWave').classList.add('is-playing');
  });
  player.addEventListener('pause', () => {
    playButton.classList.remove('is-playing');
    playButton.textContent = '▶';
    $('creativeMockWave').classList.remove('is-playing');
  });
  player.addEventListener('timeupdate', syncCreativePlayback);
  player.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(player.duration) && player.duration > 0) {
      $('creativeMockDuration').textContent = formatCreativeDuration(player.duration);
    }
    syncCreativePlayback();
  });
  player.addEventListener('ended', () => {
    player.currentTime = 0;
    syncCreativePlayback();
  });
  $('creativeProgress').addEventListener('click', (event) => {
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;
    const bounds = $('creativeProgress').getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    player.currentTime = ratio * player.duration;
  });
  for (const control of SHAPING_CONTROLS) {
    $<HTMLInputElement>(control.inputId).addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      shapingParams = sanitizeAudioShapingParams({
        ...shapingParams,
        [control.key]: input.valueAsNumber,
      });
      shapingBypassed = false;
      const key = selectedShapingKey();
      if (key) shapingDrafts.set(key, { params: { ...shapingParams }, saved: false });
      renderShapingControls();
    });
  }
  $('shapingCompareBtn').addEventListener('click', () => {
    if (isDefaultAudioShaping(shapingParams)) return;
    shapingBypassed = !shapingBypassed;
    renderShapingControls();
  });
  $('shapingResetBtn').addEventListener('click', () => {
    shapingParams = { ...DEFAULT_AUDIO_SHAPING };
    shapingBypassed = false;
    const key = selectedShapingKey();
    if (key) shapingDrafts.set(key, { params: { ...shapingParams }, saved: false });
    renderShapingControls();
  });
  $('shapingSaveBtn').addEventListener('click', () => {
    if (!selectedCreativeVersion) return;
    if (storeCurrentShaping()) {
      renderShapingControls();
      showToast('调音参数已保存，原始音频未修改', 'success');
    } else {
      showToast('参数保存失败', 'error');
    }
  });
  renderShapingControls();

  bus.subscribe((message) => {
    if (message.type === 'view.mode') {
      design.setWorkspace('audio');
      return;
    }
    if (message.type === 'bindings.select') {
      design.selectGame(message.slug);
      return;
    }
    if (message.type === 'bindings.scan') {
      design.scan();
      return;
    }
    if (message.type === 'bindings.workspace') {
      design.setWorkspace(message.workspace);
      return;
    }
    if (message.type === 'bindings.state.request') {
      design.publishState();
      return;
    }
    if (message.type === 'creative.reset') {
      abortAllCreativeJobs();
      design.setWorkspace('audio');
      resetCreativePreview();
      return;
    }
    if (message.type === 'creative.request') {
      design.setWorkspace('audio');
      void handleCreativeRequest(message.payload, message.requestId);
    }
  });

  $('saveCreativeDraftBtn').addEventListener('click', downloadSelectedCreativeVersion);
  $('publishCreativeBtn').addEventListener('click', () => {
    if (!selectedCreativeVersion) {
      showToast('请先选择一个变体', 'warning');
      return;
    }
    const button = $<HTMLButtonElement>('publishCreativeBtn');
    const shaping = isDefaultAudioShaping(shapingParams) ? undefined : { ...shapingParams };
    void openAttachEventPopover(button, {
      defaultSlug: design.currentSlug(),
      version: selectedCreativeVersion,
      shaping,
      onBusy: (busy) => { button.disabled = busy; },
      onAttached: ({ slug, eventId, file, path }) => {
        if (selectedCreativeVersion) selectedCreativeVersion.projectPath = path;
        bindings.selectEvent?.(eventId);
        design.selectGame(slug);
        design.setWorkspace('events');
        const name = file.split('/').pop() || file;
        showToast(`已配入 ${eventId} · ${name} 已写入系统文件`, 'success');
      },
    }).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });
}

function initPlatformBridge(): void {
  bridge.onMessage((message) => {
    if (!hasLeftPane) return;
    if (message.type === 'refresh') {
      window.location.reload();
    }
  });
  bridge.sendReady();
  bridge.sendStateChange({ status: 'idle' });
}

function init(): void {
  if (hasLeftPane) initLeftPane();
  if (hasCenterPane) initCenterPane();
  initPlatformBridge();
  window.addEventListener('beforeunload', () => {
    abortAllCreativeJobs();
    shapingEngine?.close();
    bus.close();
  }, { once: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
