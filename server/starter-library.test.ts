import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import toolHandlers from './tool-handlers.ts';
import { HIGH_FREQUENCY_DURATION_WARN_MS } from './audio-duration.ts';
import { listStarterAudio, readStarterClip } from './starter-library.ts';
import type { StarterEntry } from '../shared/starter-library.ts';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-starter-'));
  roots.push(projectRoot);
  await mkdir(join(projectRoot, '.forgeax/games/demo/audio'), { recursive: true });
  return projectRoot;
}

function context(projectRoot: string, kind: 'ai' | 'user' = 'ai') {
  return {
    caller: { kind },
    toolId: 'test',
    env: { FORGEAX_PROJECT_ROOT: projectRoot },
    cwd: pluginDir,
    projectRoot,
    game: 'demo',
  };
}

const handlers = toolHandlers as Record<string, (args: any, ctx: any) => Promise<any>>;

describe('packaged starter library', () => {
  test('every catalog entry points at real bytes and carries what a pick needs', async () => {
    const entries = await listStarterAudio(pluginDir);
    expect(entries.length).toBeGreaterThanOrEqual(130);

    const ids = new Set<string>();
    const files = new Set<string>();
    for (const entry of entries) {
      expect(ids.has(entry.id)).toBe(false);
      expect(files.has(entry.file)).toBe(false);
      ids.add(entry.id);
      files.add(entry.file);

      // No UI reads this catalog, so the index text is the Agent's only way to
      // tell a 200ms click from a three-minute forest bed.
      expect(entry.usage.length).toBeGreaterThan(0);
      expect(entry.durationMs).toBeGreaterThan(0);
      expect(entry.file.startsWith(`${entry.kind}/`)).toBe(true);
      expect(entry.file).not.toContain('..');
      const info = await stat(join(pluginDir, 'library/starter', entry.file));
      expect(info.size).toBe(entry.bytes as number);
    }
  });

  test('flags which clips may sit on events that fire constantly', async () => {
    const sfx = await listStarterAudio(pluginDir, { kind: 'sfx' });
    for (const entry of sfx) {
      expect(entry.highFrequencySafe).toBe((entry.durationMs as number) <= HIGH_FREQUENCY_DURATION_WARN_MS);
      // An ambience bed is a scene loop; a long tail is still a one-shot.
      if (entry.ambient) expect(entry.loop).toBe(true);
    }
    const filtered = await listStarterAudio(pluginDir, { kind: 'sfx', highFrequencyOnly: true });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(sfx.length);
    expect(filtered.every((entry) => entry.highFrequencySafe === true)).toBe(true);
    expect(filtered.some((entry) => entry.ambient)).toBe(false);
  });

  test('bgm ships as loopable beds so a 32-second track does not just stop', async () => {
    const bgm = await listStarterAudio(pluginDir, { kind: 'bgm' });
    expect(bgm.length).toBeGreaterThanOrEqual(30);
    expect(bgm.every((entry) => entry.loop === true)).toBe(true);
    // Ogg has no bitrate header to guess from; measuring it is what makes these
    // durations real instead of absent.
    expect(bgm.every((entry) => (entry.durationMs as number) >= 30_000)).toBe(true);
  });

  test('refuses an id that is not in the catalog instead of guessing a file', async () => {
    await expect(readStarterClip(pluginDir, 'sfx/ui/does-not-exist')).rejects.toThrow(/no starter clip/);
    await expect(readStarterClip(pluginDir, '../../../etc/passwd')).rejects.toThrow(/no starter clip/);
    await expect(readStarterClip(pluginDir, '')).rejects.toThrow(/no starter clip/);
  });
});

describe('list-starter-audio', () => {
  test('lists without touching the game and points at the copy step', async () => {
    const projectRoot = await fixture();
    const result = await handlers['list-starter-audio']!({}, context(projectRoot));

    expect(result.total).toBe(result.entries.length);
    expect(result.nextStep).toContain('use-starter-audio');
    expect(result.nextStep).toContain('generate-audio-assets');
    // Listing is not attaching: nothing may appear in the game from a read.
    expect(await Bun.file(join(projectRoot, '.forgeax/games/demo/audio/manifest.json')).exists()).toBe(false);
  });

  test('narrows to one kind so a BGM request does not scroll past 100 one-shots', async () => {
    const projectRoot = await fixture();
    const result = await handlers['list-starter-audio']!({ kind: 'bgm' }, context(projectRoot));
    expect(result.entries.every((entry: StarterEntry) => entry.kind === 'bgm')).toBe(true);
  });
});

describe('use-starter-audio', () => {
  test('copies picks into the game and hands back the same receipts as generation', async () => {
    const projectRoot = await fixture();
    const catalog = await listStarterAudio(pluginDir, { kind: 'sfx', highFrequencyOnly: true });
    const click = catalog.find((entry) => entry.category === 'ui')!;
    const bgm = (await listStarterAudio(pluginDir, { kind: 'bgm' }))[0]!;

    const result = await handlers['use-starter-audio']!({
      slug: 'demo',
      items: [
        { eventId: 'ui.click', starterId: click.id },
        { eventId: 'bgm.main', starterId: bgm.id },
      ],
    }, context(projectRoot));

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ total: 2, applied: 2, failed: 0 });
    expect(result.gameDir).toBe(join(projectRoot, '.forgeax/games/demo'));
    expect(result.nextStep).toContain('patch-audio-project');

    for (const entry of result.results) {
      expect(entry.ok).toBe(true);
      expect(entry.file.startsWith('assets/audio/')).toBe(true);
      expect(entry.durationMs).toBeGreaterThan(0);
      // Nothing may play out of the plugin directory.
      expect(entry.file).not.toContain('library/starter');
      const written = await stat(join(projectRoot, '.forgeax/games/demo', entry.file));
      expect(written.size).toBe(entry.bytes);
    }

    const manifest = JSON.parse(
      await readFile(join(projectRoot, '.forgeax/games/demo/audio/manifest.json'), 'utf8'),
    ) as { tracks: Array<{ assetId: string; kind: string; source: string; file: string }> };
    expect(manifest.tracks).toHaveLength(2);
    expect(manifest.tracks.every((track) => track.source.includes('starter'))).toBe(true);
    expect(manifest.tracks.map((track) => track.kind).sort()).toEqual(['bgm', 'sfx']);
  });

  test('re-picking the same clip is idempotent rather than a second copy', async () => {
    const projectRoot = await fixture();
    const click = (await listStarterAudio(pluginDir, { kind: 'sfx', highFrequencyOnly: true }))[0]!;
    const args = { slug: 'demo', items: [{ eventId: 'ui.click', starterId: click.id }] };

    const first = await handlers['use-starter-audio']!(args, context(projectRoot));
    const second = await handlers['use-starter-audio']!(args, context(projectRoot));

    expect(second.results[0].assetId).toBe(first.results[0].assetId);
    expect(second.results[0].file).toBe(first.results[0].file);
    expect(second.results[0].reused).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(projectRoot, '.forgeax/games/demo/audio/manifest.json'), 'utf8'),
    ) as { tracks: unknown[] };
    expect(manifest.tracks).toHaveLength(1);
  });

  test('warns when a long clip lands on an event that fires constantly', async () => {
    const projectRoot = await fixture();
    const bed = (await listStarterAudio(pluginDir, { kind: 'sfx' })).find((entry) => entry.ambient)!;

    const result = await handlers['use-starter-audio']!({
      slug: 'demo',
      items: [{ eventId: 'combat.hit', starterId: bed.id }],
    }, context(projectRoot));

    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].durationWarning).toContain('high-frequency');
    expect(result.nextStep).toContain('highFrequencySafe: true');
    expect(result.nextStep).toContain('combat.hit');
  });

  test('keeps the good picks when one id is wrong', async () => {
    const projectRoot = await fixture();
    const click = (await listStarterAudio(pluginDir, { kind: 'sfx', highFrequencyOnly: true }))[0]!;

    const result = await handlers['use-starter-audio']!({
      slug: 'demo',
      items: [
        { eventId: 'ui.click', starterId: click.id },
        { eventId: 'ui.hover', starterId: 'sfx/ui/invented-by-the-model' },
      ],
    }, context(projectRoot));

    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({ total: 2, applied: 1, failed: 1 });
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1]).toMatchObject({ ok: false, code: 'unknown-starter-id' });
    expect(result.nextStep).toContain('ui.hover');
  });

  test('rejects an empty batch instead of writing nothing quietly', async () => {
    const projectRoot = await fixture();
    await expect(handlers['use-starter-audio']!({ slug: 'demo', items: [] }, context(projectRoot)))
      .rejects.toThrow(/at least one starter pick/);
  });
});

describe('starter library stays a pick-list, not an authoring surface', () => {
  test('is reachable by the audio specialist, excluded from the default agent, and absent from the UI', async () => {
    type DeclaredTool = { id: string; exposedToAI?: boolean; defaultAgentAllow?: boolean; pinned?: boolean };
    const manifest = JSON.parse(await readFile(join(pluginDir, 'forgeax-extension.json'), 'utf8')) as {
      provides?: { tools?: DeclaredTool[] };
      contributes?: { tools?: DeclaredTool[] };
    };
    // 清单正在从 provides 迁到 contributes。两代都读，同一套验收才能同时守住迁移前后。
    const declared = manifest.contributes?.tools ?? manifest.provides?.tools ?? [];
    expect(declared.length).toBeGreaterThan(0);
    const tools = Object.fromEntries(declared.map((tool) => [tool.id, tool]));

    for (const id of ['list-starter-audio', 'use-starter-audio']) {
      expect(tools[id]?.exposedToAI).toBe(true);
      expect(tools[id]?.defaultAgentAllow).toBeUndefined();
    }
    // Copying into the game is the step that must survive a trimmed tool array.
    expect(tools['use-starter-audio']?.pinned).toBe(true);

    // Retired library search must not come back under a new name.
    for (const id of Object.keys(tools)) expect(id.startsWith('search-')).toBe(false);

    const html = await readFile(join(pluginDir, 'index.html'), 'utf8');
    expect(html).not.toContain('starter');
    expect(html).not.toContain('library/starter');
  });
});
