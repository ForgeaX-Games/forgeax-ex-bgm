/**
 * Reads the clips that ship with the plugin.
 *
 * This is a pick-list, not a library surface: entries are only ever resolved by
 * exact id, and the caller's next move is to copy the bytes into the game. No
 * search, no query language, no way to reference a clip that stayed inside the
 * plugin directory.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { BgmError } from './core.ts';
import type { StarterEntry, StarterIndex, StarterKind } from '../shared/starter-library.ts';

interface LoadedIndex {
  entries: StarterEntry[];
  byId: Map<string, StarterEntry>;
}

/** Keyed by root: one process can serve more than one plugin copy in tests. */
const cache = new Map<string, LoadedIndex>();

function starterRoot(pluginDir: string): string {
  return resolve(pluginDir, 'library/starter');
}

async function readStarterIndex(pluginDir: string): Promise<LoadedIndex> {
  const root = starterRoot(pluginDir);
  const hit = cache.get(root);
  if (hit) return hit;
  let parsed: Partial<StarterIndex>;
  try {
    parsed = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as Partial<StarterIndex>;
  } catch (error) {
    throw new BgmError(
      'starter-library-missing',
      `starter audio index is unavailable: ${(error as Error).message}`,
      500,
    );
  }
  if (!Array.isArray(parsed.entries) || !parsed.entries.length) {
    throw new BgmError('starter-library-missing', 'starter audio index is empty', 500);
  }
  const loaded: LoadedIndex = {
    entries: parsed.entries,
    byId: new Map(parsed.entries.map((entry) => [entry.id, entry])),
  };
  cache.set(root, loaded);
  return loaded;
}

export interface StarterListOptions {
  kind?: StarterKind;
  highFrequencyOnly?: boolean;
}

export async function listStarterAudio(
  pluginDir: string,
  options: StarterListOptions = {},
): Promise<StarterEntry[]> {
  const { entries } = await readStarterIndex(pluginDir);
  return entries.filter((entry) => {
    if (options.kind && entry.kind !== options.kind) return false;
    if (options.highFrequencyOnly && entry.kind === 'sfx' && !entry.highFrequencySafe) return false;
    return true;
  });
}

export interface StarterClip {
  entry: StarterEntry;
  bytes: Buffer;
}

export async function readStarterClip(pluginDir: string, starterId: string): Promise<StarterClip> {
  const id = String(starterId ?? '').trim();
  const { byId } = await readStarterIndex(pluginDir);
  const entry = byId.get(id);
  if (!entry) {
    throw new BgmError(
      'unknown-starter-id',
      `no starter clip with id: ${id || '(empty)'}. Call list-starter-audio and use an id from it.`,
      400,
    );
  }
  // The index is committed alongside the bytes, but it is still a file: a bad
  // entry must not become a read outside the plugin's own starter folder.
  const root = starterRoot(pluginDir);
  const absolute = resolve(root, entry.file);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new BgmError('invalid-starter-file', `starter entry escapes the library: ${entry.id}`, 500);
  }
  return { entry, bytes: await readFile(absolute) };
}
