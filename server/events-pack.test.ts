import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { normalizeAudioProject, type AudioProject } from '../shared/audio-project.ts';
import {
  AUDIO_EVENT_KIND,
  EVENTS_PACK_FILE,
  assertValidEventsPack,
  audioEventGuid,
  projectEventsPack,
  readEventsPack,
  writeEventsPack,
  type EventsPack,
} from './events-pack.ts';
import { compileAudioRuntime as compileTypedAudioRuntime } from './audio-runtime-compiler.ts';

const compileAudioRuntime = (root: string, project: Parameters<typeof compileTypedAudioRuntime>[1], javascript: string) =>
  compileTypedAudioRuntime(root, project, { javascript, declarations: 'export declare function createForgeaxAudioRuntime(project: unknown): unknown;\n' });

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempGame(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-bgm-events-pack-'));
  roots.push(root);
  await mkdir(join(root, 'assets', 'audio'), { recursive: true });
  await writeFile(join(root, 'assets/audio/confirm.mp3'), 'ID3confirm');
  return root;
}

function binding(overrides: Partial<AudioProject['bindings'][number]> = {}) {
  return {
    eventId: 'ui.confirm',
    label: '确认音',
    enabled: true,
    kind: 'sfx' as const,
    assets: [{ assetId: 'ui-ok', file: 'assets/audio/confirm.mp3', name: 'Confirm' }],
    variation: { mode: 'single' as const },
    trigger: { delayMs: 0, cooldownMs: 50, probability: 1 },
    playback: {
      volume: 0.7,
      bus: 'sfx' as const,
      spatial: '2d' as const,
      mode: 'one-shot' as const,
      fadeInMs: 0,
      fadeOutMs: 0,
    },
    conditions: [],
    ...overrides,
  };
}

function projectWith(bindings: Array<ReturnType<typeof binding>>): AudioProject {
  return normalizeAudioProject({
    schemaVersion: 'forgeax-audio-project/1',
    projectId: 'demo',
    revision: 3,
    status: 'draft',
    updatedAt: '2026-08-17T03:00:00.000Z',
    bindings,
  } as unknown as AudioProject, 'demo');
}

describe('audioEventGuid', () => {
  test('is stable per event and distinct per project', () => {
    expect(audioEventGuid('demo', 'ui.confirm')).toBe(audioEventGuid('demo', 'ui.confirm'));
    expect(audioEventGuid('demo', 'ui.cancel')).not.toBe(audioEventGuid('demo', 'ui.confirm'));
    expect(audioEventGuid('other', 'ui.confirm')).not.toBe(audioEventGuid('demo', 'ui.confirm'));
  });
});

describe('projectEventsPack', () => {
  test('emits one event asset per binding, referencing its clips by guid', async () => {
    const root = await tempGame();
    const { pack, unindexed } = await projectEventsPack(root, projectWith([binding()]));

    expect(unindexed).toEqual([]);
    expect(pack.assets).toHaveLength(1);
    const asset = pack.assets[0]!;
    expect(asset.kind).toBe(AUDIO_EVENT_KIND);
    expect(asset.guid).toBe(audioEventGuid('demo', 'ui.confirm'));
    expect(asset.name).toBe('确认音');
    expect(asset.payload.eventId).toBe('ui.confirm');
    expect(asset.payload.clips[0]).toMatchObject({
      assetId: 'ui-ok',
      file: 'assets/audio/confirm.mp3',
    });
    expect(asset.refs).toEqual([asset.payload.clips[0]!.guid]);
  });

  test('copies clip duration from the plugin sidecar into the pack', async () => {
    const root = await tempGame();
    await writeFile(join(root, 'assets/audio/confirm.mp3.forgeax-bgm.json'), JSON.stringify({
      schemaVersion: 1,
      producer: '@forgeax-extension/bgm',
      durationMs: 180,
    }));
    const { pack } = await projectEventsPack(root, projectWith([binding()]));
    expect(pack.assets[0]!.payload.clips[0]!.durationMs).toBe(180);
  });

  test('indexes a clip the plugin never generated, so events can reference it', async () => {
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([binding()]));

    const sidecar = JSON.parse(
      await readFile(join(root, 'assets/audio/confirm.mp3.meta.json'), 'utf8'),
    );
    expect(sidecar.importer).toBe('audio');
    expect(sidecar.subAssets[0].guid).toBe(pack.assets[0]!.payload.clips[0]!.guid);
    // Nothing claims the plugin produced it.
    expect(existsSync(join(root, 'assets/audio/confirm.mp3.forgeax-bgm.json'))).toBe(false);
  });

  test('gives one clip one guid however many events name it', async () => {
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([
      binding(),
      binding({ eventId: 'ui.cancel', label: '取消音', assets: [
        { assetId: 'ui-cancel', file: 'assets/audio/confirm.mp3' },
      ] }),
    ]));

    const [first, second] = pack.assets;
    expect(first!.payload.clips[0]!.guid).toBe(second!.payload.clips[0]!.guid);
    expect(first!.guid).not.toBe(second!.guid);
  });

  test('projects an event with no clips yet, so it can be filled in later', async () => {
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([
      binding({ eventId: 'ui.empty', label: '空事件', enabled: false, assets: [] }),
    ]));

    expect(pack.assets).toHaveLength(1);
    expect(pack.assets[0]!.payload.clips).toEqual([]);
    expect(pack.assets[0]!.refs).toEqual([]);
  });

  test('reports a clip it cannot index instead of emitting a dangling reference', async () => {
    const root = await tempGame();
    const { pack, unindexed } = await projectEventsPack(root, projectWith([
      binding({ assets: [{ assetId: 'gone', file: 'assets/audio/missing.mp3' }] }),
    ]));

    expect(unindexed).toHaveLength(1);
    expect(unindexed[0]!.file).toBe('assets/audio/missing.mp3');
    expect(pack.assets[0]!.refs).toEqual([]);
    expect(pack.assets[0]!.payload.clips).toEqual([]);
  });

  test('passes the engine ajv pack schema when a built pack package is available', async () => {
    const compiled = resolve(
      import.meta.dir,
      '../../../../editor/packages/engine/packages/pack/dist/schema.mjs',
    );
    if (!existsSync(compiled)) return; // needs a built engine; shape checks cover the rest
    const { validatePack } = await import(compiled) as { validatePack: (v: unknown) => boolean };
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([binding()]));
    expect(validatePack(pack)).toBe(true);
  });
});

describe('engine scan', () => {
  /**
   * The real reason the writes above are so defensive: the engine's scan is
   * fail-fast per root, so one bad descriptor empties the game's whole asset
   * library. This runs the actual scanner over what we produced.
   */
  test('accepts a game tree carrying the projection', async () => {
    const scanner = resolve(
      import.meta.dir,
      '../../../../editor/packages/engine/packages/pack/dist/scanner.mjs',
    );
    if (!existsSync(scanner)) return; // needs a built engine
    const { scan } = await import(scanner) as {
      scan: (roots: string[]) => Promise<{ ok: boolean; error?: unknown }>;
    };
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([
      binding(),
      binding({ eventId: 'ui.cancel', label: '取消音', assets: [
        { assetId: 'ui-cancel', file: 'assets/audio/confirm.mp3' },
      ] }),
    ]));
    await writeEventsPack(root, pack);

    const result = await scan([join(root, 'assets')]);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});

describe('engine catalog', () => {
  /** Acceptance: what the content browser lists for these events is `audio-event`. */
  test('lists every event as an audio-event row, empty ones included', async () => {
    const builder = resolve(
      import.meta.dir,
      '../../../../editor/packages/engine/packages/vite-plugin-pack/src/build-catalog.ts',
    );
    if (!existsSync(builder)) return; // engine sources absent in slim checkouts
    const { buildCatalogStrict } = await import(builder) as {
      buildCatalogStrict: (roots: string[]) => Promise<{
        catalog: Array<{ guid: string; kind: string; name?: string }>;
        errors: unknown[];
      }>;
    };
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([
      binding(),
      binding({ eventId: 'ui.empty', label: '空事件', enabled: false, assets: [] }),
    ]));
    await writeEventsPack(root, pack);

    const { catalog, errors } = await buildCatalogStrict([join(root, 'assets')]);
    expect(errors).toEqual([]);
    expect(catalog.filter((row) => row.kind === AUDIO_EVENT_KIND).map((row) => row.name))
      .toEqual(['确认音', '空事件']);
    // The clip is still indexed in its own right, as an audio asset.
    expect(catalog.filter((row) => row.kind === 'audio')).toHaveLength(1);
  });
});

describe('assertValidEventsPack', () => {
  const valid = (): EventsPack => ({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [{
      guid: audioEventGuid('demo', 'ui.confirm'),
      kind: AUDIO_EVENT_KIND,
      payload: {
        schemaVersion: 'forgeax-audio-event/1',
        eventId: 'ui.confirm',
        label: 'ok',
        enabled: true,
        kind: 'sfx',
        clips: [],
        variation: { mode: 'single' },
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
        playback: { volume: 1, bus: 'sfx', spatial: '2d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0 },
        conditions: [],
      },
      refs: [],
    }],
  });

  test('rejects what the engine would reject, before it reaches disk', () => {
    expect(() => assertValidEventsPack(valid())).not.toThrow();

    const duplicate = valid();
    duplicate.assets.push({ ...duplicate.assets[0]! });
    expect(() => assertValidEventsPack(duplicate)).toThrow(/duplicate event asset guid/);

    const badRef = valid();
    badRef.assets[0]!.refs = ['not-a-uuid'];
    expect(() => assertValidEventsPack(badRef)).toThrow(/ref is not a UUID/);

    const badKind = valid();
    badKind.assets[0]!.kind = 'audio' as typeof AUDIO_EVENT_KIND;
    expect(() => assertValidEventsPack(badKind)).toThrow(/kind must be/);
  });
});

describe('writeEventsPack', () => {
  test('lands at assets/audio/events.pack.json and reads back identically', async () => {
    const root = await tempGame();
    const { pack } = await projectEventsPack(root, projectWith([binding()]));
    const written = await writeEventsPack(root, pack);

    expect(written).toBe(EVENTS_PACK_FILE);
    expect(await readEventsPack(root)).toEqual(pack);
  });
});

describe('compiled runtime', () => {
  test('carries the event and clip guids the pack assigned', async () => {
    const root = await tempGame();
    const runtimeSource = 'export function createForgeaxAudioRuntime(project) { return project; }\n';
    const result = await compileAudioRuntime(root, projectWith([binding()]), runtimeSource);

    expect(result.files).toContain(EVENTS_PACK_FILE);
    const pack = await readEventsPack(root);
    const generated = await readFile(join(root, 'src/forgeax-audio/generated-bindings.ts'), 'utf8');
    expect(generated).toContain(pack.assets[0]!.guid);
    expect(generated).toContain(pack.assets[0]!.payload.clips[0]!.guid);
    // The clip is still fetched by URL; the guid is what survives a rename.
    expect(generated).toContain('new URL("../../assets/audio/confirm.mp3", import.meta.url)');
  });
});
