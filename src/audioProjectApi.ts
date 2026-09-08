import type {
  AttenuationShareSet,
  AudioBinding,
  AudioBusNode,
  AudioProject,
  MusicPlaylist,
  MusicSegment,
  MusicStinger,
  MusicTransition,
  RtpcDefinition,
  StateGroup,
  SwitchGroup,
} from '../shared/audio-project.ts';

export type AudioProjectToolId =
  | 'inspect-audio-events'
  | 'get-audio-project'
  | 'patch-audio-project'
  | 'apply-audio-project'
  | 'verify-audio-project'
  | 'define-game-sync'
  | 'define-bus'
  | 'define-attenuation'
  | 'author-music';

export interface AudioEventCandidate {
  eventId: string;
  file: string;
  line: number;
  source: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface AudioProjectVerification {
  ok: boolean;
  errors: Array<{ code: string; message: string; eventId?: string; path?: string }>;
  warnings: Array<{ code: string; message: string; eventId?: string; path?: string }>;
  instrumentedEventIds: string[];
}

export async function callAudioProjectTool<T>(
  toolId: AudioProjectToolId,
  args: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher('/api/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toolId, args, caller: { kind: 'user' } }),
  });
  const envelope = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    error?: string;
  };
  if (!response.ok || !envelope.ok || envelope.result === undefined) {
    throw new Error(envelope.error || `${toolId} 调用失败（HTTP ${response.status}）`);
  }
  return envelope.result;
}

export async function getAudioProject(slug: string): Promise<{
  project: AudioProject;
  appliedRevision: number | null;
}> {
  return callAudioProjectTool('get-audio-project', { slug });
}

export async function inspectAudioEvents(slug: string): Promise<{
  candidates: AudioEventCandidate[];
  scannedFiles: number;
}> {
  return callAudioProjectTool('inspect-audio-events', { slug });
}

export async function patchAudioProjectDraft(
  slug: string,
  expectedRevision: number,
  upsertBindings: AudioBinding[],
  removeEventIds: string[],
): Promise<{ project: AudioProject }> {
  return callAudioProjectTool('patch-audio-project', {
    slug,
    expectedRevision,
    upsertBindings,
    removeEventIds,
  });
}

export async function applyAudioProjectDraft(
  slug: string,
  expectedRevision: number,
): Promise<{ project: AudioProject; files: string[] }> {
  return callAudioProjectTool('apply-audio-project', { slug, expectedRevision });
}

export async function verifyAppliedAudioProject(slug: string): Promise<AudioProjectVerification> {
  return callAudioProjectTool('verify-audio-project', { slug });
}

export async function defineGameSyncDraft(
  slug: string,
  expectedRevision: number,
  patch: {
    states?: StateGroup[];
    switches?: SwitchGroup[];
    rtpcs?: RtpcDefinition[];
  },
): Promise<{ project: AudioProject }> {
  return callAudioProjectTool('define-game-sync', {
    slug,
    expectedRevision,
    ...patch,
  });
}

export async function defineBusDraft(
  slug: string,
  expectedRevision: number,
  buses: AudioBusNode[],
): Promise<{ project: AudioProject }> {
  return callAudioProjectTool('define-bus', { slug, expectedRevision, buses });
}

export async function defineAttenuationDraft(
  slug: string,
  expectedRevision: number,
  attenuations: AttenuationShareSet[],
): Promise<{ project: AudioProject }> {
  return callAudioProjectTool('define-attenuation', { slug, expectedRevision, attenuations });
}

export async function authorMusicDraft(
  slug: string,
  expectedRevision: number,
  patch: {
    segments?: MusicSegment[];
    playlists?: MusicPlaylist[];
    transitions?: MusicTransition[];
    stingers?: MusicStinger[];
    replaceTransitions?: boolean;
  },
): Promise<{ project: AudioProject }> {
  return callAudioProjectTool('author-music', {
    slug,
    expectedRevision,
    ...patch,
  });
}
