/**
 * Sidecars written next to every generated audio clip.
 *
 * Two files, two owners:
 *   `<clip>.meta.json`    engine-owned import descriptor. This is what makes the
 *                         clip show up in the content browser as an `audio`
 *                         asset and gives it a GUID other systems can bind to.
 *   `<clip>.forgeax-bgm.json` plugin-owned provenance (prompt, provider, hash) that
 *                         the engine neither reads nor validates.
 *
 * The engine format is strict and fail-fast, which makes this riskier than it
 * looks: a malformed sidecar, or one whose companion audio file is missing,
 * aborts the asset scan for the *whole game root*, so the content browser goes
 * empty instead of just missing one clip. Hence the rules below — write bytes
 * before descriptor, replace atomically, validate before writing, and never
 * touch a sidecar another importer already owns.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AudioShapingParams } from '../shared/audio-project.ts';

export type SidecarAudioKind = 'bgm' | 'sfx' | 'voice';

export const ENGINE_SIDECAR_SUFFIX = '.meta.json';
export const PLUGIN_SIDECAR_SUFFIX = '.forgeax-bgm.json';

/** Shape accepted by the engine's `meta.schema.json` for `importer: 'audio'`. */
export interface EngineAudioSidecar {
  schemaVersion: '1.0.0';
  kind: 'external-asset-package';
  importer: 'audio';
  source: string;
  importSettings: Record<string, never>;
  subAssets: Array<{ guid: string; sourceIndex: number; kind: 'audio'; name?: string }>;
}

export interface PluginAudioSidecar {
  schemaVersion: 1;
  producer: '@forgeax-extension/bgm';
  guid: string;
  slug: string;
  assetId: string;
  kind: SidecarAudioKind;
  name: string;
  file: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  generatedAt: string;
  provider: string;
  model?: string;
  prompt?: string;
  shaping?: AudioShapingParams;
  /** Measured length in ms; WAV from header, MP3 estimated. */
  durationMs?: number;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GUIDs are derived from asset *identity*, not from the bytes.
 *
 * Content hashing would be tempting ("same audio, same id") but two clips with
 * identical bytes are a GUID collision, and a collision fails the entire scan.
 * Identity also survives regeneration: keeping a take's GUID stable when the
 * user re-rolls it means anything already bound to it keeps working.
 */
export function deriveAssetGuid(identity: string): string {
  const digest = createHash('sha256').update(identity).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // RFC-4122 version 5 (name-based)
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Identity of a clip this plugin generated: its manifest asset id. */
export function generatedAudioGuid(slug: string, assetId: string): string {
  return deriveAssetGuid(`forgeax-bgm/audio/${slug}/${assetId}`);
}

/**
 * Identity of a clip that predates the sidecars, keyed by its game-relative
 * path rather than an asset id: several bindings may name the same file under
 * different asset ids, and the file must land on one GUID whichever binding
 * the projector happens to reach first.
 */
export function backfilledAudioGuid(slug: string, canonicalFile: string): string {
  return deriveAssetGuid(`forgeax-bgm/audio-clip/${slug}/${canonicalFile}`);
}

export function buildEngineAudioSidecar(options: {
  source: string;
  guid: string;
  name?: string;
}): EngineAudioSidecar {
  const subAsset: EngineAudioSidecar['subAssets'][number] = {
    guid: options.guid,
    sourceIndex: 0,
    kind: 'audio',
  };
  if (options.name?.trim()) subAsset.name = options.name.trim();
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'audio',
    source: options.source,
    importSettings: {},
    subAssets: [subAsset],
  };
}

/**
 * Last line of defence before a write. The engine validates with ajv and a
 * failure there costs the whole root, so anything we cannot vouch for locally
 * must not reach the disk.
 */
export function assertValidEngineAudioSidecar(value: EngineAudioSidecar): void {
  if (value.schemaVersion !== '1.0.0') throw new Error('sidecar schemaVersion must be "1.0.0"');
  if (value.kind !== 'external-asset-package') throw new Error('sidecar kind must be "external-asset-package"');
  if (value.importer !== 'audio') throw new Error('sidecar importer must be "audio"');
  if (!value.source.trim()) throw new Error('sidecar source must be a non-empty filename');
  if (value.source.includes('/') || value.source.includes('\\')) {
    throw new Error(`sidecar source must be a bare filename, got: ${value.source}`);
  }
  if (!Array.isArray(value.subAssets) || value.subAssets.length === 0) {
    throw new Error('sidecar must declare at least one subAsset');
  }
  for (const sub of value.subAssets) {
    if (!GUID_RE.test(sub.guid)) throw new Error(`sidecar subAsset guid is not a UUID: ${sub.guid}`);
    if (sub.kind !== 'audio') throw new Error(`sidecar subAsset kind must be "audio", got: ${sub.kind}`);
    if (!Number.isInteger(sub.sourceIndex) || sub.sourceIndex < 0) {
      throw new Error('sidecar subAsset sourceIndex must be a non-negative integer');
    }
  }
}

/** Crash-safe replacement: a half-written descriptor would break the scan. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

type ExistingSidecar =
  | { state: 'absent' }
  | { state: 'ours'; guid: string }
  | { state: 'foreign'; importer: string }
  | { state: 'unreadable' };

async function inspectEngineSidecar(file: string): Promise<ExistingSidecar> {
  if (!existsSync(file)) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return { state: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable' };
  const row = parsed as Partial<EngineAudioSidecar>;
  if (typeof row.importer === 'string' && row.importer !== 'audio') {
    return { state: 'foreign', importer: row.importer };
  }
  const guid = row.subAssets?.find((sub) => GUID_RE.test(sub?.guid ?? ''))?.guid;
  return guid ? { state: 'ours', guid } : { state: 'unreadable' };
}

export interface WriteSidecarsInput {
  /** Absolute path of the audio file, already on disk. */
  audioFile: string;
  /** Game-relative path recorded for humans reading the plugin sidecar. */
  gameFile: string;
  slug: string;
  assetId: string;
  name: string;
  kind: SidecarAudioKind;
  bytes: Buffer;
  mimeType: string;
  provider: string;
  model?: string;
  prompt?: string;
  shaping?: AudioShapingParams;
  durationMs?: number;
}

export interface EnsureGuidResult {
  /** GUID the clip is indexed under, or null when a foreign importer owns it. */
  guid: string | null;
  indexed: boolean;
  /** Set when we deliberately left an existing descriptor alone. */
  skippedReason?: string;
}

export type WriteSidecarsResult = EnsureGuidResult;

/**
 * Make sure the clip carries an engine descriptor, and report the GUID it is
 * indexed under. An existing descriptor always wins: its GUID may already be
 * referenced elsewhere in the catalog.
 *
 * Call this only once the audio bytes are on disk — a descriptor pointing at a
 * missing file is an orphan, and orphans fail the scan.
 */
async function ensureEngineSidecar(
  audioFile: string,
  fallbackGuid: string,
  name?: string,
): Promise<EnsureGuidResult> {
  if (!existsSync(audioFile)) {
    throw new Error(`refusing to write a sidecar for a missing audio file: ${audioFile}`);
  }
  const engineFile = `${audioFile}${ENGINE_SIDECAR_SUFFIX}`;
  const existing = await inspectEngineSidecar(engineFile);
  if (existing.state === 'foreign') {
    return {
      guid: null,
      indexed: false,
      skippedReason: `existing sidecar belongs to the '${existing.importer}' importer`,
    };
  }
  const guid = existing.state === 'ours' ? existing.guid : fallbackGuid;
  const sidecar = buildEngineAudioSidecar({ source: basename(audioFile), guid, name });
  assertValidEngineAudioSidecar(sidecar);
  await writeJson(engineFile, sidecar);
  return { guid, indexed: true };
}

/**
 * Resolve the catalog GUID of a clip the plugin did not generate, indexing it
 * on first sight. Used by the event projection, which has to reference every
 * clip a binding names — including files the user dropped in by hand.
 */
export async function ensureAudioClipGuid(
  audioFile: string,
  options: { slug: string; canonicalFile: string; name?: string },
): Promise<EnsureGuidResult> {
  return await ensureEngineSidecar(
    audioFile,
    backfilledAudioGuid(options.slug, options.canonicalFile),
    options.name,
  );
}

/** Index a generated clip and record how it was produced. */
export async function writeGeneratedAudioSidecars(
  input: WriteSidecarsInput,
): Promise<WriteSidecarsResult> {
  const indexed = await ensureEngineSidecar(
    input.audioFile,
    generatedAudioGuid(input.slug, input.assetId),
    input.name,
  );
  if (!indexed.guid) return indexed;
  const guid = indexed.guid;

  const provenance: PluginAudioSidecar = {
    schemaVersion: 1,
    producer: '@forgeax-extension/bgm',
    guid,
    slug: input.slug,
    assetId: input.assetId,
    kind: input.kind,
    name: input.name,
    file: input.gameFile,
    mimeType: input.mimeType,
    sizeBytes: input.bytes.byteLength,
    contentHash: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
    generatedAt: new Date().toISOString(),
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.shaping ? { shaping: input.shaping } : {}),
    ...(typeof input.durationMs === 'number' && input.durationMs >= 0
      ? { durationMs: Math.round(input.durationMs) }
      : {}),
  };
  await writeJson(`${input.audioFile}${PLUGIN_SIDECAR_SUFFIX}`, provenance);

  return { guid, indexed: true };
}

/** Length recorded when the plugin wrote the clip; missing on dropped files. */
export async function readPluginSidecarDuration(audioFile: string): Promise<number | undefined> {
  try {
    const parsed = JSON.parse(await readFile(`${audioFile}${PLUGIN_SIDECAR_SUFFIX}`, 'utf-8')) as {
      durationMs?: unknown;
    };
    if (typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0) {
      return Math.round(parsed.durationMs);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Remove both sidecars. Dropping the engine descriptor matters more than
 * tidiness: left behind without its audio file it becomes an orphan and takes
 * the game's whole asset scan down with it.
 */
export async function removeGeneratedAudioSidecars(audioFile: string): Promise<void> {
  await Promise.all([
    unlink(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`).catch(() => undefined),
    unlink(`${audioFile}${PLUGIN_SIDECAR_SUFFIX}`).catch(() => undefined),
  ]);
}
