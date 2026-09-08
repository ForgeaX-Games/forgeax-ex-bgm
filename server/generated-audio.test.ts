import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { attachGeneratedAudio, BgmError, readManifest } from './core.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function projectWithGame(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-bgm-generated-'));
  temporaryRoots.push(projectRoot);
  await mkdir(resolve(projectRoot, '.forgeax', 'games', 'demo'), { recursive: true });
  return projectRoot;
}

describe('generated audio persistence', () => {
  test('writes decoded bytes and an idempotent generated manifest entry', async () => {
    const projectRoot = await projectWithGame();
    const input = {
      projectRoot,
      slug: 'demo',
      assetId: 'generated:voice:1',
      name: '守卫警告',
      kind: 'sfx' as const,
      base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mimeType: 'audio/mpeg',
      filename: 'guard-warning.mp3',
      provider: 'litellm',
      model: 'doubao-tts',
      addedBy: 'human' as const,
    };

    const first = await attachGeneratedAudio(input);
    const second = await attachGeneratedAudio(input);
    expect(first.file).toBe('assets/audio/guard-warning.mp3');
    expect(second.reused).toBe(true);
    expect(await readFile(resolve(projectRoot, '.forgeax/games/demo', first.file)))
      .toEqual(Buffer.from([1, 2, 3, 4]));

    const manifest = JSON.parse(
      await readFile(resolve(projectRoot, '.forgeax/games/demo/audio/manifest.json'), 'utf8'),
    );
    expect(manifest.tracks).toHaveLength(1);
    expect(manifest.tracks[0]).toMatchObject({
      assetId: 'generated:voice:1',
      kind: 'sfx',
      file: 'assets/audio/guard-warning.mp3',
      source: 'generated:litellm',
      version: 'doubao-tts',
      addedBy: 'human',
    });
  });

  test('indexes the saved clip into the game asset catalog', async () => {
    const projectRoot = await projectWithGame();
    const saved = await attachGeneratedAudio({
      projectRoot,
      slug: 'demo',
      assetId: 'generated:bgm:1',
      name: '村庄白天',
      kind: 'bgm' as const,
      base64: Buffer.from('ID3village').toString('base64'),
      mimeType: 'audio/mpeg',
      filename: 'village-day.mp3',
      provider: 'seed-audio',
      model: 'seed-audio-1.0',
      prompt: '白天村庄的温暖循环背景乐',
    });

    expect(saved.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.indexWarning).toBeUndefined();

    const clip = resolve(projectRoot, '.forgeax/games/demo', saved.file);
    const sidecar = JSON.parse(await readFile(`${clip}.meta.json`, 'utf8'));
    expect(sidecar.importer).toBe('audio');
    expect(sidecar.source).toBe('village-day.mp3');
    expect(sidecar.subAssets[0].guid).toBe(saved.guid);

    const provenance = JSON.parse(await readFile(`${clip}.forgeax-bgm.json`, 'utf8'));
    expect(provenance.provider).toBe('seed-audio');
    expect(provenance.prompt).toBe('白天村庄的温暖循环背景乐');

    const manifest = await readManifest(projectRoot, 'demo');
    expect(manifest.tracks[0]!.guid).toBe(saved.guid);
  });

  test('persists optional shaping on the generated manifest track', async () => {
    const projectRoot = await projectWithGame();
    const shaping = {
      gainDb: 2,
      pitchSemitones: -1,
      highpassHz: 80,
      lowpassHz: 12_000,
      eqLowDb: 1,
      eqMidDb: 0,
      eqHighDb: -2,
    };
    await attachGeneratedAudio({
      projectRoot,
      slug: 'demo',
      assetId: 'generated:sfx:shaped',
      name: '命中',
      kind: 'sfx',
      base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mimeType: 'audio/wav',
      filename: 'hit.wav',
      shaping,
      addedBy: 'human',
    });
    const manifest = JSON.parse(
      await readFile(resolve(projectRoot, '.forgeax/games/demo/audio/manifest.json'), 'utf8'),
    );
    expect(manifest.tracks[0].shaping).toMatchObject(shaping);
  });

  test('avoids colliding with a historical audio/generated filename', async () => {
    const projectRoot = await projectWithGame();
    const game = resolve(projectRoot, '.forgeax/games/demo');
    await mkdir(resolve(game, 'audio'), { recursive: true });
    await writeFile(resolve(game, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [{
        assetId: 'legacy',
        name: 'old',
        kind: 'sfx',
        file: 'audio/generated/guard-warning.mp3',
        version: '1',
        source: 'generated:api',
        addedBy: 'human',
        addedAt: '2026-08-01T00:00:00.000Z',
      }],
    }));

    const result = await attachGeneratedAudio({
      projectRoot,
      slug: 'demo',
      assetId: 'generated:voice:1',
      name: '守卫警告',
      kind: 'sfx',
      base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
      mimeType: 'audio/mpeg',
      filename: 'guard-warning.mp3',
    });

    expect(result.file).not.toBe('assets/audio/guard-warning.mp3');
    expect(result.file).toStartWith('assets/audio/');
  });

  test('reads a manifest that mixes legacy audio/ paths and new assets/audio paths', async () => {
    const projectRoot = await projectWithGame();
    const game = resolve(projectRoot, '.forgeax/games/demo');
    await mkdir(resolve(game, 'audio'), { recursive: true });
    await writeFile(resolve(game, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [
        { assetId: 'old', name: 'hit', kind: 'sfx', file: 'audio/hit.wav', version: '1', source: 'human', addedBy: 'human', addedAt: '2026-08-01T00:00:00.000Z' },
        { assetId: 'fresh', name: 'fresh', kind: 'sfx', file: 'assets/audio/fresh.mp3', version: '1', source: 'generated:api', addedBy: 'human', addedAt: '2026-08-17T00:00:00.000Z' },
      ],
    }));

    const manifest = await readManifest(projectRoot, 'demo');
    expect(manifest.tracks.map((track) => track.file)).toEqual([
      'audio/hit.wav',
      'assets/audio/fresh.mp3',
    ]);
  });

  test('rejects a manifest file that escapes the allowed audio directories', async () => {
    const projectRoot = await projectWithGame();
    const game = resolve(projectRoot, '.forgeax/games/demo');
    await mkdir(resolve(game, 'audio'), { recursive: true });
    await writeFile(resolve(game, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [
        { assetId: 'escape', name: 'bad', kind: 'sfx', file: '../secret.wav', version: '1', source: 'human', addedBy: 'human', addedAt: '2026-08-01T00:00:00.000Z' },
      ],
    }));

    await expect(readManifest(projectRoot, 'demo')).rejects.toMatchObject({
      code: 'manifest-invalid',
    });
  });

  test('rejects invalid base64 before creating audio files', async () => {
    const projectRoot = await projectWithGame();
    await expect(attachGeneratedAudio({
      projectRoot,
      slug: 'demo',
      assetId: 'generated:bad',
      name: 'bad',
      kind: 'sfx',
      base64: 'not base64!',
    })).rejects.toMatchObject<BgmError>({ code: 'invalid-audio-data' });
  });

  test('measures WAV duration on attach and warns when a pickup is too long', async () => {
    const { encodeSilenceWav } = await import('./audio-duration.ts');
    const projectRoot = await projectWithGame();
    const short = await attachGeneratedAudio({
      projectRoot,
      slug: 'demo',
      assetId: 'hit-short',
      name: '命中',
      kind: 'sfx',
      eventId: 'combat.hit',
      base64: encodeSilenceWav({ durationMs: 180 }).toString('base64'),
      mimeType: 'audio/wav',
      filename: 'hit.wav',
    });
    expect(short.durationMs).toBe(180);
    expect(short.durationWarning).toBeUndefined();

    const long = await attachGeneratedAudio({
      projectRoot,
      slug: 'demo',
      assetId: 'pickup-long',
      name: '拾取',
      kind: 'sfx',
      eventId: 'item.pickup',
      base64: encodeSilenceWav({ durationMs: 2900 }).toString('base64'),
      mimeType: 'audio/wav',
      filename: 'pickup.wav',
    });
    expect(long.durationMs).toBe(2900);
    expect(long.durationWarning).toMatch(/1500ms/);
    const sidecar = JSON.parse(await readFile(
      resolve(projectRoot, '.forgeax/games/demo', `${long.file}.forgeax-bgm.json`),
      'utf8',
    ));
    expect(sidecar.durationMs).toBe(2900);
  });
});
