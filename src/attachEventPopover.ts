import { isSafeAudioEventId, type AudioKind } from '../shared/audio-project.ts';
import {
  applyBindingEdit,
  createBindingDraft,
  upsertBindingInDraft,
} from './audioBindingsEditor.ts';
import { normalizeProjectPath, projectPathForGameAudio } from './assetPath.ts';
import { saveCreativeVersionToGame } from './creativeAudioApi.ts';
import type { CreativeVersion, GeneratedAudioKind } from './creativeAudioStudio.ts';
import type { AudioShapingParams } from './audioShaping.ts';
import { getAudioProject, inspectAudioEvents, patchAudioProjectDraft } from './audioProjectApi.ts';
import { resolveActiveGameSlug } from './activeGame.ts';

export interface AttachEventResult {
  slug: string;
  eventId: string;
  file: string;
  path: string;
}

let openMenu: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

function closePopover(): void {
  cleanup?.();
  cleanup = null;
  openMenu?.remove();
  openMenu = null;
}

function kindOf(kind: GeneratedAudioKind): AudioKind {
  if (kind === 'bgm') return 'music';
  if (kind === 'voice') return 'voice';
  return 'sfx';
}

/**
 * The save tool already returns the canonical game-relative path
 * (`assets/audio/foo.mp3`); `path` is project-relative and only a fallback.
 */
export function bindingFileFrom(saved: { file?: string; path?: string }, slug: string): string {
  if (saved.file) return saved.file;
  const path = normalizeProjectPath(saved.path ?? '');
  const prefix = `.forgeax/games/${slug}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : '';
}

/** Event ids reach generated game source, so the default must be ASCII-safe. */
export function eventKeyFrom(version: CreativeVersion): string {
  const titleSlug = version.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const stem = titleSlug
    || version.id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase()
    || 'take';
  const candidate = `${version.kind}.${stem}`;
  return isSafeAudioEventId(candidate) ? candidate : `generated.${version.kind}`;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  const node = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  node.append(span, control);
  return node;
}

function selectOf(id: string, options: Array<{ value: string; label: string }>): HTMLSelectElement {
  const node = document.createElement('select');
  node.id = id;
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    node.append(option);
  }
  return node;
}

/**
 * 配入游戏：写文件 + 登记清单 + 写入声音事件草稿。弹层不占页面骨架。
 */
export async function openAttachEventPopover(
  anchor: HTMLElement,
  options: {
    defaultSlug?: string;
    version: CreativeVersion;
    shaping?: AudioShapingParams;
    onBusy?: (busy: boolean) => void;
    onAttached: (result: AttachEventResult) => void;
  },
): Promise<void> {
  if (openMenu) {
    closePopover();
    return;
  }

  // Always the project the workspace is on; there is no game to choose here.
  const slug = options.defaultSlug?.trim() || await resolveActiveGameSlug();
  const menu = document.createElement('div');
  menu.className = 'attach-popover';
  const title = document.createElement('h3');
  title.textContent = '配入游戏事件';
  const note = document.createElement('p');
  note.textContent = '写入音频文件，并在声音事件里登记一条绑定。';

  const game = document.createElement('strong');
  game.id = 'attachGame';
  game.textContent = slug || '未打开游戏工程';

  const mode = selectOf('attachMode', [
    { value: 'existing', label: '绑到已有事件' },
    { value: 'new', label: '新建事件' },
  ]);
  const eventSelect = selectOf('attachEvent', [{ value: '', label: '读取中…' }]);
  const eventId = document.createElement('input');
  eventId.type = 'text';
  eventId.placeholder = '例如 player.jump';
  eventId.value = eventKeyFrom(options.version);
  const eventLabel = document.createElement('input');
  eventLabel.type = 'text';
  eventLabel.placeholder = '显示名称';
  eventLabel.value = options.version.title;
  const role = selectOf('attachRole', [
    { value: 'default', label: '作为默认声音' },
    { value: 'variant', label: '追加为变体' },
  ]);
  const includeShaping = document.createElement('input');
  includeShaping.type = 'checkbox';
  includeShaping.checked = Boolean(options.shaping);
  const shapingRow = document.createElement('label');
  shapingRow.className = 'attach-check';
  shapingRow.append(includeShaping, document.createTextNode('连同当前塑形参数一起写入'));

  const existingWrap = document.createElement('div');
  const newWrap = document.createElement('div');
  existingWrap.append(field('目标事件', eventSelect));
  newWrap.append(field('事件 ID', eventId), field('显示名称', eventLabel));
  newWrap.classList.add('hidden');

  // Switching to 新建事件 adds two fields, so the box grows after it was first
  // placed. Re-anchor on every mode change or the footer lands off-screen.
  const place = (): void => {
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  };

  const syncMode = (): void => {
    const isNew = mode.value === 'new';
    newWrap.classList.toggle('hidden', !isNew);
    existingWrap.classList.toggle('hidden', isNew);
    place();
  };
  mode.addEventListener('change', syncMode);

  const footer = document.createElement('footer');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'audio-secondary-btn';
  cancel.textContent = '取消';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'audio-primary-btn';
  confirm.textContent = '确认配入';
  footer.append(cancel, confirm);

  if (!slug) {
    note.textContent = '当前没有打开的游戏工程。先在 IDE 打开一个游戏，再回来配入。';
    confirm.disabled = true;
  }

  menu.append(
    title,
    note,
    field('目标游戏', game),
    field('怎么登记', mode),
    existingWrap,
    newWrap,
    field('声音角色', role),
    shapingRow,
    footer,
  );
  document.body.append(menu);
  openMenu = menu;

  place();

  const onDoc = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node) && event.target !== anchor) closePopover();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePopover();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  cleanup = () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };

  const fillEvents = async (): Promise<void> => {
    eventSelect.replaceChildren();
    if (!slug) {
      eventSelect.append(Object.assign(document.createElement('option'), { value: '', textContent: '未打开游戏工程' }));
      return;
    }
    eventSelect.append(Object.assign(document.createElement('option'), { value: '', textContent: '读取中…' }));
    try {
      const [{ project }, scanned] = await Promise.all([
        getAudioProject(slug),
        inspectAudioEvents(slug).catch(() => ({ candidates: [] as Array<{ eventId: string }> })),
      ]);
      eventSelect.replaceChildren();
      const seen = new Set<string>();
      for (const binding of project.bindings) {
        seen.add(binding.eventId);
        const option = document.createElement('option');
        option.value = binding.eventId;
        option.textContent = `${binding.label || binding.eventId}（已绑定）`;
        eventSelect.append(option);
      }
      for (const candidate of scanned.candidates) {
        if (seen.has(candidate.eventId)) continue;
        seen.add(candidate.eventId);
        const option = document.createElement('option');
        option.value = candidate.eventId;
        option.textContent = `${candidate.eventId}（扫描到）`;
        eventSelect.append(option);
      }
      if (!seen.size) {
        eventSelect.append(Object.assign(document.createElement('option'), { value: '', textContent: '没有已有事件，请改用新建' }));
        mode.value = 'new';
        syncMode();
      }
    } catch {
      eventSelect.replaceChildren();
      eventSelect.append(Object.assign(document.createElement('option'), { value: '', textContent: '读取失败，可改用新建' }));
      mode.value = 'new';
      syncMode();
    }
  };

  void fillEvents();

  const showError = (message: string): void => {
    const hint = document.createElement('p');
    hint.textContent = message;
    hint.style.color = 'var(--error)';
    menu.querySelector('p + p')?.remove();
    note.after(hint);
  };

  cancel.addEventListener('click', closePopover);
  confirm.addEventListener('click', () => {
    void (async () => {
      if (!slug) return;
      const isNew = mode.value === 'new';
      const nextEventId = (isNew ? eventId.value : eventSelect.value).trim();
      if (!nextEventId) return;
      if (isNew && !isSafeAudioEventId(nextEventId)) {
        showError('事件 ID 只能用字母、数字和 . _ : -，且以字母或数字开头。它会写进游戏源码。');
        return;
      }
      confirm.disabled = true;
      options.onBusy?.(true);
      try {
        const shaping = includeShaping.checked ? options.shaping : undefined;
        const saved = await saveCreativeVersionToGame(options.version, slug, shaping);
        const file = bindingFileFrom(saved, slug);
        if (!file) throw new Error('保存成功但没有返回文件路径');
        const { project } = await getAudioProject(slug);
        const asset = {
          assetId: `generated:${options.version.id}`,
          file,
          name: options.version.title,
          ...(shaping ? { shaping } : {}),
        };
        const existing = project.bindings.find((item) => item.eventId === nextEventId);
        const kind = kindOf(options.version.kind);
        let next = existing
          ? structuredClone(existing)
          : applyBindingEdit(createBindingDraft(nextEventId, eventLabel.value || nextEventId), {
            kind,
            bus: kind,
            playbackMode: kind === 'music' ? 'loop' : 'one-shot',
          });
        if (!existing && eventLabel.value.trim()) {
          next = applyBindingEdit(next, { label: eventLabel.value });
        }
        if (role.value === 'variant' && next.assets.length > 0) {
          next = applyBindingEdit(next, {
            assets: [...next.assets, asset],
            variationMode: next.variation.mode === 'single' ? 'random-no-repeat' : next.variation.mode,
          });
        } else {
          next = applyBindingEdit(next, { assets: [asset, ...next.assets.slice(1)] });
        }
        await patchAudioProjectDraft(slug, project.revision, upsertBindingInDraft(project.bindings, next), []);
        closePopover();
        const path = saved.path
          ? normalizeProjectPath(saved.path)
          : projectPathForGameAudio(slug, file);
        options.onAttached({ slug, eventId: nextEventId, file, path });
      } catch (error) {
        confirm.disabled = false;
        throw error;
      } finally {
        options.onBusy?.(false);
      }
    })().catch((error: unknown) => {
      confirm.disabled = false;
      showError(error instanceof Error ? error.message : String(error));
    });
  });
}
