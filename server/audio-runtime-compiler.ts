import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AUDIO_ENGINE_VERSION, audioBindingAssets, normalizeAudioProject, type AudioProject } from '../shared/audio-project.ts';
import { audioImportSpecifier, canonicalAudioFile } from '../shared/audio-file-path.ts';
import { resolveGameAudioFile } from './audio-file-resolve.ts';
import {
  EVENTS_PACK_FILE,
  type EventClipRef,
  type EventsPack,
  projectEventsPack,
  readEventsPack,
  writeEventsPack,
} from './events-pack.ts';

export interface CompileAudioRuntimeResult {
  files: string[];
  /** Clips an event names but which could not be indexed into the catalog. */
  unindexed?: Array<{ file: string; reason: string }>;
}

export class AudioRuntimeCompileError extends Error {
  readonly code: 'asset_missing' | 'binding_assets_empty';

  constructor(code: AudioRuntimeCompileError['code'], message: string) {
    super(message);
    this.name = 'AudioRuntimeCompileError';
    this.code = code;
  }
}

const OUTPUT_FILES = [
  'src/forgeax-audio/runtime.ts',
  'src/forgeax-audio/generated-bindings.ts',
  'src/forgeax-audio/index.ts',
  'src/forgeax-audio/listener.ts',
] as const;

/** The generated listener system imports these; games without them get no listener file. */
const LISTENER_ENGINE_PACKAGES = [
  '@forgeax/engine-ecs',
  '@forgeax/engine-render',
  '@forgeax/engine-scene',
] as const;

async function supportsEcsListener(gameDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(gameDir, 'package.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const manifest = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  return LISTENER_ENGINE_PACKAGES.every((name) => name in dependencies);
}

/**
 * Distance attenuation needs the listener transform every frame. The engine deliberately has no
 * global per-frame hook, so the game still calls `installForgeaxAudio(world)` once from bootstrap;
 * everything after that (finding the camera, converting its rotation) is generated.
 */
const LISTENER_SOURCE = `import { Entity, Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const ACTIVE_CAMERA_KEY = 'ActiveCamera';

type AudioPoint = { x: number; y: number; z: number };
type ListenerTransform = { position: AudioPoint; forward?: AudioPoint; up?: AudioPoint };

/** Structural view of the generated runtime — the bundle exports no types. */
interface ListenerSink {
  setListener(transform: ListenerTransform): void;
  setGameObjectTransform(gameObjectId: string, transform: AudioPoint): void;
}

export interface ForgeaxAudioListenerOptions {
  /** Report the ears yourself; when it returns a value the camera lookup is skipped. */
  readListener?: () => ListenerTransform | undefined;
  /**
   * Game object id -> entity, re-read every frame. Their positions feed 3D sounds emitted with
   * the same id, so \`emit('weapon.fire', { gameObjectId: 'player' })\` needs no coordinates.
   */
  trackObjects?: () => Record<string, EntityHandle | undefined>;
}

/** Rotate a unit axis by the quaternion [x, y, z, w]. */
function rotate(quat: ArrayLike<number>, ax: number, ay: number, az: number): AudioPoint {
  const qx = quat[0] ?? 0;
  const qy = quat[1] ?? 0;
  const qz = quat[2] ?? 0;
  const qw = quat[3] ?? 1;
  const tx = 2 * (qy * az - qz * ay);
  const ty = 2 * (qz * ax - qx * az);
  const tz = 2 * (qx * ay - qy * ax);
  return {
    x: ax + qw * tx + (qy * tz - qz * ty),
    y: ay + qw * ty + (qz * tx - qx * tz),
    z: az + qw * tz + (qx * ty - qy * tx),
  };
}

function positionOf(world: World, entity: EntityHandle): AudioPoint | undefined {
  const transform = world.get(entity, Transform);
  if (!transform.ok) return undefined;
  const pos = transform.value.pos as ArrayLike<number>;
  return { x: pos[0] ?? 0, y: pos[1] ?? 0, z: pos[2] ?? 0 };
}

function reportFrom(world: World, entity: EntityHandle, runtime: ListenerSink): boolean {
  const transform = world.get(entity, Transform);
  if (!transform.ok) return false;
  const pos = transform.value.pos as ArrayLike<number>;
  const quat = transform.value.quat as ArrayLike<number>;
  runtime.setListener({
    position: { x: pos[0] ?? 0, y: pos[1] ?? 0, z: pos[2] ?? 0 },
    forward: rotate(quat, 0, 0, -1),
    up: rotate(quat, 0, 1, 0),
  });
  return true;
}

/**
 * Register the per-frame system that keeps the audio listener on the active camera.
 * Without it every 3D sound plays unattenuated, because the runtime never learns where the
 * player is. Call once from bootstrap(world).
 */
export function installForgeaxAudioListener(
  world: World,
  runtime: ListenerSink,
  options: ForgeaxAudioListenerOptions = {},
): void {
  world.addSystem(Update, {
    name: 'forgeax-audio-listener',
    queries: [{ with: [Camera, Entity] }],
    fn: (_world, queryResults) => {
      for (const [gameObjectId, entity] of Object.entries(options.trackObjects?.() ?? {})) {
        if (entity === undefined) continue;
        const position = positionOf(world, entity);
        if (position) runtime.setGameObjectTransform(gameObjectId, position);
      }

      const reported = options.readListener?.();
      if (reported) {
        runtime.setListener(reported);
        return;
      }
      // engine-render keeps the ActiveCamera resource but does not re-export its reader.
      const active = world.hasResource(ACTIVE_CAMERA_KEY)
        ? world.getResource<{ entity: number }>(ACTIVE_CAMERA_KEY)
        : undefined;
      if (active && reportFrom(world, active.entity as EntityHandle, runtime)) return;
      for (const bundle of queryResults[0]) {
        for (const rawEntity of bundle.Entity.self) {
          if (reportFrom(world, rawEntity as EntityHandle, runtime)) return;
        }
      }
    },
  });
}
`;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Compile the projected events into the game runtime.
 *
 * The events pack is the source of truth here — this reads what was written to
 * `assets/audio/events.pack.json` rather than the authoring project, so what the
 * game plays and what the content browser shows can never drift apart. Clip
 * GUIDs travel into the generated file next to their URLs, which is what makes a
 * later rename harmless.
 */
function generatedBindingsSource(project: AudioProject, pack: EventsPack): string {
  let marker = 0;
  const assetFiles: string[] = [];
  const runtimeAsset = (clip: EventClipRef) => {
    assetFiles.push(clip.file);
    return {
      assetId: clip.assetId,
      file: clip.file,
      guid: clip.guid,
      ...(clip.name ? { name: clip.name } : {}),
      ...(clip.shaping ? { shaping: clip.shaping } : {}),
      ...(typeof clip.durationMs === 'number' ? { durationMs: clip.durationMs } : {}),
      url: `__FORGEAX_AUDIO_URL_${marker++}__`,
    };
  };
  const bankFeatures = {
    music: Boolean(project.music?.segments?.length),
    attenuation: project.attenuations.length > 0,
    gameSyncs: (
      project.gameSyncs.states.length
      + project.gameSyncs.switches.length
      + project.gameSyncs.rtpcs.length
    ) > 0,
  };
  const runtimeProject = {
    schemaVersion: 'forgeax-audio-runtime/1',
    projectId: project.projectId,
    revision: project.revision,
    engineVersion: project.engineVersion || AUDIO_ENGINE_VERSION,
    bankFeatures,
    // Without the curves themselves the runtime flags attenuation as enabled but has
    // nothing to evaluate, so every 3D sound silently plays at full volume.
    ...(project.attenuations.length ? { attenuations: project.attenuations } : {}),
    // Same trap one level up: the runtime implements bus gain and ducking, but
    // falls back to a flat default graph when the compiled project omits them,
    // so anything authored through define-bus never reached the game.
    ...(project.buses.length ? { buses: project.buses } : {}),
    bindings: pack.assets.map(({ guid, payload }) => {
      const { schemaVersion: _schema, clips, follow, ...rest } = payload;
      return {
        ...rest,
        guid,
        // The runtime reads these off the binding, not off playback. Leaving them
        // nested is why every event ran on the same 8 voices and priority 50 no
        // matter what the project said.
        ...(typeof payload.playback.maxInstances === 'number'
          ? { maxInstances: payload.playback.maxInstances }
          : {}),
        ...(typeof payload.playback.priority === 'number'
          ? { priority: payload.playback.priority }
          : {}),
        assets: clips.map(runtimeAsset),
        ...(follow ? {
          follow: {
            ...follow,
            ...(follow.cases ? {
              cases: follow.cases.map((item) => ({
                value: item.value,
                ...(item.label ? { label: item.label } : {}),
                assets: item.clips.map(runtimeAsset),
              })),
            } : {}),
          },
        } : {}),
      };
    }),
  };
  let serialized = JSON.stringify(runtimeProject, null, 2);
  for (let index = 0; index < assetFiles.length; index++) {
    const placeholder = JSON.stringify(`__FORGEAX_AUDIO_URL_${index}__`);
    const relativeUrl = JSON.stringify(audioImportSpecifier(canonicalAudioFile(assetFiles[index])));
    serialized = serialized.replace(placeholder, `new URL(${relativeUrl}, import.meta.url).href`);
  }
  return [
    "import type { RuntimeAudioProject } from './runtime';",
    '',
    `export const forgeaxAudioProject: RuntimeAudioProject = ${serialized};`,
    '',
  ].join('\n');
}

async function atomicWriteGroup(gameDir: string, files: Array<{ relativePath: string; content: string }>): Promise<void> {
  const prepared: Array<{ temporary: string; target: string }> = [];
  try {
    for (const file of files) {
      const target = join(gameDir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${prepared.length}`;
      await writeFile(temporary, file.content, 'utf8');
      prepared.push({ temporary, target });
    }
    for (const file of prepared) await rename(file.temporary, file.target);
  } catch (error) {
    throw error;
  }
}

export async function compileAudioRuntime(
  gameDir: string,
  inputProject: AudioProject,
  runtimeSource: string,
): Promise<CompileAudioRuntimeResult> {
  const project = normalizeAudioProject(inputProject, inputProject.projectId);
  try {
    const manifest = JSON.parse(await readFile(join(gameDir, 'audio', 'manifest.json'), 'utf8')) as {
      tracks?: Array<{ assetId?: string; shaping?: import('../shared/audio-project.ts').AudioShapingParams }>;
    };
    const shapingByAsset = new Map(
      (manifest.tracks ?? [])
        .filter((track): track is { assetId: string; shaping?: import('../shared/audio-project.ts').AudioShapingParams } => typeof track.assetId === 'string')
        .map((track) => [track.assetId, track.shaping]),
    );
    for (const binding of project.bindings) {
      for (const asset of audioBindingAssets(binding)) {
        const shaping = asset.shaping ?? shapingByAsset.get(asset.assetId);
        if (shaping) asset.shaping = shaping;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const binding of project.bindings) {
    if (!binding.enabled) continue;
    if (binding.assets.length === 0) {
      throw new AudioRuntimeCompileError(
        'binding_assets_empty',
        `binding '${binding.eventId}' has no audio assets`,
      );
    }
    for (const asset of audioBindingAssets(binding)) {
      if (!await isFile(resolveGameAudioFile(gameDir, asset.file) ?? '')) {
        throw new AudioRuntimeCompileError('asset_missing', `audio asset '${asset.file}' does not exist`);
      }
    }
  }
  // Project the events into the catalog first, then compile from what landed on
  // disk: one source of truth for both the content browser and playback.
  const projected = await projectEventsPack(gameDir, project);
  await writeEventsPack(gameDir, projected.pack);
  const pack = await readEventsPack(gameDir);

  // The bundled runtime is plain ESM JS (still written as runtime.ts). Types
  // are therefore declared here so game authors can keep importing them from
  // `./src/forgeax-audio` without depending on erased type exports.
  const withListener = await supportsEcsListener(gameDir);
  const indexSource = [
    "import { createForgeaxAudioRuntime } from './runtime';",
    "import { forgeaxAudioProject } from './generated-bindings';",
    ...(withListener
      ? [
        "import { installForgeaxAudioListener, type ForgeaxAudioListenerOptions } from './listener';",
        "import type { World } from '@forgeax/engine-ecs';",
      ]
      : []),
    '',
    'export type AudioPoint = { x: number; y: number; z: number };',
    'export type AudioEventContext = {',
    '  emitter?: AudioPoint;',
    '  listener?: { position: AudioPoint; forward?: AudioPoint; up?: AudioPoint };',
    '  [key: string]: unknown;',
    '};',
    '',
    'export const gameAudio = createForgeaxAudioRuntime(forgeaxAudioProject);',
    '',
    '/** Opt-in bridge: post profiler snapshots to the Studio parent frame. */',
    'export function attachAudioProfilerBridge(intervalMs = 250): () => void {',
    "  if (typeof window === 'undefined' || window.parent === window) return () => undefined;",
    '  const tick = () => {',
    '    try {',
    "      window.parent.postMessage({ type: 'forgeax-audio-profiler', ...gameAudio.getProfilerSnapshot() }, '*');",
    '    } catch { /* ignore cross-origin / disposed */ }',
    '  };',
    '  const id = window.setInterval(tick, Math.max(50, intervalMs));',
    '  tick();',
    '  return () => window.clearInterval(id);',
    '}',
    '',
    ...(withListener
      ? [
        'export type { ForgeaxAudioListenerOptions };',
        '',
        '/** Call once from bootstrap(world) so 3D sounds know where the player is. */',
        'export function installForgeaxAudio(world: World, options?: ForgeaxAudioListenerOptions): void {',
        '  installForgeaxAudioListener(world, gameAudio, options);',
        '}',
        '',
      ]
      : []),
  ].join('\n');
  const files = [
    { relativePath: OUTPUT_FILES[0], content: runtimeSource },
    { relativePath: OUTPUT_FILES[1], content: generatedBindingsSource(project, pack) },
    { relativePath: OUTPUT_FILES[2], content: indexSource },
    ...(withListener ? [{ relativePath: OUTPUT_FILES[3], content: LISTENER_SOURCE }] : []),
  ];
  await atomicWriteGroup(gameDir, files);
  return {
    files: [EVENTS_PACK_FILE, ...files.map((file) => file.relativePath)],
    ...(projected.unindexed.length ? { unindexed: projected.unindexed } : {}),
  };
}
