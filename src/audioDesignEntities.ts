import type {
  AttenuationShareSet,
  AudioBusNode,
  CurvePoint,
  MusicPlaylist,
  MusicSegment,
  RtpcDefinition,
  StateGroup,
  SwitchGroup,
} from '../shared/audio-project.ts';

export type DesignWorkspace =
  | 'audio'
  | 'events'
  | 'syncs'
  | 'buses'
  | 'atten'
  | 'music'
  | 'diag';

export type SyncKind = 'switch' | 'rtpc' | 'state';

export function parseCsvValues(raw: string): string[] {
  return raw
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createSwitchGroup(name: string, values: string[] = ['a', 'b']): SwitchGroup {
  const cleaned = values.length > 0 ? values : ['default'];
  const id = `sw:${cleanedKey(name)}`;
  return {
    id,
    name: name.trim() || id,
    values: cleaned,
    defaultValue: cleaned[0]!,
  };
}

export function createRtpc(name: string, min = 0, max = 1): RtpcDefinition {
  const id = `rtpc:${cleanedKey(name)}`;
  return {
    id,
    name: name.trim() || id,
    min,
    max: max > min ? max : min + 1,
    defaultValue: min,
    scope: 'global',
    slewMsDefault: 0,
  };
}

export function createStateGroup(name: string, values: string[] = ['explore', 'combat']): StateGroup {
  const cleaned = values.length > 0 ? values : ['default'];
  const id = `st:${cleanedKey(name)}`;
  return {
    id,
    name: name.trim() || id,
    values: cleaned,
    defaultValue: cleaned[0]!,
    transitions: [],
  };
}

export function createChildBus(name: string, parentId = 'bus:master'): AudioBusNode {
  const id = `bus:${cleanedKey(name)}`;
  return {
    id,
    name: name.trim() || id,
    parentId,
    volumeDb: 0,
    effects: [],
    auxSends: [],
    ducking: [],
  };
}

export function linearCurve(x0: number, y0: number, x1: number, y1: number): CurvePoint[] {
  return [
    { x: x0, y: y0, interp: 'linear' },
    { x: x1, y: y1, interp: 'linear' },
  ];
}

/** Opinionated distance presets used by the attenuation editor. */
export function attenuationPreset(
  kind: 'close' | 'melee' | 'scene' | 'far',
  name?: string,
): AttenuationShareSet {
  const table = {
    close: { name: '贴身', maxDistance: 3, midAt: 0.45 },
    melee: { name: '近战衰减', maxDistance: 18, midAt: 0.5 },
    scene: { name: '场景环境', maxDistance: 35, midAt: 0.55 },
    far: { name: '远处广播', maxDistance: 80, midAt: 0.65 },
  } as const;
  const preset = table[kind];
  const max = preset.maxDistance;
  return {
    id: `attn:${kind}`,
    name: name?.trim() || preset.name,
    maxDistance: max,
    curves: {
      outputVolumeDb: [
        { x: 0, y: 0, interp: 'linear' },
        { x: max * preset.midAt, y: -6, interp: 'linear' },
        { x: max, y: -96, interp: 'linear' },
      ],
    },
  };
}

export function createMusicSegment(name: string, tempo = 120): MusicSegment {
  const id = `seg:${cleanedKey(name)}`;
  return {
    id,
    name: name.trim() || id,
    tempo,
    timeSignature: [4, 4],
    preEntryMs: 0,
    entryCueMs: 0,
    exitCueMs: 4_000,
    postExitMs: 0,
    customCues: [],
    tracks: [],
  };
}

export function createMusicPlaylist(name: string, segmentIds: string[] = []): MusicPlaylist {
  const id = `pl:${cleanedKey(name)}`;
  return {
    id,
    name: name.trim() || id,
    segmentIds: [...segmentIds],
  };
}

function cleanedKey(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return `item_${Date.now().toString(36)}`;
  const key = trimmed
    .replace(/[^\p{L}\p{N}._:-]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return key || `item_${Date.now().toString(36)}`;
}
