#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { resolveGameAudioFile } from '../../../server/audio-file-resolve.ts';
import { evaluateRuntimeEvidence, parseRuntimeEvidence } from '../../../server/runtime-evidence.ts';

type JsonObject = Record<string, unknown>;

interface ManifestTrack {
  assetId: string;
  file: string;
  kind?: string;
}

interface BindingAsset {
  assetId?: string;
  file?: string;
}

interface Binding {
  familyId?: string;
  assets?: BindingAsset[];
}

interface AudioProjectFollowCase {
  assets?: BindingAsset[];
}

interface AudioProjectBinding {
  eventId?: string;
  enabled?: boolean;
  assets?: BindingAsset[];
  follow?: { cases?: AudioProjectFollowCase[] };
}

/** 引擎已升到 v2，但 v1 文档仍会被自动迁移，两种都要放行。 */
const SUPPORTED_PROJECT_SCHEMAS = new Set([
  'forgeax-audio-project/1',
  'forgeax-audio-project/2',
]);

/**
 * 一个绑定实际引用的全部素材。素材可以只挂在跟随分支下（每种材质一条音频），
 * 只看顶层 `assets` 会把这类合法绑定误判成「没有声音」。
 */
function bindingAssets(binding: AudioProjectBinding): BindingAsset[] {
  return [
    ...(Array.isArray(binding.assets) ? binding.assets : []),
    ...(Array.isArray(binding.follow?.cases) ? binding.follow.cases : [])
      .flatMap((item) => (Array.isArray(item?.assets) ? item.assets : [])),
  ];
}

interface AuditResult {
  ok: boolean;
  slug: string;
  summary: {
    manifestTracks: number;
    bindings: number;
    sourceFiles: number;
    errors: number;
    warnings: number;
  };
  errors: string[];
  warnings: string[];
}

const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set([
  '.git',
  'audio',
  'dist',
  'node_modules',
  'sessions',
  'audio studio',
]);
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(file: string): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  if (!isObject(parsed)) throw new Error(`${file} root must be an object`);
  return parsed;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) {
          await walk(resolve(directory, entry.name));
        }
        continue;
      }
      if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) {
        files.push(resolve(directory, entry.name));
      }
    }
  }
  await walk(root);
  return files;
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeGameFile(gameRoot: string, file: string): string | null {
  return resolveGameAudioFile(gameRoot, file);
}

function safeAudioProjectFile(gameRoot: string, file: string): string | null {
  return resolveGameAudioFile(gameRoot, file);
}

async function auditAudioProject(
  gameRoot: string,
  slug: string,
  projectPath: string,
): Promise<AuditResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const project = await readJson(projectPath);
  if (!SUPPORTED_PROJECT_SCHEMAS.has(String(project.schemaVersion ?? ''))) {
    errors.push(`unsupported audio project schema '${String(project.schemaVersion ?? '')}'`);
  }
  if (project.status !== 'applied') errors.push('audio/project.json is not applied');
  if (project.projectId !== slug) {
    errors.push(`audio project '${String(project.projectId ?? '')}' does not match '${slug}'`);
  }
  const bindings = Array.isArray(project.bindings)
    ? project.bindings.filter(isObject) as unknown as AudioProjectBinding[]
    : [];
  if (!Array.isArray(project.bindings)) errors.push('audio project bindings must be an array');
  if (!bindings.length) errors.push('audio project has no bindings');

  const files = await sourceFiles(gameRoot);
  const sources = await Promise.all(files.map(async (file) => ({
    file,
    text: await readFile(file, 'utf8'),
  })));
  for (const runtimeFile of ['runtime.ts', 'runtime-impl.js', 'runtime-impl.d.ts', 'generated-bindings.ts', 'index.ts']) {
    const absolute = resolve(gameRoot, 'src', 'forgeax-audio', runtimeFile);
    if (!existsSync(absolute)) errors.push(`generated runtime is missing 'src/forgeax-audio/${runtimeFile}'`);
  }

  for (const [index, binding] of bindings.entries()) {
    const eventId = String(binding.eventId ?? '').trim();
    if (!eventId) {
      errors.push(`binding[${index}] requires eventId`);
      continue;
    }
    if (binding.enabled === false) {
      warnings.push(`binding '${eventId}' is disabled`);
      continue;
    }
    const assets = bindingAssets(binding);
    if (!assets.length) errors.push(`binding '${eventId}' has no assets`);
    for (const [assetIndex, asset] of assets.entries()) {
      if (!isObject(asset) || !asset.assetId || !asset.file) {
        errors.push(`binding '${eventId}' asset[${assetIndex}] requires assetId and file`);
        continue;
      }
      const absolute = safeAudioProjectFile(gameRoot, asset.file);
      if (!absolute) {
        errors.push(`binding '${eventId}' has unsafe file '${asset.file}'`);
      } else if (!existsSync(absolute)) {
        errors.push(`binding '${eventId}' is missing audio file '${asset.file}'`);
      }
    }
    const eventPattern = new RegExp(
      "gameAudio\\.emit\\s*\\(\\s*(['\"`])" + escapedRegex(eventId) + "\\1",
    );
    if (!sources.some(({ text }) => eventPattern.test(text))) {
      errors.push(`event '${eventId}' has no literal gameAudio.emit('${eventId}') call`);
    }
  }

  if (!files.length) warnings.push('game contains no TypeScript/JavaScript source files');
  return {
    ok: errors.length === 0,
    slug,
    summary: {
      manifestTracks: 0,
      bindings: bindings.length,
      sourceFiles: files.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
  };
}

async function audit(projectRoot: string, slug: string): Promise<AuditResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const gameRoot = resolve(projectRoot, '.forgeax', 'games', slug);
  const manifestPath = resolve(gameRoot, 'audio', 'manifest.json');
  const cuesPath = resolve(gameRoot, 'audio', 'cues.json');
  const projectPath = resolve(gameRoot, 'audio', 'project.json');

  if (!existsSync(gameRoot)) throw new Error(`game not found: ${gameRoot}`);
  if (existsSync(projectPath)) return auditAudioProject(gameRoot, slug, projectPath);
  if (!existsSync(manifestPath)) throw new Error(`manifest not found: ${manifestPath}`);
  if (!existsSync(cuesPath)) throw new Error(`cue map not found: ${cuesPath}`);

  const manifest = await readJson(manifestPath);
  const cues = await readJson(cuesPath);
  if (manifest.slug !== slug) {
    errors.push(`manifest slug '${String(manifest.slug ?? '')}' does not match '${slug}'`);
  }

  const tracks = Array.isArray(manifest.tracks)
    ? manifest.tracks.filter(isObject) as unknown as ManifestTrack[]
    : [];
  if (!Array.isArray(manifest.tracks)) errors.push('manifest.tracks must be an array');

  const tracksByAsset = new Map<string, ManifestTrack>();
  for (const [index, track] of tracks.entries()) {
    if (!track.assetId || !track.file) {
      errors.push(`manifest.tracks[${index}] requires assetId and file`);
      continue;
    }
    const absolute = safeGameFile(gameRoot, track.file);
    if (!absolute) {
      errors.push(`manifest track '${track.assetId}' has unsafe file '${track.file}'`);
      continue;
    }
    if (!existsSync(absolute)) {
      errors.push(`manifest track '${track.assetId}' is missing file '${track.file}'`);
    }
    tracksByAsset.set(track.assetId, track);
  }

  const rawBindings = isObject(cues.assetBindings) ? cues.assetBindings : {};
  const bindings = Object.entries(rawBindings) as Array<[string, Binding]>;
  if (!bindings.length) errors.push('audio/cues.json has no assetBindings');

  const files = await sourceFiles(gameRoot);
  const sources = await Promise.all(files.map(async (file) => ({
    file,
    text: await readFile(file, 'utf8'),
  })));
  const readsBindings = sources.some(({ text }) => text.includes('assetBindings'));
  if (bindings.length && !readsBindings) {
    errors.push('game audio runtime does not read audio/cues.json.assetBindings');
  }

  for (const [eventId, binding] of bindings) {
    if (!isObject(binding)) {
      errors.push(`binding '${eventId}' must be an object`);
      continue;
    }
    if (!binding.familyId) errors.push(`binding '${eventId}' has no familyId`);
    const assets = Array.isArray(binding.assets) ? binding.assets : [];
    if (!assets.length) errors.push(`binding '${eventId}' has no assets`);

    for (const [index, asset] of assets.entries()) {
      if (!isObject(asset) || !asset.assetId || !asset.file) {
        errors.push(`binding '${eventId}' asset[${index}] requires assetId and file`);
        continue;
      }
      const track = tracksByAsset.get(asset.assetId);
      if (!track) {
        errors.push(`binding '${eventId}' references unknown asset '${asset.assetId}'`);
      } else if (track.file !== asset.file) {
        errors.push(
          `binding '${eventId}' file '${asset.file}' differs from manifest '${track.file}'`,
        );
      }
    }

    const eventPattern = new RegExp(
      "\\.play\\s*\\(\\s*(['\"`])" + escapedRegex(eventId) + "\\1",
    );
    const callSite = sources.find(({ text }) => eventPattern.test(text));
    if (!callSite) {
      errors.push(`event '${eventId}' has no literal .play('${eventId}') call`);
    }
  }

  if (!files.length) warnings.push('game contains no TypeScript/JavaScript source files');
  return {
    ok: errors.length === 0,
    slug,
    summary: {
      manifestTracks: tracks.length,
      bindings: bindings.length,
      sourceFiles: files.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    errors,
    warnings,
  };
}

const projectRoot = argument('--project-root') || process.cwd();
const slug = argument('--slug');
const evidenceFile = argument('--runtime-evidence');
if (!slug || !SLUG_RE.test(slug)) {
  process.stderr.write(
    'usage: audit-audio-bindings.ts --project-root <root> --slug <slug> [--runtime-evidence <snapshot.json>]\n',
  );
  process.exit(2);
}

try {
  const result = await audit(resolve(projectRoot), slug);
  if (evidenceFile) {
    const raw = JSON.parse(await readFile(resolve(evidenceFile), 'utf8')) as unknown;
    const evaluated = evaluateRuntimeEvidence(parseRuntimeEvidence(raw));
    for (const item of evaluated.errors) result.errors.push(`${item.code}: ${item.message}`);
    for (const item of evaluated.warnings) result.warnings.push(`${item.code}: ${item.message}`);
    result.ok = result.errors.length === 0;
    result.summary.errors = result.errors.length;
    result.summary.warnings = result.warnings.length;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const result: AuditResult = {
    ok: false,
    slug,
    summary: {
      manifestTracks: 0,
      bindings: 0,
      sourceFiles: 0,
      errors: 1,
      warnings: 0,
    },
    errors: [(error as Error).message],
    warnings: [],
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}
