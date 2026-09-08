import { relative, resolve, sep } from 'node:path';

import { canonicalAudioFile } from '../shared/audio-file-path.ts';

function isBeneath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

function isAllowedAudioPrefix(file: string): boolean {
  return file.startsWith('assets/audio/') || file.startsWith('audio/');
}

/** Canonical game-relative path → absolute path; out-of-bounds or illegal → null. */
export function resolveGameAudioFile(gameDir: string, file: string): string | null {
  let canonical: string;
  try {
    canonical = canonicalAudioFile(file);
  } catch {
    return null;
  }
  if (!isAllowedAudioPrefix(canonical)) return null;
  const absolute = resolve(gameDir, canonical);
  if (!isBeneath(gameDir, absolute)) return null;
  const audioRoot = resolve(gameDir, 'audio');
  const assetsAudioRoot = resolve(gameDir, 'assets', 'audio');
  if (!isBeneath(audioRoot, absolute) && !isBeneath(assetsAudioRoot, absolute)) return null;
  return absolute;
}
