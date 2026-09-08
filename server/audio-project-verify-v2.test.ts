import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AUDIO_ENGINE_VERSION,
  AUDIO_PROJECT_SCHEMA,
  defaultBuses,
  type AudioProject,
  type AudioProjectDocument,
} from '../shared/audio-project.ts';
import { audioBusGraphHasCycle, verifyAudioProject } from './audio-project-verify.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempGame(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-audio-verify-v2-'));
  roots.push(root);
  await mkdir(join(root, 'audio'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'audio/hit.wav'), 'RIFF');
  await writeFile(join(root, 'src/combat.ts'), "gameAudio.emit('combat.hit');\n");
  return root;
}

function baseDocument(overrides: Partial<AudioProjectDocument> = {}): AudioProject {
  const document: AudioProjectDocument = {
    schemaVersion: AUDIO_PROJECT_SCHEMA,
    projectId: 'demo',
    revision: 1,
    status: 'draft',
    updatedAt: '2026-08-10T00:00:00.000Z',
    engineVersion: AUDIO_ENGINE_VERSION,
    buses: defaultBuses(),
    gameSyncs: {
      states: [],
      switches: [{
        id: 'sw:surface',
        name: 'surface',
        values: ['grass', 'stone'],
        defaultValue: 'grass',
      }],
      rtpcs: [{
        id: 'rtpc:distance',
        name: 'distance',
        min: 0,
        max: 100,
        defaultValue: 0,
        scope: 'global',
        slewMsDefault: 0,
      }],
    },
    attenuations: [],
    objects: [{
      id: 'obj:combat.hit',
      name: 'Hit',
      node: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
      outputBusId: 'bus:sfx',
      spatial: '2d',
      priority: 50,
      limit: { maxInstances: 4, scope: 'global', onExceed: 'stealOldest' },
      virtualBehavior: 'fromElapsed',
      playback: { mode: 'one-shot', loopCount: 1, fadeInMs: 0, fadeOutMs: 0, volume: 1 },
      rtpcBindings: [],
      stateOffsets: [],
      conditions: [],
    }],
    events: [{
      id: 'evt:combat.hit',
      name: 'combat.hit',
      label: 'Hit',
      enabled: true,
      actions: [{ type: 'play', objectId: 'obj:combat.hit', delayMs: 0, probability: 1 }],
    }],
    ...overrides,
  };
  return { ...document, bindings: [] };
}

describe('audio project verification v2', () => {
  test('detects duplicate event names and unresolved references', async () => {
    const root = await tempGame();
    const project = baseDocument({
      events: [
        {
          id: 'evt:a',
          name: 'combat.hit',
          label: 'A',
          enabled: true,
          actions: [{ type: 'play', objectId: 'obj:missing', delayMs: 0, probability: 1 }],
        },
        {
          id: 'evt:b',
          name: 'combat.hit',
          label: 'B',
          enabled: true,
          actions: [{ type: 'setBusVolume', busId: 'bus:missing', volumeDb: -6, timeMs: 0 }],
        },
      ],
      objects: [{
        ...baseDocument().objects[0]!,
        outputBusId: 'bus:ghost',
        attenuationId: 'att:missing',
        rtpcBindings: [{
          rtpcId: 'rtpc:missing',
          target: 'volumeDb',
          curve: [{ x: 0, y: 0, interp: 'linear' }],
        }],
      }],
    });

    const result = await verifyAudioProject(root, project, { requireRuntime: false });
    expect(result.ok).toBe(false);
    expect(result.errors.map((item) => item.code).sort()).toEqual(expect.arrayContaining([
      'duplicate_event_name',
      'unresolved_object_id',
      'unresolved_bus_id',
      'unresolved_attenuation_id',
      'unresolved_rtpc_id',
    ]));
  });

  test('warns on incomplete switch branches when defaultNode exists, errors otherwise', async () => {
    const root = await tempGame();
    const withDefault = baseDocument({
      objects: [{
        ...baseDocument().objects[0]!,
        node: {
          kind: 'switch',
          groupId: 'sw:surface',
          assignments: {
            grass: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
          },
          onSwitchChange: 'restart',
          defaultNode: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
        },
      }],
    });
    const warned = await verifyAudioProject(root, withDefault, { requireRuntime: false });
    expect(warned.errors.some((item) => item.code === 'switch_missing_branch')).toBe(false);
    expect(warned.warnings.some((item) => item.code === 'switch_missing_branch')).toBe(true);

    const withoutDefault = baseDocument({
      objects: [{
        ...baseDocument().objects[0]!,
        node: {
          kind: 'switch',
          groupId: 'sw:surface',
          assignments: {
            grass: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
          },
          onSwitchChange: 'restart',
        },
      }],
    });
    const errored = await verifyAudioProject(root, withoutDefault, { requireRuntime: false });
    expect(errored.errors.some((item) => item.code === 'switch_missing_branch')).toBe(true);
  });

  test('errors on blend gaps/overlaps and RTPC curve points outside definition range', async () => {
    const root = await tempGame();
    const project = baseDocument({
      objects: [{
        ...baseDocument().objects[0]!,
        node: {
          kind: 'blend',
          rtpcId: 'rtpc:distance',
          layers: [
            {
              node: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
              rangeStart: 0,
              rangeEnd: 40,
              crossfadeCurve: [{ x: 0, y: 1, interp: 'linear' }],
            },
            {
              node: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
              rangeStart: 30,
              rangeEnd: 70,
              crossfadeCurve: [{ x: 0, y: 1, interp: 'linear' }],
            },
          ],
        },
        rtpcBindings: [{
          rtpcId: 'rtpc:distance',
          target: 'volumeDb',
          curve: [
            { x: -10, y: 0, interp: 'linear' },
            { x: 150, y: -6, interp: 'linear' },
          ],
        }],
      }],
    });
    const result = await verifyAudioProject(root, project, { requireRuntime: false });
    expect(result.errors.some((item) => item.code === 'blend_layer_invalid')).toBe(true);
    expect(result.errors.some((item) => item.code === 'rtpc_curve_out_of_range')).toBe(true);
  });

  test('detects bus cycles and warns on high voiceLimit / non-silent attenuation', async () => {
    expect(audioBusGraphHasCycle([
      { id: 'a', name: 'A', parentId: 'b', volumeDb: 0, effects: [], auxSends: [], ducking: [] },
      { id: 'b', name: 'B', parentId: 'a', volumeDb: 0, effects: [], auxSends: [], ducking: [] },
    ])).toBe(true);

    const root = await tempGame();
    const project = baseDocument({
      buses: [
        { id: 'bus:master', name: 'Master', volumeDb: 0, effects: [], auxSends: [], ducking: [], voiceLimit: 200 },
        {
          id: 'bus:sfx',
          name: 'SFX',
          parentId: 'bus:master',
          volumeDb: 0,
          effects: [],
          auxSends: [{ busId: 'bus:loop', levelDb: -6 }],
          ducking: [],
        },
        {
          id: 'bus:loop',
          name: 'Loop',
          parentId: 'bus:master',
          volumeDb: 0,
          effects: [],
          auxSends: [{ busId: 'bus:sfx', levelDb: -6 }],
          ducking: [],
        },
      ],
      attenuations: [{
        id: 'att:near',
        name: 'Near',
        maxDistance: 50,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: 50, y: -12, interp: 'linear' },
          ],
        },
      }],
    });
    const result = await verifyAudioProject(root, project, { requireRuntime: false });
    expect(result.errors.some((item) => item.code === 'bus_cycle')).toBe(true);
    expect(result.warnings.some((item) => item.code === 'bus_voice_limit_high')).toBe(true);
    expect(result.warnings.some((item) => item.code === 'attenuation_never_silent')).toBe(true);
  });

  test('errors when music transitions reference missing playlists or segments', async () => {
    const root = await tempGame();
    const project = baseDocument({
      music: {
        segments: [{
          id: 'seg:a',
          name: 'A',
          tempo: 120,
          timeSignature: [4, 4],
          preEntryMs: 0,
          entryCueMs: 0,
          exitCueMs: 1000,
          postExitMs: 0,
          customCues: [],
          tracks: [],
        }],
        playlists: [{ id: 'pl:explore', name: 'Explore', segmentIds: ['seg:a'] }],
        transitions: [{
          fromPlaylistId: 'pl:explore',
          toPlaylistId: 'pl:missing',
          exitAt: 'nextBar',
          syncTo: 'entryCue',
          fadeOutMs: 100,
          fadeInMs: 100,
          transitionSegmentId: 'seg:missing',
        }],
        stingers: [],
      },
    });
    const result = await verifyAudioProject(root, project, { requireRuntime: false });
    expect(result.errors.filter((item) => item.code === 'music_transition_unresolved').length).toBeGreaterThanOrEqual(2);
  });

  test('accepts a well-formed v2 project', async () => {
    const root = await tempGame();
    const project = baseDocument({
      objects: [{
        ...baseDocument().objects[0]!,
        node: {
          kind: 'switch',
          groupId: 'sw:surface',
          assignments: {
            grass: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
            stone: { kind: 'sound', asset: { assetId: 'hit', file: 'hit.wav' } },
          },
          onSwitchChange: 'restart',
        },
      }],
      music: {
        segments: [{
          id: 'seg:a',
          name: 'A',
          tempo: 120,
          timeSignature: [4, 4],
          preEntryMs: 0,
          entryCueMs: 0,
          exitCueMs: 1000,
          postExitMs: 0,
          customCues: [],
          tracks: [],
        }],
        playlists: [{ id: 'pl:explore', name: 'Explore', segmentIds: ['seg:a'] }],
        transitions: [{
          fromPlaylistId: 'pl:explore',
          toPlaylistId: 'pl:explore',
          exitAt: 'nextBar',
          syncTo: 'entryCue',
          fadeOutMs: 0,
          fadeInMs: 0,
        }],
        stingers: [],
      },
      attenuations: [{
        id: 'att:far',
        name: 'Far',
        maxDistance: 100,
        curves: {
          outputVolumeDb: [
            { x: 0, y: 0, interp: 'linear' },
            { x: 100, y: -80, interp: 'linear' },
          ],
        },
      }],
    });
    const result = await verifyAudioProject(root, project, { requireRuntime: false });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
