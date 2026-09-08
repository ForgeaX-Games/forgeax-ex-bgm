import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  AUDIO_PROJECT_SCHEMA,
  AUDIO_PROJECT_SCHEMA_V1,
  AudioProjectError,
  attachLegacyBindings,
  emptyAudioProject,
  emptyMusicProject,
  migrateV1ToV2,
  normalizeAudioProject,
  toProjectDocument,
  type AttenuationShareSet,
  type AudioBinding,
  type AudioBusNode,
  type AudioProject,
  type AudioProjectDocument,
  type MusicPlaylist,
  type MusicProject,
  type MusicSegment,
  type MusicStinger,
  type MusicTransition,
  type RtpcDefinition,
  type StateGroup,
  type SwitchGroup,
} from '../shared/audio-project.ts';
import { applyArchetypeDefaults } from '../shared/event-archetypes.ts';
import { normalizeAudioProjectV1 } from '../shared/audio-project-v1.ts';

export interface PatchAudioProjectArgs {
  projectId: string;
  expectedRevision: number;
  upsertBindings?: Array<AudioBinding | Record<string, unknown>>;
  removeEventIds?: string[];
  /** Preferred v2 patch surface — merge by immutable entity id. */
  upsertObjects?: AudioProjectDocument['objects'];
  upsertEvents?: AudioProjectDocument['events'];
  removeObjectIds?: string[];
  removeEventEntityIds?: string[];
  /** Recorded with the revision so verification can check the result against it. */
  plan?: { tone?: string; notes?: string };
}

export interface AudioProjectStoreDeps {
  now?: () => Date;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) {
      throw new AudioProjectError('invalid_project', `invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

function mergeById<T extends { id: string }>(current: T[], upserts: T[]): T[] {
  const items = [...current];
  const positions = new Map(items.map((item, index) => [item.id, index]));
  for (const item of upserts) {
    const index = positions.get(item.id);
    if (index === undefined) {
      positions.set(item.id, items.length);
      items.push(item);
    } else {
      items[index] = item;
    }
  }
  return items;
}

type AudioProjectObject = AudioProjectDocument['objects'][number];

/**
 * A v1 binding upsert rebuilds the whole object, so fields the v1 view cannot express would be
 * reset to migration defaults every time the audio studio saves an event. Keep whatever the v2
 * surface authored for those; binding-derived fields (including attenuationId) still win.
 */
function keepAuthoredV2Fields(
  existing: AudioProjectObject | undefined,
  incoming: AudioProjectObject,
): AudioProjectObject {
  if (!existing) return incoming;
  return {
    ...incoming,
    priority: existing.priority,
    limit: existing.limit,
    virtualBehavior: existing.virtualBehavior,
    rtpcBindings: existing.rtpcBindings,
    stateOffsets: existing.stateOffsets,
  };
}

function keepEventProvenance(
  existing: AudioProjectDocument['events'][number] | undefined,
  incoming: AudioProjectDocument['events'][number],
): AudioProjectDocument['events'][number] {
  if (incoming.provenance || !existing?.provenance) return incoming;
  return { ...incoming, provenance: existing.provenance };
}

function removeById<T extends { id: string }>(current: T[], ids: Iterable<string>): T[] {
  const remove = new Set(ids);
  return current.filter((item) => !remove.has(item.id));
}

function referencedObjectIds(document: AudioProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const event of document.events) {
    for (const action of event.actions) {
      if (action.type === 'play' || action.type === 'stop') ids.add(action.objectId);
    }
  }
  return ids;
}

function pruneOrphans(document: AudioProjectDocument): AudioProjectDocument {
  const usedObjects = referencedObjectIds(document);
  const objects = document.objects.filter((object) => usedObjects.has(object.id));
  const usedSwitchIds = new Set<string>();
  const usedRtpcIds = new Set<string>();
  const walk = (node: AudioProjectDocument['objects'][number]['node']): void => {
    if (node.kind === 'switch') {
      usedSwitchIds.add(node.groupId);
      for (const child of Object.values(node.assignments)) walk(child);
      if (node.defaultNode) walk(node.defaultNode);
    } else if (node.kind === 'blend') {
      usedRtpcIds.add(node.rtpcId);
      for (const layer of node.layers) walk(layer.node);
    } else if (node.kind === 'random' || node.kind === 'sequence') {
      for (const child of node.children) walk(child);
    }
  };
  for (const object of objects) {
    walk(object.node);
    for (const binding of object.rtpcBindings) usedRtpcIds.add(binding.rtpcId);
  }
  return {
    ...document,
    objects,
    gameSyncs: {
      states: document.gameSyncs.states,
      switches: document.gameSyncs.switches.filter((item) => usedSwitchIds.has(item.id)),
      rtpcs: document.gameSyncs.rtpcs.filter((item) => usedRtpcIds.has(item.id)),
    },
  };
}

export async function readAudioProject(gameDir: string, projectId: string): Promise<AudioProject> {
  const audioDir = join(gameDir, 'audio');
  const draft = await readJson(join(audioDir, 'project.draft.json'));
  if (draft !== undefined) return normalizeAudioProject(draft, projectId);
  const applied = await readJson(join(audioDir, 'project.json'));
  if (applied !== undefined) {
    return { ...normalizeAudioProject(applied, projectId), status: 'draft' };
  }
  return emptyAudioProject(projectId);
}

export async function readAppliedAudioProject(
  gameDir: string,
  projectId: string,
): Promise<AudioProject | undefined> {
  const applied = await readJson(join(gameDir, 'audio/project.json'));
  if (applied === undefined) return undefined;
  return { ...normalizeAudioProject(applied, projectId), status: 'applied' };
}

export async function writeAppliedAudioProject(
  gameDir: string,
  input: AudioProject,
): Promise<AudioProject> {
  const applied = {
    ...normalizeAudioProject(input, input.projectId),
    status: 'applied' as const,
  };
  await atomicWriteJson(join(gameDir, 'audio/project.json'), toProjectDocument(applied));
  return applied;
}

export async function patchAudioProject(
  gameDir: string,
  args: PatchAudioProjectArgs,
  deps: AudioProjectStoreDeps = {},
): Promise<AudioProject> {
  if (!Number.isInteger(args.expectedRevision) || args.expectedRevision < 0) {
    throw new AudioProjectError('bad_input', 'expectedRevision must be a non-negative integer');
  }
  const current = await readAudioProject(gameDir, args.projectId);
  if (current.revision !== args.expectedRevision) {
    throw new AudioProjectError(
      'revision_conflict',
      `audio project revision changed from ${args.expectedRevision} to ${current.revision}`,
      current.revision,
    );
  }

  let document = toProjectDocument(current);

  if (args.removeEventEntityIds?.length) {
    document = { ...document, events: removeById(document.events, args.removeEventEntityIds) };
  }
  if (args.removeObjectIds?.length) {
    document = { ...document, objects: removeById(document.objects, args.removeObjectIds) };
  }
  if (args.removeEventIds?.length) {
    const names = new Set(args.removeEventIds);
    const removedEvents = document.events.filter((event) => names.has(event.name));
    const removedIds = new Set(removedEvents.map((event) => event.id));
    document = {
      ...document,
      events: document.events.filter((event) => !removedIds.has(event.id)),
    };
  }

  if (args.upsertObjects?.length) {
    document = { ...document, objects: mergeById(document.objects, args.upsertObjects) };
  }
  if (args.upsertEvents?.length) {
    document = { ...document, events: mergeById(document.events, args.upsertEvents) };
  }

  if (args.upsertBindings?.length) {
    const prepared = args.upsertBindings.map((binding) => (
      applyArchetypeDefaults({ ...(binding as unknown as Record<string, unknown>) })
    ));
    const v1 = normalizeAudioProjectV1({ bindings: prepared }, args.projectId);
    const migrated = migrateV1ToV2({ ...v1, projectId: args.projectId, revision: 0, status: 'draft', updatedAt: '' });
    const existingObjects = new Map(document.objects.map((object) => [object.id, object]));
    const existingEvents = new Map(document.events.map((event) => [event.id, event]));
    const objects = migrated.objects.map(
      (object) => keepAuthoredV2Fields(existingObjects.get(object.id), object),
    );
    const events = migrated.events.map(
      (event) => keepEventProvenance(existingEvents.get(event.id), event),
    );
    document = {
      ...document,
      objects: mergeById(document.objects, objects),
      events: mergeById(document.events, events),
      gameSyncs: {
        states: mergeById(document.gameSyncs.states, migrated.gameSyncs.states),
        switches: mergeById(document.gameSyncs.switches, migrated.gameSyncs.switches),
        rtpcs: mergeById(document.gameSyncs.rtpcs, migrated.gameSyncs.rtpcs),
      },
    };
  }

  document = pruneOrphans(document);
  const now = deps.now?.() ?? new Date();
  const plan = args.plan?.tone?.trim() || args.plan?.notes?.trim()
    ? {
      ...(args.plan.tone?.trim() ? { tone: args.plan.tone.trim() } : {}),
      ...(args.plan.notes?.trim() ? { notes: args.plan.notes.trim() } : {}),
      recordedAt: now.toISOString(),
    }
    : document.plan;
  const next = attachLegacyBindings({
    ...document,
    ...(plan ? { plan } : {}),
    revision: current.revision + 1,
    status: 'draft',
    updatedAt: now.toISOString(),
  });
  await atomicWriteJson(join(gameDir, 'audio/project.draft.json'), toProjectDocument(next));
  return next;
}

async function assertRevision(
  current: AudioProject,
  expectedRevision: number,
): Promise<void> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new AudioProjectError('bad_input', 'expectedRevision must be a non-negative integer');
  }
  if (current.revision !== expectedRevision) {
    throw new AudioProjectError(
      'revision_conflict',
      `audio project revision changed from ${expectedRevision} to ${current.revision}`,
      current.revision,
    );
  }
}

async function writeDraft(
  gameDir: string,
  document: AudioProjectDocument,
  deps: AudioProjectStoreDeps = {},
): Promise<AudioProject> {
  const next = attachLegacyBindings({
    ...document,
    status: 'draft',
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  await atomicWriteJson(join(gameDir, 'audio/project.draft.json'), toProjectDocument(next));
  return next;
}

export interface MigrateAudioProjectResult {
  before: AudioProjectDocument;
  after: AudioProjectDocument;
  diffSummary: {
    schemaBefore: string;
    schemaAfter: string;
    objects: number;
    events: number;
    switches: number;
    rtpcs: number;
    buses: number;
    attenuations: number;
    musicSegments: number;
  };
  project: AudioProject;
}

export async function migrateAudioProjectDraft(
  gameDir: string,
  args: { projectId: string; expectedRevision: number },
  deps: AudioProjectStoreDeps = {},
): Promise<MigrateAudioProjectResult> {
  const audioDir = join(gameDir, 'audio');
  const rawDraft = await readJson(join(audioDir, 'project.draft.json'));
  const rawApplied = rawDraft === undefined ? await readJson(join(audioDir, 'project.json')) : undefined;
  const raw = rawDraft ?? rawApplied;
  const current = await readAudioProject(gameDir, args.projectId);
  await assertRevision(current, args.expectedRevision);

  const schemaBefore = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? String((raw as { schemaVersion?: unknown }).schemaVersion
      ?? (Array.isArray((raw as { bindings?: unknown }).bindings) ? AUDIO_PROJECT_SCHEMA_V1 : AUDIO_PROJECT_SCHEMA))
    : AUDIO_PROJECT_SCHEMA_V1;
  const before = toProjectDocument(current);

  // Persist the in-memory v2 document so a v1-on-disk draft becomes v2 on disk.
  const project = await writeDraft(gameDir, {
    ...before,
    revision: current.revision + 1,
    status: 'draft',
  }, deps);
  const after = toProjectDocument(project);
  return {
    before,
    after,
    diffSummary: {
      schemaBefore,
      schemaAfter: AUDIO_PROJECT_SCHEMA,
      objects: after.objects.length,
      events: after.events.length,
      switches: after.gameSyncs.switches.length,
      rtpcs: after.gameSyncs.rtpcs.length,
      buses: after.buses.length,
      attenuations: after.attenuations.length,
      musicSegments: after.music?.segments.length ?? 0,
    },
    project,
  };
}

export interface DefineGameSyncArgs {
  projectId: string;
  expectedRevision: number;
  states?: StateGroup[];
  switches?: SwitchGroup[];
  rtpcs?: RtpcDefinition[];
}

export async function defineGameSync(
  gameDir: string,
  args: DefineGameSyncArgs,
  deps: AudioProjectStoreDeps = {},
): Promise<AudioProject> {
  const current = await readAudioProject(gameDir, args.projectId);
  await assertRevision(current, args.expectedRevision);
  const document = toProjectDocument(current);
  return writeDraft(gameDir, {
    ...document,
    revision: current.revision + 1,
    gameSyncs: {
      states: args.states?.length ? mergeById(document.gameSyncs.states, args.states) : document.gameSyncs.states,
      switches: args.switches?.length
        ? mergeById(document.gameSyncs.switches, args.switches)
        : document.gameSyncs.switches,
      rtpcs: args.rtpcs?.length ? mergeById(document.gameSyncs.rtpcs, args.rtpcs) : document.gameSyncs.rtpcs,
    },
  }, deps);
}

export interface DefineBusArgs {
  projectId: string;
  expectedRevision: number;
  buses: AudioBusNode[];
}

export async function defineBus(
  gameDir: string,
  args: DefineBusArgs,
  deps: AudioProjectStoreDeps = {},
): Promise<AudioProject> {
  const current = await readAudioProject(gameDir, args.projectId);
  await assertRevision(current, args.expectedRevision);
  const document = toProjectDocument(current);
  return writeDraft(gameDir, {
    ...document,
    revision: current.revision + 1,
    buses: mergeById(document.buses, args.buses),
  }, deps);
}

export interface DefineAttenuationArgs {
  projectId: string;
  expectedRevision: number;
  attenuations: AttenuationShareSet[];
}

export async function defineAttenuation(
  gameDir: string,
  args: DefineAttenuationArgs,
  deps: AudioProjectStoreDeps = {},
): Promise<AudioProject> {
  const current = await readAudioProject(gameDir, args.projectId);
  await assertRevision(current, args.expectedRevision);
  const document = toProjectDocument(current);
  return writeDraft(gameDir, {
    ...document,
    revision: current.revision + 1,
    attenuations: mergeById(document.attenuations, args.attenuations),
  }, deps);
}

export interface AuthorMusicArgs {
  projectId: string;
  expectedRevision: number;
  segments?: MusicSegment[];
  playlists?: MusicPlaylist[];
  transitions?: MusicTransition[];
  stingers?: MusicStinger[];
  /** When true, replace transitions wholesale instead of appending. */
  replaceTransitions?: boolean;
}

function mergeMusicFragment(
  current: MusicProject | undefined,
  args: AuthorMusicArgs,
): MusicProject {
  const base = current ?? emptyMusicProject();
  return {
    segments: args.segments?.length ? mergeById(base.segments, args.segments) : base.segments,
    playlists: args.playlists?.length ? mergeById(base.playlists, args.playlists) : base.playlists,
    transitions: args.replaceTransitions
      ? (args.transitions ?? [])
      : (args.transitions?.length ? [...base.transitions, ...args.transitions] : base.transitions),
    stingers: args.stingers?.length ? mergeById(base.stingers, args.stingers) : base.stingers,
  };
}

export async function authorMusic(
  gameDir: string,
  args: AuthorMusicArgs,
  deps: AudioProjectStoreDeps = {},
): Promise<AudioProject> {
  const current = await readAudioProject(gameDir, args.projectId);
  await assertRevision(current, args.expectedRevision);
  const document = toProjectDocument(current);
  return writeDraft(gameDir, {
    ...document,
    revision: current.revision + 1,
    music: mergeMusicFragment(document.music, args),
  }, deps);
}
