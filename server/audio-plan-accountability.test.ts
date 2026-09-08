import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { patchAudioProject, readAudioProject } from './audio-project-store.ts';
import { verifyAudioProject } from './audio-project-verify.ts';
import {
  EVENT_ARCHETYPES,
  archetypeVolumeDrift,
  varietyShortfall,
} from '../shared/event-archetypes.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gameDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-audio-plan-'));
  roots.push(root);
  await mkdir(join(root, 'audio'), { recursive: true });
  return root;
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'enemy-defeat',
    label: '击败',
    kind: 'sfx',
    archetype: 'defeat',
    assets: [{ assetId: 'a', file: 'assets/audio/a.mp3' }],
    ...overrides,
  };
}

describe('archetype defaults reach the game', () => {
  test('a declared archetype sizes voices and priority instead of one blanket number', async () => {
    const dir = await gameDir();
    const project = await patchAudioProject(dir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [binding(), binding({ eventId: 'bgm-main', kind: 'music', archetype: 'bgm-loop' })],
    });

    const defeat = project.objects.find((object) => object.name === '击败')!;
    const music = project.objects.find((object) => object.id.includes('bgm-main'))!;
    expect(defeat.limit.maxInstances).toBe(EVENT_ARCHETYPES.defeat.maxInstances);
    expect(defeat.priority).toBe(EVENT_ARCHETYPES.defeat.priority);
    // A footstep must not be able to evict music, so priorities have to differ.
    expect(music.priority).toBeGreaterThan(defeat.priority);
    expect(defeat.playback.volume).toBe(EVENT_ARCHETYPES.defeat.volume);
  });

  test('the archetype survives on disk so its numbers stay auditable', async () => {
    const dir = await gameDir();
    await patchAudioProject(dir, {
      projectId: 'demo',
      expectedRevision: 0,
      upsertBindings: [binding()],
    });
    const reread = await readAudioProject(dir, 'demo');
    expect(reread.events[0]!.archetype).toBe('defeat');
    expect(reread.bindings[0]!.archetype).toBe('defeat');
  });
});

describe('the audio plan is recorded with the revision', () => {
  test('tone and notes land on the draft and survive a later patch', async () => {
    const dir = await gameDir();
    const first = await patchAudioProject(dir, {
      projectId: 'demo',
      expectedRevision: 0,
      plan: { tone: '仙侠打斗', notes: '攻击按元素拆四条' },
      upsertBindings: [binding()],
    });
    expect(first.plan?.tone).toBe('仙侠打斗');
    expect(first.plan?.recordedAt).toBeTruthy();

    const second = await patchAudioProject(dir, {
      projectId: 'demo',
      expectedRevision: first.revision,
      upsertBindings: [binding({ label: '击败 2' })],
    });
    expect(second.plan?.tone).toBe('仙侠打斗');
  });
});

describe('richness findings', () => {
  test('a declared high-frequency beat with one clip is reported, not failed', () => {
    const shortfall = varietyShortfall({
      eventId: 'combat-impact',
      archetype: 'impact',
      assets: [{}],
    });
    expect(shortfall?.code).toBe('variety_below_archetype');
    expect(shortfall?.expected).toBe(EVENT_ARCHETYPES.impact.variants);
  });

  test('per-case clips count as variety of their own kind', () => {
    expect(varietyShortfall({
      eventId: 'player-attack',
      archetype: 'attack',
      assets: [{}],
      follow: { cases: [{}, {}, {}, {}] },
    })).toBeUndefined();
  });

  test('an undeclared archetype is left alone rather than judged by its name', () => {
    expect(varietyShortfall({ eventId: 'combat-impact', assets: [{}] })).toBeUndefined();
    expect(archetypeVolumeDrift({ eventId: 'enemy-defeat', playback: { volume: 0.5 } })).toBeUndefined();
  });

  test('a defeat written five times louder than its tuned value is flagged', () => {
    const drift = archetypeVolumeDrift({
      eventId: 'enemy-defeat',
      archetype: 'defeat',
      playback: { volume: 0.5 },
    });
    expect(drift?.code).toBe('archetype_volume_drift');
    expect(drift?.expected).toBe(0.1);
    expect(drift?.message).toContain('louder');
  });

  test('keeping the archetype default raises nothing', () => {
    expect(archetypeVolumeDrift({
      eventId: 'enemy-defeat',
      archetype: 'defeat',
      playback: { volume: EVENT_ARCHETYPES.defeat.volume },
    })).toBeUndefined();
  });
});

describe('verify holds the result against the plan', () => {
  test('a planned variant count that was not generated becomes a warning', async () => {
    const dir = await gameDir();
    await writeFile(join(dir, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [{
        assetId: 'a',
        name: 'a',
        kind: 'sfx',
        file: 'assets/audio/a.mp3',
        version: 'generated',
        source: 'generated:seed-audio',
        addedBy: 'ai',
        addedAt: new Date().toISOString(),
      }],
    }));
    await mkdir(dirname(join(dir, 'assets/audio/a.mp3')), { recursive: true });
    await writeFile(join(dir, 'assets/audio/a.mp3'), 'x');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src/main.ts'), "gameAudio.emit('combat-impact');\n");

    const project = await patchAudioProject(dir, {
      projectId: 'demo',
      expectedRevision: 0,
      plan: { tone: '仙侠打斗' },
      upsertBindings: [{
        eventId: 'combat-impact',
        label: '命中',
        kind: 'sfx',
        archetype: 'impact',
        plannedVariants: 3,
        assets: [{ assetId: 'a', file: 'assets/audio/a.mp3' }],
        provenance: { status: 'wired', file: 'src/main.ts', reason: '命中结算', symbol: 'onHit' },
      }],
    });

    const result = await verifyAudioProject(dir, project, { requireRuntime: false });
    const unmet = result.warnings.find((item) => item.code === 'plan_variants_unmet');
    expect(unmet?.eventId).toBe('combat-impact');
    expect(unmet?.message).toContain('3 variant(s) but has 1');
    // Richness is a finding, never a gate: nothing here is broken.
    expect(result.errors.filter((item) => item.code.startsWith('plan_'))).toEqual([]);
    expect(result.warnings.some((item) => item.code === 'variety_below_archetype')).toBe(false);
  });
});
