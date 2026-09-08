import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ENGINE_SIDECAR_SUFFIX,
  PLUGIN_SIDECAR_SUFFIX,
  assertValidEngineAudioSidecar,
  buildEngineAudioSidecar,
  generatedAudioGuid,
  removeGeneratedAudioSidecars,
  writeGeneratedAudioSidecars,
} from './asset-sidecar.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A clip on disk plus the arguments needed to describe it. */
async function stageClip(name = 'guard-warning.mp3') {
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-bgm-sidecar-'));
  const audioDir = resolve(dir, 'assets', 'audio');
  await mkdir(audioDir, { recursive: true });
  const audioFile = resolve(audioDir, name);
  const bytes = Buffer.from('ID3fake-audio-bytes');
  await writeFile(audioFile, bytes);
  return {
    audioFile,
    input: {
      audioFile,
      gameFile: `assets/audio/${name}`,
      slug: 'demo',
      assetId: 'guard-warning',
      name: '守卫警戒',
      kind: 'voice' as const,
      bytes,
      mimeType: 'audio/mpeg',
      provider: 'seed-audio',
      model: 'seed-audio-1.0',
      prompt: '守卫发现玩家时的警戒喊话',
    },
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
}

describe('generatedAudioGuid', () => {
  test('is a v5-shaped RFC-4122 uuid', () => {
    const guid = generatedAudioGuid('demo', 'guard-warning');
    expect(guid).toMatch(UUID_RE);
    expect(guid[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(guid[19]!);
  });

  test('is stable for the same asset so bindings survive a re-roll', () => {
    expect(generatedAudioGuid('demo', 'guard-warning'))
      .toBe(generatedAudioGuid('demo', 'guard-warning'));
  });

  test('differs per asset and per game, since a collision fails the whole scan', () => {
    const a = generatedAudioGuid('demo', 'guard-warning');
    expect(generatedAudioGuid('demo', 'guard-alert')).not.toBe(a);
    expect(generatedAudioGuid('other', 'guard-warning')).not.toBe(a);
  });
});

describe('engine sidecar shape', () => {
  test('matches the field set of a real engine-authored audio sidecar', async () => {
    const fixture = resolve(
      import.meta.dir,
      '../../../../editor/packages/engine/forgeax-engine-assets/learn-opengl/audio/bleep.mp3.meta.json',
    );
    if (!existsSync(fixture)) return; // engine assets are optional in slim checkouts
    const reference = await readJson(fixture);
    const ours = buildEngineAudioSidecar({ source: 'bleep.mp3', guid: generatedAudioGuid('demo', 'x') });

    expect(Object.keys(ours).sort()).toEqual(Object.keys(reference).sort());
    expect(ours.schemaVersion).toBe(reference.schemaVersion as '1.0.0');
    expect(ours.kind).toBe(reference.kind as 'external-asset-package');
    expect(ours.importer).toBe(reference.importer as 'audio');
    const referenceSub = (reference.subAssets as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(ours.subAssets[0]!).sort()).toEqual(Object.keys(referenceSub).sort());
  });

  test('passes the engine ajv schema when a built pack package is available', async () => {
    const compiled = resolve(
      import.meta.dir,
      '../../../../editor/packages/engine/packages/pack/dist/schema.mjs',
    );
    if (!existsSync(compiled)) return; // needs a built engine; covered by shape checks otherwise
    const { validateMeta } = await import(compiled) as { validateMeta: (v: unknown) => boolean };
    const sidecar = buildEngineAudioSidecar({
      source: 'guard-warning.mp3',
      guid: generatedAudioGuid('demo', 'guard-warning'),
      name: '守卫警戒',
    });
    expect(validateMeta(sidecar)).toBe(true);
  });

  test('rejects anything it cannot vouch for before it reaches disk', () => {
    const good = buildEngineAudioSidecar({ source: 'a.mp3', guid: generatedAudioGuid('demo', 'a') });
    expect(() => assertValidEngineAudioSidecar(good)).not.toThrow();
    expect(() => assertValidEngineAudioSidecar({ ...good, subAssets: [] })).toThrow(/at least one subAsset/);
    expect(() => assertValidEngineAudioSidecar({
      ...good,
      subAssets: [{ ...good.subAssets[0]!, guid: 'not-a-uuid' }],
    })).toThrow(/not a UUID/);
    expect(() => assertValidEngineAudioSidecar({ ...good, source: 'audio/a.mp3' }))
      .toThrow(/bare filename/);
  });
});

describe('writeGeneratedAudioSidecars', () => {
  test('indexes the clip and records provenance next to it', async () => {
    const { audioFile, input } = await stageClip();
    const result = await writeGeneratedAudioSidecars(input);

    expect(result.indexed).toBe(true);
    expect(result.guid).toBe(generatedAudioGuid('demo', 'guard-warning'));

    const engine = await readJson(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`);
    expect(engine.importer).toBe('audio');
    expect(engine.source).toBe('guard-warning.mp3');
    expect((engine.subAssets as Array<Record<string, unknown>>)[0]!.guid).toBe(result.guid);

    const provenance = await readJson(`${audioFile}${PLUGIN_SIDECAR_SUFFIX}`);
    expect(provenance.producer).toBe('@forgeax-extension/bgm');
    expect(provenance.assetId).toBe('guard-warning');
    expect(provenance.kind).toBe('voice');
    expect(provenance.provider).toBe('seed-audio');
    expect(provenance.prompt).toBe('守卫发现玩家时的警戒喊话');
    expect(provenance.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(provenance.sizeBytes).toBe(input.bytes.byteLength);
  });

  test('records measured duration when the caller already knows it', async () => {
    const { audioFile, input } = await stageClip();
    await writeGeneratedAudioSidecars({ ...input, durationMs: 240 });
    const provenance = await readJson(`${audioFile}${PLUGIN_SIDECAR_SUFFIX}`);
    expect(provenance.durationMs).toBe(240);
  });

  test('refuses to describe a missing file, which would orphan the sidecar', async () => {
    const { input } = await stageClip();
    await expect(writeGeneratedAudioSidecars({ ...input, audioFile: `${input.audioFile}.gone` }))
      .rejects.toThrow(/missing audio file/);
  });

  test('keeps an existing audio guid so catalog references stay valid', async () => {
    const { audioFile, input } = await stageClip();
    const inherited = '201222ef-ccf4-4538-96ce-14a96ecc993d';
    await writeFile(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`, JSON.stringify(
      buildEngineAudioSidecar({ source: 'guard-warning.mp3', guid: inherited }),
    ));

    const result = await writeGeneratedAudioSidecars(input);
    expect(result.guid).toBe(inherited);
    expect(result.indexed).toBe(true);
  });

  test('leaves a sidecar owned by another importer untouched', async () => {
    const { audioFile, input } = await stageClip();
    const foreign = {
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'texture',
      source: 'guard-warning.mp3',
      importSettings: {},
      subAssets: [{ guid: '201222ef-ccf4-4538-96ce-14a96ecc993d', sourceIndex: 0, kind: 'texture' }],
    };
    await writeFile(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`, JSON.stringify(foreign));

    const result = await writeGeneratedAudioSidecars(input);
    expect(result.indexed).toBe(false);
    expect(result.guid).toBeNull();
    expect(result.skippedReason).toContain('texture');
    expect(await readJson(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`)).toEqual(foreign);
    expect(existsSync(`${audioFile}${PLUGIN_SIDECAR_SUFFIX}`)).toBe(false);
  });

  test('replaces a corrupt sidecar, which would otherwise fail the scan', async () => {
    const { audioFile, input } = await stageClip();
    await writeFile(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`, '{ this is not json');

    const result = await writeGeneratedAudioSidecars(input);
    expect(result.indexed).toBe(true);
    expect((await readJson(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`)).importer).toBe('audio');
  });

  test('removes both sidecars together', async () => {
    const { audioFile, input } = await stageClip();
    await writeGeneratedAudioSidecars(input);
    await removeGeneratedAudioSidecars(audioFile);
    expect(existsSync(`${audioFile}${ENGINE_SIDECAR_SUFFIX}`)).toBe(false);
    expect(existsSync(`${audioFile}${PLUGIN_SIDECAR_SUFFIX}`)).toBe(false);
  });
});
