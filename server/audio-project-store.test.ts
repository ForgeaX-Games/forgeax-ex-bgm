import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AudioProjectError,
  normalizeAudioProject,
  type AudioBinding,
} from '../shared/audio-project.ts';
import {
  patchAudioProject,
  readAudioProject,
} from './audio-project-store.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempGame(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-audio-project-'));
  roots.push(root);
  return root;
}

function binding(eventId = 'combat.attack.hit'): AudioBinding {
  return {
    eventId,
    label: '重击命中',
    enabled: true,
    kind: 'sfx',
    assets: [
      { assetId: 'hit-01', file: 'audio/hit-01.wav', name: 'Hit 01' },
      { assetId: 'hit-02', file: 'audio/hit-02.wav', name: 'Hit 02' },
    ],
    variation: { mode: 'random-no-repeat' },
    trigger: { delayMs: 35, cooldownMs: 120, probability: 0.75 },
    playback: {
      volume: 0.8,
      bus: 'sfx',
      spatial: '3d',
      mode: 'one-shot',
      fadeInMs: 0,
      fadeOutMs: 80,
    },
    conditions: [{ field: 'target.material', operator: 'eq', value: 'metal' }],
  };
}

describe('audio project contract', () => {
  test('normalizes editable defaults without changing the event or asset identity', () => {
    const project = normalizeAudioProject({
      schemaVersion: 'forgeax-audio-project/1',
      revision: 4,
      status: 'draft',
      bindings: [{
        eventId: 'ui.confirm',
        kind: 'sfx',
        assets: [{ assetId: 'ui-ok', file: 'audio/ui/ok.wav' }],
      }],
    }, 'demo');

    expect(project.schemaVersion).toBe('forgeax-audio-project/2');
    expect(project.projectId).toBe('demo');
    expect(project.revision).toBe(4);
    expect(project.objects).toHaveLength(1);
    expect(project.events).toHaveLength(1);
    expect(project.bindings).toEqual([{
      eventId: 'ui.confirm',
      label: 'ui.confirm',
      enabled: true,
      kind: 'sfx',
      assets: [{ assetId: 'ui-ok', file: 'audio/ui/ok.wav' }],
      variation: { mode: 'single' },
      trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
      playback: {
        volume: 1,
        bus: 'sfx',
        spatial: '2d',
        mode: 'one-shot',
        fadeInMs: 0,
        fadeOutMs: 0,
      },
      conditions: [],
    }]);
  });

  test('accepts manifest-style audio paths and keeps the game-relative prefix', () => {
    const normalized = normalizeAudioProject({
      bindings: [{
        eventId: 'music.strategy',
        kind: 'music',
        assets: [{ assetId: 'strategy', file: 'audio/music/strategy_theme.wav' }],
      }],
    }, 'demo');

    expect(normalized.bindings[0]!.assets[0]!.file).toBe('audio/music/strategy_theme.wav');
  });

  test('keeps newly generated assets/audio paths', () => {
    const normalized = normalizeAudioProject({
      bindings: [{
        eventId: 'ui.confirm',
        kind: 'sfx',
        assets: [{ assetId: 'fresh', file: 'assets/audio/confirm.mp3' }],
      }],
    }, 'demo');
    expect(normalized.bindings[0]!.assets[0]!.file).toBe('assets/audio/confirm.mp3');
  });

  test('rejects duplicate events instead of silently replacing one binding', () => {
    expect(() => normalizeAudioProject({
      bindings: [binding('combat.hit'), binding('combat.hit')],
    }, 'demo')).toThrow(expect.objectContaining({
      code: 'invalid_project',
      message: "duplicate audio eventId 'combat.hit'",
    }));
  });

  test('rejects unsafe event IDs, asset traversal and out-of-range controls', () => {
    const invalid = [
      { ...binding('../combat.hit'), eventId: '../combat.hit' },
      { ...binding(), assets: [{ assetId: 'escape', file: '../secret.wav' }] },
      { ...binding(), trigger: { delayMs: -1, cooldownMs: 0, probability: 1 } },
      { ...binding(), playback: { ...binding().playback, volume: 4.1 } },
    ];

    for (const value of invalid) {
      expect(() => normalizeAudioProject({ bindings: [value] }, 'demo')).toThrow(AudioProjectError);
    }
  });
});

describe('revisioned audio project draft store', () => {
  test('returns an empty revision-zero draft for a game with no audio project', async () => {
    const gameDir = await tempGame();
    const project = await readAudioProject(gameDir, 'demo');
    expect(project).toMatchObject({
      schemaVersion: 'forgeax-audio-project/2',
      projectId: 'demo',
      revision: 0,
      status: 'draft',
      bindings: [],
      objects: [],
      events: [],
    });
    expect(project.buses.map((bus) => bus.id)).toEqual([
      'bus:master', 'bus:sfx', 'bus:music', 'bus:voice',
    ]);
  });

  test('uses the applied document as the editable base when no draft exists', async () => {
    const gameDir = await tempGame();
    await mkdir(join(gameDir, 'audio'), { recursive: true });
    await writeFile(join(gameDir, 'audio/project.json'), JSON.stringify({
      schemaVersion: 'forgeax-audio-project/1',
      projectId: 'demo',
      revision: 7,
      status: 'applied',
      updatedAt: '2026-08-01T00:00:00.000Z',
      bindings: [binding()],
    }));

    const draft = await readAudioProject(gameDir, 'demo');
    expect(draft.status).toBe('draft');
    expect(draft.revision).toBe(7);
    expect(draft.bindings).toEqual([binding()]);
  });

  test('upserts and removes bindings in one atomic revision without touching applied state', async () => {
    const gameDir = await tempGame();
    await mkdir(join(gameDir, 'audio'), { recursive: true });
    const applied = {
      schemaVersion: 'forgeax-audio-project/1',
      projectId: 'demo',
      revision: 2,
      status: 'applied',
      updatedAt: '2026-08-01T00:00:00.000Z',
      bindings: [binding('old.event')],
    };
    await writeFile(join(gameDir, 'audio/project.json'), JSON.stringify(applied));

    const next = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 2,
      upsertBindings: [binding('new.event')],
      removeEventIds: ['old.event'],
    }, { now: () => new Date('2026-08-03T03:00:00.000Z') });

    expect(next.revision).toBe(3);
    expect(next.updatedAt).toBe('2026-08-03T03:00:00.000Z');
    expect(next.schemaVersion).toBe('forgeax-audio-project/2');
    expect(next.bindings.map((item) => item.eventId)).toEqual(['new.event']);
    expect(next.objects.map((item) => item.id)).toEqual(['obj:new.event']);
    expect(JSON.parse(await readFile(join(gameDir, 'audio/project.json'), 'utf8'))).toEqual(applied);
    const draftOnDisk = JSON.parse(await readFile(join(gameDir, 'audio/project.draft.json'), 'utf8')) as {
      schemaVersion: string;
      bindings?: unknown;
      events: Array<{ name: string }>;
    };
    expect(draftOnDisk.schemaVersion).toBe('forgeax-audio-project/2');
    expect(draftOnDisk.bindings).toBeUndefined();
    expect(draftOnDisk.events.map((event) => event.name)).toEqual(['new.event']);
  });

  test('saving a binding keeps object fields the v1 view cannot express', async () => {
    const gameDir = await tempGame();
    const seeded = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [binding('weapon.fire')],
    });
    const objectId = seeded.objects[0]!.id;
    const authored = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: seeded.revision,
      upsertObjects: [{
        ...seeded.objects[0]!,
        priority: 90,
        limit: { maxInstances: 2, scope: 'gameObject', onExceed: 'stealQuietest' },
      }],
    });
    expect(authored.objects[0]).toMatchObject({ id: objectId, priority: 90 });

    const resaved = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: authored.revision,
      upsertBindings: [{
        ...binding('weapon.fire'),
        playback: { ...binding('weapon.fire').playback, attenuationId: 'att:gunfire' },
      }],
    });

    expect(resaved.objects[0]).toMatchObject({
      id: objectId,
      priority: 90,
      limit: { maxInstances: 2, scope: 'gameObject', onExceed: 'stealQuietest' },
      attenuationId: 'att:gunfire',
    });
    expect(resaved.bindings[0]?.playback.attenuationId).toBe('att:gunfire');
  });

  test('fills cooldown and volume from the event archetype when the agent omits them', async () => {
    const gameDir = await tempGame();
    const project = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [{
        eventId: 'enemy.death',
        kind: 'sfx',
        assets: [{ assetId: 'ko', file: 'audio/ko.wav' }],
      } as AudioBinding],
    });
    expect(project.bindings[0]?.trigger).toMatchObject({ cooldownMs: 0, delayMs: 0, probability: 1 });
    expect(project.bindings[0]?.playback).toMatchObject({
      volume: 0.1,
      spatial: '3d',
      mode: 'one-shot',
      bus: 'sfx',
    });
  });

  test('keeps an explicit cooldown even when the archetype would zero it', async () => {
    const gameDir = await tempGame();
    const project = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [{
        eventId: 'item.pickup',
        kind: 'sfx',
        assets: [{ assetId: 'pick', file: 'audio/pick.wav' }],
        trigger: { delayMs: 0, cooldownMs: 200, probability: 1 },
      } as AudioBinding],
    });
    expect(project.bindings[0]?.trigger.cooldownMs).toBe(200);
    expect(project.bindings[0]?.playback.spatial).toBe('2d');
  });

  test('round-trips a wired hook through patch and does not drop it on a later numeric edit', async () => {
    const gameDir = await tempGame();
    const first = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [{
        ...binding('enemy.death'),
        provenance: {
          status: 'wired',
          file: 'src/combat.ts',
          symbol: 'settleEnemyDefeat',
          reason: 'hp reaches zero once here',
        },
      }],
    });
    expect(first.bindings[0]?.provenance).toEqual({
      status: 'wired',
      file: 'src/combat.ts',
      symbol: 'settleEnemyDefeat',
      reason: 'hp reaches zero once here',
    });

    const second = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 1,
      upsertBindings: [{
        ...binding('enemy.death'),
        trigger: { delayMs: 0, cooldownMs: 0, probability: 1 },
      }],
    });
    expect(second.bindings[0]?.provenance?.file).toBe('src/combat.ts');
  });

  test('rejects a stale expected revision and preserves the current draft bytes', async () => {
    const gameDir = await tempGame();
    const first = await patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [binding()],
      removeEventIds: [],
    });
    const before = await readFile(join(gameDir, 'audio/project.draft.json'), 'utf8');

    await expect(patchAudioProject(gameDir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [binding('stale.event')],
      removeEventIds: [],
    })).rejects.toMatchObject({ code: 'revision_conflict', actualRevision: first.revision });

    expect(await readFile(join(gameDir, 'audio/project.draft.json'), 'utf8')).toBe(before);
  });
});
