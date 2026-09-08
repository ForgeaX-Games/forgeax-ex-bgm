/**
 * Projection of audio events into the game's asset catalog.
 *
 * The plugin's own store (`audio/project.json`) stays the authoring format, but
 * what the engine — and therefore the content browser — can see is a pack file:
 * `assets/audio/events.pack.json`. One asset per event, each referencing its
 * clips by GUID instead of by filename, so renaming a clip no longer silently
 * unbinds the sound that plays it.
 *
 * The same fail-fast caveat as the clip sidecars applies: a malformed pack
 * aborts the asset scan for the whole game root. Validate, then write through a
 * temporary file.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { AudioBinding, AudioProject } from '../shared/audio-project.ts';
import { canonicalAudioFile } from '../shared/audio-file-path.ts';
import { deriveAssetGuid, ensureAudioClipGuid, readPluginSidecarDuration } from './asset-sidecar.ts';
import { resolveGameAudioFile } from './audio-file-resolve.ts';

/** Catalog kind of an event asset; also the `resourceEditors` selector value. */
export const AUDIO_EVENT_KIND = 'audio-event';
export const EVENTS_PACK_FILE = 'assets/audio/events.pack.json';
export const AUDIO_EVENT_PAYLOAD_SCHEMA = 'forgeax-audio-event/1';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A clip as referenced from an event: identity first, path second. */
export interface EventClipRef {
  guid: string;
  assetId: string;
  file: string;
  name?: string;
  shaping?: AudioBinding['assets'][number]['shaping'];
  durationMs?: number;
}

export interface AudioEventPayload {
  schemaVersion: typeof AUDIO_EVENT_PAYLOAD_SCHEMA;
  eventId: string;
  label: string;
  enabled: boolean;
  kind: AudioBinding['kind'];
  clips: EventClipRef[];
  variation: AudioBinding['variation'];
  trigger: AudioBinding['trigger'];
  playback: AudioBinding['playback'];
  shaping?: AudioBinding['shaping'];
  conditions: AudioBinding['conditions'];
  follow?: Omit<NonNullable<AudioBinding['follow']>, 'cases'> & {
    cases?: Array<{ value: unknown; label?: string; clips: EventClipRef[] }>;
  };
}

export interface EventsPackAsset {
  guid: string;
  kind: typeof AUDIO_EVENT_KIND;
  name?: string;
  payload: AudioEventPayload;
  refs: string[];
}

export interface EventsPack {
  schemaVersion: '1.0.0';
  kind: 'internal-text-package';
  assets: EventsPackAsset[];
}

/** Stable identity of an event asset: the project it lives in plus its id. */
export function audioEventGuid(projectId: string, eventId: string): string {
  return deriveAssetGuid(`forgeax-bgm/audio-event/${projectId}/${eventId}`);
}

/**
 * Guards the write. The engine validates with ajv and a failure costs the whole
 * root, so anything we cannot vouch for locally must not reach the disk.
 */
export function assertValidEventsPack(pack: EventsPack): void {
  if (pack.schemaVersion !== '1.0.0') throw new Error('events pack schemaVersion must be "1.0.0"');
  if (pack.kind !== 'internal-text-package') {
    throw new Error('events pack kind must be "internal-text-package"');
  }
  if (!Array.isArray(pack.assets)) throw new Error('events pack assets must be an array');
  const seen = new Set<string>();
  for (const asset of pack.assets) {
    if (!GUID_RE.test(asset.guid)) throw new Error(`event asset guid is not a UUID: ${asset.guid}`);
    const normalized = asset.guid.toLowerCase();
    if (seen.has(normalized)) throw new Error(`duplicate event asset guid: ${asset.guid}`);
    seen.add(normalized);
    if (asset.kind !== AUDIO_EVENT_KIND) {
      throw new Error(`event asset kind must be "${AUDIO_EVENT_KIND}", got: ${asset.kind}`);
    }
    if (asset.name !== undefined && !asset.name) throw new Error('event asset name must not be empty');
    if (!asset.payload || typeof asset.payload !== 'object') {
      throw new Error(`event asset '${asset.guid}' has no payload`);
    }
    if (!Array.isArray(asset.refs)) throw new Error(`event asset '${asset.guid}' has no refs array`);
    for (const ref of asset.refs) {
      if (!GUID_RE.test(ref)) throw new Error(`event asset ref is not a UUID: ${ref}`);
    }
  }
}

export interface ProjectEventsPackResult {
  pack: EventsPack;
  /** Clips a binding names but which could not be indexed, by game-relative path. */
  unindexed: Array<{ file: string; reason: string }>;
}

/**
 * Build the pack for a project, resolving (and backfilling) the catalog GUID of
 * every clip the events reference.
 *
 * Disabled and still-empty events are projected too: an event has to exist as an
 * asset before the user can open it and put sounds in it.
 */
export async function projectEventsPack(
  gameDir: string,
  project: AudioProject,
): Promise<ProjectEventsPackResult> {
  const slug = basename(gameDir);
  const guidByFile = new Map<string, string>();
  const unindexed: Array<{ file: string; reason: string }> = [];

  const clipRef = async (asset: AudioBinding['assets'][number]): Promise<EventClipRef | null> => {
    const file = canonicalAudioFile(asset.file);
    const absolute = resolveGameAudioFile(gameDir, file);
    let guid = guidByFile.get(file);
    if (!guid) {
      if (!absolute) {
        unindexed.push({ file, reason: '路径不在游戏音频目录内' });
        return null;
      }
      let resolved;
      try {
        resolved = await ensureAudioClipGuid(absolute, {
          slug,
          canonicalFile: file,
          ...(asset.name ? { name: asset.name } : {}),
        });
      } catch (error) {
        unindexed.push({ file, reason: (error as Error).message });
        return null;
      }
      if (!resolved.guid) {
        unindexed.push({ file, reason: resolved.skippedReason ?? '无法建立资产索引' });
        return null;
      }
      guid = resolved.guid;
      guidByFile.set(file, guid);
    }
    if (!guid) return null;
    const durationMs = absolute ? await readPluginSidecarDuration(absolute) : undefined;
    return {
      guid,
      assetId: asset.assetId,
      file,
      ...(asset.name ? { name: asset.name } : {}),
      ...(asset.shaping ? { shaping: asset.shaping } : {}),
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
    };
  };

  const assets: EventsPackAsset[] = [];
  for (const binding of project.bindings) {
    const clips = (await Promise.all(binding.assets.map(clipRef)))
      .filter((clip): clip is EventClipRef => clip !== null);
    const cases = binding.follow?.cases
      ? await Promise.all(binding.follow.cases.map(async (item) => ({
        value: item.value,
        ...(item.label ? { label: item.label } : {}),
        clips: (await Promise.all(item.assets.map(clipRef)))
          .filter((clip): clip is EventClipRef => clip !== null),
      })))
      : undefined;
    const payload: AudioEventPayload = {
      schemaVersion: AUDIO_EVENT_PAYLOAD_SCHEMA,
      eventId: binding.eventId,
      label: binding.label,
      enabled: binding.enabled,
      kind: binding.kind,
      clips,
      variation: binding.variation,
      trigger: binding.trigger,
      playback: binding.playback,
      ...(binding.shaping ? { shaping: binding.shaping } : {}),
      conditions: binding.conditions,
      ...(binding.follow
        ? { follow: { ...binding.follow, cases: undefined, ...(cases ? { cases } : {}) } }
        : {}),
    };
    if (payload.follow && payload.follow.cases === undefined) delete payload.follow.cases;
    const refs = [...new Set([
      ...clips.map((clip) => clip.guid),
      ...(cases ?? []).flatMap((item) => item.clips.map((clip) => clip.guid)),
    ])];
    assets.push({
      guid: audioEventGuid(project.projectId, binding.eventId),
      kind: AUDIO_EVENT_KIND,
      ...(binding.label ? { name: binding.label } : {}),
      payload,
      refs,
    });
  }

  const pack: EventsPack = { schemaVersion: '1.0.0', kind: 'internal-text-package', assets };
  assertValidEventsPack(pack);
  return { pack, unindexed };
}

export async function writeEventsPack(gameDir: string, pack: EventsPack): Promise<string> {
  assertValidEventsPack(pack);
  const target = join(gameDir, EVENTS_PACK_FILE);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(pack, null, 2)}\n`);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return EVENTS_PACK_FILE;
}

/** Read back what was projected. The compiler generates the game runtime from this. */
export async function readEventsPack(gameDir: string): Promise<EventsPack> {
  const raw = await readFile(join(gameDir, EVENTS_PACK_FILE), 'utf8');
  const parsed = JSON.parse(raw) as EventsPack;
  assertValidEventsPack(parsed);
  return parsed;
}
