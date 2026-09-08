/**
 * Canonical game-relative audio paths.
 *
 * All path-shape rules live here so project.json, manifest.json, the compiler,
 * and the FilesPanel share one representation:
 *   audio/hit.wav
 *   audio/generated/footstep.mp3
 *   assets/audio/bgm-main-abc123.mp3
 */

export class AudioFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFilePathError';
  }
}

/** Upgrade any incoming audio path value to a canonical game-relative path. */
export function canonicalAudioFile(input: string): string {
  if (typeof input !== 'string') {
    throw new AudioFilePathError('audio file path must be a string');
  }
  if (input.includes('\0') || input.includes('\\') || input.startsWith('/')) {
    throw new AudioFilePathError('audio file path must stay inside the game audio directories');
  }
  const normalized = input.replace(/\\/g, '/');
  if (!normalized) {
    throw new AudioFilePathError('audio file path must stay inside the game audio directories');
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new AudioFilePathError('audio file path must stay inside the game audio directories');
  }
  if (normalized.startsWith('assets/audio/') || normalized.startsWith('audio/')) {
    return normalized;
  }
  return `audio/${normalized}`;
}

/** Landing path for newly generated media. The only write-site helper. */
export function generatedAudioGameFile(filename: string): string {
  return `assets/audio/${filename}`;
}

/** Import specifier from `<game>/src/forgeax-audio/generated-bindings.ts`. */
export function audioImportSpecifier(canonical: string): string {
  return `../../${canonical}`;
}

/** FilesPanel `data-fp-path` for a game audio file. */
export function projectPathForGameAudio(slug: string, file: string): string {
  const game = slug.trim();
  if (!game) return '';
  try {
    return `.forgeax/games/${game}/${canonicalAudioFile(file)}`;
  } catch {
    return '';
  }
}
