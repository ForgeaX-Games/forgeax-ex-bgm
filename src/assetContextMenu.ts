import { filenameFromPath } from './assetPath.ts';
import {
  citeProjectFileInChat,
  downloadHref,
  downloadProjectFile,
  revealProjectFileInExplorer,
} from './hostStudio.ts';
import { showToast } from './utils.ts';

export interface AssetContextTarget {
  title: string;
  filename: string;
  /** In-memory take. Used when the file is not yet in the project. */
  dataUrl?: string;
  /** FilesPanel path, e.g. `.forgeax/games/<slug>/assets/audio/foo.mp3`. */
  projectPath?: string;
  /** Writes an in-memory take into the game and returns its FilesPanel path.
   *  Cite and locate both need a real file; this lets a take reach them without
   *  first going through 配入游戏事件. */
  ensureProjectPath?: () => Promise<string>;
  missingReason?: string;
}

const MENU_ID = 'creativeVariantMenu';

let menuEl: HTMLElement | null = null;
let installed = false;

function menu(): HTMLElement {
  if (menuEl?.isConnected) return menuEl;
  menuEl = document.getElementById(MENU_ID);
  if (!menuEl) {
    menuEl = document.createElement('div');
    menuEl.id = MENU_ID;
    menuEl.className = 'creative-variant-menu hidden';
    menuEl.setAttribute('role', 'menu');
    document.body.appendChild(menuEl);
  }
  return menuEl;
}

export function hideAssetContextMenu(): void {
  const node = menu();
  node.classList.add('hidden');
  node.innerHTML = '';
}

function installDismiss(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('click', (event) => {
    const node = document.getElementById(MENU_ID);
    if (!node || node.classList.contains('hidden')) return;
    if (!node.contains(event.target as Node)) hideAssetContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideAssetContextMenu();
  });
  window.addEventListener('blur', hideAssetContextMenu);
}

function item(
  label: string,
  onClick: () => void | Promise<void>,
  disabled?: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  if (disabled) {
    button.disabled = true;
    button.title = disabled;
    return button;
  }
  button.addEventListener('click', () => {
    // Dismiss first: writing the take into the game is async, and a menu left
    // hanging over the workspace reads as a frozen click.
    hideAssetContextMenu();
    void (async () => {
      try {
        await onClick();
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    })();
  });
  return button;
}

function downloadTarget(target: AssetContextTarget): void {
  if (target.projectPath) {
    downloadProjectFile(target.projectPath, target.filename);
    return;
  }
  if (!target.dataUrl) throw new Error('当前版本没有真实音频');
  downloadHref(target.filename, target.dataUrl);
}

/** The project path, writing the take into the game first when it has none. */
async function projectPathOf(target: AssetContextTarget): Promise<string> {
  if (target.projectPath) return target.projectPath;
  if (!target.ensureProjectPath) {
    throw new Error(target.missingReason || '先配入游戏后才能引用和定位');
  }
  const path = (await target.ensureProjectPath()).trim();
  if (!path) throw new Error('写入游戏后没有拿到文件路径');
  target.projectPath = path;
  return path;
}

async function citeTarget(target: AssetContextTarget): Promise<void> {
  const path = await projectPathOf(target);
  if (!citeProjectFileInChat(path)) {
    throw new Error('仅在 Studio 内可引用到 Chat');
  }
  showToast(`已引用 ${target.filename} 到 Chat`, 'success');
}

async function locateTarget(target: AssetContextTarget): Promise<void> {
  const path = await projectPathOf(target);
  if (!revealProjectFileInExplorer(path)) {
    throw new Error('仅在 Studio 内可定位到系统文件');
  }
  showToast(`正在文件资源管理器中定位 ${filenameFromPath(path)}`, 'success');
}

export function showAssetContextMenu(event: MouseEvent, target: AssetContextTarget): void {
  event.preventDefault();
  event.stopPropagation();
  installDismiss();
  const node = menu();
  node.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'creative-variant-menu-title';
  heading.textContent = target.title;
  const blocked = target.projectPath || target.ensureProjectPath
    ? undefined
    : (target.missingReason || '先配入游戏后才能引用和定位');
      const canDownload = Boolean(target.projectPath || target.dataUrl);
      node.append(
        heading,
        item(
          `下载 ${target.filename || '音频'}`,
          () => downloadTarget(target),
          canDownload ? undefined : (target.missingReason || '没有可下载的文件'),
        ),
    item('引用到 Chat', () => citeTarget(target), blocked),
    item('在文件资源管理器中定位', () => locateTarget(target), blocked),
  );
  if (blocked) {
    const hint = document.createElement('p');
    hint.className = 'creative-variant-menu-hint';
    hint.textContent = blocked;
    node.append(hint);
  }
  node.classList.remove('hidden');
  const left = Math.min(event.clientX, window.innerWidth - 260);
  const top = Math.min(event.clientY, window.innerHeight - 180);
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}
