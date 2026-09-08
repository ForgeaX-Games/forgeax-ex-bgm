function isEmbedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

function postToHost(payload: Record<string, unknown>): boolean {
  if (!isEmbedded()) return false;
  window.parent.postMessage(payload, '*');
  return true;
}

/** Insert a project-file pill into the system Chat composer. Does not auto-send. */
export function citeProjectFileInChat(path: string): boolean {
  const target = path.trim();
  if (!target) return false;
  return postToHost({ type: 'FORGEAX_COMPOSER_INSERT', path: target });
}

/** Reveal the system Files panel and select this project path. */
export function revealProjectFileInExplorer(path: string): boolean {
  const target = path.trim();
  if (!target) return false;
  return postToHost({ type: 'FORGEAX_FILES_REVEAL', path: target });
}

export function downloadHref(filename: string, href: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function downloadProjectFile(path: string, filename: string): void {
  downloadHref(filename, `/api/files/raw?path=${encodeURIComponent(path)}`);
}
