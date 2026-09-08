import type {
  AttenuationShareSet,
  AudioBusNode,
  AudioNode,
  AudioProject,
  MusicPlaylist,
  MusicSegment,
  RtpcDefinition,
  StateGroup,
  SwitchGroup,
} from '../shared/audio-project.ts';
import {
  attenuationPreset,
  createChildBus,
  createMusicPlaylist,
  createMusicSegment,
  createRtpc,
  createStateGroup,
  createSwitchGroup,
  parseCsvValues,
  type DesignWorkspace,
  type SyncKind,
} from './audioDesignEntities.ts';
import {
  applyAudioProjectDraft,
  defineAttenuationDraft,
  defineBusDraft,
  defineGameSyncDraft,
  authorMusicDraft,
  getAudioProject,
  verifyAppliedAudioProject,
  type AudioProjectVerification,
} from './audioProjectApi.ts';
import { enablePreciseOutput, showToast } from './utils.ts';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

type BindingsHandle = {
  selectGame: (slug: string) => void;
  scan: () => void;
  publishState: () => void;
  reload?: () => void;
  selectEvent?: (eventId: string) => void;
};

type DesignUiOptions = {
  bindings: BindingsHandle;
  onApplied?: (result: { slug: string; revision: number }) => void;
  onStateChange?: (state: {
    slug: string;
    revisionLabel: string;
    bindingCount: number;
    busy: boolean;
    workspace: DesignWorkspace;
  }) => void;
};

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const node = document.createElement('label');
  if (control instanceof HTMLInputElement && control.type === 'range') {
    node.className = 'binding-range-field';
    const head = document.createElement('span');
    const title = document.createElement('i');
    title.textContent = label;
    const output = document.createElement('output');
    const unit = control.dataset.unit ?? '';
    const format = (): string => {
      const raw = control.value;
      return unit ? `${raw} ${unit}` : raw;
    };
    const sync = (): void => { output.textContent = format(); };
    control.addEventListener('input', sync);
    sync();
    enablePreciseOutput(control, output, format);
    head.append(title, output);
    node.append(head, control);
    return node;
  }
  node.className = 'binding-inline-field';
  const span = document.createElement('span');
  span.textContent = label;
  node.append(span, control);
  return node;
}

function textInput(value: string, aria: string): HTMLInputElement {
  const node = document.createElement('input');
  node.value = value;
  node.setAttribute('aria-label', aria);
  return node;
}

function numberInput(
  value: number,
  aria: string,
  spec: { min: number; max: number; step?: number; unit?: string } = { min: 0, max: 100 },
): HTMLInputElement {
  const node = document.createElement('input');
  node.type = 'range';
  const min = Math.min(spec.min, value);
  const max = Math.max(spec.max, value);
  node.min = String(min);
  node.max = String(max);
  node.step = String(spec.step ?? 1);
  node.value = String(value);
  node.dataset.defaultMin = String(spec.min);
  node.dataset.defaultMax = String(spec.max);
  if (spec.unit) node.dataset.unit = spec.unit;
  node.setAttribute('aria-label', aria);
  return node;
}

/* ════════════════════════════════════════════════════════════════════════
   三区版式的只读呈现件（区1 库 / 区2 预览）。
   规格：docs/2026-08-14-design-tabs-generator-layout.zh-CN.html frame 2–6。
   这里只造 DOM，样式全部来自 src/gen3.css 已有的类名；内联 style 仅用于
   数据驱动的几何量（百分比位置 / 锥形角度 / 圆点色），CSS 类无法表达。
   ════════════════════════════════════════════════════════════════════════ */

type Tone = 'accent' | 'cyan' | 'warn' | 'error';
type MetaTone = 'mono' | 'accent' | 'error';
type DotTone = 'ok' | 'warn' | 'error' | 'info' | 'cyan';

type TagSpec = { text: string; tone?: Tone };
type MetaCell = { label: string; value: string; tone?: MetaTone };
type CardSpec = {
  id: string;
  title: string;
  subtitle: string;
  tags: TagSpec[];
  thumb?: SVGElement;
  music?: boolean;
};
type TreeSpec = {
  id: string;
  label: string;
  tail?: string;
  child?: boolean;
  tags?: TagSpec[];
};
type ChipSpec = { key: string; label: string; count: number; tone?: 'warn' | 'info' };
type ChipGroup = { rule: string; chips: ChipSpec[] };
type SegSpec = { key: string; label: string };

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAGE_VIEW = '0 0 560 170';
const THUMB_VIEW = '0 0 120 58';
const SILENCE_DB = -60;

// Mirrors of the style.css tokens. SVG presentation attributes are set through
// setAttribute here, so `var(--…)` can't be handed to them — these must stay
// literal and be updated alongside :root.
const ACCENT = '#d4ff48';
const VIOLET = '#8caaff';
const WARN = '#ffb056';
const DANGER = '#f26a6a';
const RULE = '#333333';
const RULE_SOFT = '#242424';
const MUTED = 'rgba(255,255,255,.30)';

function svgNode(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function svgText(x: number, y: number, text: string, fill = MUTED): SVGElement {
  const node = svgNode('text', { x, y, fill, 'font-size': 10 });
  node.textContent = text;
  return node;
}

function polylineNode(points: Array<[number, number]>, stroke: string, width = 2): SVGElement {
  return svgNode('polyline', {
    points: points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
    fill: 'none',
    stroke,
    'stroke-width': width,
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function dbText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0 dB';
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)} dB`;
}

/** Deterministic LCG: a card's waveform must not flicker between renders. */
function seeded(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tagNode(spec: TagSpec): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = spec.tone ? `gen3-tag is-${spec.tone}` : 'gen3-tag';
  node.textContent = spec.text;
  return node;
}

function curveThumb(points: Array<[number, number]>, stroke: string): SVGElement {
  const root = svgNode('svg', { viewBox: THUMB_VIEW, preserveAspectRatio: 'none' });
  root.append(polylineNode(points, stroke));
  return root;
}

/** Switch / State / playlist thumbnails: one equal-width bar per value. */
function barsThumb(count: number, fill: string): SVGElement {
  const root = svgNode('svg', { viewBox: THUMB_VIEW });
  const total = Math.max(1, Math.min(10, count));
  const slot = 120 / total;
  const width = Math.max(4, Math.min(16, slot * 0.52));
  for (let index = 0; index < total; index += 1) {
    const height = 14 + ((index * 3) % 5) * 7;
    root.append(svgNode('rect', {
      x: (slot * (index + 0.5) - width / 2).toFixed(2),
      y: ((58 - height) / 2).toFixed(2),
      width: width.toFixed(2),
      height,
      rx: 1,
      fill,
    }));
  }
  return root;
}

function waveThumb(seed: number, fill: string): SVGElement {
  const root = svgNode('svg', { viewBox: THUMB_VIEW, preserveAspectRatio: 'none' });
  const random = seeded(seed);
  const bars = 34;
  const slot = 120 / bars;
  for (let index = 0; index < bars; index += 1) {
    const ratio = index / bars;
    const envelope = 0.55 + 0.35 * Math.sin(ratio * Math.PI * 3);
    const height = Math.max(6, Math.min(56, envelope * (0.55 + 0.45 * random()) * 58));
    root.append(svgNode('rect', {
      x: (index * slot + 0.35).toFixed(2),
      y: ((58 - height) / 2).toFixed(2),
      width: (slot - 0.7).toFixed(2),
      height: height.toFixed(2),
      rx: 1,
      fill,
    }));
  }
  return root;
}

function rtpcCurvePoints(
  rtpc: RtpcDefinition,
  left: number,
  right: number,
  top: number,
  bottom: number,
): Array<[number, number]> {
  const span = rtpc.max - rtpc.min;
  const ratio = span > 0 ? clamp01((rtpc.defaultValue - rtpc.min) / span) : 0;
  // 默认值靠下限 → 曲线晚起势；靠上限 → 早饱和。始终单调递增。
  const power = 0.45 + (1 - ratio) * 1.7;
  const points: Array<[number, number]> = [];
  for (let step = 0; step <= 8; step += 1) {
    const t = step / 8;
    points.push([left + t * (right - left), bottom - (bottom - top) * Math.pow(t, power)]);
  }
  return points;
}

function attenCurvePoints(
  atten: AttenuationShareSet,
  left: number,
  right: number,
  top: number,
  bottom: number,
): Array<[number, number]> {
  const max = Math.max(0.001, atten.maxDistance);
  const raw = atten.curves.outputVolumeDb.length >= 2
    ? atten.curves.outputVolumeDb
    : [{ x: 0, y: 0 }, { x: max, y: -96 }];
  return raw.map((point): [number, number] => [
    left + clamp01(point.x / max) * (right - left),
    top + clamp01(-point.y / 96) * (bottom - top),
  ]);
}

function attenTailDb(atten: AttenuationShareSet): number {
  const points = atten.curves.outputVolumeDb;
  const last = points.length > 0 ? points[points.length - 1] : undefined;
  return last ? last.y : 0;
}

function walkAudioNodes(node: AudioNode, visit: (node: AudioNode) => void): void {
  visit(node);
  if (node.kind === 'random' || node.kind === 'sequence') {
    for (const child of node.children) walkAudioNodes(child, visit);
    return;
  }
  if (node.kind === 'switch') {
    for (const child of Object.values(node.assignments)) walkAudioNodes(child, visit);
    if (node.defaultNode) walkAudioNodes(node.defaultNode, visit);
    return;
  }
  if (node.kind === 'blend') {
    for (const layer of node.layers) walkAudioNodes(layer.node, visit);
  }
}

/** First single-quoted token of a verify message, used only as a jump target. */
function quotedId(message: string): string {
  const match = /'([^']+)'/.exec(message);
  return match ? match[1] : '';
}

/**
 * Shell around the v1 event editor: left workspace nav + alternate entity panes.
 * Event editing itself stays in `initAudioBindingsUi`.
 */
export function initAudioDesignUi(
  initialSlug: string,
  options: DesignUiOptions,
): {
  currentSlug: () => string;
  selectGame: (slug: string) => void;
  scan: () => void;
  publishState: () => void;
  setWorkspace: (workspace: DesignWorkspace) => void;
} {
  let slug = initialSlug === 'default' ? '' : initialSlug.trim();
  let workspace: DesignWorkspace = 'events';
  let project: AudioProject | null = null;
  let appliedRevision: number | null = null;
  let busy = false;
  let selectedId = '';
  let pendingSelection = '';
  let filterKey = 'all';
  let previewMode = '';
  let verification: AudioProjectVerification | null = null;

  const revisionLabel = (): string => (
    project
      ? `草稿 v${project.revision}${appliedRevision === project.revision ? ' · 已应用' : ' · 待应用'}`
      : '未打开游戏工程'
  );

  const publishState = (): void => {
    options.onStateChange?.({
      slug,
      revisionLabel: revisionLabel(),
      bindingCount: project?.bindings.length ?? 0,
      busy,
      workspace,
    });
  };

  const setBusy = (next: boolean): void => {
    busy = next;
    for (const id of ['designSaveBtn', 'designApplyBtn', 'designVerifyBtn', 'bindingSaveBtn', 'bindingApplyBtn', 'bindingVerifyBtn']) {
      const node = document.getElementById(id) as HTMLButtonElement | null;
      if (node) node.disabled = next || !slug;
    }
    publishState();
  };

  const updateLeftChrome = (): void => {
    const gameName = document.getElementById('bindingWorkspaceGameName');
    if (gameName) gameName.textContent = slug || '未打开游戏工程';
    const revision = document.getElementById('bindingRevision');
    if (revision) revision.textContent = revisionLabel();
    const designRevision = document.getElementById('designRevision');
    if (designRevision) designRevision.textContent = revisionLabel();
    publishState();
  };

  const setWorkspace = (next: DesignWorkspace): void => {
    workspace = next;
    document.querySelectorAll<HTMLButtonElement>('[data-design-workspace]').forEach((button) => {
      button.classList.toggle('is-selected', button.dataset.designWorkspace === next);
    });
    byId('designAudioWorkspace').classList.toggle('hidden', next !== 'audio');
    byId('designEventsWorkspace').classList.toggle('hidden', next !== 'events');
    byId('designEntityWorkspace').classList.toggle('hidden', next === 'audio' || next === 'events');
    if (next !== 'events' && next !== 'audio') {
      selectedId = pendingSelection;
      pendingSelection = '';
      filterKey = 'all';
      previewMode = '';
      // Agent 可能刚改过草稿，缓存里的那份已经过期。进工作区一律重新拉，
      // 否则用户看到的是旧数据却无从察觉。
      project = null;
      void ensureProject().then(() => renderEntityWorkspace());
    }
    publishState();
  };

  /** Jump from a diagnostic to the tab + entity that owns it. */
  const jumpTo = (next: DesignWorkspace, entityId = ''): void => {
    pendingSelection = entityId;
    setWorkspace(next);
  };

  const ensureProject = async (): Promise<AudioProject | null> => {
    if (!slug) return null;
    if (project) return project;
    setBusy(true);
    try {
      const result = await getAudioProject(slug);
      project = structuredClone(result.project);
      appliedRevision = result.appliedRevision;
      updateLeftChrome();
      return project;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const adoptProject = (next: AudioProject): void => {
    project = structuredClone(next);
    updateLeftChrome();
    options.bindings.reload?.();
  };

  const select = (id: string): void => {
    selectedId = id;
    previewMode = '';
    renderEntityWorkspace();
  };

  /* ── 区1：分类栏 + 卡片 / 缩进树 ─────────────────────────────────── */

  const renderChips = (groups: ChipGroup[]): void => {
    const host = byId('designChips');
    host.innerHTML = '';
    for (const group of groups) {
      if (group.chips.length === 0) continue;
      const rule = document.createElement('div');
      rule.className = 'gen3-chips-rule';
      rule.textContent = group.rule;
      host.append(rule);
      for (const chip of group.chips) {
        const button = document.createElement('button');
        button.type = 'button';
        const tone = chip.tone ? ` is-${chip.tone}` : '';
        button.className = `gen3-chip${chip.key === filterKey ? ' is-selected' : ''}${tone}`;
        button.append(document.createTextNode(chip.label));
        const count = document.createElement('strong');
        count.textContent = String(chip.count);
        button.append(count);
        button.addEventListener('click', () => {
          filterKey = chip.key;
          renderEntityWorkspace();
        });
        host.append(button);
      }
    }
  };

  const listHost = (className: string, empty: string, count: number): HTMLElement => {
    const list = byId('designEntityList');
    list.className = className;
    list.innerHTML = '';
    const note = byId('designEntityListEmpty');
    note.textContent = empty;
    note.classList.toggle('hidden', count > 0);
    return list;
  };

  const renderCards = (cards: CardSpec[], empty: string): void => {
    const list = listHost('gen3-cards', empty, cards.length);
    for (const card of cards) {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `gen3-card${card.id === selectedId ? ' is-selected' : ''}`;
      const thumb = document.createElement('div');
      thumb.className = card.music ? 'gen3-thumb is-music' : 'gen3-thumb';
      if (card.thumb) thumb.append(card.thumb);
      const body = document.createElement('div');
      body.className = 'gen3-cbody';
      const title = document.createElement('h3');
      title.textContent = card.title;
      const subtitle = document.createElement('p');
      subtitle.textContent = card.subtitle;
      body.append(title, subtitle);
      if (card.tags.length > 0) {
        const tags = document.createElement('div');
        tags.className = 'gen3-tags';
        for (const tag of card.tags) tags.append(tagNode(tag));
        body.append(tags);
      }
      node.append(thumb, body);
      node.title = `${card.title} · ${card.subtitle}`;
      node.addEventListener('click', () => select(card.id));
      list.append(node);
    }
  };

  const renderTree = (nodes: TreeSpec[], empty: string): void => {
    const list = listHost('gen3-tree', empty, nodes.length);
    for (const item of nodes) {
      const node = document.createElement('button');
      node.type = 'button';
      const child = item.child ? ' is-child' : '';
      node.className = `gen3-bnode${item.id === selectedId ? ' is-selected' : ''}${child}`;
      for (const tag of item.tags ?? []) node.append(tagNode(tag));
      node.append(document.createTextNode(item.label));
      if (item.tail) {
        const tail = document.createElement('s');
        tail.textContent = item.tail;
        node.append(tail);
      }
      node.title = item.tail ? `${item.label} · ${item.tail}` : item.label;
      node.addEventListener('click', () => select(item.id));
      list.append(node);
    }
  };

  /* ── 区2：预览（只读；这里不允许出现任何输入控件） ─────────────── */

  const preview = (sub: string): { stage: HTMLElement; meta: HTMLElement } => {
    byId('designPreviewSub').textContent = sub;
    byId('designPreviewSeg').innerHTML = '';
    const stage = byId('designPreviewStage');
    stage.innerHTML = '';
    const meta = byId('designPreviewMeta');
    meta.innerHTML = '';
    return { stage, meta };
  };

  const renderSeg = (items: SegSpec[], active: string): void => {
    const host = byId('designPreviewSeg');
    host.innerHTML = '';
    if (items.length < 2) return;
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(item.key === active));
      if (item.key === active) button.className = 'is-selected';
      button.textContent = item.label;
      button.addEventListener('click', () => {
        previewMode = item.key;
        renderEntityWorkspace();
      });
      host.append(button);
    }
  };

  const stageEmpty = (stage: HTMLElement, title: string, note = ''): void => {
    const node = document.createElement('div');
    node.className = 'gen3-stage-empty';
    const strong = document.createElement('strong');
    strong.textContent = title;
    node.append(strong);
    if (note) {
      const span = document.createElement('span');
      span.textContent = note;
      node.append(span);
    }
    stage.append(node);
  };

  const stageCurve = (stage: HTMLElement, stretch = true): SVGElement => {
    const root = svgNode('svg', {
      class: 'gen3-curve',
      viewBox: STAGE_VIEW,
      ...(stretch ? { preserveAspectRatio: 'none' } : {}),
    });
    stage.append(root);
    return root;
  };

  const stageOverlay = (stage: HTMLElement, tags: TagSpec[]): void => {
    if (tags.length === 0) return;
    const node = document.createElement('div');
    node.className = 'gen3-ov';
    for (const tag of tags) node.append(tagNode(tag));
    stage.append(node);
  };

  const stageAxis = (stage: HTMLElement, labels: string[]): void => {
    if (labels.length === 0) return;
    const node = document.createElement('div');
    node.className = 'gen3-axis';
    for (const label of labels) {
      const span = document.createElement('span');
      span.textContent = label;
      node.append(span);
    }
    stage.append(node);
  };

  const stageBars = (
    stage: HTMLElement,
    items: Array<{ label: string; selected?: boolean; basis?: number }>,
  ): void => {
    const node = document.createElement('div');
    node.className = 'gen3-bars';
    for (const item of items) {
      const span = document.createElement('span');
      if (item.selected) span.className = 'is-selected';
      span.textContent = item.label;
      // 段落宽度就是数据本身（小节占比），CSS 类无法表达。
      if (item.basis !== undefined) span.style.flex = `0 0 ${item.basis.toFixed(2)}%`;
      node.append(span);
    }
    stage.append(node);
  };

  const stageGrid = (
    stage: HTMLElement,
    bars: number,
    zone?: { left: number; right: number },
  ): void => {
    const grid = document.createElement('div');
    grid.className = 'gen3-grid';
    const total = Math.max(1, Math.min(64, Math.round(bars)));
    for (let index = 1; index < total; index += 1) {
      const line = document.createElement('i');
      if (index % 4 === 0) line.className = 'is-beat';
      line.style.left = `${((index / total) * 100).toFixed(3)}%`;
      grid.append(line);
    }
    if (zone) {
      const band = document.createElement('div');
      band.className = 'gen3-zone';
      band.style.left = `${clamp01(zone.left / 100) * 100}%`;
      band.style.right = `${clamp01(zone.right / 100) * 100}%`;
      grid.append(band);
    }
    stage.append(grid);
  };

  /** 锥形俯视。内外角是数据，只能内联进 conic-gradient 的角度。 */
  const stageCone = (stage: HTMLElement, cone: NonNullable<AttenuationShareSet['cone']>): void => {
    const inner = Math.max(0, Math.min(360, cone.innerAngleDeg));
    const outer = Math.max(inner, Math.min(360, cone.outerAngleDeg));
    const node = document.createElement('div');
    node.className = 'gen3-cone';
    const fill = document.createElement('i');
    fill.style.background = [
      `conic-gradient(from ${(-inner / 2).toFixed(1)}deg,`,
      `rgba(212,255,72,.30) 0deg ${inner.toFixed(1)}deg,`,
      `rgba(212,255,72,.10) ${inner.toFixed(1)}deg ${outer.toFixed(1)}deg,`,
      `transparent ${outer.toFixed(1)}deg 360deg)`,
    ].join(' ');
    node.append(fill, document.createElement('b'));
    stage.append(node);
  };

  const renderMeta = (meta: HTMLElement, cells: MetaCell[]): void => {
    for (let index = 0; index < cells.length; index += 2) {
      const row = document.createElement('div');
      row.className = 'gen3-mrow';
      for (const cell of cells.slice(index, index + 2)) {
        const wrap = document.createElement('div');
        const term = document.createElement('dt');
        term.textContent = cell.label;
        const value = document.createElement('dd');
        if (cell.tone) value.className = `is-${cell.tone}`;
        value.textContent = cell.value;
        value.title = cell.value;
        wrap.append(term, value);
        row.append(wrap);
      }
      meta.append(row);
    }
  };

  /* ── 区3：编辑区（唯一允许出现编辑控件的区域） ─────────────────── */

  const setEntityHeader = (title: string, status: string): void => {
    byId('designEntityTitle').textContent = title;
    byId('designEntityStatus').textContent = status;
  };

  const resetEditorColumns = (): HTMLElement => {
    const panel = byId('designEntityEditorPanel');
    for (const node of Array.from(panel.children)) {
      if (node.id !== 'designEntityEditor') node.remove();
    }
    const host = byId('designEntityEditor');
    host.className = 'gen3-fcol';
    host.innerHTML = '';
    return host;
  };

  const clearEditor = (message: string): void => {
    resetEditorColumns();
    const empty = byId('designEntityEditorEmpty');
    empty.classList.remove('hidden');
    const strong = empty.querySelector('.gen3-empty-note strong');
    if (strong) strong.textContent = message;
    byId('designEntityEditorPanel').classList.add('hidden');
  };

  /**
   * 区3 是一条横向宽带：把分节铺进若干 `.gen3-fcol` 分栏，整份表单一屏可见。
   * 第一栏复用 `#designEntityEditor` 本身，后续栏是它在 `.binding-editor`
   * 里的兄弟节点（`.binding-editor` 已经是 flex 容器）。
   */
  const showEditor = (): { column: () => HTMLElement } => {
    byId('designEntityEditorEmpty').classList.add('hidden');
    const panel = byId('designEntityEditorPanel');
    panel.classList.remove('hidden');
    const host = resetEditorColumns();
    let hostUsed = false;
    return {
      column(): HTMLElement {
        if (!hostUsed) {
          hostUsed = true;
          return host;
        }
        const node = document.createElement('div');
        node.className = 'gen3-fcol';
        panel.append(node);
        return node;
      },
    };
  };

  const section = (title: string, note: string, body: HTMLElement, action?: HTMLElement): HTMLElement => {
    const node = document.createElement('section');
    node.className = 'binding-editor-section';
    const head = document.createElement('div');
    head.className = 'binding-section-head';
    const label = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = title;
    label.append(strong);
    if (note) {
      const span = document.createElement('span');
      span.textContent = note;
      label.append(span);
    }
    head.append(label);
    if (action) head.append(action);
    node.append(head, body);
    return node;
  };

  const stack = (...nodes: HTMLElement[]): HTMLElement => {
    const node = document.createElement('div');
    node.className = 'gen3-stack';
    node.append(...nodes);
    return node;
  };

  const fieldRow = (...fields: HTMLElement[]): HTMLElement => {
    const node = document.createElement('div');
    const hasRange = fields.some((item) => item.classList.contains('binding-range-field'));
    if (hasRange || fields.length <= 1) node.className = 'gen3-stack';
    else if (fields.length === 2) node.className = 'binding-field-grid is-two';
    else node.className = 'binding-field-grid';
    node.append(...fields);
    return node;
  };

  const hint = (text: string): HTMLParagraphElement => {
    const node = document.createElement('p');
    node.className = 'design-hint';
    node.textContent = text;
    return node;
  };

  const saveButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'audio-primary-btn';
    node.textContent = label;
    node.addEventListener('click', onClick);
    return node;
  };

  /** 只读事实行；带 onClick 时是导航按钮，不是输入控件。 */
  const fixRow = (text: string, action: string, dot: DotTone, onClick?: () => void): HTMLElement => {
    const node = document.createElement(onClick ? 'button' : 'div');
    if (node instanceof HTMLButtonElement) node.type = 'button';
    node.className = 'gen3-fixrow';
    const marker = document.createElement('u');
    marker.className = `is-${dot}`;
    const label = document.createElement('span');
    label.textContent = text;
    const tail = document.createElement('s');
    tail.textContent = action;
    node.append(marker, label, tail);
    node.title = `${text} · ${action}`;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  };

  const issueCard = (title: string, body: string): HTMLElement => {
    const node = document.createElement('div');
    node.className = 'gen3-issue';
    const strong = document.createElement('b');
    strong.textContent = title;
    const text = document.createElement('p');
    text.textContent = body;
    node.append(strong, text);
    return node;
  };

  const emptyNote = (text: string): HTMLElement => {
    const node = document.createElement('div');
    node.className = 'gen3-issue';
    const strong = document.createElement('b');
    strong.textContent = '没有内容';
    const body = document.createElement('p');
    body.textContent = text;
    node.append(strong, body);
    return node;
  };

  /* ════════════════ 游戏变量（syncs） ════════════════ */

  type SyncEntry =
    | { kind: 'switch'; key: string; entity: SwitchGroup }
    | { kind: 'rtpc'; key: string; entity: RtpcDefinition }
    | { kind: 'state'; key: string; entity: StateGroup };

  const syncEntries = (): SyncEntry[] => {
    if (!project) return [];
    return [
      ...project.gameSyncs.switches.map((entity): SyncEntry => ({ kind: 'switch', key: `switch:${entity.id}`, entity })),
      ...project.gameSyncs.rtpcs.map((entity): SyncEntry => ({ kind: 'rtpc', key: `rtpc:${entity.id}`, entity })),
      ...project.gameSyncs.states.map((entity): SyncEntry => ({ kind: 'state', key: `state:${entity.id}`, entity })),
    ];
  };

  const syncAliases = (entry: SyncEntry): string[] => {
    const bare = entry.entity.id.replace(/^(sw|rtpc|st):/, '');
    return [entry.entity.id, entry.entity.name, bare];
  };

  /** 引用关系；未知来源一律不猜，只列能确证的。 */
  const syncRefs = (entry: SyncEntry): Array<{ label: string; note: string; dot: DotTone; jump?: () => void }> => {
    if (!project) return [];
    const rows: Array<{ label: string; note: string; dot: DotTone; jump?: () => void }> = [];
    const id = entry.entity.id;
    const aliases = syncAliases(entry);
    for (const object of project.objects) {
      if (entry.kind === 'rtpc') {
        if (object.rtpcBindings.some((item) => item.rtpcId === id)) {
          rows.push({ label: object.name || object.id, note: '参数曲线', dot: 'ok' });
          continue;
        }
        let blended = false;
        walkAudioNodes(object.node, (node) => {
          if (node.kind === 'blend' && node.rtpcId === id) blended = true;
        });
        if (blended) rows.push({ label: object.name || object.id, note: '分层混合', dot: 'ok' });
      } else if (entry.kind === 'switch') {
        let used = false;
        walkAudioNodes(object.node, (node) => {
          if (node.kind === 'switch' && node.groupId === id) used = true;
        });
        if (used) rows.push({ label: object.name || object.id, note: '切换容器', dot: 'ok' });
      } else if (object.stateOffsets.some((item) => item.groupId === id)) {
        rows.push({ label: object.name || object.id, note: '状态偏移', dot: 'ok' });
      }
    }
    for (const event of project.events) {
      for (const action of event.actions) {
        const hit = (action.type === 'setSwitch' && entry.kind === 'switch' && action.groupId === id)
          || (action.type === 'setState' && entry.kind === 'state' && action.groupId === id);
        if (hit) rows.push({ label: event.name || event.id, note: '事件动作', dot: 'cyan' });
      }
    }
    for (const segment of project.music?.segments ?? []) {
      for (const track of segment.tracks) {
        if (entry.kind === 'switch' && track.switchGroupId === id) {
          rows.push({ label: `${segment.name} / ${track.id}`, note: '音乐轨', dot: 'cyan' });
        }
        if (entry.kind === 'rtpc' && track.rtpcBindings.some((item) => item.rtpcId === id)) {
          rows.push({ label: `${segment.name} / ${track.id}`, note: '音乐轨', dot: 'cyan' });
        }
      }
    }
    for (const binding of project.bindings) {
      const follow = binding.follow;
      if (!follow || !aliases.includes(follow.field)) continue;
      const matches = (entry.kind === 'rtpc' && follow.range) || (entry.kind !== 'rtpc' && follow.cases);
      if (matches) {
        rows.push({
          label: binding.eventId,
          note: '事件跟随',
          dot: 'ok',
          jump: () => setWorkspace('events'),
        });
      }
    }
    return rows;
  };

  const syncKindLabel = (kind: SyncKind): string => (
    kind === 'switch' ? '切换组' : kind === 'rtpc' ? '连续参数' : '状态组'
  );

  const syncThumb = (entry: SyncEntry): SVGElement => {
    if (entry.kind === 'rtpc') {
      return curveThumb(rtpcCurvePoints(entry.entity, 4, 116, 6, 52), ACCENT);
    }
    return barsThumb(
      entry.entity.values.length,
      entry.kind === 'switch' ? 'rgba(212,255,72,.5)' : 'rgba(140,170,255,.5)',
    );
  };

  const renderSyncs = (): void => {
    if (!project) return;
    const entries = syncEntries();
    const refCounts = new Map<string, number>();
    for (const entry of entries) refCounts.set(entry.key, syncRefs(entry).length);
    const unused = entries.filter((entry) => (refCounts.get(entry.key) ?? 0) === 0);

    renderChips([
      {
        rule: '类型',
        chips: [
          { key: 'all', label: '全部', count: entries.length },
          { key: 'switch', label: '切换组', count: project.gameSyncs.switches.length },
          { key: 'rtpc', label: '连续参数', count: project.gameSyncs.rtpcs.length },
          { key: 'state', label: '状态组', count: project.gameSyncs.states.length },
        ],
      },
      { rule: '引用', chips: [{ key: 'unused', label: '无人引用', count: unused.length, tone: 'warn' }] },
    ]);

    const visible = entries.filter((entry) => {
      if (filterKey === 'unused') return (refCounts.get(entry.key) ?? 0) === 0;
      if (filterKey === 'all') return true;
      return entry.kind === filterKey;
    });

    renderCards(visible.map((entry): CardSpec => {
      const refs = refCounts.get(entry.key) ?? 0;
      const tags: TagSpec[] = [];
      if (entry.kind === 'rtpc') {
        tags.push({ text: 'RTPC', tone: 'accent' }, { text: `${entry.entity.min}–${entry.entity.max}` });
      } else if (entry.kind === 'switch') {
        tags.push({ text: 'Switch', tone: 'cyan' }, { text: `${entry.entity.values.length} 值` });
      } else {
        tags.push({ text: 'State' }, { text: `${entry.entity.values.length} 状态` });
      }
      if (refs === 0) tags.push({ text: '无人引用', tone: 'warn' });
      return {
        id: entry.key,
        title: entry.entity.name,
        subtitle: entry.entity.id,
        tags,
        thumb: syncThumb(entry),
      };
    }), entries.length === 0 ? '还没有游戏变量，用右上角按钮新建。' : '当前筛选下没有变量。');

    const actions = byId('designEntityActions');
    actions.innerHTML = '';
    for (const [kind, label] of [['switch', '新建切换组'], ['rtpc', '新建连续参数'], ['state', '新建状态组']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'audio-secondary-btn';
      button.textContent = label;
      button.addEventListener('click', () => { void createSync(kind); });
      actions.append(button);
    }

    const active = entries.find((entry) => entry.key === selectedId) ?? visible[0] ?? entries[0];
    if (!active) {
      preview('选择条目后查看');
      stageEmpty(byId('designPreviewStage'), '还没有游戏变量', '切换组 / 连续参数 / 状态组');
      setEntityHeader('游戏变量库', '切换组 / 连续参数 / 状态组');
      clearEditor('选择或新建一个游戏变量');
      return;
    }
    selectedId = active.key;
    setEntityHeader('游戏变量库', `${active.entity.id} · ${syncKindLabel(active.kind)}`);
    renderSyncPreview(active, syncRefs(active));
    if (active.kind === 'switch') renderSwitchEditor(active.entity, active);
    else if (active.kind === 'rtpc') renderRtpcEditor(active.entity, active);
    else renderStateEditor(active.entity, active);
  };

  const renderSyncPreview = (
    entry: SyncEntry,
    refs: Array<{ label: string; note: string; dot: DotTone }>,
  ): void => {
    const { stage, meta } = preview('取值域 · 平滑 · 默认值');
    const cells: MetaCell[] = [
      { label: '名称', value: entry.entity.name },
      { label: '变量名', value: entry.entity.id, tone: 'mono' },
      { label: '类型', value: `${syncKindLabel(entry.kind)} ${entry.kind.toUpperCase()}`, tone: 'accent' },
    ];

    if (entry.kind === 'rtpc') {
      const rtpc = entry.entity;
      const root = stageCurve(stage);
      root.append(svgNode('line', { x1: 0, y1: 150, x2: 560, y2: 150, stroke: RULE }));
      root.append(svgNode('line', { x1: 0, y1: 86, x2: 560, y2: 86, stroke: RULE_SOFT, 'stroke-dasharray': '3 4' }));
      const points = rtpcCurvePoints(rtpc, 14, 546, 22, 146);
      root.append(polylineNode(points, ACCENT));
      const span = rtpc.max - rtpc.min;
      const ratio = span > 0 ? clamp01((rtpc.defaultValue - rtpc.min) / span) : 0;
      const markerX = 14 + ratio * 532;
      const markerIndex = Math.round(ratio * (points.length - 1));
      const markerY = points[markerIndex] ? points[markerIndex][1] : 146;
      root.append(svgNode('line', { x1: markerX, y1: 18, x2: markerX, y2: 150, stroke: '#ffffff', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
      root.append(svgNode('circle', { cx: markerX, cy: markerY, r: 4, fill: ACCENT }));
      stageOverlay(stage, [
        { text: `默认值 ${rtpc.defaultValue}`, tone: 'accent' },
        { text: `平滑 ${rtpc.slewMsDefault} ms` },
      ]);
      stageAxis(stage, [0, 0.25, 0.5, 0.75, 1].map((step) => {
        const value = rtpc.min + (rtpc.max - rtpc.min) * step;
        return String(Math.round(value * 100) / 100);
      }));
      cells.push(
        { label: '作用域', value: rtpc.scope === 'global' ? '全局' : '按发声体' },
        { label: '取值范围', value: `${rtpc.min} – ${rtpc.max}` },
        { label: '默认值', value: `${rtpc.defaultValue} · 平滑 ${rtpc.slewMsDefault} 毫秒` },
      );
    } else {
      const values = entry.entity.values;
      stageBars(stage, values.length > 0
        ? values.map((value) => ({ label: value, selected: value === entry.entity.defaultValue }))
        : [{ label: '还没有可选值' }]);
      const root = stageCurve(stage);
      root.append(svgNode('line', { x1: 0, y1: 118, x2: 560, y2: 118, stroke: RULE }));
      const slot = values.length > 0 ? 532 / values.length : 532;
      values.forEach((value, index) => {
        const x = 14 + slot * (index + 0.5);
        const active = value === entry.entity.defaultValue;
        root.append(svgNode('line', {
          x1: x,
          y1: active ? 74 : 92,
          x2: x,
          y2: 118,
          stroke: active ? ACCENT : (entry.kind === 'switch' ? 'rgba(212,255,72,.4)' : 'rgba(140,170,255,.55)'),
          'stroke-width': 3,
        }));
      });
      stageAxis(stage, [
        `${values.length} 个可选值`,
        `默认 ${entry.entity.defaultValue || '未设置'}`,
      ]);
      const transition = entry.kind === 'state' ? entry.entity.transitions[0]?.timeMs : undefined;
      cells.push(
        { label: '作用域', value: '全局' },
        { label: '取值范围', value: values.join(' / ') || '（空）' },
        {
          label: '默认值',
          value: transition === undefined
            ? (entry.entity.defaultValue || '未设置')
            : `${entry.entity.defaultValue || '未设置'} · 过渡 ${transition} 毫秒`,
        },
      );
    }

    cells.push(
      { label: '被引用', value: refs.length > 0 ? `${refs.length} 处` : '0 处（可安全删除）' },
      { label: '编译状态', value: 'gameSyncs 未序列化', tone: 'error' },
    );
    renderMeta(meta, cells);
  };

  const syncWriteCall = (entry: SyncEntry): string => {
    if (entry.kind === 'rtpc') return `setGameValue('${entry.entity.id}', v)`;
    if (entry.kind === 'switch') return `setSwitch('${entry.entity.id}', '${entry.entity.defaultValue}')`;
    return `setState('${entry.entity.id}', '${entry.entity.defaultValue}')`;
  };

  const appendSyncSideColumns = (editor: { column: () => HTMLElement }, entry: SyncEntry): void => {
    const refs = syncRefs(entry);
    const refColumn = editor.column();
    const refRows = refs.length > 0
      ? refs.map((ref) => fixRow(ref.label, ref.note, ref.dot, ref.jump))
      : [emptyNote('没有任何事件、声音对象或音乐轨引用这个变量，可以安全删除。')];
    refColumn.append(section('被谁引用', '只读 · 删改前先看这里', stack(...refRows)));
    refColumn.append(hint('改动取值范围 / 可选值会同时影响以上位置。点带「事件跟随」的行可以跳到声音事件页。'));

    const runtimeColumn = editor.column();
    runtimeColumn.append(section('游戏侧接入', '只读', stack(
      fixRow(syncWriteCall(entry), '游戏侧写入', 'cyan'),
      fixRow('运行时使用默认值兜底', '不报错也不静音', 'ok'),
      fixRow('gameSyncs 未写进运行时', '编译器缺失', 'error'),
    )));
    runtimeColumn.append(hint('编译器只把 bankFeatures 开关和 attenuations / bindings 写进运行时，变量定义本身还没有序列化：这一页配好的取值范围与默认值在游戏里读不到。'));
  };

  const createSync = async (kind: SyncKind): Promise<void> => {
    if (!project || !slug) return;
    const name = window.prompt(kind === 'switch' ? '切换组名称' : kind === 'rtpc' ? '连续参数名称' : '状态组名称');
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const patch = kind === 'switch'
        ? { switches: [createSwitchGroup(name)] }
        : kind === 'rtpc'
          ? { rtpcs: [createRtpc(name)] }
          : { states: [createStateGroup(name)] };
      const result = await defineGameSyncDraft(slug, project.revision, patch);
      adoptProject(result.project);
      const created = kind === 'switch'
        ? result.project.gameSyncs.switches[result.project.gameSyncs.switches.length - 1]
        : kind === 'rtpc'
          ? result.project.gameSyncs.rtpcs[result.project.gameSyncs.rtpcs.length - 1]
          : result.project.gameSyncs.states[result.project.gameSyncs.states.length - 1];
      selectedId = created ? `${kind}:${created.id}` : '';
      showToast('游戏变量已保存到草稿', 'success');
      renderEntityWorkspace();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveSync = async (patch: {
    switches?: SwitchGroup[];
    rtpcs?: RtpcDefinition[];
    states?: StateGroup[];
  }): Promise<void> => {
    if (!project || !slug) return;
    setBusy(true);
    try {
      const result = await defineGameSyncDraft(slug, project.revision, patch);
      adoptProject(result.project);
      showToast('游戏变量已保存到草稿', 'success');
      renderEntityWorkspace();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const renderSwitchEditor = (group: SwitchGroup, entry: SyncEntry): void => {
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(group.name, '名称');
    const values = textInput(group.values.join(', '), '可选值');
    const defaults = document.createElement('select');
    const rebuildDefaults = (): void => {
      const list = parseCsvValues(values.value);
      defaults.innerHTML = '';
      for (const value of list) defaults.append(option(value, value));
      defaults.value = list.includes(group.defaultValue) ? group.defaultValue : (list[0] ?? '');
    };
    rebuildDefaults();
    values.addEventListener('input', rebuildDefaults);
    const body = stack(
      field('名称', name),
      field('可选值（逗号分隔）', values),
      fieldRow(field('默认值', defaults)),
    );
    const save = saveButton('保存到草稿', () => {
      const nextValues = parseCsvValues(values.value);
      if (nextValues.length === 0) {
        showToast('至少需要一个可选值', 'warning');
        return;
      }
      void saveSync({
        switches: [{
          ...group,
          name: name.value.trim() || group.name,
          values: nextValues,
          defaultValue: defaults.value || nextValues[0]!,
        }],
      });
    });
    host.append(section('切换组', 'Switch', body), save);
    host.append(hint('声音事件里「跟随游戏变化」选地面材质等预设时，会引用这类切换组。游戏侧用 setSwitch / setGameValue 喂值。'));
    appendSyncSideColumns(editor, entry);
  };

  const renderRtpcEditor = (rtpc: RtpcDefinition, entry: SyncEntry): void => {
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(rtpc.name, '名称');
    const min = numberInput(rtpc.min, '最小值', { min: -100, max: 100, step: 0.1 });
    const max = numberInput(rtpc.max, '最大值', { min: -100, max: 100, step: 0.1 });
    const def = numberInput(rtpc.defaultValue, '默认值', { min: -100, max: 100, step: 0.1 });
    const slew = numberInput(rtpc.slewMsDefault, '平滑毫秒', { min: 0, max: 2000, step: 10, unit: 'ms' });
    const scope = document.createElement('select');
    scope.append(option('global', '全局'), option('gameObject', '按发声体'));
    scope.value = rtpc.scope;
    const body = stack(
      field('名称', name),
      field('作用域', scope),
      fieldRow(field('最小值', min), field('最大值', max)),
      fieldRow(field('默认值', def), field('默认平滑（毫秒）', slew)),
    );
    const save = saveButton('保存到草稿', () => {
      const nextMin = Number(min.value);
      const nextMax = Number(max.value);
      if (!(nextMax > nextMin)) {
        showToast('最大值必须大于最小值', 'warning');
        return;
      }
      void saveSync({
        rtpcs: [{
          ...rtpc,
          name: name.value.trim() || rtpc.name,
          min: nextMin,
          max: nextMax,
          defaultValue: Number(def.value),
          scope: scope.value as RtpcDefinition['scope'],
          slewMsDefault: Math.max(0, Number(slew.value) || 0),
        }],
      });
    });
    host.append(section('连续参数', 'RTPC', body), save);
    host.append(hint('事件的「跟随 → 随数值连续变化」会生成/引用连续参数。曲线效果仍在事件编辑里用「越大越强烈」等预设选择。'));
    appendSyncSideColumns(editor, entry);
  };

  const renderStateEditor = (state: StateGroup, entry: SyncEntry): void => {
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(state.name, '名称');
    const values = textInput(state.values.join(', '), '可选状态');
    const defaults = document.createElement('select');
    const rebuildDefaults = (): void => {
      const list = parseCsvValues(values.value);
      defaults.innerHTML = '';
      for (const value of list) defaults.append(option(value, value));
      defaults.value = list.includes(state.defaultValue) ? state.defaultValue : (list[0] ?? '');
    };
    rebuildDefaults();
    values.addEventListener('input', rebuildDefaults);
    const transition = numberInput(state.transitions[0]?.timeMs ?? 800, '过渡毫秒', { min: 0, max: 5000, step: 50, unit: 'ms' });
    const body = stack(
      field('名称', name),
      field('可选状态（逗号分隔）', values),
      fieldRow(field('默认状态', defaults), field('默认过渡时间（毫秒）', transition)),
    );
    const save = saveButton('保存到草稿', () => {
      const nextValues = parseCsvValues(values.value);
      if (nextValues.length === 0) {
        showToast('至少需要一个状态', 'warning');
        return;
      }
      void saveSync({
        states: [{
          ...state,
          name: name.value.trim() || state.name,
          values: nextValues,
          defaultValue: defaults.value || nextValues[0]!,
          transitions: [{ from: '*', to: '*', timeMs: Math.max(0, Number(transition.value) || 0) }],
        }],
      });
    });
    host.append(section('状态组', 'State', body), save);
    host.append(hint('状态组表达全局局势（探索 / 战斗等），过渡时间决定切换时的淡变长度。'));
    appendSyncSideColumns(editor, entry);
  };

  /* ════════════════ 总线与闪避（buses） ════════════════ */

  const busName = (id: string | undefined): string => {
    if (!id) return '';
    const found = project?.buses.find((item) => item.id === id);
    return found ? found.name : id;
  };

  /** 按 parentId 排出层级顺序；深度只用来决定是否加 `is-child`。 */
  const busOrder = (buses: AudioBusNode[]): Array<{ bus: AudioBusNode; depth: number }> => {
    const rows: Array<{ bus: AudioBusNode; depth: number }> = [];
    const known = new Set(buses.map((bus) => bus.id));
    const visited = new Set<string>();
    const walk = (parentId: string | undefined, depth: number): void => {
      for (const bus of buses) {
        const parent = bus.parentId && known.has(bus.parentId) ? bus.parentId : undefined;
        if (parent !== parentId || visited.has(bus.id)) continue;
        visited.add(bus.id);
        rows.push({ bus, depth });
        walk(bus.id, depth + 1);
      }
    };
    walk(undefined, 0);
    for (const bus of buses) {
      if (!visited.has(bus.id)) rows.push({ bus, depth: 1 });
    }
    return rows;
  };

  const renderBuses = (): void => {
    if (!project) return;
    const rows = busOrder(project.buses);
    const ducked = project.buses.filter((bus) => bus.ducking.length > 0);

    renderChips([
      {
        rule: '层级',
        chips: [
          { key: 'all', label: '全部', count: rows.length },
          { key: 'root', label: '根节点', count: rows.filter((row) => row.depth === 0).length },
          { key: 'child', label: '子总线', count: rows.filter((row) => row.depth > 0).length },
        ],
      },
      {
        rule: '规则',
        chips: [
          { key: 'duck', label: '有闪避', count: ducked.length, tone: 'info' },
          { key: 'ineffective', label: '闪避不生效', count: ducked.length, tone: 'warn' },
        ],
      },
    ]);

    const visible = rows.filter((row) => {
      if (filterKey === 'root') return row.depth === 0;
      if (filterKey === 'child') return row.depth > 0;
      if (filterKey === 'duck' || filterKey === 'ineffective') return row.bus.ducking.length > 0;
      return true;
    });

    renderTree(visible.map((row): TreeSpec => ({
      id: row.bus.id,
      label: row.bus.name,
      tail: dbText(row.bus.volumeDb),
      child: row.depth > 0,
      tags: row.bus.ducking.length > 0 ? [{ text: 'duck', tone: 'warn' }] : [],
    })), rows.length === 0 ? '还没有总线。' : '当前筛选下没有总线。');

    const actions = byId('designEntityActions');
    actions.innerHTML = '';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'audio-secondary-btn';
    add.textContent = '新建子总线';
    add.addEventListener('click', () => { void createBus(); });
    actions.append(add);

    const bus = project.buses.find((item) => item.id === selectedId)
      ?? visible[0]?.bus
      ?? rows[0]?.bus;
    if (!bus) {
      preview('选择条目后查看');
      stageEmpty(byId('designPreviewStage'), '还没有总线', '层级音量 · Ducking');
      setEntityHeader('总线库', '层级音量 · Ducking');
      clearEditor('选择一条总线');
      return;
    }
    selectedId = bus.id;
    const duck = bus.ducking[0];
    setEntityHeader('总线库', duck ? `${bus.name} · 闪避来源 ${busName(duck.sourceBusId)}` : `${bus.name} · 无闪避`);
    renderBusPreview(bus);
    renderBusEditor(bus);
  };

  const renderBusPreview = (bus: AudioBusNode): void => {
    const { stage, meta } = preview('闪避包络 · 编译状态');
    const duck = bus.ducking[0];
    const root = stageCurve(stage);
    if (duck) {
      const top = 40;
      const depth = clamp01(Math.abs(duck.volumeDb) / 12);
      const low = top + 20 + depth * 90;
      const total = Math.max(1, duck.attackMs + duck.releaseMs + 400);
      const attackW = Math.min(160, Math.max(10, (duck.attackMs / total) * 420));
      const releaseW = Math.min(200, Math.max(10, (duck.releaseMs / total) * 420));
      const start = 150;
      const holdEnd = 330;
      root.append(svgNode('line', { x1: 0, y1: top, x2: 560, y2: top, stroke: RULE_SOFT, 'stroke-dasharray': '3 4' }));
      root.append(svgNode('line', { x1: 0, y1: low, x2: 560, y2: low, stroke: RULE_SOFT, 'stroke-dasharray': '3 4' }));
      root.append(svgNode('rect', {
        x: start,
        y: 16,
        width: holdEnd + releaseW - start,
        height: 140,
        fill: 'rgba(255,176,86,.10)',
      }));
      root.append(polylineNode([
        [14, top],
        [start, top],
        [start + attackW, low],
        [holdEnd, low],
        [holdEnd + releaseW, top],
        [546, top],
      ], ACCENT));
      root.append(svgText(start + 6, 12, `attack ${duck.attackMs}ms`));
      root.append(svgText(holdEnd + 6, 12, `release ${duck.releaseMs}ms`));
      stageOverlay(stage, [{
        text: `${busName(duck.sourceBusId)} 发声 → ${bus.name} 压低 ${Math.abs(duck.volumeDb)} dB`,
        tone: 'warn',
      }]);
      stageAxis(stage, [
        dbText(bus.volumeDb),
        `${busName(duck.sourceBusId)} 起`,
        `${dbText(duck.volumeDb)} 保持`,
        `${busName(duck.sourceBusId)} 停`,
        '恢复',
      ]);
    } else {
      root.append(svgNode('line', { x1: 0, y1: 86, x2: 560, y2: 86, stroke: RULE_SOFT, 'stroke-dasharray': '3 4' }));
      root.append(polylineNode([[14, 86], [546, 86]], ACCENT));
      root.append(svgText(20, 76, '无闪避规则 · 音量恒定'));
      stageOverlay(stage, [{ text: '没有配置闪避来源' }]);
      stageAxis(stage, ['时间 →', dbText(bus.volumeDb)]);
    }

    renderMeta(meta, [
      { label: '名称', value: bus.name },
      { label: '父级', value: bus.parentId ? busName(bus.parentId) : '根节点' },
      { label: '音量', value: dbText(bus.volumeDb) },
      { label: '声部上限', value: bus.voiceLimit ? String(bus.voiceLimit) : '0（不限）' },
      { label: '来源总线', value: duck ? busName(duck.sourceBusId) : '无闪避', tone: duck ? 'accent' : undefined },
      { label: '压低量', value: duck ? dbText(duck.volumeDb) : '—' },
      { label: '编译状态', value: 'buses 未序列化', tone: 'error' },
      { label: '游戏内效果', value: '闪避不生效', tone: 'error' },
    ]);
  };

  const renderBusEditor = (bus: AudioBusNode): void => {
    if (!project) return;
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(bus.name, '名称');
    const volume = numberInput(bus.volumeDb, '音量 dB', { min: -24, max: 12, step: 0.5, unit: 'dB' });
    const limit = numberInput(bus.voiceLimit ?? 0, '声部上限', { min: 0, max: 64, step: 1 });
    const parent = document.createElement('select');
    parent.append(option('', '（根节点）'));
    for (const candidate of project.buses) {
      if (candidate.id === bus.id) continue;
      parent.append(option(candidate.id, candidate.name));
    }
    parent.value = bus.parentId ?? '';

    const duckSource = document.createElement('select');
    duckSource.append(option('', '无闪避'));
    for (const candidate of project.buses) {
      if (candidate.id === bus.id) continue;
      duckSource.append(option(candidate.id, candidate.name));
    }
    const duck = bus.ducking[0];
    duckSource.value = duck?.sourceBusId ?? '';
    const duckDb = numberInput(duck?.volumeDb ?? -8, '压低 dB', { min: -24, max: 0, step: 0.5, unit: 'dB' });
    const duckAttack = numberInput(duck?.attackMs ?? 40, 'Attack', { min: 0, max: 2000, step: 10, unit: 'ms' });
    const duckRelease = numberInput(duck?.releaseMs ?? 320, 'Release', { min: 0, max: 4000, step: 10, unit: 'ms' });

    const body = stack(
      field('名称', name),
      field('父级', parent),
      fieldRow(field('音量 (dB)', volume), field('声部上限（0=不限）', limit)),
    );
    const save = saveButton('保存到草稿', () => {
      const next: AudioBusNode = {
        ...bus,
        name: name.value.trim() || bus.name,
        volumeDb: Number(volume.value),
        ...(parent.value ? { parentId: parent.value } : { parentId: undefined }),
        ...(Number(limit.value) > 0 ? { voiceLimit: Math.floor(Number(limit.value)) } : { voiceLimit: undefined }),
        ducking: duckSource.value
          ? [{
            sourceBusId: duckSource.value,
            volumeDb: Number(duckDb.value),
            attackMs: Math.max(0, Number(duckAttack.value) || 0),
            releaseMs: Math.max(0, Number(duckRelease.value) || 0),
            curve: duck?.curve ?? 'linear',
          }]
          : [],
      };
      if (!next.parentId) delete next.parentId;
      if (next.voiceLimit === undefined) delete next.voiceLimit;
      void saveBuses([next]);
    });
    host.append(section('总线', '层级音量', body), save);

    const duckColumn = editor.column();
    duckColumn.append(section('闪避（Ducking）', '来源总线发声时压低本总线', stack(
      field('来源总线', duckSource),
      fieldRow(field('压低量 (dB)', duckDb), field('Attack (ms)', duckAttack), field('Release (ms)', duckRelease)),
    )));
    duckColumn.append(hint('现状：闪避由声部计数触发，不看幅度阈值。参数改动保存后会反映到左上的包络预览。'));

    const compileColumn = editor.column();
    compileColumn.append(section('编译产物检查', '只读 · 决定配置是否真的进了游戏', stack(
      fixRow('buses 序列化', '缺失', 'error'),
      fixRow('闪避规则写入运行时', '未进游戏', 'error'),
      fixRow('声部结束回收', '依赖上一项', 'warn'),
      fixRow('重新验证接入', '运行验证', 'info', () => { void runVerify(false); }),
    )));
    compileColumn.append(hint('编译器当前只把 attenuations 与 bindings 写进运行时，buses 没有落盘，所以这一页配好的层级音量与闪避在游戏里不会生效。要先修编译器，界面配置才有意义。'));
  };

  const createBus = async (): Promise<void> => {
    if (!project || !slug) return;
    const name = window.prompt('子总线名称', 'SFX Extra');
    if (!name?.trim()) return;
    const created = createChildBus(name, selectedId.startsWith('bus:') ? selectedId : 'bus:master');
    await saveBuses([created]);
    selectedId = created.id;
  };

  const saveBuses = async (buses: AudioBusNode[]): Promise<void> => {
    if (!project || !slug) return;
    setBusy(true);
    try {
      const result = await defineBusDraft(slug, project.revision, buses);
      adoptProject(result.project);
      showToast('总线已保存到草稿', 'success');
      renderEntityWorkspace();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ════════════════ 距离衰减（atten） ════════════════ */

  const attenRefs = (atten: AttenuationShareSet): Array<{ label: string; note: string; jump?: () => void }> => {
    if (!project) return [];
    const rows: Array<{ label: string; note: string; jump?: () => void }> = [];
    for (const binding of project.bindings) {
      if (binding.playback.attenuationId !== atten.id) continue;
      rows.push({
        label: binding.eventId,
        note: binding.playback.mode === 'loop' ? '3D · 循环' : '3D',
        jump: () => setWorkspace('events'),
      });
    }
    for (const object of project.objects) {
      if (object.attenuationId !== atten.id) continue;
      if (rows.some((row) => row.label === (object.name || object.id))) continue;
      rows.push({ label: object.name || object.id, note: '声音对象' });
    }
    return rows;
  };

  const attenCurveText = (atten: AttenuationShareSet): string => {
    const points = atten.curves.outputVolumeDb;
    if (points.length === 0) return '未定义';
    return points
      .map((point) => `${Math.round(point.x * 10) / 10}m→${Math.round(point.y)}dB`)
      .join(' · ');
  };

  const renderAtten = (): void => {
    if (!project) return;
    const items = project.attenuations;
    const coned = items.filter((item) => Boolean(item.cone));
    const loud = items.filter((item) => attenTailDb(item) > SILENCE_DB);

    renderChips([
      {
        rule: '预设',
        chips: [
          { key: 'all', label: '全部', count: items.length },
          { key: 'near', label: '近距离', count: items.filter((item) => item.maxDistance <= 20).length },
          { key: 'far', label: '远距离', count: items.filter((item) => item.maxDistance > 20).length },
        ],
      },
      {
        rule: '特性',
        chips: [
          { key: 'cone', label: '带锥形', count: coned.length, tone: 'info' },
          { key: 'loud', label: '末端不静音', count: loud.length, tone: 'warn' },
        ],
      },
    ]);

    const visible = items.filter((item) => {
      if (filterKey === 'near') return item.maxDistance <= 20;
      if (filterKey === 'far') return item.maxDistance > 20;
      if (filterKey === 'cone') return Boolean(item.cone);
      if (filterKey === 'loud') return attenTailDb(item) > SILENCE_DB;
      return true;
    });

    renderCards(visible.map((item): CardSpec => {
      const neverSilent = attenTailDb(item) > SILENCE_DB;
      const refs = attenRefs(item).length;
      const tags: TagSpec[] = [];
      if (item.cone) tags.push({ text: '锥形', tone: 'cyan' });
      if (neverSilent) tags.push({ text: '末端不静音', tone: 'warn' });
      if (refs > 0) tags.push({ text: `${refs} 引用` });
      return {
        id: item.id,
        title: item.name,
        subtitle: `max ${item.maxDistance} m`,
        tags,
        thumb: curveThumb(attenCurvePoints(item, 4, 116, 6, 54), neverSilent ? WARN : ACCENT),
      };
    }), items.length === 0 ? '还没有衰减预设，用右上角按钮新建。' : '当前筛选下没有预设。');

    const actions = byId('designEntityActions');
    actions.innerHTML = '';
    for (const [kind, label] of [['melee', '近战'], ['close', '贴身'], ['scene', '场景'], ['far', '远处']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'audio-secondary-btn';
      button.textContent = `新建·${label}`;
      button.addEventListener('click', () => { void createAtten(kind); });
      actions.append(button);
    }

    const atten = items.find((item) => item.id === selectedId) ?? visible[0] ?? items[0];
    if (!atten) {
      preview('选择条目后查看');
      stageEmpty(byId('designPreviewStage'), '还没有衰减预设', '可复用预设 · 声音对象引用');
      setEntityHeader('衰减预设库', '可复用预设 · 声音对象引用');
      clearEditor('选择或新建一个衰减预设');
      return;
    }
    selectedId = atten.id;
    setEntityHeader('衰减预设库', `${atten.name} · ${atten.maxDistance} m${atten.cone ? ' · 带锥形' : ''}`);
    renderAttenPreview(atten);
    renderAttenEditor(atten);
  };

  const renderAttenPreview = (atten: AttenuationShareSet): void => {
    const { stage, meta } = preview('音量曲线 · 锥形 · 末端静音');
    const neverSilent = attenTailDb(atten) > SILENCE_DB;
    const root = stageCurve(stage);
    root.append(svgNode('line', { x1: 0, y1: 26, x2: 560, y2: 26, stroke: RULE_SOFT, 'stroke-dasharray': '3 4' }));
    root.append(svgNode('line', { x1: 0, y1: 76, x2: 560, y2: 76, stroke: RULE_SOFT, 'stroke-dasharray': '3 4' }));
    root.append(svgNode('line', { x1: 0, y1: 152, x2: 560, y2: 152, stroke: RULE }));
    const points = attenCurvePoints(atten, 14, 540, 26, 152);
    root.append(polylineNode(points, neverSilent ? WARN : ACCENT));
    for (const point of points) {
      root.append(svgNode('circle', { cx: point[0], cy: point[1], r: 3.5, fill: neverSilent ? WARN : ACCENT }));
    }
    root.append(svgText(18, 20, '0 dB'));
    root.append(svgText(18, 70, '−6 dB'));
    root.append(svgText(430, 146, `${Math.round(attenTailDb(atten))} dB`));
    if (atten.cone) stageCone(stage, atten.cone);
    stageOverlay(stage, [
      { text: `最大距离 ${atten.maxDistance} m`, tone: 'accent' },
      ...(atten.cone
        ? [{ text: `锥形 内 ${atten.cone.innerAngleDeg}° / 外 ${atten.cone.outerAngleDeg}°`, tone: 'cyan' as Tone }]
        : []),
      ...(neverSilent ? [{ text: '末端不静音', tone: 'warn' as Tone }] : []),
    ]);
    // 最右侧标签留空：锥形俯视图钉在右上角，写满会压到坐标轴。
    stageAxis(stage, [
      '0 m',
      `${Math.round(atten.maxDistance * 0.25 * 10) / 10} m`,
      `${Math.round(atten.maxDistance * 0.5 * 10) / 10} m`,
      `${Math.round(atten.maxDistance * 0.75 * 10) / 10} m`,
      '',
    ]);

    renderMeta(meta, [
      { label: '名称', value: atten.name },
      { label: '最大距离', value: `${atten.maxDistance} m` },
      { label: '曲线', value: attenCurveText(atten) },
      {
        label: '末端静音',
        value: neverSilent ? `不静音（${Math.round(attenTailDb(atten))} dB）` : '满足验证',
        tone: neverSilent ? 'error' : 'accent',
      },
      {
        label: '锥形',
        value: atten.cone ? `启用 · 内 ${atten.cone.innerAngleDeg}° / 外 ${atten.cone.outerAngleDeg}°` : '未启用',
      },
      {
        label: '外侧',
        value: atten.cone ? `${dbText(atten.cone.outerVolumeDb)} · 低通 ${atten.cone.outerLowpassHz} Hz` : '—',
      },
      { label: '被引用', value: `${attenRefs(atten).length} 处 3D 发声` },
      { label: '长音更新', value: '仅发声瞬间计算', tone: 'error' },
    ]);
  };

  const renderAttenEditor = (atten: AttenuationShareSet): void => {
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(atten.name, '名称');
    const maxDistance = numberInput(atten.maxDistance, '最大距离', { min: 1, max: 200, step: 0.5, unit: 'm' });
    const inner = numberInput(atten.cone?.innerAngleDeg ?? 60, '内角', { min: 0, max: 360, step: 1, unit: '°' });
    const outer = numberInput(atten.cone?.outerAngleDeg ?? 120, '外角', { min: 0, max: 360, step: 1, unit: '°' });
    const outerDb = numberInput(atten.cone?.outerVolumeDb ?? -12, '外侧音量', { min: -96, max: 0, step: 1, unit: 'dB' });
    const outerLp = numberInput(atten.cone?.outerLowpassHz ?? 2500, '外侧低通', { min: 20, max: 20_000, step: 10, unit: 'Hz' });
    const enableCone = document.createElement('input');
    enableCone.type = 'checkbox';
    enableCone.checked = Boolean(atten.cone);

    const save = saveButton('保存到草稿', () => {
      const max = Math.max(0.1, Number(maxDistance.value) || atten.maxDistance);
      const next: AttenuationShareSet = {
        ...atten,
        name: name.value.trim() || atten.name,
        maxDistance: max,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: max * 0.5, y: -6, interp: 'linear' },
            { x: max, y: -96, interp: 'linear' },
          ],
        },
        ...(enableCone.checked
          ? {
            cone: {
              innerAngleDeg: Number(inner.value),
              outerAngleDeg: Number(outer.value),
              outerVolumeDb: Number(outerDb.value),
              outerLowpassHz: Number(outerLp.value),
            },
          }
          : {}),
      };
      if (!enableCone.checked) delete next.cone;
      void saveAtten([next]);
    });
    host.append(section('衰减预设', '可复用', stack(
      field('名称', name),
      fieldRow(field('最大距离 (m)', maxDistance)),
    )), save);
    host.append(hint(`音量曲线：0m → 0 dB，中段约 -6 dB，${atten.maxDistance}m → -96 dB（验证要求末端 ≤ ${SILENCE_DB} dB）。`));

    const coneToggle = document.createElement('label');
    coneToggle.className = 'binding-enabled';
    const coneLabel = document.createElement('span');
    coneLabel.textContent = '启用锥形衰减';
    coneToggle.append(enableCone, coneLabel);
    const coneColumn = editor.column();
    coneColumn.append(section('锥形', '朝向影响音量与低通', stack(
      fieldRow(coneToggle),
      fieldRow(field('内角 (°)', inner), field('外角 (°)', outer)),
      fieldRow(field('外侧音量 (dB)', outerDb), field('外侧低通 (Hz)', outerLp)),
    )));
    coneColumn.append(hint('内外角保存后会画进右上的锥形俯视图；内角内是全音量区，内外角之间过渡到外侧音量。'));

    const refColumn = editor.column();
    const refs = attenRefs(atten);
    const rows = refs.length > 0
      ? refs.map((ref) => fixRow(ref.label, ref.note, 'ok', ref.jump))
      : [emptyNote('还没有事件或声音对象引用这个预设。')];
    rows.push(fixRow('播放中随距离更新', '不更新', 'error'));
    refColumn.append(section('引用与运行时', '只读', stack(...rows)));
    refColumn.append(hint('衰减只在发声瞬间计算一次，长音与循环音不会随听者移动改变音量与闷感——这是运行时缺陷，改参数绕不过去。'));
  };

  const createAtten = async (kind: 'close' | 'melee' | 'scene' | 'far'): Promise<void> => {
    if (!project || !slug) return;
    const created = attenuationPreset(kind);
    await saveAtten([created]);
    selectedId = created.id;
  };

  const saveAtten = async (attenuations: AttenuationShareSet[]): Promise<void> => {
    if (!project || !slug) return;
    setBusy(true);
    try {
      const result = await defineAttenuationDraft(slug, project.revision, attenuations);
      adoptProject(result.project);
      showToast('衰减预设已保存到草稿', 'success');
      renderEntityWorkspace();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ════════════════ 交互音乐（music） ════════════════ */

  const musicProject = () => project?.music ?? { segments: [], playlists: [], transitions: [], stingers: [] };

  const segmentBars = (segment: MusicSegment): {
    barMs: number;
    totalBars: number;
    introPct: number;
    loopPct: number;
    outroPct: number;
    entryBar: number;
    exitBar: number;
  } => {
    const beats = Math.max(1, segment.timeSignature[0] || 4);
    const barMs = (60_000 / Math.max(1, segment.tempo)) * beats;
    const entryBar = Math.max(0, segment.entryCueMs / barMs);
    const exitBar = Math.max(entryBar + 1, segment.exitCueMs / barMs);
    const outroBars = Math.max(1, segment.postExitMs / barMs || 2);
    const totalBars = Math.max(4, Math.min(48, Math.ceil(exitBar + outroBars)));
    const introPct = clamp01(entryBar / totalBars) * 100;
    const loopPct = clamp01((exitBar - entryBar) / totalBars) * 100;
    return {
      barMs,
      totalBars,
      introPct,
      loopPct,
      outroPct: Math.max(0, 100 - introPct - loopPct),
      entryBar,
      exitBar,
    };
  };

  const playlistOf = (segmentId: string): MusicPlaylist | undefined => (
    musicProject().playlists.find((playlist) => playlist.segmentIds.includes(segmentId))
  );

  const renderMusic = (): void => {
    if (!project) return;
    const music = musicProject();
    const unloaded = music.segments.filter((item) => item.tracks.length === 0);
    const orphan = music.segments.filter((item) => !playlistOf(item.id));

    renderChips([
      {
        rule: '类型',
        chips: [
          { key: 'all', label: '全部', count: music.segments.length + music.playlists.length },
          { key: 'seg', label: '乐段', count: music.segments.length },
          { key: 'pl', label: '播放列表', count: music.playlists.length },
        ],
      },
      {
        rule: '状态',
        chips: [
          { key: 'noasset', label: '未挂素材', count: unloaded.length, tone: 'warn' },
          { key: 'orphan', label: '未入列表', count: orphan.length, tone: 'info' },
        ],
      },
    ]);

    const cards: CardSpec[] = [];
    const wantSegments = filterKey !== 'pl';
    const wantPlaylists = filterKey === 'all' || filterKey === 'pl';
    if (wantSegments) {
      for (const segment of music.segments) {
        if (filterKey === 'noasset' && segment.tracks.length > 0) continue;
        if (filterKey === 'orphan' && playlistOf(segment.id)) continue;
        const tags: TagSpec[] = [{ text: '乐段', tone: 'cyan' }];
        if (segment.tracks.length > 0) tags.push({ text: `${segment.tracks.length} 轨` });
        else tags.push({ text: '未挂素材', tone: 'warn' });
        cards.push({
          id: `seg:${segment.id}`,
          title: segment.name,
          subtitle: `${segment.tempo} BPM · ${segment.timeSignature.join('/')}`,
          tags,
          music: true,
          thumb: waveThumb(hashSeed(segment.id), 'rgba(34,211,238,.5)'),
        });
      }
    }
    if (wantPlaylists) {
      for (const playlist of music.playlists) {
        cards.push({
          id: `pl:${playlist.id}`,
          title: playlist.name,
          subtitle: `播放列表 · ${playlist.segmentIds.length} 段`,
          tags: [{ text: '列表' }],
          thumb: barsThumb(playlist.segmentIds.length || 1, 'rgba(140,170,255,.5)'),
        });
      }
    }

    const total = music.segments.length + music.playlists.length;
    renderCards(cards, total === 0 ? '还没有乐段或播放列表。' : '当前筛选下没有内容。');

    const actions = byId('designEntityActions');
    actions.innerHTML = '';
    const addSeg = document.createElement('button');
    addSeg.type = 'button';
    addSeg.className = 'audio-secondary-btn';
    addSeg.textContent = '新建乐段';
    addSeg.addEventListener('click', () => { void createSegment(); });
    const addPl = document.createElement('button');
    addPl.type = 'button';
    addPl.className = 'audio-secondary-btn';
    addPl.textContent = '新建播放列表';
    addPl.addEventListener('click', () => { void createPlaylist(); });
    actions.append(addSeg, addPl);

    const activeId = cards.some((card) => card.id === selectedId) ? selectedId : (cards[0]?.id ?? '');
    if (!activeId) {
      preview('选择条目后查看');
      stageEmpty(byId('designPreviewStage'), '还没有交互音乐', '乐段 · 播放列表 · 过渡');
      setEntityHeader('音乐库', '乐段 · 播放列表 · 过渡');
      clearEditor('选择或新建乐段 / 播放列表');
      return;
    }
    selectedId = activeId;

    if (selectedId.startsWith('seg:')) {
      const segment = music.segments.find((item) => item.id === selectedId.slice('seg:'.length));
      if (!segment) { clearEditor('乐段不存在'); return; }
      setEntityHeader('音乐库', `${segment.name} · 乐段`);
      renderSegmentPreview(segment);
      renderSegmentEditor(segment);
      return;
    }
    const playlist = music.playlists.find((item) => item.id === selectedId.slice('pl:'.length));
    if (!playlist) { clearEditor('播放列表不存在'); return; }
    setEntityHeader('音乐库', `${playlist.name} · 播放列表`);
    renderPlaylistPreview(playlist);
    renderPlaylistEditor(playlist, music.segments);
  };

  const renderSegmentPreview = (segment: MusicSegment): void => {
    const mode = previewMode === 'structure' ? 'structure' : 'timeline';
    const { stage, meta } = preview('小节网格 · 入出点 · 所属列表');
    renderSeg([{ key: 'timeline', label: '时间轴' }, { key: 'structure', label: '结构' }], mode);
    const layout = segmentBars(segment);
    const playlist = playlistOf(segment.id);

    if (mode === 'timeline') {
      const bars: Array<{ label: string; selected?: boolean; basis?: number }> = [];
      if (layout.introPct > 3) bars.push({ label: 'intro', basis: layout.introPct });
      bars.push({
        label: `loop · ${Math.max(1, Math.round(layout.exitBar - layout.entryBar))} 小节`,
        selected: true,
        basis: layout.loopPct,
      });
      if (layout.outroPct > 3) bars.push({ label: 'outro', basis: layout.outroPct });
      stageBars(stage, bars);
      stageGrid(stage, layout.totalBars, { left: layout.introPct, right: layout.outroPct });
      stageAxis(stage, [0, 0.25, 0.5, 0.75, 1].map((step) => String(Math.round(layout.totalBars * step) + 1)));
    } else if (playlist) {
      stageBars(stage, playlist.segmentIds.map((id) => {
        const found = musicProject().segments.find((item) => item.id === id);
        return { label: found ? found.name : id, selected: id === segment.id };
      }));
      stageGrid(stage, Math.max(1, playlist.segmentIds.length));
      stageAxis(stage, [`播放列表 ${playlist.name}`, `${playlist.segmentIds.length} 段`]);
    } else {
      stageEmpty(stage, '这个乐段还没有进任何播放列表', '结构视图需要先把乐段加进列表');
    }

    renderMeta(meta, [
      { label: '名称', value: segment.name },
      { label: 'BPM / 拍号', value: `${segment.tempo} · ${segment.timeSignature.join('/')}` },
      { label: '入点', value: `${segment.entryCueMs} ms（第 ${Math.floor(layout.entryBar) + 1} 小节）` },
      { label: '出点', value: `${segment.exitCueMs} ms（第 ${Math.floor(layout.exitBar) + 1} 小节）` },
      {
        label: '所属列表',
        value: playlist
          ? `${playlist.name}（第 ${playlist.segmentIds.indexOf(segment.id) + 1} 段）`
          : '未加入任何列表',
      },
      {
        label: '轨道',
        value: segment.tracks.length > 0 ? `${segment.tracks.length} 层` : '未挂素材',
        tone: segment.tracks.length > 0 ? undefined : 'error',
      },
      { label: '编译状态', value: 'music / gameSyncs 未序列化', tone: 'error' },
      { label: '游戏内效果', value: '过渡不会发生', tone: 'error' },
    ]);
  };

  const renderPlaylistPreview = (playlist: MusicPlaylist): void => {
    const { stage, meta } = preview('播放顺序 · 乐段引用');
    const segments = musicProject().segments;
    const missing = playlist.segmentIds.filter((id) => !segments.some((item) => item.id === id));
    if (playlist.segmentIds.length > 0) {
      stageBars(stage, playlist.segmentIds.map((id, index) => {
        const found = segments.find((item) => item.id === id);
        return { label: `${index + 1} · ${found ? found.name : `${id}（缺失）`}`, selected: index === 0 };
      }));
      stageGrid(stage, Math.max(1, playlist.segmentIds.length));
      stageAxis(stage, ['第 1 段', `第 ${playlist.segmentIds.length} 段`]);
    } else {
      stageEmpty(stage, '这个播放列表还没有乐段', '在下方填入乐段 id');
    }
    renderMeta(meta, [
      { label: '名称', value: playlist.name },
      { label: '列表 id', value: playlist.id, tone: 'mono' },
      { label: '段数', value: `${playlist.segmentIds.length} 段` },
      {
        label: '缺失乐段',
        value: missing.length > 0 ? missing.join(', ') : '无',
        tone: missing.length > 0 ? 'error' : undefined,
      },
      { label: '播放顺序', value: playlist.segmentIds.join(' → ') || '（空）' },
      { label: '过渡规则', value: `${musicProject().transitions.length} 条` },
      { label: '编译状态', value: 'music / gameSyncs 未序列化', tone: 'error' },
      { label: '游戏内效果', value: '过渡不会发生', tone: 'error' },
    ]);
  };

  const createSegment = async (): Promise<void> => {
    if (!project || !slug) return;
    const name = window.prompt('乐段名称', 'combat_a');
    if (!name?.trim()) return;
    const created = createMusicSegment(name);
    await saveMusic({ segments: [created] });
    selectedId = `seg:${created.id}`;
  };

  const createPlaylist = async (): Promise<void> => {
    if (!project || !slug) return;
    const name = window.prompt('播放列表名称', 'combat');
    if (!name?.trim()) return;
    const created = createMusicPlaylist(name);
    await saveMusic({ playlists: [created] });
    selectedId = `pl:${created.id}`;
  };

  const saveMusic = async (patch: {
    segments?: MusicSegment[];
    playlists?: MusicPlaylist[];
  }): Promise<void> => {
    if (!project || !slug) return;
    setBusy(true);
    try {
      const result = await authorMusicDraft(slug, project.revision, patch);
      adoptProject(result.project);
      showToast('交互音乐已保存到草稿', 'success');
      renderEntityWorkspace();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const musicCompileColumn = (editor: { column: () => HTMLElement }): void => {
    const column = editor.column();
    column.append(section('编译产物检查', '只读 · 决定配置是否真的进了游戏', stack(
      fixRow('music 序列化', '缺失', 'error'),
      fixRow('gameSyncs 序列化', '缺失', 'error'),
      fixRow('过渡在游戏里发生', '不发生', 'error'),
      fixRow('重新验证接入', '运行验证', 'info', () => { void runVerify(false); }),
    )));
    column.append(hint('编译器当前没把 music 与 gameSyncs 写进运行时（只写了一个 bankFeatures 开关），过渡在游戏里不会发生。要先修编译器，这一页的结构才会生效。'));
  };

  const renderSegmentEditor = (segment: MusicSegment): void => {
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(segment.name, '名称');
    const tempo = numberInput(segment.tempo, 'BPM', { min: 40, max: 240, step: 1, unit: 'BPM' });
    const entry = numberInput(segment.entryCueMs, '入点', { min: 0, max: 30_000, step: 50, unit: 'ms' });
    const exit = numberInput(segment.exitCueMs, '出点', { min: 0, max: 30_000, step: 50, unit: 'ms' });
    const body = stack(
      field('名称', name),
      fieldRow(field('BPM', tempo), field('拍号', (() => {
        const node = textInput(segment.timeSignature.join('/'), '拍号');
        node.readOnly = true;
        return node;
      })())),
      fieldRow(field('入点 (ms)', entry), field('出点 (ms)', exit)),
    );
    const save = saveButton('保存到草稿', () => {
      void saveMusic({
        segments: [{
          ...segment,
          name: name.value.trim() || segment.name,
          tempo: Math.max(1, Number(tempo.value) || segment.tempo),
          entryCueMs: Math.max(0, Number(entry.value) || 0),
          exitCueMs: Math.max(0, Number(exit.value) || 0),
        }],
      });
    });
    host.append(section('乐段', '结构先定下来，素材可由 Agent 补', body), save);
    host.append(hint('轨道与素材挂接可由 Agent 用 author-music 补全；编辑区先把结构定下来。拍号目前由 author-music 决定，界面只读。'));

    const listColumn = editor.column();
    const playlist = playlistOf(segment.id);
    const rows = playlist
      ? playlist.segmentIds.map((id, index) => {
        const found = musicProject().segments.find((item) => item.id === id);
        return fixRow(
          `${index + 1} · ${found ? found.name : `${id}（缺失）`}`,
          id === segment.id ? '当前' : '同列表',
          found ? (id === segment.id ? 'cyan' : 'ok') : 'error',
          id === segment.id ? undefined : () => select(`seg:${id}`),
        );
      })
      : [emptyNote('这个乐段还没有加入任何播放列表，选中列表后在「乐段 id」里补上。')];
    listColumn.append(section('所属播放列表', playlist ? playlist.name : '未加入', stack(...rows)));
    listColumn.append(hint('播放顺序在播放列表实体上编辑：从库里选中对应的播放列表卡片即可。'));

    musicCompileColumn(editor);
  };

  const renderPlaylistEditor = (playlist: MusicPlaylist, segments: MusicSegment[]): void => {
    const editor = showEditor();
    const host = editor.column();
    const name = textInput(playlist.name, '名称');
    const ids = textInput(playlist.segmentIds.join(', '), '乐段 id');
    const body = stack(field('名称', name), field('乐段 id（逗号分隔）', ids));
    const save = saveButton('保存到草稿', () => {
      void saveMusic({
        playlists: [{
          ...playlist,
          name: name.value.trim() || playlist.name,
          segmentIds: parseCsvValues(ids.value),
        }],
      });
    });
    host.append(section('播放列表', `${playlist.segmentIds.length} 段`, body), save);
    if (segments.length > 0) {
      host.append(hint(`可用乐段：${segments.map((item) => item.id).join(', ')}`));
    } else {
      host.append(hint('还没有乐段，先在库里新建乐段再回来编排顺序。'));
    }

    const orderColumn = editor.column();
    const rows = playlist.segmentIds.length > 0
      ? playlist.segmentIds.map((id, index) => {
        const found = segments.find((item) => item.id === id);
        return fixRow(
          `${index + 1} · ${found ? found.name : id}`,
          found ? '存在' : '缺失',
          found ? 'ok' : 'error',
          found ? () => select(`seg:${id}`) : undefined,
        );
      })
      : [emptyNote('列表为空：在左边的「乐段 id」里按播放顺序填入。')];
    orderColumn.append(section('乐段顺序', '只读 · 顺序即播放顺序', stack(...rows)));
    orderColumn.append(hint('顺序由左边的 id 文本框决定，逗号顺序就是播放顺序；点存在的行可以跳到那个乐段。'));

    musicCompileColumn(editor);
  };

  /* ════════════════ 诊断（diag） ════════════════ */

  type DiagIssue = {
    id: string;
    level: 'error' | 'warn';
    code: string;
    message: string;
    eventId?: string;
    path?: string;
  };

  type DiagFacts = {
    source: string;
    sourceKey: string;
    expect: string;
    current: string;
    impact: string;
    action?: { label: string; run: () => void };
    codeChange?: string;
  };

  /** 只列验证器真的会报的 code；未知 code 一律退回消息本身，不猜。 */
  const diagFacts = (issue: DiagIssue): DiagFacts => {
    const target = quotedId(issue.message);
    const toEvents = { label: '去声音事件', run: () => setWorkspace('events') };
    switch (issue.code) {
      case 'binding_assets_empty':
        return {
          source: '声音事件', sourceKey: 'events',
          expect: '至少 1 个可解析的音频文件',
          current: '0 个音频文件',
          impact: '该事件在游戏里静音',
          action: toEvents,
        };
      case 'asset_missing':
      case 'asset_not_in_manifest':
        return {
          source: '声音事件', sourceKey: 'events',
          expect: '音频文件存在且已进清单',
          current: '文件解析不到',
          impact: '该变体静音',
          action: toEvents,
        };
      case 'binding_disabled':
        return {
          source: '声音事件', sourceKey: 'events',
          expect: '绑定处于启用状态',
          current: '绑定被停用',
          impact: '事件不发声',
          action: toEvents,
        };
      case 'event_not_instrumented':
        return {
          source: '声音事件', sourceKey: 'events',
          expect: '游戏代码里有 gameAudio.emit / play 字面调用',
          current: '扫不到调用点',
          impact: '事件永远不会被触发',
          codeChange: '游戏代码',
        };
      case 'attenuation_never_silent':
        return {
          source: '距离衰减', sourceKey: 'atten',
          expect: `maxDistance 处 ≤ ${SILENCE_DB} dB`,
          current: '末端仍然有音量',
          impact: '远处依然听得见',
          action: { label: '去改数值', run: () => jumpTo('atten', target) },
        };
      case 'unresolved_attenuation_id':
        return {
          source: '距离衰减', sourceKey: 'atten',
          expect: '引用的衰减预设存在',
          current: '预设找不到',
          impact: '3D 声音退化为不衰减',
          action: { label: '去距离衰减', run: () => jumpTo('atten') },
        };
      case 'bus_cycle':
      case 'bus_voice_limit_high':
      case 'unresolved_bus_id':
        return {
          source: '总线', sourceKey: 'buses',
          expect: '总线层级无环、上限合理、引用可解析',
          current: '总线结构不合法',
          impact: '输出路由不可预测',
          action: { label: '去总线', run: () => jumpTo('buses', target) },
        };
      case 'unresolved_group_id':
      case 'unresolved_rtpc_id':
      case 'rtpc_curve_out_of_range':
      case 'switch_missing_branch':
      case 'blend_layer_invalid':
        return {
          source: '游戏变量', sourceKey: 'syncs',
          expect: '引用的变量存在且取值覆盖完整',
          current: '变量缺失或分支不全',
          impact: '对应分支拿不到声音',
          action: { label: '去游戏变量', run: () => jumpTo('syncs') },
        };
      case 'music_transition_unresolved':
        return {
          source: '交互音乐', sourceKey: 'music',
          expect: '过渡两端的播放列表 / 乐段都存在',
          current: '过渡引用解析失败',
          impact: '切歌不会发生',
          action: { label: '去交互音乐', run: () => jumpTo('music') },
        };
      case 'runtime_missing':
        return {
          source: '编译产物', sourceKey: 'runtime',
          expect: 'src/forgeax-audio/* 已生成',
          current: '生成文件缺失',
          impact: '游戏侧完全没有音频运行时',
          action: { label: '确认并应用', run: () => { void applyCurrent(); } },
        };
      case 'manifest_missing':
      case 'manifest_invalid':
        return {
          source: '编译产物', sourceKey: 'runtime',
          expect: '音频清单可读',
          current: '清单缺失或损坏',
          impact: '无法校验素材是否真的存在',
          action: { label: '确认并应用', run: () => { void applyCurrent(); } },
        };
      default:
        return {
          source: '项目', sourceKey: 'project',
          expect: '验证器不报这一条',
          current: issue.message,
          impact: '见消息本身',
        };
    }
  };

  const diagIssues = (): DiagIssue[] => [
    ...(verification?.errors ?? []).map((item, index): DiagIssue => ({
      id: `err:${index}`,
      level: 'error',
      code: item.code,
      message: item.message,
      ...(item.eventId ? { eventId: item.eventId } : {}),
      ...(item.path ? { path: item.path } : {}),
    })),
    ...(verification?.warnings ?? []).map((item, index): DiagIssue => ({
      id: `warn:${index}`,
      level: 'warn',
      code: item.code,
      message: item.message,
      ...(item.eventId ? { eventId: item.eventId } : {}),
      ...(item.path ? { path: item.path } : {}),
    })),
  ];

  const renderDiag = (): void => {
    const issues = diagIssues();
    const errors = issues.filter((item) => item.level === 'error');
    const warnings = issues.filter((item) => item.level === 'warn');
    const sources = new Map<string, { label: string; count: number }>();
    for (const issue of issues) {
      const facts = diagFacts(issue);
      const bucket = sources.get(facts.sourceKey) ?? { label: facts.source, count: 0 };
      bucket.count += 1;
      sources.set(facts.sourceKey, bucket);
    }

    renderChips([
      {
        rule: '级别',
        chips: [
          { key: 'all', label: '全部', count: issues.length },
          { key: 'error', label: '错误', count: errors.length, tone: 'warn' },
          { key: 'warn', label: '提醒', count: warnings.length, tone: 'info' },
        ],
      },
      {
        rule: '来源',
        chips: Array.from(sources.entries()).map(([key, value]) => ({
          key: `src:${key}`,
          label: value.label,
          count: value.count,
        })),
      },
    ]);

    const visible = issues.filter((issue) => {
      if (filterKey === 'error' || filterKey === 'warn') return issue.level === filterKey;
      if (filterKey.startsWith('src:')) return diagFacts(issue).sourceKey === filterKey.slice(4);
      return true;
    });

    renderTree(visible.map((issue): TreeSpec => ({
      id: issue.id,
      label: issue.message,
      tail: issue.eventId ?? issue.code,
      tags: [{ text: issue.level === 'error' ? 'error' : 'warn', tone: issue.level === 'error' ? 'error' : 'warn' }],
    })), verification
      ? (issues.length === 0 ? '验证通过，没有任何问题。' : '当前筛选下没有问题。')
      : '还没有验证结果，点右上角「重新验证」。');

    const actions = byId('designEntityActions');
    actions.innerHTML = '';
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'audio-secondary-btn';
    run.textContent = '重新验证';
    run.addEventListener('click', () => { void runVerify(true); });
    actions.append(run);

    setEntityHeader(
      '问题库',
      verification ? `${errors.length} 个错误 · ${warnings.length} 个提醒` : '尚未验证',
    );

    if (!verification) {
      const { stage } = preview('期望 vs 当前');
      stageEmpty(stage, '还没有验证结果', '点「重新验证」或右上角「验证接入」');
      clearEditor('点击「重新验证」或右上角「验证接入」');
      return;
    }

    const active = visible.find((issue) => issue.id === selectedId) ?? visible[0] ?? issues[0];
    if (!active) {
      const { stage, meta } = preview('期望 vs 当前');
      stageEmpty(stage, '验证通过', `${verification.instrumentedEventIds.length} 个事件已接入`);
      renderMeta(meta, [
        { label: '错误', value: '0', tone: 'accent' },
        { label: '提醒', value: '0', tone: 'accent' },
        { label: '已接入', value: `${verification.instrumentedEventIds.length} 个事件` },
        { label: '能否应用', value: '可以应用', tone: 'accent' },
      ]);
      renderDiagEditor(null, issues);
      return;
    }
    selectedId = active.id;
    renderDiagPreview(active);
    renderDiagEditor(active, issues);
  };

  /** 期望 vs 当前：两个块加箭头，整块用 SVG 画，天然只读。 */
  const renderDiagPreview = (issue: DiagIssue): void => {
    const facts = diagFacts(issue);
    const { stage, meta } = preview('期望 vs 当前');
    const root = stageCurve(stage, false);
    const wrap = (text: string, limit: number): string[] => {
      const lines: string[] = [];
      let rest = text;
      while (rest.length > limit && lines.length < 2) {
        lines.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      lines.push(rest.length > limit ? `${rest.slice(0, limit - 1)}…` : rest);
      return lines;
    };
    const block = (x: number, fill: string, stroke: string, dashed: boolean, title: string, caption: string, color: string): void => {
      root.append(svgNode('rect', {
        x, y: 42, width: 200, height: 74, rx: 8, fill, stroke,
        ...(dashed ? { 'stroke-dasharray': '5 4' } : {}),
      }));
      wrap(title, 22).forEach((line, index) => {
        const node = svgNode('text', {
          x: x + 100, y: 74 + index * 15, fill: color, 'font-size': 11, 'text-anchor': 'middle',
        });
        node.textContent = line;
        root.append(node);
      });
      const note = svgNode('text', { x: x + 100, y: 132, fill: MUTED, 'font-size': 10, 'text-anchor': 'middle' });
      note.textContent = caption;
      root.append(note);
    };
    block(40, 'rgba(242,106,106,.07)', 'rgba(242,106,106,.5)', true, facts.current, `当前 · ${issue.eventId ?? issue.code}`, DANGER);
    block(320, 'rgba(212,255,72,.08)', 'rgba(212,255,72,.45)', false, facts.expect, `期望 · ${facts.source}`, ACCENT);
    const arrow = svgNode('text', { x: 280, y: 84, fill: MUTED, 'font-size': 18, 'text-anchor': 'middle' });
    arrow.textContent = '→';
    root.append(arrow);

    renderMeta(meta, [
      { label: '代码', value: issue.code, tone: 'mono' },
      {
        label: '级别',
        value: issue.level === 'error' ? '错误 · 阻断应用' : '提醒 · 不阻断',
        tone: issue.level === 'error' ? 'error' : undefined,
      },
      { label: '事件', value: issue.eventId ?? '—', tone: issue.eventId ? 'mono' : undefined },
      { label: '来源', value: facts.source },
      { label: '期望', value: facts.expect },
      { label: '当前', value: facts.current, tone: 'error' },
      { label: '影响', value: facts.impact },
      { label: '位置', value: issue.path ?? '验证只给到实体 id', tone: issue.path ? 'mono' : undefined },
    ]);
  };

  const renderDiagEditor = (issue: DiagIssue | null, issues: DiagIssue[]): void => {
    const editor = showEditor();
    const fixColumn = editor.column();
    const fixRows: HTMLElement[] = [];
    for (const item of issues) {
      const facts = diagFacts(item);
      if (!facts.action) continue;
      fixRows.push(fixRow(
        item.message,
        facts.action.label,
        item.level === 'error' ? 'error' : 'warn',
        facts.action.run,
      ));
    }
    fixRows.push(fixRow('全部重新验证', '运行验证', 'info', () => { void runVerify(false); }));
    fixRows.push(fixRow('查看声音事件', '跳转', 'cyan', () => setWorkspace('events')));
    fixColumn.append(section('可一键修复', '点一下跳到对应实体，不用自己找', stack(...fixRows)));
    fixColumn.append(hint('这里只做跳转与重新验证，不放输入框：真正的改动在对应实体页的表单里完成。错误清零后「确认并应用」才会解锁。'));

    const codeColumn = editor.column();
    const codeRows: HTMLElement[] = [
      fixRow('buses / music / gameSyncs 未序列化', '编译器', 'info'),
      fixRow('长音不随距离更新', '运行时', 'info'),
    ];
    for (const item of issues) {
      const facts = diagFacts(item);
      if (!facts.codeChange) continue;
      codeRows.push(fixRow(item.message, facts.codeChange, item.level === 'error' ? 'error' : 'warn'));
    }
    codeColumn.append(section('需要改代码', '界面配了也不生效，必须落到需求', stack(...codeRows)));
    codeColumn.append(hint('这两类不是配置错误：编译器只把 attenuations / bindings 写进运行时，衰减也只在发声瞬间算一次。编辑区能做的只有如实标注，不能靠改参数绕过。'));

    const impactColumn = editor.column();
    const facts = issue ? diagFacts(issue) : null;
    const errors = issues.filter((item) => item.level === 'error').length;
    const warnings = issues.length - errors;
    impactColumn.append(section('影响面', issue ? '选中问题牵连到哪里' : '当前没有选中问题', stack(
      issueCard('游戏调用点', issue?.path ?? issue?.eventId ?? '验证只给到实体 id，没有文件与行号'),
      issueCard('运行时收据', facts ? facts.impact : '没有需要处理的问题'),
      issueCard('能否应用', errors > 0 ? `blocked · ${errors} errors` : `可以应用 · ${warnings} warnings`),
    )));
    impactColumn.append(hint('「运行时收据」来自问题类型的已知影响，验证接口本身不返回逐条收据。'));
  };

  /* ════════════════ 调度 ════════════════ */

  const renderEntityWorkspace = (): void => {
    if (workspace === 'events' || workspace === 'audio') return;
    if (!project && workspace !== 'diag') {
      setEntityHeader('声音设计', '未打开游戏工程');
      renderChips([]);
      renderCards([], '未打开游戏工程。');
      preview('未打开游戏工程');
      stageEmpty(byId('designPreviewStage'), '未打开游戏工程', '打开游戏工程后这里显示预览');
      clearEditor('未打开游戏工程');
      return;
    }
    if (workspace === 'syncs') renderSyncs();
    else if (workspace === 'buses') renderBuses();
    else if (workspace === 'atten') renderAtten();
    else if (workspace === 'music') renderMusic();
    else renderDiag();
  };

  const runVerify = async (switchToDiag = false): Promise<void> => {
    if (!slug) return;
    setBusy(true);
    try {
      verification = await verifyAppliedAudioProject(slug);
      const message = verification.ok
        ? `验证通过：${verification.instrumentedEventIds.length} 个事件已接入`
        : `需要处理：${verification.errors.length} 个错误，${verification.warnings.length} 个提醒`;
      byId('designEntityStatus').textContent = message;
      showToast(verification.ok ? '验证通过' : '验证发现问题', verification.ok ? 'success' : 'warning');
      if (switchToDiag || workspace === 'diag') {
        workspace = 'diag';
        setWorkspace('diag');
      }
      updateDiagBadge();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const updateDiagBadge = (): void => {
    const badge = document.getElementById('designDiagBadge');
    if (!badge) return;
    const count = (verification?.errors.length ?? 0) + (verification?.warnings.length ?? 0);
    badge.textContent = count > 0 ? String(count) : '';
    badge.classList.toggle('hidden', count === 0);
  };

  const saveCurrent = async (): Promise<void> => {
    if (workspace === 'events') {
      byId('bindingSaveBtn').click();
      return;
    }
    showToast('请在下方编辑区里点「保存到草稿」', 'warning');
  };

  const applyCurrent = async (): Promise<void> => {
    if (!project || !slug) return;
    if (!window.confirm(`将草稿 v${project.revision} 应用到游戏“${slug}”并更新游戏侧音频运行时。继续吗？`)) return;
    setBusy(true);
    try {
      const result = await applyAudioProjectDraft(slug, project.revision);
      appliedRevision = result.project.revision;
      adoptProject(result.project);
      showToast('音频项目已应用到游戏', 'success');
      options.onApplied?.({ slug, revision: result.project.revision });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  document.querySelectorAll<HTMLButtonElement>('[data-design-workspace]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.dataset.designWorkspace as DesignWorkspace;
      if (next) setWorkspace(next);
    });
  });

  byId('designSaveBtn').addEventListener('click', () => { void saveCurrent(); });
  byId('designApplyBtn').addEventListener('click', () => { void applyCurrent(); });
  byId('designVerifyBtn').addEventListener('click', () => { void runVerify(true); });

  setBusy(false);
  setWorkspace('audio');
  if (slug) void ensureProject();

  return {
    currentSlug(): string {
      return slug;
    },
    selectGame(nextSlug: string): void {
      slug = nextSlug.trim();
      project = null;
      appliedRevision = null;
      verification = null;
      selectedId = '';
      pendingSelection = '';
      filterKey = 'all';
      previewMode = '';
      updateLeftChrome();
      updateDiagBadge();
      options.bindings.selectGame(slug);
      if (workspace !== 'events' && workspace !== 'audio') {
        void ensureProject().then(() => renderEntityWorkspace());
      }
    },
    scan(): void {
      options.bindings.scan();
      if (workspace !== 'events') setWorkspace('events');
    },
    publishState,
    setWorkspace,
  };
}
