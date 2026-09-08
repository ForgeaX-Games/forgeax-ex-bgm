import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(pluginDir, 'runtime/forgeax-audio-runtime.bundle.js');
const buildScript = join(pluginDir, 'scripts/build-runtime.mjs');

function buildRuntime(): string {
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: pluginDir,
    encoding: 'utf8',
    env: { ...process.env, BUN_BIN: process.env.BUN_BIN || 'bun' },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'build-runtime failed');
  }
  return result.stdout;
}

describe('runtime bundle (P0-0)', () => {
  test('builds a single ESM file with no external imports', async () => {
    buildRuntime();
    const source = await readFile(bundlePath, 'utf8');

    expect(source.startsWith('/* forgeax-audio-runtime')).toBe(true);
    expect(source).toContain('export {');
    expect(source).toContain('createForgeaxAudioRuntime');
    expect(source).toContain('mergeShaping');
    // Path comments from the bundler are fine; bare module imports are not.
    expect(source).not.toMatch(/\bfrom\s+['"][^./]/);
    expect(source).not.toMatch(/\bimport\s+['"][^./]/);
  });

  test('two consecutive builds produce identical bytes', async () => {
    buildRuntime();
    const first = await readFile(bundlePath);
    buildRuntime();
    const second = await readFile(bundlePath);
    expect(second.equals(first)).toBe(true);
  });

  test('apply-audio-project embeds the bundle, not the TypeScript sources', async () => {
    buildRuntime();
    const bundle = await readFile(bundlePath, 'utf8');
    const root = await mkdtemp(join(tmpdir(), 'forgeax-audio-bundle-'));
    try {
      const gameDir = join(root, '.forgeax/games/demo');
      await mkdir(join(gameDir, 'audio'), { recursive: true });
      await mkdir(join(gameDir, 'src'), { recursive: true });
      await writeFile(join(gameDir, 'audio/hit.wav'), 'fake');
      await writeFile(join(gameDir, 'audio/project.draft.json'), JSON.stringify({
        schemaVersion: 'forgeax-audio-project/1',
        projectId: 'demo',
        revision: 1,
        bindings: [{
          eventId: 'player.hit',
          label: 'Hit',
          enabled: true,
          kind: 'sfx',
          assets: [{ assetId: 'hit', file: 'hit.wav' }],
          variation: { mode: 'single' },
          trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
          playback: {
            volume: 1, bus: 'sfx', spatial: '2d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0,
          },
          conditions: [],
        }],
      }));

      const toolHandlers = (await import('./tool-handlers.ts')).default as Record<
        string,
        (args: unknown, ctx: unknown) => Promise<{ files: string[] }>
      >;
      const applied = await toolHandlers['apply-audio-project']!(
        { slug: 'demo', expectedRevision: 1 },
        { cwd: pluginDir, projectRoot: root, caller: { kind: 'user' } },
      );

      expect(applied.files).toEqual([
        'assets/audio/events.pack.json',
        'src/forgeax-audio/runtime.ts',
        'src/forgeax-audio/generated-bindings.ts',
        'src/forgeax-audio/index.ts',
      ]);
      const runtime = await readFile(join(gameDir, 'src/forgeax-audio/runtime.ts'), 'utf8');
      expect(runtime).toBe(bundle);
      expect(runtime).not.toContain('export interface AudioEventContext');
      const index = await readFile(join(gameDir, 'src/forgeax-audio/index.ts'), 'utf8');
      expect(index).toContain('export type AudioEventContext');
      expect(index).not.toContain("export type { AudioEventContext } from './runtime'");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
