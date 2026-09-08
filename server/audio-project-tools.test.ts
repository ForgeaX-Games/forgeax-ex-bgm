import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import toolHandlers from './tool-handlers.ts';

const roots: string[] = [];
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ projectRoot: string; gameDir: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-audio-tools-'));
  roots.push(projectRoot);
  const gameDir = join(projectRoot, '.forgeax/games/demo');
  await mkdir(join(gameDir, 'audio'), { recursive: true });
  await mkdir(join(gameDir, 'src'), { recursive: true });
  return { projectRoot, gameDir };
}

function context(projectRoot: string, kind: 'ai' | 'user') {
  return {
    caller: { kind },
    toolId: 'test',
    env: { FORGEAX_PROJECT_ROOT: projectRoot },
    cwd: pluginDir,
    projectRoot,
    game: 'demo',
  };
}

const editableBinding = {
  eventId: 'combat.hit',
  label: '命中',
  enabled: true,
  kind: 'sfx',
  assets: [{ assetId: 'hit', file: 'audio/hit.wav' }],
  variation: { mode: 'random-no-repeat' },
  trigger: { delayMs: 20, cooldownMs: 100, probability: 0.9 },
  playback: {
    volume: 0.8,
    bus: 'sfx',
    spatial: '3d',
    mode: 'one-shot',
    fadeInMs: 0,
    fadeOutMs: 50,
  },
  conditions: [{ field: 'damage', operator: 'gte', value: 10 }],
};

describe('shared audio project plugin tools', () => {
  test('publishes audio operations to the specialist, excludes the default agent, and only gates migration', async () => {
    type DeclaredTool = {
      id: string;
      exposedToAI?: boolean;
      defaultAgentAllow?: boolean;
      pinned?: boolean;
      requireConfirm?: string;
      confirmMessage?: unknown;
    };
    const manifest = JSON.parse(await readFile(join(pluginDir, 'forgeax-extension.json'), 'utf8')) as {
      provides?: { tools?: DeclaredTool[] };
      contributes?: { tools?: DeclaredTool[] };
    };
    // 清单正在从 provides 迁到 contributes。两代都读，同一套验收才能同时守住迁移前后。
    const declared = manifest.contributes?.tools ?? manifest.provides?.tools ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const descriptors = Object.fromEntries(declared.map((tool) => [tool.id, tool]));

    for (const id of [
      'get-audio-project',
      'patch-audio-project',
      'apply-audio-project',
      'verify-audio-project',
      'generate-audio-assets',
      'migrate-audio-project',
      'define-game-sync',
      'define-bus',
      'define-attenuation',
      'author-music',
    ]) {
      expect(descriptors[id]?.exposedToAI).toBe(true);
    }

    for (const id of [
      'generate-audio-assets',
      'get-audio-project',
      'patch-audio-project',
      'apply-audio-project',
      'verify-audio-project',
    ]) {
      expect(descriptors[id]?.defaultAgentAllow).toBeUndefined();
      expect(descriptors[id]?.pinned).toBe(true);
    }

    // Discovery is the agent's job of reading gameplay code. This scanner only
    // finds emits that already exist, so exposing it as a tool wastes a slot
    // and sends new games down an empty-result dead end. verify still imports
    // the function directly.
    expect(descriptors['inspect-audio-events']?.exposedToAI).toBe(false);

    // Generating and applying must run unattended: the gate blocks inside
    // ToolRegistry and fails the call after 30s, so a one-instruction audio pass
    // would die halfway whenever nobody is watching the chat. Both stay
    // recoverable without a prompt — generation is idempotent per assetId, and
    // apply only rewrites the plugin's own `src/forgeax-audio/` output.
    for (const id of ['apply-audio-project', 'generate-audio-assets']) {
      expect(descriptors[id]?.requireConfirm).toBeUndefined();
    }

    // Still gated: the v1→v2 rewrite is the one draft change with no inverse.
    expect(descriptors['migrate-audio-project']?.requireConfirm).toBe('always');
    expect(descriptors['migrate-audio-project']?.confirmMessage).toBeTruthy();

    for (const id of ['define-game-sync', 'define-bus', 'define-attenuation', 'author-music']) {
      expect(descriptors[id]?.requireConfirm).toBeUndefined();
    }
  });

  test('lets AI create a draft that the user reads and protects it from stale edits', async () => {
    const { projectRoot } = await fixture();
    const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;

    const empty = await handlers['get-audio-project']!({ slug: 'demo' }, context(projectRoot, 'user'));
    expect(empty.project.revision).toBe(0);
    // Pins which copy of the game to read and write when a same-named one sits elsewhere.
    expect(empty.gameDir).toBe(join(projectRoot, '.forgeax/games/demo'));

    const patched = await handlers['patch-audio-project']!({
      slug: 'demo',
      expectedRevision: 0,
      upsertBindings: [editableBinding],
      removeEventIds: [],
    }, context(projectRoot, 'ai'));
    expect(patched.project.revision).toBe(1);

    const visibleToUser = await handlers['get-audio-project']!({ slug: 'demo' }, context(projectRoot, 'user'));
    expect(visibleToUser.project.bindings[0]).toMatchObject(editableBinding);

    await expect(handlers['patch-audio-project']!({
      slug: 'demo',
      expectedRevision: 0,
      removeEventIds: ['combat.hit'],
    }, context(projectRoot, 'user'))).rejects.toMatchObject({ code: 'revision_conflict', actualRevision: 1 });
  });

  test('inspects without writing and applies the expected draft into generated game files', async () => {
    const { projectRoot, gameDir } = await fixture();
    const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;
    await writeFile(join(gameDir, 'audio/hit.wav'), 'RIFF');
    await writeFile(join(gameDir, 'src/combat.ts'), "EventBus.instance.emit('combat:attack_hit', data);");

    const inspection = await handlers['inspect-audio-events']!({ slug: 'demo' }, context(projectRoot, 'ai'));
    expect(inspection.candidates).toEqual([
      expect.objectContaining({ eventId: 'combat:attack_hit', file: 'src/combat.ts', line: 1 }),
    ]);
    await expect(readFile(join(gameDir, 'audio/project.draft.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await handlers['patch-audio-project']!({
      slug: 'demo',
      expectedRevision: 0,
      upsertBindings: [editableBinding],
    }, context(projectRoot, 'ai'));
    const applied = await handlers['apply-audio-project']!({
      slug: 'demo',
      expectedRevision: 1,
    }, context(projectRoot, 'user'));

    expect(applied.project).toMatchObject({ revision: 1, status: 'applied' });
    expect(applied.files).toEqual([
      'assets/audio/events.pack.json',
      'src/forgeax-audio/runtime.ts',
      'src/forgeax-audio/generated-bindings.ts',
      'src/forgeax-audio/index.ts',
    ]);
    expect(JSON.parse(await readFile(join(gameDir, 'audio/project.json'), 'utf8'))).toMatchObject({
      revision: 1,
      status: 'applied',
    });
  });

  test('verifies applied instrumentation and preserves the previous applied project on invalid re-apply', async () => {
    const { projectRoot, gameDir } = await fixture();
    const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;
    await writeFile(join(gameDir, 'audio/hit.wav'), 'RIFF');
    await writeFile(join(gameDir, 'src/combat.ts'), "gameAudio.emit('combat.hit', { damage: 20 });");
    await handlers['patch-audio-project']!({
      slug: 'demo', expectedRevision: 0, upsertBindings: [editableBinding],
    }, context(projectRoot, 'ai'));
    await handlers['apply-audio-project']!({ slug: 'demo', expectedRevision: 1 }, context(projectRoot, 'user'));

    const verified = await handlers['verify-audio-project']!({ slug: 'demo' }, context(projectRoot, 'ai'));
    expect(verified).toMatchObject({ ok: true, instrumentedEventIds: ['combat.hit'] });

    const before = await readFile(join(gameDir, 'audio/project.json'), 'utf8');
    await handlers['patch-audio-project']!({
      slug: 'demo',
      expectedRevision: 1,
      upsertBindings: [{ ...editableBinding, assets: [{ assetId: 'missing', file: 'missing.wav' }] }],
    }, context(projectRoot, 'user'));
    await expect(handlers['apply-audio-project']!({
      slug: 'demo', expectedRevision: 2,
    }, context(projectRoot, 'user'))).rejects.toMatchObject({ code: 'asset_missing' });
    expect(await readFile(join(gameDir, 'audio/project.json'), 'utf8')).toBe(before);
  });

  test('fills archetype defaults and warns when a 2D multi-instance event keeps a cooldown', async () => {
    const { projectRoot } = await fixture();
    const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;

    const filled = await handlers['patch-audio-project']!({
      slug: 'demo',
      expectedRevision: 0,
      upsertBindings: [{
        eventId: 'weapon.fire',
        kind: 'sfx',
        assets: [{ assetId: 'shot', file: 'audio/shot.wav' }],
      }],
    }, context(projectRoot, 'ai'));
    expect(filled.warnings).toEqual([]);
    expect(filled.project.bindings[0]?.trigger.cooldownMs).toBe(0);
    expect(filled.project.bindings[0]?.playback).toMatchObject({
      volume: 0.5,
      spatial: '3d',
      mode: 'one-shot',
    });
    expect(filled.project.bindings[0]?.trigger.rhythmLockMs).toBeUndefined();

    const warned = await handlers['patch-audio-project']!({
      slug: 'demo',
      expectedRevision: 1,
      upsertBindings: [{
        eventId: 'item.pickup',
        kind: 'sfx',
        assets: [{ assetId: 'pick', file: 'audio/pick.wav' }],
        trigger: { delayMs: 0, cooldownMs: 200, probability: 1 },
        playback: {
          volume: 0.22, bus: 'sfx', spatial: '2d', mode: 'one-shot', fadeInMs: 0, fadeOutMs: 0,
        },
      }],
    }, context(projectRoot, 'ai'));
    expect(warned.warnings).toEqual([
      expect.objectContaining({ code: 'cooldown_needs_game_object', eventId: 'item.pickup' }),
    ]);
  });
});
