import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  repository?: { url?: unknown };
  publishConfig?: { access?: unknown; provenance?: unknown };
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  files?: unknown;
};
const manifest = JSON.parse(readFileSync(resolve(root, 'forgeax-extension.json'), 'utf8')) as {
  id?: unknown;
  version?: unknown;
  entry?: { frontend?: unknown; backend?: unknown };
};
const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');

describe('independent BGM release contract', () => {
  test('uses one canonical npm identity and repository', () => {
    expect(packageJson.name).toBe('@forgeax-extension/bgm');
    expect(packageJson.private).toBe(false);
    expect(packageJson.repository?.url).toBe(
      'git+https://github.com/ForgeaX-Games/forgeax-ex-bgm.git',
    );
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    expect(manifest.id).toBe(packageJson.name);
    expect(manifest.version).toBe(packageJson.version);
  });

  test('contains no local, workspace, or git dependency specs', () => {
    const forbidden = /^(?:file:|link:|workspace:|git(?:\+|:))/u;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const spec of Object.values(packageJson[field] ?? {})) {
        expect(typeof spec).toBe('string');
        expect(forbidden.test(String(spec))).toBe(false);
      }
    }
  });

  test('publishes every manifest-owned runtime surface', () => {
    expect(packageJson.files).toEqual(expect.arrayContaining([
      'dist',
      'forgeax-extension.json',
      'library',
      'runtime',
      'schemas',
      'server',
      'shared',
      'skills',
    ]));
    expect(manifest.entry?.frontend).toBe('./dist/index.html');
    expect(manifest.entry?.backend).toBe('./dist/server/tool-handlers.mjs');
    // A compiled Studio sidecar cannot resolve an extension's bare imports from
    // the filesystem. The published backend is therefore self-contained rather
    // than relying on the consumer to reproduce this repository's dev graph.
    expect(packageJson.dependencies?.typescript).toBeUndefined();
  });

  test('serves the canonical extension route', () => {
    expect(viteConfig).toContain("base: '/extensions/bgm/'");
  });
});
