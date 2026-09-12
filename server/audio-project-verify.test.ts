import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AudioProject } from '../shared/audio-project.ts';
import { verifyAudioProject } from './audio-project-verify.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempGame(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-audio-verify-'));
  roots.push(root);
  await mkdir(join(root, 'audio'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  return root;
}

function project(): AudioProject {
  return {
    schemaVersion: 'forgeax-audio-project/1',
    projectId: 'demo',
    revision: 3,
    status: 'applied',
    updatedAt: '2026-08-03T03:00:00.000Z',
    bindings: [{
      eventId: 'combat.hit',
      label: '命中',
      enabled: true,
      kind: 'sfx',
      assets: [{ assetId: 'hit', file: 'hit.wav' }],
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
    }],
  };
}

describe('audio project verification', () => {
  test('accepts an applied project with assets, generated runtime and literal instrumentation', async () => {
    const root = await tempGame();
    await writeFile(join(root, 'audio/hit.wav'), 'RIFF');
    await writeFile(join(root, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [{ assetId: 'hit', file: 'audio/hit.wav', kind: 'sfx' }],
    }));
    await mkdir(join(root, 'src/forgeax-audio'), { recursive: true });
    await Promise.all(['runtime.ts', 'runtime-impl.js', 'runtime-impl.d.ts', 'generated-bindings.ts', 'index.ts'].map((file) => (
      writeFile(join(root, 'src/forgeax-audio', file), 'export {};')
    )));
    await writeFile(join(root, 'src/combat.ts'), "gameAudio.emit('combat.hit', { damage: 10 });");

    expect(await verifyAudioProject(root, project())).toMatchObject({
      ok: true,
      errors: [],
      warnings: [],
      instrumentedEventIds: ['combat.hit'],
    });
  });

  test('reports empty bindings, missing files, missing runtime modules and absent instrumentation', async () => {
    const root = await tempGame();
    const invalid = project();
    invalid.bindings.push({ ...invalid.bindings[0]!, eventId: 'ui.empty', assets: [] });

    const result = await verifyAudioProject(root, invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { code: 'asset_missing', eventId: 'combat.hit', file: 'audio/hit.wav', message: "audio asset 'audio/hit.wav' does not exist" },
      { code: 'binding_assets_empty', eventId: 'ui.empty', message: "binding 'ui.empty' has no audio assets" },
      { code: 'runtime_missing', file: 'src/forgeax-audio/generated-bindings.ts', message: "generated runtime file 'src/forgeax-audio/generated-bindings.ts' does not exist" },
      { code: 'runtime_missing', file: 'src/forgeax-audio/index.ts', message: "generated runtime file 'src/forgeax-audio/index.ts' does not exist" },
      { code: 'runtime_missing', file: 'src/forgeax-audio/runtime.ts', message: "generated runtime file 'src/forgeax-audio/runtime.ts' does not exist" },
      { code: 'runtime_missing', file: 'src/forgeax-audio/runtime-impl.js', message: "generated runtime file 'src/forgeax-audio/runtime-impl.js' does not exist" },
      { code: 'runtime_missing', file: 'src/forgeax-audio/runtime-impl.d.ts', message: "generated runtime file 'src/forgeax-audio/runtime-impl.d.ts' does not exist" },
      { code: 'event_not_instrumented', eventId: 'combat.hit', message: "event 'combat.hit' has no literal gameAudio.emit/play call" },
      { code: 'event_not_instrumented', eventId: 'ui.empty', message: "event 'ui.empty' has no literal gameAudio.emit/play call" },
    ]);
    expect(result.instrumentedEventIds).toEqual([]);
  });

  test('accepts a newly generated assets/audio file without reporting asset_missing', async () => {
    const root = await tempGame();
    await mkdir(join(root, 'assets/audio'), { recursive: true });
    await writeFile(join(root, 'assets/audio/fresh.mp3'), 'RIFF');
    const next = project();
    next.status = 'draft';
    next.bindings[0]!.assets[0]!.file = 'assets/audio/fresh.mp3';

    const result = await verifyAudioProject(root, next, { requireRuntime: false });
    expect(result.errors.filter((item) => item.code === 'asset_missing')).toEqual([]);
  });

  test('treats disabled bindings as editable drafts rather than runtime failures', async () => {
    const root = await tempGame();
    const disabled = project();
    disabled.bindings[0] = { ...disabled.bindings[0]!, enabled: false, assets: [] };

    const result = await verifyAudioProject(root, disabled, { requireRuntime: false });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      { code: 'binding_disabled', eventId: 'combat.hit', message: "binding 'combat.hit' is disabled" },
    ]);
  });

  test('rejects an enabled binding that is still a hook gap', async () => {
    const root = await tempGame();
    const next = project();
    next.status = 'draft';
    next.bindings[0] = {
      ...next.bindings[0]!,
      provenance: { status: 'gap', reason: 'no settleEnemyDefeat in this build' },
    };
    await writeFile(join(root, 'audio/hit.wav'), 'RIFF');

    const result = await verifyAudioProject(root, next, { requireRuntime: false });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provenance_gap_enabled', eventId: 'combat.hit' }),
    ]));
  });

  test('warns when the recorded hook file no longer matches the emit', async () => {
    const root = await tempGame();
    await writeFile(join(root, 'audio/hit.wav'), 'RIFF');
    await writeFile(join(root, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [{ assetId: 'hit', file: 'audio/hit.wav', kind: 'sfx' }],
    }));
    await writeFile(join(root, 'src/combat.ts'), "gameAudio.emit('combat.hit');");
    const next = project();
    next.status = 'draft';
    next.bindings[0] = {
      ...next.bindings[0]!,
      provenance: {
        status: 'wired',
        file: 'src/legacy-combat.ts',
        symbol: 'settleHit',
        reason: 'damage is confirmed here',
      },
    };

    const result = await verifyAudioProject(root, next, { requireRuntime: false });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'provenance_drift',
        eventId: 'combat.hit',
        file: 'src/legacy-combat.ts',
      }),
    ]);
  });

  test('fails verification when runtime evidence shows a locked context', async () => {
    const root = await tempGame();
    await writeFile(join(root, 'audio/hit.wav'), 'RIFF');
    await writeFile(join(root, 'audio/manifest.json'), JSON.stringify({
      version: 1,
      slug: 'demo',
      tracks: [{ assetId: 'hit', file: 'audio/hit.wav', kind: 'sfx' }],
    }));
    await mkdir(join(root, 'src/forgeax-audio'), { recursive: true });
    await Promise.all(['runtime.ts', 'runtime-impl.js', 'runtime-impl.d.ts', 'generated-bindings.ts', 'index.ts'].map((file) => (
      writeFile(join(root, 'src/forgeax-audio', file), 'export {};')
    )));
    await writeFile(join(root, 'src/combat.ts'), "gameAudio.emit('combat.hit');");

    const result = await verifyAudioProject(root, project(), {
      runtimeEvidence: {
        counts: {
          total: 4,
          byOutcome: { context_locked: 4 },
          byEvent: { 'combat.hit': { total: 4, byOutcome: { context_locked: 4 } } },
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.code)).toEqual([
      'runtime_silent',
      'runtime_context_locked',
    ]);
  });
});


test('preparation checks assets without requiring pending gameplay integration', async () => {
  const root = await tempGame();
  await writeFile(join(root, 'audio/hit.wav'), 'RIFF');
  const prepared = await verifyAudioProject(root, project(), { phase: 'preparation' });
  expect(prepared.ok).toBe(true);
  expect(prepared.phase).toBe('preparation');
  expect(prepared.warnings.some(row => row.code === 'event_not_instrumented')).toBe(true);
  const integrated = await verifyAudioProject(root, project(), { phase: 'integration' });
  expect(integrated.ok).toBe(false);
  expect(integrated.errors.some(row => row.code === 'event_not_instrumented')).toBe(true);
  await rm(join(root, 'audio/hit.wav'));
  const missing = await verifyAudioProject(root, project(), { phase: 'preparation' });
  expect(missing.errors.some(row => row.code === 'asset_missing')).toBe(true);
});

test('runtime verification requires evidence from the target project', async () => {
  const root = await tempGame();
  const missing = await verifyAudioProject(root, project(), { phase: 'runtime' });
  expect(missing.errors.some(row => row.code === 'runtime_evidence_missing')).toBe(true);
  const wrong = await verifyAudioProject(root, project(), { phase: 'runtime', runtimeEvidence: {
    projectId: 'another-game', counts: { total: 1, byOutcome: { played: 1 } },
  } });
  expect(wrong.errors.some(row => row.code === 'runtime_project_mismatch')).toBe(true);
});
