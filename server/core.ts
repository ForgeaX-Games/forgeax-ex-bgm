/**
 * forgeax-bgm core — game-side generated audio persistence.
 *
 * Library search/attach lived here historically and has been removed. What
 * remains is the manifest + generated-asset write path used by
 * `generate-audio-assets` and `save-generated-audio`.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, relative, basename, dirname, extname } from 'node:path';
import type { AudioShapingParams } from '../shared/audio-project.ts';
import { canonicalAudioFile, generatedAudioGameFile } from '../shared/audio-file-path.ts';
import { writeGeneratedAudioSidecars } from './asset-sidecar.ts';
import { highFrequencyDurationWarning, measureAudioDurationMs } from './audio-duration.ts';

export type AudioKind = 'bgm' | 'sfx' | 'voice';

const MANIFEST_VERSION = 1;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024; // 64 MB safety ceiling per blob
const manifestWriteTails = new Map<string, Promise<void>>();

export class BgmError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 500,
    public detail?: string,
  ) {
    super(message);
    this.name = 'BgmError';
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface ManifestTrack {
  assetId: string;
  name: string;
  kind: AudioKind;
  file: string; // game-relative, e.g. "audio/foo.mp3" or "assets/audio/foo.mp3"
  version: string;
  source: string; // depot name
  addedBy: 'human' | 'ai';
  addedAt: string; // ISO timestamp
  shaping?: AudioShapingParams;
  /** Engine asset GUID from the clip's `.meta.json`; absent for legacy tracks. */
  guid?: string;
}
export interface AudioManifest {
  version: number;
  slug: string;
  tracks: ManifestTrack[];
}

function listGameSlugs(projectRoot: string): string[] {
  const gamesDir = resolve(projectRoot, '.forgeax', 'games');
  if (!existsSync(gamesDir)) return [];
  try {
    return readdirSync(gamesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function gameRoot(projectRoot: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new BgmError('invalid-slug', `invalid game slug: ${slug}`, 400);
  const abs = resolve(projectRoot, '.forgeax/games', slug);
  const rel = relative(projectRoot, abs);
  const segs = rel.split(/[/\\]/);
  if (segs[0] !== '.forgeax' || segs[1] !== 'games' || segs[2] !== slug) {
    throw new BgmError('invalid-slug', `slug escapes games dir: ${slug}`, 400);
  }
  return abs;
}

function manifestPath(projectRoot: string, slug: string): string {
  return resolve(gameRoot(projectRoot, slug), 'audio', 'manifest.json');
}

function normalizeShaping(value: unknown): AudioShapingParams | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Partial<Record<keyof AudioShapingParams, unknown>>;
  const clampNumber = (key: keyof AudioShapingParams, fallback: number, min: number, max: number) => {
    const raw = row[key];
    const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    return Math.min(max, Math.max(min, numeric));
  };
  const shaping: AudioShapingParams = {
    gainDb: clampNumber('gainDb', 0, -24, 12),
    pitchSemitones: clampNumber('pitchSemitones', 0, -12, 12),
    highpassHz: clampNumber('highpassHz', 20, 20, 2_000),
    lowpassHz: clampNumber('lowpassHz', 20_000, 1_000, 20_000),
    eqLowDb: clampNumber('eqLowDb', 0, -12, 12),
    eqMidDb: clampNumber('eqMidDb', 0, -12, 12),
    eqHighDb: clampNumber('eqHighDb', 0, -12, 12),
  };
  if (shaping.highpassHz >= shaping.lowpassHz) shaping.highpassHz = Math.max(20, shaping.lowpassHz - 100);
  return shaping;
}

function requireSlug(slug?: string): string {
  const s = slug && slug.trim() ? slug.trim() : '';
  if (!s) throw new BgmError('slug-required', 'slug is required (explicit; no auto-detect)', 400);
  if (!SLUG_RE.test(s)) throw new BgmError('invalid-slug', `invalid game slug: ${s}`, 400);
  return s;
}

export async function readManifest(projectRoot: string, slug?: string): Promise<AudioManifest> {
  const resolved = requireSlug(slug);
  const file = manifestPath(projectRoot, resolved);
  if (!existsSync(file)) return { version: MANIFEST_VERSION, slug: resolved, tracks: [] };
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as Partial<AudioManifest>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('manifest root must be an object');
    }
    if (parsed.slug && parsed.slug !== resolved) {
      throw new BgmError(
        'manifest-slug-mismatch',
        `audio manifest slug '${parsed.slug}' does not match target '${resolved}'`,
        409,
      );
    }
    if (parsed.tracks !== undefined && !Array.isArray(parsed.tracks)) {
      throw new Error('manifest.tracks must be an array');
    }
    const tracks = (parsed.tracks ?? []) as ManifestTrack[];
    for (const [index, track] of tracks.entries()) {
      if (
        !track
        || typeof track.assetId !== 'string'
        || typeof track.file !== 'string'
        || (track.kind !== 'bgm' && track.kind !== 'sfx' && track.kind !== 'voice')
      ) {
        throw new Error(`manifest.tracks[${index}] is invalid`);
      }
      let canonical: string;
      try {
        canonical = canonicalAudioFile(track.file);
      } catch {
        throw new Error(`manifest.tracks[${index}].file escapes the allowed audio directories`);
      }
      if (!canonical.startsWith('audio/') && !canonical.startsWith('assets/audio/')) {
        throw new Error(`manifest.tracks[${index}].file escapes the allowed audio directories`);
      }
      const trackPath = resolve(gameRoot(projectRoot, resolved), canonical);
      const trackRelative = relative(gameRoot(projectRoot, resolved), trackPath);
      if (trackRelative.startsWith('..')) {
        throw new Error(`manifest.tracks[${index}].file escapes the allowed audio directories`);
      }
      track.file = canonical;
      const shaping = normalizeShaping(track.shaping);
      if (shaping) track.shaping = shaping;
      else delete track.shaping;
    }
    return {
      version: parsed.version ?? MANIFEST_VERSION,
      slug: resolved,
      tracks,
    };
  } catch (error) {
    if (error instanceof BgmError) throw error;
    throw new BgmError(
      'manifest-invalid',
      `audio manifest is invalid for '${resolved}': ${(error as Error).message}`,
      409,
    );
  }
}

/** Crash-safe JSON replacement used by manifest/cue-plan writes. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Serialize manifest mutations for one game while allowing network downloads
 * to run concurrently. This also protects human and AI attach calls from
 * overwriting each other's manifest updates inside the same server process. */
async function withManifestWriteLock<T>(
  file: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = manifestWriteTails.get(file) ?? Promise.resolve();
  let release: () => void = () => {};
  const ticket = new Promise<void>((resolveTicket) => {
    release = resolveTicket;
  });
  const tail = previous.catch(() => undefined).then(() => ticket);
  manifestWriteTails.set(file, tail);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (manifestWriteTails.get(file) === tail) manifestWriteTails.delete(file);
  }
}

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|opus|wma)$/i;

function safeFilename(name: string, resUrl: string): string {
  const fromUrl = basename((resUrl.split('?')[0] || '').trim());
  let candidate = AUDIO_EXT_RE.test(fromUrl) ? fromUrl : name;
  candidate = candidate.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!candidate) candidate = 'audio';
  if (!AUDIO_EXT_RE.test(candidate)) {
    const ext = extname(fromUrl);
    candidate += AUDIO_EXT_RE.test(`x${ext}`) ? ext : '.mp3';
  }
  return candidate;
}

export interface AttachResult {
  ok: true;
  slug: string;
  assetId: string;
  kind: AudioKind;
  file: string;
  path: string;
  url: string;
  bytes: number;
  manifest: string;
  reused: boolean;
  /** Engine asset GUID, or null when the clip could not be indexed. */
  guid: string | null;
  /** Why the clip is missing from the asset catalog, when it is. */
  indexWarning?: string;
  durationMs?: number;
  durationWarning?: string;
}

export interface AttachGeneratedAudioInput {
  projectRoot: string;
  slug?: string;
  assetId: string;
  name: string;
  kind: AudioKind;
  base64: string;
  mimeType?: string;
  filename?: string;
  provider?: string;
  model?: string;
  addedBy?: 'human' | 'ai';
  shaping?: AudioShapingParams;
  /** Recorded in the clip's provenance sidecar so a take can be traced back. */
  prompt?: string;
  /** Used to warn when a high-frequency SFX is too long. */
  eventId?: string;
}

/**
 * Persist API-generated audio into a game without round-tripping through an
 * external URL. The browser receives generated bytes from the host gateway,
 * previews them, and sends the selected version back through this host tool.
 * The same manifest lock and validation rules as library attachments apply.
 */
export async function attachGeneratedAudio(
  input: AttachGeneratedAudioInput,
): Promise<AttachResult> {
  const slug = requireSlug(input.slug);
  if (!existsSync(gameRoot(input.projectRoot, slug))) {
    const available = listGameSlugs(input.projectRoot).join(', ') || '(none)';
    throw new BgmError(
      'unknown-slug',
      `game not found: ${slug}. Available games: ${available}.`,
      400,
    );
  }
  const assetId = String(input.assetId ?? '').trim();
  if (!assetId || assetId.length > 160) {
    throw new BgmError('invalid-asset-id', 'generated assetId is required and must be <= 160 characters', 400);
  }
  if (input.kind !== 'bgm' && input.kind !== 'sfx' && input.kind !== 'voice') {
    throw new BgmError('invalid-kind', `kind must be 'bgm', 'sfx', or 'voice', got: ${input.kind}`, 400);
  }
  const encoded = String(input.base64 ?? '').replace(/^data:[^;]+;base64,/, '').trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new BgmError('invalid-audio-data', 'generated audio must be valid base64', 400);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw new BgmError('empty-audio', 'generated audio contains 0 bytes', 400);
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new BgmError('too-large', `audio exceeds ${MAX_AUDIO_BYTES} byte ceiling`, 413);
  }

  const mime = String(input.mimeType ?? '').toLowerCase();
  const extension = mime.includes('wav') ? '.wav'
    : mime.includes('ogg') ? '.ogg'
      : mime.includes('flac') ? '.flac'
        : '.mp3';
  const root = gameRoot(input.projectRoot, slug);
  const audioDir = resolve(root, 'assets', 'audio');
  const manifestFile = manifestPath(input.projectRoot, slug);

  return await withManifestWriteLock(manifestFile, async () => {
    const manifest = await readManifest(input.projectRoot, slug);
    const existing = manifest.tracks.find((track) => track.assetId === assetId);
    let fileRel = existing?.file;
    if (!fileRel) {
      let filename = safeFilename(
        input.filename || input.name || assetId,
        input.filename || `generated${extension}`,
      );
      const usedByAnother = (candidate: string) => manifest.tracks.some((track) =>
        (track.file === generatedAudioGameFile(candidate) || track.file === `audio/generated/${candidate}`)
        && track.assetId !== assetId);
      if (usedByAnother(filename) || existsSync(resolve(audioDir, filename))) {
        const ext = extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        filename = `${stem}-${assetId.replace(/[^a-zA-Z0-9]/g, '').slice(-8) || 'x'}${ext}`;
      }
      fileRel = generatedAudioGameFile(filename);
    }
    const absolute = resolve(root, fileRel);
    await mkdir(dirname(absolute), { recursive: true });
    const reused = existsSync(absolute);
    await writeFile(absolute, bytes);

    const provider = String(input.provider ?? 'api').trim() || 'api';
    const model = String(input.model ?? '').trim();
    const shaping = normalizeShaping(input.shaping);
    const name = String(input.name ?? '').trim() || basename(fileRel);
    const durationMs = measureAudioDurationMs(bytes, mime || undefined);
    const durationWarning = highFrequencyDurationWarning({
      durationMs,
      kind: input.kind,
      eventId: input.eventId,
    });

    // Index the clip into the game's asset catalog. Deliberately non-fatal: the
    // bytes and the manifest entry are what the plugin itself needs, so a
    // catalog hiccup is reported rather than losing the user's take.
    let guid: string | null = null;
    let indexWarning: string | undefined;
    try {
      const indexed = await writeGeneratedAudioSidecars({
        audioFile: absolute,
        gameFile: fileRel,
        slug,
        assetId,
        name,
        kind: input.kind,
        bytes,
        mimeType: mime || 'audio/mpeg',
        provider,
        ...(model ? { model } : {}),
        ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
        ...(shaping ? { shaping } : {}),
        ...(typeof durationMs === 'number' ? { durationMs } : {}),
      });
      guid = indexed.guid;
      if (!indexed.indexed) indexWarning = indexed.skippedReason;
    } catch (error) {
      indexWarning = `无法写入资产索引：${(error as Error).message}`;
    }

    const track: ManifestTrack = {
      assetId,
      name,
      kind: input.kind,
      file: fileRel,
      version: model || 'generated',
      source: `generated:${provider}`,
      addedBy: input.addedBy === 'ai' ? 'ai' : 'human',
      addedAt: new Date().toISOString(),
      ...(shaping ? { shaping } : {}),
      ...(guid ? { guid } : {}),
    };
    const index = manifest.tracks.findIndex((track) => track.assetId === assetId);
    if (index >= 0) manifest.tracks[index] = track;
    else manifest.tracks.push(track);
    manifest.version = MANIFEST_VERSION;
    manifest.slug = slug;
    await writeJsonAtomic(manifestFile, manifest);

    return {
      ok: true,
      slug,
      assetId,
      kind: input.kind,
      file: fileRel,
      path: relative(input.projectRoot, absolute),
      url: '',
      bytes: bytes.length,
      manifest: relative(input.projectRoot, manifestFile),
      reused,
      guid,
      ...(indexWarning ? { indexWarning } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
      ...(durationWarning ? { durationWarning } : {}),
    };
  });
}
