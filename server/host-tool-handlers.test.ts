import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import source from './tool-handlers.ts';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

for (const packaged of [false, true]) {
  describe(packaged ? 'packaged Host backend' : 'source Host backend', () => {
    test('dispatches declared tools and shares draft/apply state with the direct API', async () => {
      let backend = source;
      if (packaged) {
        const build = Bun.spawnSync([process.execPath, 'scripts/build-server.mjs'], { cwd: pluginDir });
        expect(build.exitCode, build.stderr.toString()).toBe(0);
        const manifest = JSON.parse(await readFile(join(pluginDir, 'forgeax-extension.json'), 'utf8'));
        backend = (await import(pathToFileURL(join(pluginDir, manifest.entry.backend)).href)).default;
      }
      const manifest = JSON.parse(await readFile(join(pluginDir, 'forgeax-extension.json'), 'utf8'));
      for (const tool of manifest.contributes.tools) {
        expect(typeof backend.tools?.[tool.id], tool.id).toBe('function');
        expect(typeof (backend as any)[tool.id], tool.id).toBe('function');
      }

      const projectRoot = await mkdtemp(join(tmpdir(), 'bgm-host-tools-'));
      roots.push(projectRoot);
      const gameDir = join(projectRoot, '.forgeax/games/demo');
      await mkdir(join(gameDir, 'src'), { recursive: true });
      const host = { gameId: 'demo', gameRoot: gameDir };
      const direct = { caller: { kind: 'ai' }, toolId: 'test', cwd: pluginDir, projectRoot, game: 'demo', env: {} };
      // Host uses context first; omitting slug must select its active game.
      const initial = await backend.tools['get-audio-project']!(host, {}) as any;
      expect(initial.gameDir).toBe(gameDir);
      expect(initial.project).toMatchObject({ projectId: 'demo', revision: 0 });
      await backend.tools['patch-audio-project']!(host, { expectedRevision: 0, upsertBindings: [] });
      const visible = await backend['get-audio-project']({}, direct);
      expect(visible.project.revision).toBe(1);
      // Applying an empty draft still reads the shipped runtime from the plugin root.
      const applied = await backend.tools['apply-audio-project']!(host, { expectedRevision: 1 }) as any;
      expect(applied.project).toMatchObject({ revision: 1, status: 'applied' });
      expect(await readFile(join(gameDir, 'src/forgeax-audio/runtime-impl.js'), 'utf8'))
        .toBe(await readFile(join(pluginDir, 'runtime/forgeax-audio-runtime.bundle.js'), 'utf8'));
      await expect(backend.tools['patch-audio-project']!(host, { expectedRevision: 0, upsertBindings: [] }) as Promise<unknown>)
        .rejects.toMatchObject({ code: 'revision_conflict' });
    });
  });
}
