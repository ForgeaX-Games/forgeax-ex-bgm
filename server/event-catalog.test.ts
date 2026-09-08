import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { isSafeAudioEventId } from '../shared/audio-project.ts';
import {
  EVENT_GENRES,
  bindingFromPreset,
  customPreset,
  findPreset,
  presetsFor,
  wireIntoGamePrompt,
} from '../src/eventCatalog.ts';
import { patchAudioProject } from './audio-project-store.ts';
import { verifyAudioProject } from './audio-project-verify.ts';
import { AUDIO_EVENT_KIND, projectEventsPack, writeEventsPack } from './events-pack.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function blankGame(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-bgm-catalog-'));
  roots.push(root);
  await mkdir(join(root, 'audio'), { recursive: true });
  return root;
}

describe('preset catalog', () => {
  test('covers the four genres the requirement names, plus shared basics', () => {
    expect(EVENT_GENRES.map((group) => group.id))
      .toEqual(['common', 'shooter', 'platformer', 'puzzle', 'casual']);
  });

  // One tab is one checklist, and the acceptance bar is ten events in one go.
  test('every genre tab can fill a ten-event checklist on its own', () => {
    for (const group of EVENT_GENRES) {
      expect(group.presets.length).toBeGreaterThanOrEqual(10);
    }
  });

  test('every preset id survives project-store validation and is unique', () => {
    const seen = new Set<string>();
    for (const group of EVENT_GENRES) {
      for (const preset of group.presets) {
        expect(isSafeAudioEventId(preset.eventId)).toBe(true);
        expect(preset.hint.length).toBeGreaterThan(0);
        const key = `${group.id}/${preset.eventId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  test('music presets loop and sit on the music bus', () => {
    const preset = findPreset('music.main')!;
    const binding = bindingFromPreset(preset);
    expect(binding.kind).toBe('music');
    expect(binding.playback.bus).toBe('music');
    expect(binding.playback.mode).toBe('loop');
  });

  test('a fresh event is disabled and soundless, so it cannot break an apply', () => {
    const binding = bindingFromPreset(findPreset('weapon.fire')!);
    expect(binding.enabled).toBe(false);
    expect(binding.assets).toEqual([]);
    expect(binding.playback.mode).toBe('one-shot');
  });
});

describe('customPreset', () => {
  test('accepts a usable id and rejects what the store would reject', () => {
    expect(customPreset('boss.roar')).toMatchObject({ eventId: 'boss.roar', kind: 'sfx' });
    expect(customPreset('  boss.roar  ')?.eventId).toBe('boss.roar');
    expect(customPreset('中文事件')).toBeNull();
    expect(customPreset('.leading-dot')).toBeNull();
    expect(customPreset('')).toBeNull();
  });

  test('folds a typed id back onto the preset when it already exists', () => {
    expect(customPreset('player.jump')).toBe(findPreset('player.jump')!);
  });
});

describe('wireIntoGamePrompt', () => {
  test('names the game and every event the agent has to find a trigger for', () => {
    const prompt = wireIntoGamePrompt('demo', [findPreset('weapon.fire')!, findPreset('music.main')!]);
    expect(prompt).toContain('“demo”');
    expect(prompt).toContain('`weapon.fire`');
    expect(prompt).toContain('每次射出子弹时');
    expect(prompt).toContain('`music.main`');
    expect(prompt).toContain('gameAudio.emit');
    // The events exist already; the agent must not re-author the audio config.
    expect(prompt).toContain('不要改 `audio/` 下的任何配置');
  });
});

describe('acceptance: ten events on a blank game, no code written', () => {
  test('checklist picks become ten audio-event assets in the catalog', async () => {
    const root = await blankGame();
    const picks = [...presetsFor('shooter'), ...presetsFor('common')].slice(0, 10);
    expect(picks).toHaveLength(10);

    const project = await patchAudioProject(root, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: picks.map(bindingFromPreset),
    });

    // One patch, one revision: the agent may be editing the same draft.
    expect(project.revision).toBe(1);
    expect(project.bindings).toHaveLength(10);

    // Empty events must not read as a broken project, or apply would be blocked.
    const verified = await verifyAudioProject(root, project, { requireRuntime: false });
    expect(verified.ok).toBe(true);
    expect(verified.warnings.every((warning) => warning.code === 'binding_disabled')).toBe(true);

    const { pack } = await projectEventsPack(root, project);
    await writeEventsPack(root, pack);
    expect(pack.assets).toHaveLength(10);
    expect(pack.assets.every((asset) => asset.kind === AUDIO_EVENT_KIND)).toBe(true);

    const builder = resolve(
      import.meta.dir,
      '../../../../editor/packages/engine/packages/vite-plugin-pack/src/build-catalog.ts',
    );
    if (!existsSync(builder)) return; // engine sources absent in slim checkouts
    const { buildCatalogStrict } = await import(builder) as {
      buildCatalogStrict: (roots: string[]) => Promise<{
        catalog: Array<{ kind: string; name?: string }>;
        errors: unknown[];
      }>;
    };
    const { catalog, errors } = await buildCatalogStrict([join(root, 'assets')]);
    expect(errors).toEqual([]);
    expect(catalog.filter((row) => row.kind === AUDIO_EVENT_KIND)).toHaveLength(10);
  });
});
