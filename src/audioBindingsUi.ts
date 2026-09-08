import {
  audioBindingAssets,
  type AudioAssetRef,
  type AudioBinding,
  type AudioCondition,
  type AudioConditionOperator,
  type AudioFollowCase,
  type AudioFollowRule,
  type AudioKind,
  type AudioProject,
  type AudioShapingParams,
  type AudioVariationMode,
} from '../shared/audio-project.ts';
import {
  applyBindingEdit,
  buildAudioProjectPatch,
  conditionFromFields,
  createBindingDraft,
  removeBindingFromDraft,
  upsertBindingInDraft,
  type AudioBindingEdit,
} from './audioBindingsEditor.ts';
import {
  applyAudioProjectDraft,
  getAudioProject,
  inspectAudioEvents,
  patchAudioProjectDraft,
  verifyAppliedAudioProject,
  type AudioEventCandidate,
} from './audioProjectApi.ts';
import { mergeShaping } from '../runtime/forgeax-audio-runtime.ts';
import {
  applyPreviewShaping,
  currentPreviewKey,
  onPreviewChange,
  previewKey,
  stopPreview,
  togglePreview,
} from './audioPreviewPlayer.ts';
import { gameAudioUrl } from './proxyUrl.ts';
import { enablePreciseOutput, showToast } from './utils.ts';
import { filenameFromPath, projectPathForGameAudio } from './assetPath.ts';
import { showAssetContextMenu } from './assetContextMenu.ts';
import {
  EVENT_GENRES,
  bindingFromPreset,
  customPreset,
  presetsFor,
  wireIntoGamePrompt,
  type EventGenre,
  type EventPreset,
} from './eventCatalog.ts';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function input(value: string, placeholder: string, ariaLabel: string): HTMLInputElement {
  const node = document.createElement('input');
  node.value = value;
  node.placeholder = placeholder;
  node.setAttribute('aria-label', ariaLabel);
  return node;
}

const DEFAULT_EVENT_SHAPING: AudioShapingParams = {
  gainDb: 0,
  pitchSemitones: 0,
  highpassHz: 20,
  lowpassHz: 20_000,
  eqLowDb: 0,
  eqMidDb: 0,
  eqHighDb: 0,
};

type FollowPreset = 'none' | 'surface' | 'phase' | 'speed' | 'health' | 'distance' | 'custom-cases' | 'custom-range';
type FollowEffect = 'intense' | 'distant' | 'recover' | 'calm';

/** 分支素材选择器里代表「不复用顶层素材，本分支自己填一个文件」的档位。 */
const OWN_CASE_ASSET = 'own';

/**
 * 分支专属素材。assetId 优先沿用已有的（Agent 写的要保住），否则按文件名兜底，
 * 免得保存时卡在「有未填写完整的声音」而用户看不出差在哪。
 */
function ownCaseAsset(previous: AudioAssetRef | undefined, file: string): AudioAssetRef | undefined {
  if (!file) return undefined;
  const fallbackId = (file.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  return {
    assetId: previous?.assetId.trim() || fallbackId,
    file,
    ...(previous?.name ? { name: previous.name } : {}),
    ...(previous?.shaping ? { shaping: previous.shaping } : {}),
  };
}

function followRange(effect: FollowEffect, min: number, max: number): NonNullable<AudioFollowRule['range']> {
  const effects: Record<FollowEffect, Omit<NonNullable<AudioFollowRule['range']>, 'min' | 'max'>> = {
    intense: { volumeStart: 0.72, volumeEnd: 1.12, pitchStart: -2, pitchEnd: 2, lowpassStart: 8_000, lowpassEnd: 20_000 },
    distant: { volumeStart: 1, volumeEnd: 0.45, pitchStart: 0, pitchEnd: 0, lowpassStart: 20_000, lowpassEnd: 2_500 },
    recover: { volumeStart: 0.82, volumeEnd: 1, pitchStart: -2, pitchEnd: 0, lowpassStart: 3_500, lowpassEnd: 20_000 },
    calm: { volumeStart: 1.08, volumeEnd: 0.72, pitchStart: 2, pitchEnd: -2, lowpassStart: 20_000, lowpassEnd: 7_000 },
  };
  return { min, max, ...effects[effect] };
}

function matchingFollowEffect(range: NonNullable<AudioFollowRule['range']>): FollowEffect {
  if (range.lowpassEnd <= 3_000 && range.volumeEnd < range.volumeStart) return 'distant';
  if (range.lowpassStart <= 4_000 && range.lowpassEnd >= 18_000) return 'recover';
  if (range.pitchStart > range.pitchEnd && range.volumeStart > range.volumeEnd) return 'calm';
  return 'intense';
}

function followPreset(rule: AudioFollowRule | undefined): FollowPreset {
  if (!rule) return 'none';
  if (rule.field === 'surface.material' && rule.cases) return 'surface';
  if (rule.field === 'game.phase' && rule.cases) return 'phase';
  if (rule.field === 'player.speed' && rule.range) return 'speed';
  if (rule.field === 'player.health' && rule.range) return 'health';
  if (rule.field === 'distance' && rule.range) return 'distance';
  return rule.cases ? 'custom-cases' : 'custom-range';
}

/** 区1 分类栏的档位：前四个按声音类型分，后两个按状态分。 */
type LibraryFilter = 'all' | AudioKind | 'missing' | 'scanned';

const KIND_LABEL: Record<AudioKind, string> = { sfx: '音效', music: '音乐', voice: '语音' };

const VARIATION_LABEL: Record<AudioVariationMode, string> = {
  single: '只用第一个',
  sequential: '按顺序轮播',
  'random-no-repeat': '随机且不连续重复',
};

const EFFECT_LABEL: Record<FollowEffect, string> = {
  intense: '越大越强烈',
  distant: '越大越遥远',
  recover: '越大越恢复正常',
  calm: '越大越柔和',
};

const CONFIDENCE_LABEL: Record<'high' | 'medium' | 'low', string> = {
  high: '把握高',
  medium: '把握中',
  low: '把握低',
};

/**
 * 确定性伪随机波形。同一个种子必须永远画出同一条波形：卡片会因为改一个滑杆就
 * 重渲染，每次换形状会让人以为声音也被改了。算法与 main.ts 的生成结果卡一致。
 */
function waveHeights(seed: string, count: number): number[] {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  return Array.from({ length: count }, () => {
    hash = (hash * 1103515245 + 12345) | 0;
    return 18 + Math.abs(hash % 82);
  });
}

function waveBars(host: HTMLElement, seed: string, count: number): void {
  for (const height of waveHeights(seed, count)) {
    const bar = document.createElement('i');
    bar.style.height = `${height}%`;
    host.appendChild(bar);
  }
}

function tag(text: string, modifier = ''): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = modifier ? `gen3-tag ${modifier}` : 'gen3-tag';
  node.textContent = text;
  return node;
}

function stageEmpty(title: string, hint: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'gen3-stage-empty';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const note = document.createElement('span');
  note.textContent = hint;
  node.append(heading, note);
  return node;
}

export function initAudioBindingsUi(
  initialSlug = '',
  onApplied?: (result: { slug: string; revision: number }) => void,
  onStateChange?: (state: {
    slug: string;
    revisionLabel: string;
    bindingCount: number;
    busy: boolean;
  }) => void,
  /** Hands「接入游戏」's prompt to the system Chat so the agent finds the trigger points. */
  onWireIntoGame?: (prompt: string) => void,
): {
  selectGame: (slug: string) => void;
  selectEvent: (eventId: string) => void;
  scan: () => void;
  publishState: () => void;
  reload: () => void;
  queueAsset: (asset: AudioAssetRef) => void;
} {
  let slug = initialSlug === 'default' ? '' : initialSlug.trim();
  let project: AudioProject | null = null;
  let draft: AudioBinding[] = [];
  let selectedEventId = '';
  let candidates: AudioEventCandidate[] = [];
  let scannedFiles: number | null = null;
  let appliedRevision: number | null = null;
  let busy = false;
  /** Audio attached from another workspace, waiting for an event to be picked. */
  let pendingAsset: AudioAssetRef | null = null;
  /** 配入事件后来这里定位；loadProject 结束前不要被默认第一条冲掉。 */
  let pendingEventId = '';
  let libraryFilter: LibraryFilter = 'all';
  let presetGenre: EventGenre = 'common';
  /** Ticked presets, by event id. */
  const presetPicks = new Set<string>();
  /** User-typed events added to the checklist this session. */
  let presetCustom: EventPreset[] = [];
  /** Kept so「接入游戏」still knows what to wire after the ticks are cleared. */
  let presetCreated: EventPreset[] = [];
  let previewMode: 'wave' | 'follow' = 'wave';
  /** 区2 正在预览的变体下标；一条声音播完后按变体方式轮到下一条。 */
  let previewVariant = 0;

  const selected = (): AudioBinding | null => (
    draft.find((binding) => binding.eventId === selectedEventId) ?? null
  );

  /** 换事件就从第一个变体重新数，否则新事件一进来就显示「变体 3 / 3」。 */
  const setSelectedEvent = (eventId: string): void => {
    selectedEventId = eventId;
    previewVariant = 0;
  };

  const setStatus = (message: string): void => {
    byId('bindingStatus').textContent = message;
  };

  const setBusy = (nextBusy: boolean): void => {
    busy = nextBusy;
    for (const id of ['bindingSaveBtn', 'bindingApplyBtn', 'bindingVerifyBtn']) {
      byId<HTMLButtonElement>(id).disabled = nextBusy || !slug;
    }
    renderPresetCatalog();
    publishState();
  };

  const revisionLabel = (): string => project
      ? `草稿 v${project.revision}${appliedRevision === project.revision ? ' · 已应用' : ' · 待应用'}`
      : '未打开游戏工程';

  function publishState(): void {
    onStateChange?.({
      slug,
      revisionLabel: revisionLabel(),
      bindingCount: draft.length,
      busy,
    });
  }

  /** 区1 标题栏：先说库里有什么、缺什么，再说草稿状态。 */
  const updateHeader = (): void => {
    const missing = draft.filter(needsAudio).length;
    byId('bindingRevision').textContent = project
      ? `${draft.length} 个事件${missing ? ` · ${missing} 个待补声音` : ''} · ${revisionLabel()}`
      : revisionLabel();
    publishState();
  };

  // 每次重渲染都会丢弃旧按钮，这里按区域回收播放状态订阅，避免监听器堆积。
  const previewDisposers = new Map<string, Array<() => void>>();

  /**
   * 试听要听到的是「调完参数之后」的声音，所以按 runtime 的口径把素材层和事件
   * 层叠起来（顺序与 runtime 一致），音量则另算一道。跟随规则依赖运行期的游戏
   * 变量，静态试听取不到，这里只还原静态部分。
   */
  const previewTarget = (
    binding: AudioBinding | null,
    asset: AudioAssetRef | undefined,
    file: string,
  ): { file: string; shaping?: AudioShapingParams; volume: number } => ({
    file,
    shaping: mergeShaping(asset?.shaping, binding?.shaping),
    volume: binding?.playback.volume ?? 1,
  });

  /** 调 EQ / 音量时改写正在响的那一条，不用停下来重播。 */
  const refreshLivePreview = (): void => {
    const playing = currentPreviewKey();
    if (!playing) return;
    const binding = selected();
    const asset = binding
      && audioBindingAssets(binding).find((item) => previewKey(slug, item.file) === playing);
    if (!binding || !asset) return;
    const target = previewTarget(binding, asset, asset.file);
    applyPreviewShaping(target.shaping, target.volume);
  };

  /**
   * 试听按钮。file 为空（该事件还没配声音）时按钮置灰，避免让人点了没反应还
   * 不知道为什么。
   */
  const playButton = (
    scope: string,
    getTarget: () => { file: string; shaping?: AudioShapingParams; volume: number },
    label: string | (() => string),
    className = 'binding-play-btn',
  ): { el: HTMLButtonElement; refresh: () => void } => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    const sync = (playing: string): void => {
      const { file } = getTarget();
      const active = Boolean(file) && playing === previewKey(slug, file);
      const name = typeof label === 'function' ? label() : label;
      button.disabled = !slug || !file;
      button.classList.toggle('is-playing', active);
      button.textContent = active ? '■' : '▶';
      const action = active ? '停止' : '试听';
      button.title = button.disabled ? '该事件还没有声音文件' : `${action} ${name}`;
      button.setAttribute('aria-label', `${action} ${name}`);
    };
    sync(currentPreviewKey());
    const disposers = previewDisposers.get(scope) ?? [];
    disposers.push(onPreviewChange(sync));
    previewDisposers.set(scope, disposers);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePreview({
        slug,
        ...getTarget(),
        onError: (message) => showToast(message, 'error'),
      });
    });
    return { el: button, refresh: () => sync(currentPreviewKey()) };
  };

  const resetPreviewScope = (scope: string): void => {
    for (const dispose of previewDisposers.get(scope) ?? []) dispose();
    previewDisposers.set(scope, []);
  };

  /** 能真正响的声音。素材可以只挂在跟随分支下（Agent 常这么写），按全量口径数。 */
  const playableAssets = (binding: AudioBinding): AudioAssetRef[] => (
    audioBindingAssets(binding).filter((asset) => asset.file.trim())
  );

  const needsAudio = (binding: AudioBinding): boolean => playableAssets(binding).length === 0;

  /**
   * 扫到但还没进草稿的事件。已绑定的那些不再列进来——它们就在上面的卡片网格里，
   * 重复出现只会让人以为要再添加一次。一个事件在代码里喊十次也只是一个声音，
   * 按事件名合并。
   */
  const newCandidates = (): Array<{ first: AudioEventCandidate; count: number }> => {
    const bound = new Set(draft.map((binding) => binding.eventId));
    const grouped = new Map<string, { first: AudioEventCandidate; count: number }>();
    for (const candidate of candidates) {
      if (bound.has(candidate.eventId)) continue;
      const seen = grouped.get(candidate.eventId);
      if (seen) seen.count += 1;
      else grouped.set(candidate.eventId, { first: candidate, count: 1 });
    }
    return [...grouped.values()];
  };

  const filteredBindings = (): AudioBinding[] => {
    if (libraryFilter === 'scanned') return [];
    if (libraryFilter === 'all') return draft;
    if (libraryFilter === 'missing') return draft.filter(needsAudio);
    return draft.filter((binding) => binding.kind === libraryFilter);
  };

  const selectEvent = (eventId: string): void => {
    setSelectedEvent(eventId);
    renderAll();
  };

  const renderChips = (): void => {
    const host = byId('bindingChips');
    host.innerHTML = '';
    const counts: Record<LibraryFilter, number> = {
      all: draft.length,
      sfx: draft.filter((binding) => binding.kind === 'sfx').length,
      music: draft.filter((binding) => binding.kind === 'music').length,
      voice: draft.filter((binding) => binding.kind === 'voice').length,
      missing: draft.filter(needsAudio).length,
      scanned: newCandidates().length,
    };
    // 过滤档位会被草稿变化清空（补完最后一个缺声音的事件就是这样），留在空网格
    // 上会让人以为清单丢了，这里退回「全部」。
    if (libraryFilter !== 'all' && counts[libraryFilter] === 0) libraryFilter = 'all';
    const rule = (text: string): void => {
      const node = document.createElement('div');
      node.className = 'gen3-chips-rule';
      node.textContent = text;
      host.appendChild(node);
    };
    const chip = (filter: LibraryFilter, label: string, modifier = ''): void => {
      const button = document.createElement('button');
      button.type = 'button';
      const isSelected = libraryFilter === filter;
      button.className = ['gen3-chip', isSelected ? 'is-selected' : '', modifier].filter(Boolean).join(' ');
      button.setAttribute('aria-pressed', String(isSelected));
      const count = document.createElement('strong');
      count.textContent = String(counts[filter]);
      button.append(label, count);
      button.addEventListener('click', () => {
        libraryFilter = filter;
        renderChips();
        renderBindingList();
        renderCandidates();
      });
      host.appendChild(button);
    };
    rule('分类');
    chip('all', '全部');
    chip('sfx', '音效');
    chip('music', '音乐');
    chip('voice', '语音');
    if (counts.missing || counts.scanned) rule('状态');
    if (counts.missing) chip('missing', '待补声音', 'is-warn');
    if (counts.scanned) chip('scanned', '扫描发现', 'is-info');
  };

  /**
   * 区1 卡片网格。库只负责浏览和选中：卡片上不放试听或删除按钮，编辑动作一律
   * 留给区3，试听由区2 的播放控制统一承担。
   */
  const renderBindingList = (): void => {
    const list = byId('bindingList');
    list.innerHTML = '';
    const items = filteredBindings();
    const empty = byId('bindingListEmpty');
    // 「扫描发现」档位下网格是刻意空的，这时只该看到下面的候选分组。
    empty.classList.toggle('hidden', items.length > 0 || libraryFilter === 'scanned');
    empty.textContent = draft.length === 0
      ? '还没有声音事件：从下面的扫描发现里挑一个，或在下方“手动添加事件”里填事件名。'
      : '这个档位下没有事件。';
    for (const binding of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `gen3-card${binding.eventId === selectedEventId ? ' is-selected' : ''}`;
      card.title = `${binding.label || binding.eventId} · ${binding.eventId}`;
      const assets = playableAssets(binding);
      const thumb = document.createElement('div');
      thumb.className = `gen3-thumb${binding.kind === 'music' ? ' is-music' : ''}`;
      waveBars(thumb, assets[0]?.file ?? binding.eventId, 22);
      const body = document.createElement('div');
      body.className = 'gen3-cbody';
      const title = document.createElement('h3');
      title.textContent = binding.label || binding.eventId;
      const event = document.createElement('p');
      event.textContent = binding.eventId;
      const tags = document.createElement('div');
      tags.className = 'gen3-tags';
      tags.append(binding.playback.spatial === '3d' ? tag('3D', 'is-accent') : tag('2D'));
      tags.append(assets.length ? tag(`${assets.length} 变体`) : tag('缺声音', 'is-warn'));
      if (binding.follow) tags.append(tag('跟随', 'is-cyan'));
      if (!binding.enabled) tags.append(tag('已停用'));
      body.append(title, event, tags);
      card.append(thumb, body);
      card.addEventListener('click', () => { selectEvent(binding.eventId); });
      card.addEventListener('contextmenu', (event) => {
        const asset = assets[0];
        const path = asset && slug ? projectPathForGameAudio(slug, asset.file) : '';
        showAssetContextMenu(event, {
          title: `${binding.label || binding.eventId}`,
          filename: path ? filenameFromPath(path) : '',
          projectPath: path || undefined,
          missingReason: path ? undefined : '这个事件还没有声音文件',
        });
      });
      list.appendChild(card);
    }
  };

  const renderCandidates = (): void => {
    const group = byId('bindingCandidateGroup');
    group.classList.toggle('hidden', libraryFilter !== 'all' && libraryFilter !== 'scanned');
    const list = byId('bindingCandidateList');
    // 候选也是库里的卡片，沿用同一套网格。
    list.classList.add('gen3-cards');
    list.innerHTML = '';
    const items = newCandidates();
    const empty = byId('bindingCandidatesEmpty');
    empty.classList.toggle('hidden', items.length > 0);
    if (!items.length) {
      const scannedEvents = new Set(candidates.map((candidate) => candidate.eventId)).size;
      empty.textContent = scannedFiles === null
        ? '打开游戏工程后点击“扫描游戏事件”。'
        : scannedEvents
          ? `扫到的 ${scannedEvents} 个事件都已经在上面的清单里了。`
          : `扫了 ${scannedFiles} 个源文件，没找到 gameAudio.emit('x')、sfx.play('x') 这类带事件名的调用`
            + '（用 ECS 组件播声音的游戏就属于这种）。可以在下方“手动添加事件”里补。';
    }
    for (const { first, count } of items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'gen3-card';
      card.title = `添加并编辑 ${first.eventId}`;
      const body = document.createElement('div');
      body.className = 'gen3-cbody';
      const title = document.createElement('h3');
      title.textContent = first.eventId;
      const source = document.createElement('p');
      source.textContent = count > 1
        ? `${first.file}:${first.line} 等 ${count} 处`
        : `${first.file}:${first.line}`;
      const tags = document.createElement('div');
      tags.className = 'gen3-tags';
      tags.append(tag('扫描发现', 'is-cyan'), tag(CONFIDENCE_LABEL[first.confidence]));
      body.append(title, source, tags);
      card.append(body);
      card.addEventListener('click', () => {
        draft = upsertBindingInDraft(draft, createBindingDraft(first.eventId, first.eventId));
        selectEvent(first.eventId);
      });
      list.appendChild(card);
    }
  };

  /** 区2 当前该预览的变体：素材被删到只剩一条时下标要收回来。 */
  const previewAsset = (binding: AudioBinding): AudioAssetRef | undefined => {
    const assets = playableAssets(binding);
    if (!assets.length) return undefined;
    return assets[Math.min(previewVariant, assets.length - 1)];
  };

  const previewVariantTarget = (): { file: string; shaping?: AudioShapingParams; volume: number } => {
    const binding = selected();
    const asset = binding ? previewAsset(binding) : undefined;
    return previewTarget(binding, asset, asset?.file ?? '');
  };

  const renderWaveStage = (stage: HTMLElement, binding: AudioBinding): void => {
    const assets = playableAssets(binding);
    if (!assets.length) {
      stage.append(stageEmpty('这个事件还没有声音', '在下方“播放的声音”里填游戏相对路径，如 audio/hit.wav 或 assets/audio/footstep.mp3。'));
      return;
    }
    for (const scope of [...previewDisposers.keys()]) {
      if (scope.startsWith('wave-var-')) resetPreviewScope(scope);
    }
    const list = document.createElement('div');
    list.className = 'gen3-variants';
    const current = Math.min(previewVariant, assets.length - 1);
    assets.forEach((asset, index) => {
      const row = document.createElement('div');
      row.className = `gen3-varow${index === current ? ' is-active' : ''}`;
      const play = playButton(
        `wave-var-${index}`,
        () => previewTarget(binding, asset, asset.file),
        () => asset.name || asset.file || `变体 ${index + 1}`,
        'gen3-ibtn',
      );
      play.el.addEventListener('click', () => {
        previewVariant = index;
        for (const node of list.children) node.classList.remove('is-active');
        row.classList.add('is-active');
      });
      const copy = document.createElement('div');
      copy.className = 'gen3-varow-copy';
      const title = document.createElement('b');
      title.textContent = asset.name || `变体 ${index + 1}`;
      const wave = document.createElement('div');
      wave.className = 'gen3-wave';
      waveBars(wave, asset.file, 36);
      copy.append(title, wave);
      row.append(play.el, copy);
      row.addEventListener('contextmenu', (event) => {
        const path = slug ? projectPathForGameAudio(slug, asset.file) : '';
        showAssetContextMenu(event, {
          title: asset.name || `变体 ${index + 1}`,
          filename: path ? filenameFromPath(path) : asset.file,
          projectPath: path || undefined,
          missingReason: path ? undefined : '先打开游戏工程才能引用和定位',
        });
      });
      list.append(row);
    });
    stage.append(list);
  };

  const renderFollowStage = (stage: HTMLElement, binding: AudioBinding): void => {
    const rule = binding.follow;
    if (!rule) {
      stage.append(stageEmpty('未配置跟随', '在下方“跟随游戏变化”里选一种，声音就会随游戏变量走。'));
      return;
    }
    const axis = document.createElement('div');
    axis.className = 'gen3-axis';
    const axisTick = (text: string): void => {
      const span = document.createElement('span');
      span.textContent = text;
      axis.appendChild(span);
    };
    if (rule.cases) {
      // 分支枚举：跟随变量取到哪个值就播哪一条，默认值那条标出来。
      const bars = document.createElement('div');
      bars.className = 'gen3-bars';
      const shown = rule.cases.slice(0, 8);
      for (const item of shown) {
        const span = document.createElement('span');
        const name = item.label ? `${String(item.value)}（${item.label}）` : String(item.value);
        const hasAudio = item.assets.some((asset) => asset.file.trim());
        span.textContent = hasAudio ? name : `${name} · 缺声音`;
        if (String(item.value) === String(rule.defaultValue)) span.className = 'is-selected';
        bars.appendChild(span);
      }
      if (rule.cases.length > shown.length) {
        const more = document.createElement('span');
        more.textContent = `+${rule.cases.length - shown.length}`;
        bars.appendChild(more);
      }
      stage.append(bars);
      axisTick(`跟随 ${rule.field}`);
      axisTick(`${rule.cases.length} 个分支 · 其余用默认声音`);
    } else if (rule.range) {
      const { min, max, volumeStart, volumeEnd } = rule.range;
      const overlay = document.createElement('div');
      overlay.className = 'gen3-ov';
      overlay.append(
        tag(rule.label || rule.field, 'is-cyan'),
        tag(EFFECT_LABEL[matchingFollowEffect(rule.range)]),
      );
      // 音量随取值连续变化的那条线。viewBox 用 0..100 两个方向都按舞台拉满。
      const top = Math.max(volumeStart, volumeEnd, 1);
      const y = (volume: number): number => 92 - (volume / top) * 74;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'gen3-curve');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      area.setAttribute('points', `0,${y(volumeStart)} 100,${y(volumeEnd)} 100,100 0,100`);
      area.setAttribute('fill', 'rgba(212, 255, 72, .12)');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.setAttribute('points', `0,${y(volumeStart)} 100,${y(volumeEnd)}`);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#d4ff48');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(area, line);
      stage.append(overlay, svg);
      axisTick(`${min} · 音量 ${Math.round(volumeStart * 100)}%`);
      axisTick(rule.field);
      axisTick(`${max} · 音量 ${Math.round(volumeEnd * 100)}%`);
    }
    stage.append(axis);
  };

  /** 区2 只读：只留波形 / 跟随可视化 + 试听，参数都在下方编辑区改。 */
  function renderPreview(): void {
    const binding = selected();
    for (const button of byId('bindingPreviewSeg').querySelectorAll<HTMLButtonElement>('[data-binding-preview]')) {
      const isSelected = button.dataset.bindingPreview === previewMode;
      button.classList.toggle('is-selected', isSelected);
      button.setAttribute('aria-selected', String(isSelected));
    }
    previewTransport.refresh();
    byId('bindingPreviewSub').textContent = binding
      ? `${binding.eventId} · ${previewMode === 'wave' ? '波形试听' : '跟随曲线'}`
      : '选择事件后试听';
    const stage = byId('bindingPreviewStage');
    stage.innerHTML = '';
    if (!binding) {
      stage.append(stageEmpty('还没有选中事件', '在左边的库里点一张卡片，这里只用来试听。'));
      return;
    }
    if (previewMode === 'wave') renderWaveStage(stage, binding);
    else renderFollowStage(stage, binding);
  }

  // 区2 的播放控制只建一次：它自己订阅播放状态，重复创建会堆监听器。
  const previewTransport = playButton(
    'transport',
    previewVariantTarget,
    () => {
      const binding = selected();
      if (!binding) return '选中的声音';
      const assets = playableAssets(binding);
      return assets.length > 1
        ? `${binding.label || binding.eventId} 变体 ${Math.min(previewVariant, assets.length - 1) + 1}`
        : binding.label || binding.eventId;
    },
    'gen3-abtn',
  );
  byId('bindingPreviewSeg').insertAdjacentElement('afterend', previewTransport.el);

  byId('bindingPreviewSeg').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-binding-preview]');
    if (!button) return;
    const mode = button.dataset.bindingPreview === 'follow' ? 'follow' : 'wave';
    if (mode === previewMode) return;
    previewMode = mode;
    renderPreview();
  });

  /**
   * 一条变体播完就轮到下一条，和 runtime 的变体方式对齐——这样「变体 2 / 3」
   * 这行读数才是真的，而不是永远停在第一条。
   */
  let lastPlayingKey = currentPreviewKey();
  onPreviewChange((playing) => {
    const previous = lastPlayingKey;
    lastPlayingKey = playing;
    if (playing || !previous) return;
    const binding = selected();
    const asset = binding ? previewAsset(binding) : undefined;
    if (!binding || !asset || previewKey(slug, asset.file) !== previous) return;
    const total = playableAssets(binding).length;
    const index = Math.min(previewVariant, total - 1);
    if (total < 2 || binding.variation.mode === 'single') return;
    if (binding.variation.mode === 'sequential') previewVariant = (index + 1) % total;
    else {
      let next = index;
      while (next === index) next = Math.floor(Math.random() * total);
      previewVariant = next;
    }
    renderPreview();
  });

  /** 卡片上的标签、分类计数和区2 的只读读数都要跟着编辑器改动走。 */
  const CARD_EDIT_KEYS: Array<keyof AudioBindingEdit> = ['enabled', 'label', 'kind', 'spatial', 'follow', 'assets'];

  const updateSelected = (edit: AudioBindingEdit, rerenderList = false): void => {
    const current = selected();
    if (!current) return;
    draft = upsertBindingInDraft(draft, applyBindingEdit(current, edit));
    if (rerenderList || CARD_EDIT_KEYS.some((key) => key in edit)) {
      renderChips();
      renderBindingList();
    }
    renderPreview();
    refreshLivePreview();
    updateHeader();
  };

  const renderAssets = (binding: AudioBinding): void => {
    const list = byId('bindingAssetList');
    resetPreviewScope('assets');
    list.innerHTML = '';
    binding.assets.forEach((asset, index) => {
      const row = document.createElement('div');
      row.className = 'binding-repeat-row binding-asset-row';
      const name = input(asset.name ?? '', '显示名称', '声音名称');
      const file = input(asset.file, '游戏相对路径，如 audio/hit.wav', '声音文件');
      file.classList.add('binding-asset-file');
      const play = playButton(
        'assets',
        () => previewTarget(selected(), selected()?.assets[index], file.value.trim()),
        asset.name ?? asset.file,
      );
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'audio-text-btn';
      remove.textContent = '移除';
      const sync = (): void => {
        play.refresh();
        const assets = selected()?.assets.map((item) => ({ ...item })) ?? [];
        const shaping = assets[index]?.shaping;
        assets[index] = {
          assetId: asset.assetId,
          file: file.value.trim(),
          ...(name.value.trim() ? { name: name.value.trim() } : {}),
          ...(shaping ? { shaping } : {}),
        };
        updateSelected({ assets });
      };
      name.addEventListener('input', sync);
      file.addEventListener('input', sync);
      remove.addEventListener('click', () => {
        const assets = (selected()?.assets ?? []).filter((_item, itemIndex) => itemIndex !== index);
        updateSelected({ assets });
        const next = selected();
        if (next) renderAssets(next);
      });
      row.append(name, file, play.el, remove);
      list.appendChild(row);
    });
  };

  const conditionValueText = (condition: AudioCondition): string => (
    typeof condition.value === 'string' ? condition.value : JSON.stringify(condition.value)
  );

  const renderConditions = (binding: AudioBinding): void => {
    const list = byId('bindingConditionList');
    list.innerHTML = '';
    binding.conditions.forEach((condition, index) => {
      const row = document.createElement('div');
      row.className = 'binding-repeat-row binding-condition-row';
      const field = input(condition.field, '条件字段，如 damage', '条件字段');
      const operator = document.createElement('select');
      for (const [value, label] of [
        ['eq', '等于'], ['neq', '不等于'], ['gt', '大于'], ['gte', '大于等于'],
        ['lt', '小于'], ['lte', '小于等于'], ['in', '包含于'],
      ]) operator.appendChild(option(value, label));
      operator.value = condition.operator;
      const value = input(conditionValueText(condition), '值', '条件值');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'audio-text-btn';
      remove.textContent = '移除';
      const sync = (): void => {
        const conditions = selected()?.conditions.map((item) => structuredClone(item)) ?? [];
        const next = conditionFromFields(
          field.value,
          operator.value as AudioConditionOperator,
          value.value,
        );
        if (next) conditions[index] = next;
        updateSelected({ conditions });
      };
      field.addEventListener('input', sync);
      operator.addEventListener('change', sync);
      value.addEventListener('input', sync);
      remove.addEventListener('click', () => {
        const conditions = (selected()?.conditions ?? []).filter((_item, itemIndex) => itemIndex !== index);
        updateSelected({ conditions });
        const next = selected();
        if (next) renderConditions(next);
      });
      row.append(field, operator, value, remove);
      list.appendChild(row);
    });
  };

  const renderFollowCases = (binding: AudioBinding, rule: AudioFollowRule): void => {
    const list = byId('bindingFollowCaseList');
    resetPreviewScope('follow');
    list.innerHTML = '';
    for (const [index, item] of (rule.cases ?? []).entries()) {
      const row = document.createElement('div');
      row.className = 'binding-repeat-row binding-follow-case-row';
      const value = input(String(item.value), '例如 grass', '游戏变量取值');
      const current = item.assets[0];
      const sharedIndex = binding.assets.findIndex((candidate) => (
        candidate.assetId === current?.assetId && candidate.file === current?.file
      ));
      // schema 允许分支自带素材，Agent 也确实这么写（每种材质一条独立音频）。
      // 选择器必须能表达「专属」这一档，否则界面一保存就把分支素材覆盖成顶层的。
      const ownMode = Boolean(current) && sharedIndex < 0;
      const asset = document.createElement('select');
      asset.setAttribute('aria-label', `${String(item.value)}对应的声音`);
      if (binding.assets.length === 0) asset.appendChild(option('', '请先在上方添加声音'));
      binding.assets.forEach((candidate, assetIndex) => {
        asset.appendChild(option(String(assetIndex), candidate.name || candidate.file || `声音 ${assetIndex + 1}`));
      });
      asset.appendChild(option(OWN_CASE_ASSET, '本分支专属素材'));
      asset.value = ownMode ? OWN_CASE_ASSET : sharedIndex >= 0 ? String(sharedIndex) : '';
      const file = input(
        ownMode ? current!.file : '',
        '游戏相对路径，如 assets/audio/footstep_asphalt.mp3',
        `${String(item.value)}的专属声音文件`,
      );
      file.classList.add('binding-asset-file');
      file.disabled = !ownMode;
      if (!ownMode) file.placeholder = '跟随上方素材';
      const play = playButton(
        'follow',
        () => {
          const target = selected()?.follow?.cases?.[index]?.assets[0];
          return previewTarget(selected(), target, target?.file ?? '');
        },
        `${String(item.value)} 的声音`,
      );
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'audio-text-btn';
      remove.textContent = '移除';
      const sync = (): void => {
        const currentRule = selected()?.follow;
        if (!currentRule?.cases) return;
        const cases = currentRule.cases.map((candidate) => structuredClone(candidate));
        const own = asset.value === OWN_CASE_ASSET;
        const previous = cases[index]?.assets[0];
        const mapped = own
          ? ownCaseAsset(previous, file.value.trim())
          : binding.assets[Number(asset.value)];
        cases[index] = {
          ...cases[index]!,
          value: value.value.trim(),
          assets: mapped ? [structuredClone(mapped)] : [],
        };
        file.disabled = !own;
        file.placeholder = own ? '游戏相对路径，如 assets/audio/footstep_asphalt.mp3' : '跟随上方素材';
        if (!own) file.value = '';
        updateSelected({ follow: { ...currentRule, cases } });
        play.refresh();
      };
      value.addEventListener('input', sync);
      asset.addEventListener('change', sync);
      file.addEventListener('input', sync);
      remove.addEventListener('click', () => {
        const currentRule = selected()?.follow;
        if (!currentRule?.cases) return;
        const cases = currentRule.cases.filter((_candidate, caseIndex) => caseIndex !== index);
        if (cases.length === 0) updateSelected({ follow: null });
        else updateSelected({ follow: { ...currentRule, cases } });
        const next = selected();
        if (next) renderFollow(next);
      });
      row.append(value, asset, file, play.el, remove);
      list.appendChild(row);
    }
  };

  const renderFollow = (binding: AudioBinding): void => {
    const preset = followPreset(binding.follow);
    setValue('bindingFollowPreset', preset);
    byId('bindingFollowPanel').classList.toggle('hidden', preset === 'none');
    const custom = preset === 'custom-cases' || preset === 'custom-range';
    byId('bindingFollowFieldRow').classList.toggle('hidden', !custom);
    setValue('bindingFollowField', binding.follow?.field ?? 'game.value');
    const cases = Boolean(binding.follow?.cases);
    byId('bindingFollowCasesPanel').classList.toggle('hidden', !cases);
    byId('bindingFollowRangePanel').classList.toggle('hidden', !binding.follow?.range);
    if (binding.follow?.cases) renderFollowCases(binding, binding.follow);
    if (binding.follow?.range) {
      setRangeValue('bindingFollowMin', 'bindingFollowMinValue', binding.follow.range.min, String);
      setRangeValue('bindingFollowMax', 'bindingFollowMaxValue', binding.follow.range.max, String);
      setValue('bindingFollowEffect', matchingFollowEffect(binding.follow.range));
    }
  };

  const formatDb = (value: number): string => `${value > 0 ? '+' : ''}${value} dB`;

  const renderShaping = (binding: AudioBinding): void => {
    const shaping = binding.shaping ?? DEFAULT_EVENT_SHAPING;
    for (const [inputId, outputId, value] of [
      ['bindingEqLow', 'bindingEqLowValue', shaping.eqLowDb],
      ['bindingEqMid', 'bindingEqMidValue', shaping.eqMidDb],
      ['bindingEqHigh', 'bindingEqHighValue', shaping.eqHighDb],
    ] as const) {
      setValue(inputId, value);
      byId<HTMLOutputElement>(outputId).value = formatDb(value);
    }
    const distance = Math.round((20_000 - shaping.lowpassHz) / 190);
    setValue('bindingDistance', distance);
    byId<HTMLOutputElement>('bindingDistanceValue').value = distance === 0 ? '原声' : `${distance}%`;
  };

  const setValue = (id: string, value: string | number): void => {
    const node = byId<HTMLInputElement | HTMLSelectElement>(id);
    node.value = String(value);
  };

  const formatDuration = (value: number): string => {
    if (value < 1000) return `${value} 毫秒`;
    const seconds = value / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  };

  const setRangeValue = (
    inputId: string,
    outputId: string,
    value: number,
    format: (value: number) => string,
  ): void => {
    const range = byId<HTMLInputElement>(inputId);
    const configuredMax = Number(range.dataset.defaultMax || range.max);
    range.max = String(Math.max(configuredMax, value));
    range.value = String(value);
    byId<HTMLOutputElement>(outputId).value = format(value);
  };

  const renderAttenuationOptions = (binding: AudioBinding): void => {
    const select = byId<HTMLSelectElement>('bindingAttenuation');
    const current = binding.playback.attenuationId ?? '';
    select.replaceChildren(option('', '不使用'));
    for (const item of project?.attenuations ?? []) {
      select.append(option(item.id, `${item.name || item.id}（${item.maxDistance} 米）`));
    }
    // 曲线可能已在「距离衰减」工作区被删掉，这里保留原值而不是悄悄改成「不使用」。
    if (current && !Array.from(select.options).some((node) => node.value === current)) {
      select.append(option(current, `${current}（已删除）`));
    }
    select.value = current;
    const label = byId('bindingAttenuationField').querySelector('span');
    if (label) label.textContent = binding.playback.spatial === '3d' ? '距离衰减' : '距离衰减（需 3D）';
  };

  const renderRhythm = (binding: AudioBinding): void => {
    const authored = binding.trigger.rhythmLockMs;
    const mode = authored === undefined ? 'auto' : authored > 0 ? 'fixed' : 'off';
    byId<HTMLSelectElement>('bindingRhythmMode').value = mode;
    const msField = byId('bindingRhythmMsField');
    msField.classList.toggle('hidden', mode !== 'fixed');
    setRangeValue(
      'bindingRhythmMs',
      'bindingRhythmMsValue',
      authored && authored > 0 ? authored : 100,
      formatDuration,
    );
    // A looping sound has no beat to line up, so the whole idea is moot for it.
    byId('bindingRhythmFields').classList.toggle('hidden', binding.playback.mode !== 'one-shot');
  };

  const renderEditor = (): void => {
    const binding = selected();
    byId('bindingEditorEmpty').classList.toggle('hidden', Boolean(binding));
    byId('bindingEditor').classList.toggle('hidden', !binding);
    if (!binding) return;
    byId<HTMLInputElement>('bindingEnabled').checked = binding.enabled;
    setValue('bindingLabel', binding.label);
    byId('bindingEventId').textContent = binding.eventId;
    setValue('bindingKind', binding.kind);
    setValue('bindingVariation', binding.variation.mode);
    setRangeValue('bindingDelay', 'bindingDelayValue', binding.trigger.delayMs, formatDuration);
    setRangeValue('bindingCooldown', 'bindingCooldownValue', binding.trigger.cooldownMs, formatDuration);
    setRangeValue('bindingProbability', 'bindingProbabilityValue', Math.round(binding.trigger.probability * 100), (value) => `${value}%`);
    renderRhythm(binding);
    setRangeValue('bindingVolume', 'bindingVolumeValue', Math.round(binding.playback.volume * 100), (value) => `${value}%`);
    setValue('bindingBus', binding.playback.bus);
    setValue('bindingSpatial', binding.playback.spatial);
    renderAttenuationOptions(binding);
    setValue('bindingPlaybackMode', binding.playback.mode);
    setRangeValue('bindingFadeIn', 'bindingFadeInValue', binding.playback.fadeInMs, formatDuration);
    setRangeValue('bindingFadeOut', 'bindingFadeOutValue', binding.playback.fadeOutMs, formatDuration);
    setValue('bindingStopEvent', binding.playback.stopEventId ?? '');
    renderAssets(binding);
    renderFollow(binding);
    renderShaping(binding);
    renderConditions(binding);
  };

  /** The checklist for the selected genre, with this session's custom events. */
  const presetRows = (): EventPreset[] => (
    presetGenre === 'common' ? [...presetsFor(presetGenre), ...presetCustom] : presetsFor(presetGenre)
  );

  const pickedPresets = (): EventPreset[] => {
    const known = new Map<string, EventPreset>();
    for (const group of EVENT_GENRES) for (const preset of group.presets) known.set(preset.eventId, preset);
    for (const preset of presetCustom) known.set(preset.eventId, preset);
    return [...presetPicks].map((eventId) => known.get(eventId)).filter((p): p is EventPreset => Boolean(p));
  };

  function renderPresetCatalog(): void {
    const genres = byId('bindingPresetGenres');
    genres.replaceChildren(...EVENT_GENRES.map((group) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = group.name;
      button.title = group.blurb;
      button.setAttribute('role', 'tab');
      button.classList.toggle('is-selected', group.id === presetGenre);
      button.addEventListener('click', () => {
        presetGenre = group.id;
        renderPresetCatalog();
      });
      return button;
    }));

    const list = byId('bindingPresetList');
    list.replaceChildren(...presetRows().map((preset) => {
      const exists = draft.some((binding) => binding.eventId === preset.eventId);
      const row = document.createElement('label');
      row.className = `binding-preset-row${exists ? ' is-existing' : ''}`;
      row.title = exists ? `${preset.hint}（已存在）` : preset.hint;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = presetPicks.has(preset.eventId);
      box.disabled = exists;
      box.addEventListener('change', () => {
        if (box.checked) presetPicks.add(preset.eventId);
        else presetPicks.delete(preset.eventId);
        renderPresetCatalog();
      });
      const name = document.createElement('b');
      name.textContent = preset.label;
      const id = document.createElement('code');
      id.textContent = preset.eventId;
      row.append(box, name, id);
      if (preset.kind !== 'sfx') row.append(tag(preset.kind === 'music' ? '音乐' : '语音', 'is-cyan'));
      return row;
    }));

    const count = presetPicks.size;
    byId('bindingPresetCount').textContent = count
      ? `已勾选 ${count} 个事件`
      : presetCreated.length
        ? `刚建了 ${presetCreated.length} 个事件，可直接接入游戏`
        : '未勾选事件';
    byId<HTMLButtonElement>('bindingPresetCreateBtn').disabled = busy || !slug || count === 0;
    byId<HTMLButtonElement>('bindingPresetWireBtn').disabled = busy || !slug
      || (count === 0 && presetCreated.length === 0);
  }

  function renderAll(): void {
    updateHeader();
    renderChips();
    renderBindingList();
    renderCandidates();
    renderPresetCatalog();
    renderPreview();
    renderEditor();
  }

  const loadProject = async (): Promise<void> => {
    if (!slug) return;
    setBusy(true);
    setStatus('正在读取共享草稿…');
    try {
      const result = await getAudioProject(slug);
      project = structuredClone(result.project);
      draft = result.project.bindings.map((binding) => structuredClone(binding));
      appliedRevision = result.appliedRevision;
      const keep = pendingEventId && draft.some((binding) => binding.eventId === pendingEventId)
        ? pendingEventId
        : draft[0]?.eventId ?? '';
      pendingEventId = '';
      setSelectedEvent(keep);
      setStatus('草稿已同步；Agent 和你编辑的是同一份内容');
      renderAll();
    } catch (error) {
      setStatus('草稿读取失败');
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!slug || !project) return false;
    const incomplete = draft.find((binding) => audioBindingAssets(binding)
      .some((asset) => !asset.assetId.trim() || !asset.file.trim()));
    if (incomplete) {
      showToast(`“${incomplete.label}”有未填写完整的声音`, 'warning');
      return false;
    }
    // schema 要求每个分支至少一个素材。提前拦下来，否则报错来自服务端 normalize，
    // 用户看到的是一句路径式英文，根本对不上界面里的哪一行。
    const emptyCase = draft.find((binding) => (binding.follow?.cases ?? [])
      .some((item) => item.assets.length === 0));
    if (emptyCase) {
      showToast(`“${emptyCase.label}”有跟随分支还没有声音`, 'warning');
      return false;
    }
    const patch = buildAudioProjectPatch(project, draft);
    if (!patch.upsertBindings.length && !patch.removeEventIds.length) {
      showToast('草稿没有新的改动');
      return true;
    }
    setBusy(true);
    try {
      const result = await patchAudioProjectDraft(
        slug,
        patch.expectedRevision,
        patch.upsertBindings,
        patch.removeEventIds,
      );
      project = structuredClone(result.project);
      draft = result.project.bindings.map((binding) => structuredClone(binding));
      setStatus(`草稿 v${result.project.revision} 已保存，尚未应用到游戏`);
      renderAll();
      showToast('音频绑定草稿已保存', 'success');
      return true;
    } catch (error) {
      showToast(`${error instanceof Error ? error.message : String(error)}；请重新读取后再编辑`, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 本地是否有还没写回服务端的改动——决定后台同步能不能直接覆盖界面。 */
  const hasUnsavedEdits = (): boolean => {
    if (!project) return false;
    const patch = buildAudioProjectPatch(project, draft);
    return patch.upsertBindings.length > 0 || patch.removeEventIds.length > 0;
  };

  /**
   * Agent 与用户共用一份草稿，但写入方在服务端、界面在 iframe 里，两边没有变更
   * 通道，于是 Agent 改完界面还停在旧数据上，用户以为它没干活。这里主动对齐：
   * 比对 revision，发现被改过就把界面拉到最新；本地有未保存改动时只提示不覆盖，
   * 免得抢掉用户正在编的内容。
   */
  let syncing = false;
  const syncRemoteRevision = async (): Promise<void> => {
    if (!slug || busy || syncing || document.hidden) return;
    syncing = true;
    try {
      const result = await getAudioProject(slug);
      const known = project?.revision ?? -1;
      if (result.project.revision === known && result.appliedRevision === appliedRevision) return;
      if (hasUnsavedEdits()) {
        setStatus(`Agent 已把草稿更新到 v${result.project.revision}；你有未保存的改动，保存或放弃后会同步`);
        return;
      }
      project = structuredClone(result.project);
      draft = result.project.bindings.map((binding) => structuredClone(binding));
      appliedRevision = result.appliedRevision;
      if (!draft.some((binding) => binding.eventId === selectedEventId)) {
        setSelectedEvent(draft[0]?.eventId ?? '');
      }
      renderAll();
      if (known >= 0) showToast(`Agent 更新了音频草稿，已同步到 v${result.project.revision}`, 'success');
    } catch {
      // 后台对齐失败不打扰用户：下一轮轮询或手动读取会再试。
    } finally {
      syncing = false;
    }
  };
  window.setInterval(() => { void syncRemoteRevision(); }, 5_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void syncRemoteRevision();
  });
  window.addEventListener('focus', () => { void syncRemoteRevision(); });

  const scan = async (): Promise<void> => {
    if (!slug) return;
    setBusy(true);
    setStatus('正在只读扫描游戏事件…');
    try {
      const result = await inspectAudioEvents(slug);
      candidates = result.candidates;
      scannedFiles = result.scannedFiles;
      // 扫描结果会改变「扫描发现」的计数与可见档位，分类栏和网格一起刷。
      renderChips();
      renderBindingList();
      renderCandidates();
      const events = new Set(candidates.map((candidate) => candidate.eventId)).size;
      // 报出扫了多少文件：只说“0 个候选”时，没人分得清是游戏没埋点还是扫描器瞎了。
      setStatus(events
        ? `扫描完成：${result.scannedFiles} 个源文件里发现 ${events} 个事件`
          + `（${candidates.length} 处调用），没有修改游戏`
        : `扫描完成：${result.scannedFiles} 个源文件里没有带事件名的音频调用，可手动添加`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  byId('bindingManualAddBtn').addEventListener('click', () => {
    const eventInput = byId<HTMLInputElement>('bindingManualEvent');
    const labelInput = byId<HTMLInputElement>('bindingManualLabel');
    const eventId = eventInput.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId)) {
      showToast('请输入有效事件名，例如 player.jump', 'warning');
      return;
    }
    if (draft.some((binding) => binding.eventId === eventId)) {
      selectEvent(eventId);
      return;
    }
    draft = upsertBindingInDraft(draft, createBindingDraft(eventId, labelInput.value));
    eventInput.value = '';
    labelInput.value = '';
    selectEvent(eventId);
  });

  byId('bindingPresetCustomAddBtn').addEventListener('click', () => {
    const field = byId<HTMLInputElement>('bindingPresetCustom');
    const preset = customPreset(field.value);
    if (!preset) {
      showToast('请输入有效事件名，例如 boss.roar', 'warning');
      return;
    }
    if (!presetCustom.some((item) => item.eventId === preset.eventId)) {
      presetCustom = [...presetCustom, preset];
    }
    presetPicks.add(preset.eventId);
    presetGenre = 'common';
    field.value = '';
    renderPresetCatalog();
  });

  byId('bindingPresetCreateBtn').addEventListener('click', async () => {
    const picks = pickedPresets().filter((preset) => !draft.some((b) => b.eventId === preset.eventId));
    if (!picks.length) return;
    // One patch for all of them: each call bumps the revision, and a batch that
    // walks the revision forward one event at a time would collide with the
    // agent editing the same draft.
    draft = picks.reduce((acc, preset) => upsertBindingInDraft(acc, bindingFromPreset(preset)), draft);
    if (!await saveDraft()) return;
    presetCreated = picks;
    presetPicks.clear();
    showToast(`已新建 ${picks.length} 个空事件，接下来给它们装声音`);
    selectEvent(picks[0]!.eventId);
  });

  byId('bindingPresetWireBtn').addEventListener('click', () => {
    const picks = presetPicks.size ? pickedPresets() : presetCreated;
    if (!slug || !picks.length) return;
    if (!onWireIntoGame) {
      showToast('当前不在 Studio 中，无法投给系统 Chat', 'warning');
      return;
    }
    onWireIntoGame(wireIntoGamePrompt(slug, picks));
    showToast('已把接入需求投给系统 Chat');
  });

  const discreteFollow = (
    field: string,
    label: string,
    values: Array<[string, string]>,
    binding: AudioBinding,
  ): AudioFollowRule => ({
    field,
    label,
    defaultValue: '',
    cases: values.map(([value, caseLabel], index): AudioFollowCase => ({
      value,
      label: caseLabel,
      assets: binding.assets.length > 0
        ? [structuredClone(binding.assets[index % binding.assets.length]!)]
        : [],
    })),
  });

  const buildFollow = (preset: FollowPreset, binding: AudioBinding): AudioFollowRule | null => {
    if (preset === 'none') return null;
    if (preset === 'surface') {
      return discreteFollow('surface.material', '地面材质', [
        ['grass', '草地'], ['stone', '石头'], ['wood', '木板'], ['water', '水面'],
      ], binding);
    }
    if (preset === 'phase') {
      return discreteFollow('game.phase', '游戏阶段', [
        ['explore', '探索'], ['combat', '战斗'], ['danger', '危险'], ['pause', '暂停'],
      ], binding);
    }
    if (preset === 'speed') {
      return { field: 'player.speed', label: '玩家速度', defaultValue: 0, range: followRange('intense', 0, 10) };
    }
    if (preset === 'health') {
      return { field: 'player.health', label: '玩家血量', defaultValue: 100, range: followRange('recover', 0, 100) };
    }
    if (preset === 'distance') {
      return { field: 'distance', label: '与玩家的距离', defaultValue: 0, range: followRange('distant', 0, 50) };
    }
    if (preset === 'custom-cases') {
      if (binding.follow?.cases) return structuredClone(binding.follow);
      return discreteFollow('game.value', '自定义变化', [['default', '默认值']], binding);
    }
    if (binding.follow?.range) return structuredClone(binding.follow);
    return { field: 'game.value', label: '自定义数值', defaultValue: 0, range: followRange('intense', 0, 1) };
  };

  byId<HTMLSelectElement>('bindingFollowPreset').addEventListener('change', (event) => {
    const binding = selected();
    if (!binding) return;
    updateSelected({ follow: buildFollow((event.target as HTMLSelectElement).value as FollowPreset, binding) });
    const next = selected();
    if (next) renderFollow(next);
  });

  byId<HTMLInputElement>('bindingFollowField').addEventListener('input', (event) => {
    const rule = selected()?.follow;
    if (!rule) return;
    updateSelected({ follow: { ...rule, field: (event.target as HTMLInputElement).value.trim() } });
  });

  const updateFollowRange = (): void => {
    const rule = selected()?.follow;
    if (!rule?.range) return;
    const min = Number(byId<HTMLInputElement>('bindingFollowMin').value);
    const requestedMax = Number(byId<HTMLInputElement>('bindingFollowMax').value);
    const max = requestedMax > min ? requestedMax : min + 1;
    const effect = byId<HTMLSelectElement>('bindingFollowEffect').value as FollowEffect;
    updateSelected({ follow: { ...rule, defaultValue: min, range: followRange(effect, min, max) } });
  };
  byId('bindingFollowMin').addEventListener('input', () => {
    byId<HTMLOutputElement>('bindingFollowMinValue').value = byId<HTMLInputElement>('bindingFollowMin').value;
    updateFollowRange();
  });
  byId('bindingFollowMax').addEventListener('input', () => {
    byId<HTMLOutputElement>('bindingFollowMaxValue').value = byId<HTMLInputElement>('bindingFollowMax').value;
    updateFollowRange();
  });
  byId('bindingFollowEffect').addEventListener('change', updateFollowRange);

  byId('bindingAddFollowCaseBtn').addEventListener('click', () => {
    const binding = selected();
    const rule = binding?.follow;
    if (!binding || !rule?.cases || rule.cases.length >= 32) return;
    const mapped = binding.assets[0];
    const cases: AudioFollowCase[] = [
      ...rule.cases.map((item) => structuredClone(item)),
      { value: `value${rule.cases.length + 1}`, assets: mapped ? [structuredClone(mapped)] : [] },
    ];
    updateSelected({ follow: { ...rule, cases } });
    const next = selected();
    if (next) renderFollow(next);
  });

  const updateEventShaping = (key: keyof AudioShapingParams, value: number): void => {
    const binding = selected();
    if (!binding) return;
    updateSelected({ shaping: { ...(binding.shaping ?? DEFAULT_EVENT_SHAPING), [key]: value } });
  };

  for (const [inputId, outputId, key] of [
    ['bindingEqLow', 'bindingEqLowValue', 'eqLowDb'],
    ['bindingEqMid', 'bindingEqMidValue', 'eqMidDb'],
    ['bindingEqHigh', 'bindingEqHighValue', 'eqHighDb'],
  ] as const) {
    byId<HTMLInputElement>(inputId).addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      byId<HTMLOutputElement>(outputId).value = formatDb(value);
      updateEventShaping(key, value);
    });
  }
  byId<HTMLInputElement>('bindingDistance').addEventListener('input', (event) => {
    const distance = Number((event.target as HTMLInputElement).value);
    byId<HTMLOutputElement>('bindingDistanceValue').value = distance === 0 ? '原声' : `${distance}%`;
    updateEventShaping('lowpassHz', 20_000 - distance * 190);
  });
  byId('bindingShapingResetBtn').addEventListener('click', () => {
    updateSelected({ shaping: null });
    const binding = selected();
    if (binding) renderShaping(binding);
  });

  const editMap: Array<[
    string,
    keyof AudioBindingEdit,
    'text' | 'number' | 'checked',
    boolean?,
  ]> = [
    ['bindingEnabled', 'enabled', 'checked', true],
    ['bindingLabel', 'label', 'text', true],
    ['bindingKind', 'kind', 'text'],
    ['bindingVariation', 'variationMode', 'text'],
    ['bindingDelay', 'delayMs', 'number'],
    ['bindingCooldown', 'cooldownMs', 'number'],
    ['bindingProbability', 'probabilityPercent', 'number'],
    ['bindingVolume', 'volumePercent', 'number'],
    ['bindingBus', 'bus', 'text'],
    ['bindingSpatial', 'spatial', 'text'],
    ['bindingAttenuation', 'attenuationId', 'text'],
    ['bindingPlaybackMode', 'playbackMode', 'text'],
    ['bindingFadeIn', 'fadeInMs', 'number'],
    ['bindingFadeOut', 'fadeOutMs', 'number'],
    ['bindingStopEvent', 'stopEventId', 'text'],
  ];
  for (const [id, key, valueType, rerenderList] of editMap) {
    const node = byId<HTMLInputElement | HTMLSelectElement>(id);
    const eventName = node instanceof HTMLInputElement && (valueType === 'text' || node.type === 'range')
      ? 'input'
      : 'change';
    node.addEventListener(eventName, () => {
      const value = valueType === 'checked'
        ? (node as HTMLInputElement).checked
        : valueType === 'number'
          ? Number(node.value)
          : node.value;
      const edit = { [key]: value } as AudioBindingEdit;
      if (key === 'kind') {
        edit.bus = value as AudioBindingEdit['bus'];
        if (value === 'music') edit.playbackMode = 'loop';
      }
      updateSelected(edit, rerenderList);
      if (key === 'kind') {
        const binding = selected();
        if (binding) renderEditor();
      }
      if (key === 'spatial') {
        const binding = selected();
        if (binding) renderAttenuationOptions(binding);
      }
      if (key === 'playbackMode') {
        const binding = selected();
        if (binding) renderRhythm(binding);
      }
    });
  }

  byId<HTMLSelectElement>('bindingRhythmMode').addEventListener('change', (event) => {
    const mode = (event.currentTarget as HTMLSelectElement).value;
    const intervalMs = Number(byId<HTMLInputElement>('bindingRhythmMs').value) || 100;
    updateSelected({ rhythmLock: mode === 'fixed' ? intervalMs : mode === 'off' ? 'off' : 'auto' });
    const binding = selected();
    if (binding) renderRhythm(binding);
  });

  byId<HTMLInputElement>('bindingRhythmMs').addEventListener('input', (event) => {
    const intervalMs = Number((event.currentTarget as HTMLInputElement).value);
    byId<HTMLOutputElement>('bindingRhythmMsValue').value = formatDuration(intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    updateSelected({ rhythmLock: intervalMs });
  });

  for (const [inputId, outputId, format] of [
    ['bindingDelay', 'bindingDelayValue', formatDuration],
    ['bindingCooldown', 'bindingCooldownValue', formatDuration],
    ['bindingProbability', 'bindingProbabilityValue', (value: number) => `${value}%`],
    ['bindingVolume', 'bindingVolumeValue', (value: number) => `${value}%`],
    ['bindingFadeIn', 'bindingFadeInValue', formatDuration],
    ['bindingFadeOut', 'bindingFadeOutValue', formatDuration],
  ] as const) {
    byId<HTMLInputElement>(inputId).addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      byId<HTMLOutputElement>(outputId).value = format(value);
    });
  }

  byId('bindingAddAssetBtn').addEventListener('click', () => {
    const assets: AudioAssetRef[] = [
      ...(selected()?.assets ?? []),
      pendingAsset ? structuredClone(pendingAsset) : { assetId: '', file: '' },
    ];
    pendingAsset = null;
    updateSelected({ assets });
    const binding = selected();
    if (binding) renderAssets(binding);
  });

  byId('bindingAddConditionBtn').addEventListener('click', () => {
    const conditions: AudioCondition[] = [
      ...(selected()?.conditions ?? []),
      { field: 'state', operator: 'eq', value: 'value' },
    ];
    updateSelected({ conditions });
    const binding = selected();
    if (binding) renderConditions(binding);
  });

  byId('bindingDeleteBtn').addEventListener('click', () => {
    const binding = selected();
    if (!binding || !window.confirm(`删除“${binding.label}”绑定？声音文件不会被删除。`)) return;
    draft = removeBindingFromDraft(draft, binding.eventId);
    selectEvent(draft[0]?.eventId ?? '');
  });

  byId('bindingSaveBtn').addEventListener('click', () => { void saveDraft(); });
  byId('bindingApplyBtn').addEventListener('click', async () => {
    if (!project || !slug || !await saveDraft()) return;
    if (!window.confirm(`将草稿 v${project.revision} 应用到游戏“${slug}”并更新游戏侧音频运行时。继续吗？`)) return;
    setBusy(true);
    try {
      const result = await applyAudioProjectDraft(slug, project.revision);
      appliedRevision = result.project.revision;
      setStatus(`已应用 v${result.project.revision} · 生成 ${result.files.length} 个游戏侧文件`);
      updateHeader();
      showToast('音频绑定已应用到游戏', 'success');
      onApplied?.({ slug, revision: result.project.revision });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  });

  byId('bindingVerifyBtn').addEventListener('click', async () => {
    if (!slug) return;
    setBusy(true);
    try {
      const result = await verifyAppliedAudioProject(slug);
      setStatus(result.ok
        ? `验证通过：${result.instrumentedEventIds.length} 个事件已接入`
        : `需要处理：${result.errors.length} 个错误，${result.warnings.length} 个提醒`);
      showToast(result.ok ? '音频事件接入验证通过' : '验证发现需要处理的项目', result.ok ? 'success' : 'warning');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  });

  setBusy(false);
  renderAll();
  if (slug) void loadProject();
  const precisePairs: Array<[string, string, (value: number) => string]> = [
    ['bindingDelay', 'bindingDelayValue', formatDuration],
    ['bindingCooldown', 'bindingCooldownValue', formatDuration],
    ['bindingProbability', 'bindingProbabilityValue', (value) => `${value}%`],
    ['bindingVolume', 'bindingVolumeValue', (value) => `${value}%`],
    ['bindingFadeIn', 'bindingFadeInValue', formatDuration],
    ['bindingFadeOut', 'bindingFadeOutValue', formatDuration],
    ['bindingRhythmMs', 'bindingRhythmMsValue', formatDuration],
    ['bindingFollowMin', 'bindingFollowMinValue', String],
    ['bindingFollowMax', 'bindingFollowMaxValue', String],
    ['bindingEqLow', 'bindingEqLowValue', formatDb],
    ['bindingEqMid', 'bindingEqMidValue', formatDb],
    ['bindingEqHigh', 'bindingEqHighValue', formatDb],
    ['bindingDistance', 'bindingDistanceValue', (value) => (value === 0 ? '原声' : `${value}%`)],
  ];
  for (const [inputId, outputId, format] of precisePairs) {
    const input = byId<HTMLInputElement>(inputId);
    const output = byId<HTMLOutputElement>(outputId);
    enablePreciseOutput(input, output, () => format(Number(input.value)));
  }

  return {
    selectEvent(eventId: string): void {
      pendingEventId = eventId;
      selectEvent(eventId);
    },
    selectGame(nextSlug: string): void {
      // 切游戏后正在播的声音已不属于当前上下文，继续放会造成误判。
      const keep = pendingEventId;
      stopPreview();
      slug = nextSlug.trim();
      project = null;
      draft = [];
      candidates = [];
      scannedFiles = null;
      libraryFilter = 'all';
      previewMode = 'wave';
      setSelectedEvent('');
      pendingEventId = keep;
      renderAll();
      if (slug) void loadProject();
    },
    scan(): void { void scan(); },
    publishState,
    reload(): void {
      if (slug) void loadProject();
    },
    queueAsset(asset: AudioAssetRef): void {
      const binding = selected();
      if (binding) {
        updateSelected({ assets: [...binding.assets, structuredClone(asset)] });
        const next = selected();
        if (next) renderAssets(next);
        showToast('自定义音频已加入当前事件', 'success');
      } else {
        pendingAsset = structuredClone(asset);
        setStatus('自定义音频已准备好；选择事件后点击“添加声音”');
      }
    },
  };
}
