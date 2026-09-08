export { projectPathForGameAudio } from '../shared/audio-file-path.ts';

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function filenameFromPath(path: string): string {
  const normalized = normalizeProjectPath(path);
  return normalized.split('/').pop() || normalized;
}

export function extensionForMime(mimeType: string | undefined): string {
  if (mimeType?.includes('wav')) return 'wav';
  if (mimeType?.includes('ogg')) return 'ogg';
  if (mimeType?.includes('flac')) return 'flac';
  return 'mp3';
}

export function filenameForCreativeVersion(version: {
  kind: string;
  title: string;
  id: string;
  mimeType?: string;
}): string {
  const stem = `${version.kind}-${version.title}-${version.id.slice(-12)}`
    .replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'generated-audio';
  return `${stem}.${extensionForMime(version.mimeType)}`;
}
