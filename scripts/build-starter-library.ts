/**
 * Builds `library/starter/index.json` — the catalog the Agent picks from when a
 * game needs sound without waiting on generation.
 *
 * The index is the only readable description of those bytes, so it carries both
 * curated fields (what a clip is for) and measured ones (how long it actually
 * is). Measured fields are re-derived from disk on every run; curated fields
 * survive from the existing index, or arrive with `--import-*` from a delivery
 * batch's own manifest.
 *
 *   bun scripts/build-starter-library.ts                     # rebuild from disk
 *   bun scripts/build-starter-library.ts --check             # CI: index matches disk
 *   bun scripts/build-starter-library.ts \
 *     --import-sfx <dir with sfx/**.mp3 + manifest.csv> \
 *     --import-bgm <dir with audio/**.ogg + manifest.json>
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HIGH_FREQUENCY_DURATION_WARN_MS, measureAudioDurationMs } from '../server/audio-duration.ts';
import type { StarterEntry, StarterIndex, StarterKind } from '../shared/starter-library.ts';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const starterDir = join(pluginDir, 'library/starter');
const indexFile = join(starterDir, 'index.json');

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Delivery folders prefix categories with an ordering number that collides. */
function categoryFromDir(name: string): string {
  return slug(name.replace(/^\d+_/, ''));
}

/** Keeps ids pronounceable when a source file is named `2(32s).ogg`. */
function stemId(parents: string[], file: string): string {
  const stem = slug(basename(file, extname(file)));
  if (/^[a-z]/.test(stem)) return stem;
  const parent = slug(parents[parents.length - 1] ?? '');
  return parent ? `${parent}-${stem}` : `clip-${stem}`;
}

function walkAudio(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (MIME_BY_EXT[extname(entry.name).toLowerCase()]) out.push(abs);
    }
  };
  visit(root);
  return out.sort();
}

/** A long tail is not a loop: an 8-second explosion must still fire once. */
function looksLooped(id: string, kind: StarterKind, category: string): boolean {
  return kind === 'bgm' || category === 'ambient' || /-loop(-|$)/.test(id);
}

/* ───────────────────────── import: SFX delivery batch ───────────────────────── */

interface SfxRow {
  assetId: string;
  usage: string;
  sourcePath: string;
}

/** `manifest.csv` joins on source_path; its 一级目录 column drifted from disk. */
function readSfxRows(root: string): Map<string, SfxRow> {
  const rows = new Map<string, SfxRow>();
  const csv = join(root, 'manifest.csv');
  if (!statSafe(csv)) return rows;
  const lines = readFileSync(csv, 'utf8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const assetId = (cells[2] ?? '').trim();
    const usage = (cells[4] ?? '').trim();
    const sourcePath = (cells[5] ?? '').trim();
    if (!sourcePath) continue;
    rows.set(sourcePath.replace(/\.[^.]+$/, ''), { assetId, usage, sourcePath });
  }
  return rows;
}

function importSfx(sourceRoot: string): StarterEntry[] {
  const audioRoot = join(sourceRoot, 'sfx');
  if (!statSafe(audioRoot)) throw new Error(`--import-sfx expects an "sfx" folder under ${sourceRoot}`);
  const rows = readSfxRows(resolve(sourceRoot, '..'));
  const entries: StarterEntry[] = [];

  for (const abs of walkAudio(audioRoot)) {
    const rel = relative(audioRoot, abs);
    const parts = rel.split('/');
    const category = categoryFromDir(parts[0] ?? '');
    const id = `sfx/${category}/${stemId(parts.slice(0, -1), rel)}`;
    const file = `sfx/${category}/${basename(id)}${extname(abs).toLowerCase()}`;
    const row = rows.get(`sfx/${rel}`.replace(/\.[^.]+$/, ''));
    writeStarterFile(abs, file);
    entries.push({
      id,
      kind: 'sfx',
      category,
      usage: row?.usage || '',
      file,
      ...(row?.assetId ? { sourceAssetId: row.assetId } : {}),
    });
  }
  return entries;
}

/* ───────────────────────── import: BGM delivery batch ───────────────────────── */

interface BgmRow {
  output_path?: string;
  cue?: string;
  usage?: string;
  mood?: string[];
  energy?: string;
  world?: string;
  loopable?: boolean;
  asset_id?: string;
}

function importBgm(sourceRoot: string): StarterEntry[] {
  const manifestFile = join(sourceRoot, 'manifest.json');
  if (!statSafe(manifestFile)) throw new Error(`--import-bgm expects manifest.json under ${sourceRoot}`);
  const rows = JSON.parse(readFileSync(manifestFile, 'utf8')) as BgmRow[];
  const entries: StarterEntry[] = [];

  for (const row of rows) {
    if (!row.output_path) continue;
    const abs = join(sourceRoot, row.output_path);
    if (!statSafe(abs)) throw new Error(`manifest.json points at a missing file: ${row.output_path}`);
    const parts = row.output_path.split('/');
    const category = slug(row.cue || categoryFromDir(parts[1] ?? ''));
    const id = `bgm/${category}/${stemId(parts.slice(0, -1), row.output_path)}`;
    const file = `bgm/${category}/${basename(id)}${extname(abs).toLowerCase()}`;
    writeStarterFile(abs, file);
    entries.push({
      id,
      kind: 'bgm',
      category,
      usage: row.usage || '',
      file,
      // The delivery batch means "seamless" by `loopable`; every track is a
      // 32-second bed, so all of them still get looped when wired to a game.
      ...(row.loopable === true ? { seamlessLoop: true } : {}),
      ...(Array.isArray(row.mood) && row.mood.length ? { mood: row.mood } : {}),
      ...(row.energy ? { energy: row.energy } : {}),
      ...(row.world ? { world: row.world } : {}),
      ...(row.asset_id ? { sourceAssetId: row.asset_id } : {}),
    });
  }
  return entries;
}

/* ────────────────────────────────── shared ────────────────────────────────── */

function statSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeStarterFile(from: string, relFile: string): void {
  const target = join(starterDir, relFile);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
}

function readExistingIndex(): StarterEntry[] {
  if (!statSafe(indexFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(indexFile, 'utf8')) as Partial<StarterIndex>;
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Curated fields describe intent and cannot be recovered from the bytes, so
 * they are carried over; everything derived is dropped first, or a flag from an
 * earlier build outlives the rule that produced it.
 */
function measure(entry: StarterEntry): StarterEntry {
  const abs = join(starterDir, entry.file);
  const bytes = readFileSync(abs);
  const mime = MIME_BY_EXT[extname(entry.file).toLowerCase()] ?? 'audio/mpeg';
  const durationMs = measureAudioDurationMs(bytes, mime);
  const {
    mime: _mime,
    bytes: _bytes,
    durationMs: _durationMs,
    loop: _loop,
    ambient: _ambient,
    highFrequencySafe: _highFrequencySafe,
    ...curated
  } = entry;
  return {
    ...curated,
    mime,
    bytes: bytes.byteLength,
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
    loop: looksLooped(entry.id, entry.kind, entry.category),
    ...(entry.kind === 'sfx' && entry.category === 'ambient' ? { ambient: true } : {}),
    ...(entry.kind === 'sfx'
      ? { highFrequencySafe: typeof durationMs === 'number' && durationMs <= HIGH_FREQUENCY_DURATION_WARN_MS }
      : {}),
  };
}

function build(imported: StarterEntry[]): StarterIndex {
  const seen = new Set<string>();
  for (const entry of imported) {
    if (seen.has(entry.id)) {
      throw new Error(`two source clips map to the same starter id: ${entry.id} (${entry.file})`);
    }
    seen.add(entry.id);
  }
  const merged = new Map<string, StarterEntry>();
  for (const entry of readExistingIndex()) merged.set(entry.id, entry);
  for (const entry of imported) merged.set(entry.id, { ...merged.get(entry.id), ...entry });

  const onDisk = new Set(
    walkAudio(starterDir).map((abs) => relative(starterDir, abs)),
  );
  const entries: StarterEntry[] = [];
  for (const entry of [...merged.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!onDisk.has(entry.file)) continue;
    onDisk.delete(entry.file);
    entries.push(measure(entry));
  }
  if (onDisk.size) {
    throw new Error(
      `starter files are missing from the index (run --import first): ${[...onDisk].slice(0, 5).join(', ')}`,
    );
  }
  return { version: 1, entries };
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };

  mkdirSync(starterDir, { recursive: true });
  const imported: StarterEntry[] = [];
  const sfxRoot = flag('--import-sfx');
  const bgmRoot = flag('--import-bgm');
  if (sfxRoot) imported.push(...importSfx(resolve(sfxRoot)));
  if (bgmRoot) imported.push(...importBgm(resolve(bgmRoot)));

  const next = build(imported);
  const serialized = `${JSON.stringify(next, null, 2)}\n`;

  if (argv.includes('--check')) {
    const current = statSafe(indexFile) ? readFileSync(indexFile, 'utf8') : '';
    if (current !== serialized) {
      console.error('library/starter/index.json is stale — run: bun scripts/build-starter-library.ts');
      process.exit(1);
    }
    console.log(`starter library index is current (${next.entries.length} entries)`);
    return;
  }

  writeFileSync(indexFile, serialized);
  const sfx = next.entries.filter((entry) => entry.kind === 'sfx');
  const bgm = next.entries.filter((entry) => entry.kind === 'bgm');
  console.log(
    `wrote ${relative(pluginDir, indexFile)}: ${next.entries.length} entries `
    + `(${sfx.length} sfx — ${sfx.filter((e) => e.highFrequencySafe).length} short enough for `
    + `high-frequency events, ${sfx.filter((e) => e.ambient).length} ambience beds; ${bgm.length} bgm)`,
  );
}

main();
