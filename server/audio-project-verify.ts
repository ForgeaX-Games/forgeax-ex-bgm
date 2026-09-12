import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  audioBindingAssets,
  normalizeAudioProject,
  type AudioBusNode,
  type AudioNode,
  type AudioProject,
  type CurvePoint,
} from '../shared/audio-project.ts';
import { archetypeVolumeDrift, varietyShortfall } from '../shared/event-archetypes.ts';
import { inspectAudioEvents } from './audio-event-inspector.ts';
import { resolveGameAudioFile } from './audio-file-resolve.ts';
import { evaluateRuntimeEvidence, parseRuntimeEvidence } from './runtime-evidence.ts';

export interface AudioProjectDiagnostic {
  code: string;
  message: string;
  eventId?: string;
  file?: string;
}

export type AudioVerificationPhase = 'preparation' | 'integration' | 'runtime';

export interface AudioProjectVerification {
  phase: AudioVerificationPhase;
  nextStep: string;
  ok: boolean;
  errors: AudioProjectDiagnostic[];
  warnings: AudioProjectDiagnostic[];
  instrumentedEventIds: string[];
}

const SILENCE_DB = -60;
const VOICE_LIMIT_WARN = 128;

/** Parent-link cycle detection for authoring bus nodes (mirrors runtime busGraphHasCycle). */
export function audioBusGraphHasCycle(buses: AudioBusNode[]): boolean {
  const parent = new Map(buses.map((bus) => [bus.id, bus.parentId]));
  for (const bus of buses) {
    const seen = new Set<string>();
    let current: string | undefined = bus.id;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = parent.get(current);
    }
  }
  // Aux-send edges can also introduce cycles relative to the bus graph.
  const adj = new Map<string, string[]>();
  for (const bus of buses) {
    const edges = [...(adj.get(bus.id) ?? [])];
    if (bus.parentId) edges.push(bus.parentId);
    for (const send of bus.auxSends ?? []) edges.push(send.busId);
    adj.set(bus.id, edges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const bus of buses) {
    if (dfs(bus.id)) return true;
  }
  return false;
}

function walkNodes(node: AudioNode, visit: (node: AudioNode) => void): void {
  visit(node);
  switch (node.kind) {
    case 'sound':
      return;
    case 'random':
    case 'sequence':
      for (const child of node.children) walkNodes(child, visit);
      return;
    case 'switch':
      for (const child of Object.values(node.assignments)) walkNodes(child, visit);
      if (node.defaultNode) walkNodes(node.defaultNode, visit);
      return;
    case 'blend':
      for (const layer of node.layers) walkNodes(layer.node, visit);
      return;
  }
}

function curveYAtOrBeyond(curve: CurvePoint[], x: number): number | undefined {
  if (!curve.length) return undefined;
  const sorted = [...curve].sort((a, b) => a.x - b.x);
  const last = sorted[sorted.length - 1]!;
  if (x >= last.x) return last.y;
  for (let index = 0; index < sorted.length - 1; index++) {
    const a = sorted[index]!;
    const b = sorted[index + 1]!;
    if (x >= a.x && x <= b.x) {
      if (b.x === a.x) return b.y;
      const t = (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return sorted[0]!.y;
}

function blendLayerIssues(
  layers: Array<{ rangeStart: number; rangeEnd: number }>,
  rtpcMin: number,
  rtpcMax: number,
): string[] {
  const issues: string[] = [];
  if (layers.length === 0) {
    issues.push('has no layers');
    return issues;
  }
  const sorted = [...layers].sort((a, b) => a.rangeStart - b.rangeStart || a.rangeEnd - b.rangeEnd);
  for (const layer of sorted) {
    if (!(layer.rangeEnd > layer.rangeStart)) {
      issues.push(`layer range [${layer.rangeStart}, ${layer.rangeEnd}] is empty`);
    }
  }
  let coverage = rtpcMin;
  for (const layer of sorted) {
    if (layer.rangeStart > coverage + 1e-9) {
      issues.push(`gap between ${coverage} and ${layer.rangeStart}`);
    }
    // Ambiguous overlap: more than one layer covering the same open interval.
    const overlapping = sorted.filter((other) => (
      other !== layer
      && other.rangeStart < layer.rangeEnd
      && other.rangeEnd > layer.rangeStart
      && !(Math.abs(other.rangeEnd - layer.rangeStart) < 1e-9
        || Math.abs(layer.rangeEnd - other.rangeStart) < 1e-9)
    ));
    if (overlapping.length > 0) {
      issues.push(`ambiguous overlap around [${layer.rangeStart}, ${layer.rangeEnd}]`);
    }
    coverage = Math.max(coverage, layer.rangeEnd);
  }
  if (coverage + 1e-9 < rtpcMax) {
    issues.push(`gap between ${coverage} and ${rtpcMax}`);
  }
  return [...new Set(issues)];
}

function verifyV2Structure(
  project: AudioProject,
  errors: AudioProjectDiagnostic[],
  warnings: AudioProjectDiagnostic[],
): void {
  const objectIds = new Set(project.objects.map((object) => object.id));
  const busIds = new Set(project.buses.map((bus) => bus.id));
  const stateIds = new Set(project.gameSyncs.states.map((item) => item.id));
  const switchIds = new Map(project.gameSyncs.switches.map((item) => [item.id, item]));
  const rtpcIds = new Map(project.gameSyncs.rtpcs.map((item) => [item.id, item]));
  const attenuationIds = new Set(project.attenuations.map((item) => item.id));

  const eventNames = new Map<string, string[]>();
  for (const event of project.events) {
    const list = eventNames.get(event.name) ?? [];
    list.push(event.id);
    eventNames.set(event.name, list);
  }
  for (const [name, ids] of eventNames) {
    if (ids.length > 1) {
      errors.push({
        code: 'duplicate_event_name',
        eventId: name,
        message: `duplicate event name '${name}' (${ids.join(', ')})`,
      });
    }
  }

  for (const event of project.events) {
    for (const action of event.actions) {
      if ((action.type === 'play' || action.type === 'stop') && !objectIds.has(action.objectId)) {
        errors.push({
          code: 'unresolved_object_id',
          eventId: event.name,
          message: `event '${event.name}' references missing objectId '${action.objectId}'`,
        });
      }
      if (action.type === 'setSwitch' && !switchIds.has(action.groupId)) {
        errors.push({
          code: 'unresolved_group_id',
          eventId: event.name,
          message: `event '${event.name}' references missing switch groupId '${action.groupId}'`,
        });
      }
      if (action.type === 'setState' && !stateIds.has(action.groupId)) {
        errors.push({
          code: 'unresolved_group_id',
          eventId: event.name,
          message: `event '${event.name}' references missing state groupId '${action.groupId}'`,
        });
      }
      if (action.type === 'setBusVolume' && !busIds.has(action.busId)) {
        errors.push({
          code: 'unresolved_bus_id',
          eventId: event.name,
          message: `event '${event.name}' references missing busId '${action.busId}'`,
        });
      }
    }
  }

  for (const object of project.objects) {
    if (!busIds.has(object.outputBusId)) {
      errors.push({
        code: 'unresolved_bus_id',
        message: `object '${object.id}' references missing outputBusId '${object.outputBusId}'`,
      });
    }
    if (object.attenuationId && !attenuationIds.has(object.attenuationId)) {
      errors.push({
        code: 'unresolved_attenuation_id',
        message: `object '${object.id}' references missing attenuationId '${object.attenuationId}'`,
      });
    }
    for (const binding of object.rtpcBindings) {
      const rtpc = rtpcIds.get(binding.rtpcId);
      if (!rtpc) {
        errors.push({
          code: 'unresolved_rtpc_id',
          message: `object '${object.id}' references missing rtpcId '${binding.rtpcId}'`,
        });
        continue;
      }
      for (const point of binding.curve) {
        if (point.x < rtpc.min || point.x > rtpc.max) {
          errors.push({
            code: 'rtpc_curve_out_of_range',
            message: `object '${object.id}' RTPC curve x=${point.x} outside [${rtpc.min}, ${rtpc.max}]`,
          });
        }
      }
    }
    for (const offset of object.stateOffsets) {
      if (!stateIds.has(offset.groupId)) {
        errors.push({
          code: 'unresolved_group_id',
          message: `object '${object.id}' references missing state groupId '${offset.groupId}'`,
        });
      }
    }

    walkNodes(object.node, (node) => {
      if (node.kind === 'switch') {
        const group = switchIds.get(node.groupId);
        if (!group) {
          errors.push({
            code: 'unresolved_group_id',
            message: `object '${object.id}' switch references missing groupId '${node.groupId}'`,
          });
          return;
        }
        const assignmentCovers = (value: string): boolean => {
          if (value in node.assignments) return true;
          return Object.keys(node.assignments).some((key) => {
            const separator = key.indexOf(':');
            return separator >= 0 ? key.slice(separator + 1) === value : key === value;
          });
        };
        const missing = group.values.filter((value) => !assignmentCovers(value));
        if (missing.length > 0) {
          const diagnostic: AudioProjectDiagnostic = {
            code: 'switch_missing_branch',
            message: `object '${object.id}' switch '${group.id}' missing branches: ${missing.join(', ')}`,
          };
          if (node.defaultNode) warnings.push(diagnostic);
          else errors.push(diagnostic);
        }
      }
      if (node.kind === 'blend') {
        const rtpc = rtpcIds.get(node.rtpcId);
        if (!rtpc) {
          errors.push({
            code: 'unresolved_rtpc_id',
            message: `object '${object.id}' blend references missing rtpcId '${node.rtpcId}'`,
          });
          return;
        }
        for (const issue of blendLayerIssues(node.layers, rtpc.min, rtpc.max)) {
          errors.push({
            code: 'blend_layer_invalid',
            message: `object '${object.id}' blend ${issue}`,
          });
        }
      }
    });
  }

  if (audioBusGraphHasCycle(project.buses)) {
    errors.push({
      code: 'bus_cycle',
      message: 'bus graph contains a cycle (parent or aux-send links)',
    });
  }
  for (const bus of project.buses) {
    if (typeof bus.voiceLimit === 'number' && bus.voiceLimit > VOICE_LIMIT_WARN) {
      warnings.push({
        code: 'bus_voice_limit_high',
        message: `bus '${bus.id}' voiceLimit ${bus.voiceLimit} exceeds ${VOICE_LIMIT_WARN}`,
      });
    }
    for (const send of bus.auxSends ?? []) {
      if (!busIds.has(send.busId)) {
        errors.push({
          code: 'unresolved_bus_id',
          message: `bus '${bus.id}' aux send references missing busId '${send.busId}'`,
        });
      }
    }
    if (bus.parentId && !busIds.has(bus.parentId)) {
      errors.push({
        code: 'unresolved_bus_id',
        message: `bus '${bus.id}' references missing parentId '${bus.parentId}'`,
      });
    }
  }

  for (const attenuation of project.attenuations) {
    const y = curveYAtOrBeyond(attenuation.curves.outputVolumeDb ?? [], attenuation.maxDistance);
    if (y !== undefined && y > SILENCE_DB) {
      warnings.push({
        code: 'attenuation_never_silent',
        message: `attenuation '${attenuation.id}' outputVolumeDb is ${y} dB at maxDistance (expected ≤ ${SILENCE_DB})`,
      });
    }
  }

  const music = project.music;
  if (music) {
    const segmentIds = new Set(music.segments.map((item) => item.id));
    const playlistIds = new Set(music.playlists.map((item) => item.id));
    for (const transition of music.transitions) {
      if (transition.fromPlaylistId !== '*' && !playlistIds.has(transition.fromPlaylistId)) {
        errors.push({
          code: 'music_transition_unresolved',
          message: `music transition references missing playlist '${transition.fromPlaylistId}'`,
        });
      }
      if (transition.toPlaylistId !== '*' && !playlistIds.has(transition.toPlaylistId)) {
        errors.push({
          code: 'music_transition_unresolved',
          message: `music transition references missing playlist '${transition.toPlaylistId}'`,
        });
      }
      if (transition.transitionSegmentId && !segmentIds.has(transition.transitionSegmentId)) {
        errors.push({
          code: 'music_transition_unresolved',
          message: `music transition references missing segment '${transition.transitionSegmentId}'`,
        });
      }
    }
    for (const playlist of music.playlists) {
      for (const segmentId of playlist.segmentIds) {
        if (!segmentIds.has(segmentId)) {
          errors.push({
            code: 'music_transition_unresolved',
            message: `music playlist '${playlist.id}' references missing segment '${segmentId}'`,
          });
        }
      }
    }
    for (const stinger of music.stingers) {
      if (!segmentIds.has(stinger.segmentId)) {
        errors.push({
          code: 'music_transition_unresolved',
          message: `music stinger '${stinger.id}' references missing segment '${stinger.segmentId}'`,
        });
      }
    }
  }
}

export async function verifyAudioProject(
  gameDir: string,
  project: AudioProject,
  options: { requireRuntime?: boolean; runtimeEvidence?: unknown; phase?: AudioVerificationPhase } = {},
): Promise<AudioProjectVerification> {
  const phase = options.phase ?? (options.runtimeEvidence !== undefined ? 'runtime' : 'integration');
  const errors: AudioProjectDiagnostic[] = [];
  const warnings: AudioProjectDiagnostic[] = [];
  let normalized: AudioProject;
  try {
    normalized = normalizeAudioProject(project, project.projectId);
  } catch (error) {
    return {
      ok: false,
      phase,
      nextStep: 'Repair the audio project structure before continuing.',
      errors: [{ code: 'project_invalid', message: error instanceof Error ? error.message : String(error) }],
      warnings,
      instrumentedEventIds: [],
    };
  }

  const exists = async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };

  let manifestAssets: Set<string> | null = null;
  try {
    const manifest = JSON.parse(await readFile(join(gameDir, 'audio', 'manifest.json'), 'utf8')) as {
      tracks?: Array<{ assetId?: unknown }>;
    };
    manifestAssets = new Set((manifest.tracks ?? [])
      .map((track) => track.assetId)
      .filter((assetId): assetId is string => typeof assetId === 'string' && assetId.length > 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (normalized.bindings.some((binding) => binding.assets.length > 0)) {
        warnings.push({
          code: 'manifest_missing',
          message: 'audio/manifest.json is missing; asset provider/provenance cannot be verified',
        });
      }
    } else {
      warnings.push({ code: 'manifest_invalid', message: `audio manifest cannot be read: ${(error as Error).message}` });
    }
  }

  for (const binding of normalized.bindings) {
    if (!binding.enabled) {
      warnings.push({
        code: 'binding_disabled',
        eventId: binding.eventId,
        message: `binding '${binding.eventId}' is disabled`,
      });
      if (phase !== 'preparation') continue;
    }
    if (binding.assets.length === 0) {
      errors.push({
        code: 'binding_assets_empty',
        eventId: binding.eventId,
        message: `binding '${binding.eventId}' has no audio assets`,
      });
      continue;
    }
    for (const asset of audioBindingAssets(binding)) {
      if (!await exists(resolveGameAudioFile(gameDir, asset.file) ?? '')) {
        errors.push({
          code: 'asset_missing',
          eventId: binding.eventId,
          file: asset.file,
          message: `audio asset '${asset.file}' does not exist`,
        });
      }
      if (manifestAssets && !manifestAssets.has(asset.assetId)) {
        warnings.push({
          code: 'asset_not_in_manifest',
          eventId: binding.eventId,
          file: asset.file,
          message: `audio asset '${asset.assetId}' is not registered in audio/manifest.json`,
        });
      }
    }
  }

  verifyV2Structure(normalized, errors, warnings);

  const requireRuntime = phase === 'runtime' || (phase === 'integration' && (options.requireRuntime ?? normalized.status === 'applied'));
  if (requireRuntime) {
    const runtimeFiles = [
      'src/forgeax-audio/generated-bindings.ts',
      'src/forgeax-audio/index.ts',
      'src/forgeax-audio/runtime.ts',
    ];
    for (const file of runtimeFiles) {
      if (!await exists(join(gameDir, file))) {
        errors.push({
          code: 'runtime_missing',
          file,
          message: `generated runtime file '${file}' does not exist`,
        });
      }
    }
  }

  const inspection = await inspectAudioEvents(gameDir);
  const instrumentedEventIds = [...new Set(
    inspection.candidates
      .filter((candidate) => candidate.source === 'game-audio' || candidate.source === 'legacy-audio')
      .map((candidate) => candidate.eventId),
  )].sort();
  const instrumented = new Set(instrumentedEventIds);
  const filesByEvent = new Map<string, string[]>();
  for (const candidate of inspection.candidates) {
    if (candidate.source !== 'game-audio' && candidate.source !== 'legacy-audio') continue;
    const files = filesByEvent.get(candidate.eventId) ?? [];
    files.push(candidate.file);
    filesByEvent.set(candidate.eventId, files);
  }

  // Coverage — a file exists, an emit exists, it played once — says nothing about
  // whether the player hears the same take four hundred times. These are the
  // richness findings: reported, never fatal, because one clip can be the right
  // call as long as it was a decision rather than a default nobody revisited.
  for (const binding of normalized.bindings) {
    if (!binding.enabled) continue;
    const planned = binding.plannedVariants;
    const actual = binding.assets.length;
    if (typeof planned === 'number' && actual < planned) {
      warnings.push({
        code: 'plan_variants_unmet',
        eventId: binding.eventId,
        message:
          `event '${binding.eventId}' was planned with ${planned} variant(s) but has ${actual}; `
          + 'the audio plan is the acceptance criterion, so either generate the rest or restate it',
      });
      continue;
    }
    if (planned === undefined) {
      const shortfall = varietyShortfall(binding);
      if (shortfall) {
        warnings.push({
          code: shortfall.code,
          eventId: shortfall.eventId,
          message: shortfall.message,
        });
      }
    }
    const drift = archetypeVolumeDrift(binding);
    if (drift) {
      warnings.push({ code: drift.code, eventId: drift.eventId, message: drift.message });
    }
  }

  for (const binding of normalized.bindings) {
    const provenance = binding.provenance;
    if (provenance?.status === 'gap' && binding.enabled) {
      errors.push({
        code: 'provenance_gap_enabled',
        eventId: binding.eventId,
        message:
          `event '${binding.eventId}' is marked as a hook gap and must stay disabled `
          + 'until a settle point exists',
      });
    }
    if (!binding.enabled) continue;
    if (!instrumented.has(binding.eventId)) {
      (phase === 'preparation' ? warnings : errors).push({
        code: 'event_not_instrumented',
        eventId: binding.eventId,
        message: `event '${binding.eventId}' has no literal gameAudio.emit/play call`,
      });
      continue;
    }
    if (provenance?.status === 'wired' && provenance.file) {
      const actual = filesByEvent.get(binding.eventId) ?? [];
      if (!actual.some((file) => hookFilesMatch(provenance.file!, file))) {
        warnings.push({
          code: 'provenance_drift',
          eventId: binding.eventId,
          file: provenance.file,
          message:
            `event '${binding.eventId}' was recorded on '${provenance.file}'`
            + `${provenance.symbol ? ` (${provenance.symbol})` : ''}, but emit is now in `
            + `${actual.join(', ') || 'an unknown file'}`,
        });
      }
    }
  }

  if (options.runtimeEvidence !== undefined) {
    try {
      const evidence = parseRuntimeEvidence(options.runtimeEvidence);
      if (evidence.projectId !== undefined && evidence.projectId !== normalized.projectId) {
        errors.push({ code: 'runtime_project_mismatch', message: 'Runtime evidence belongs to another audio project; capture this game in Play.' });
      }
      const evaluated = evaluateRuntimeEvidence(evidence);
      errors.push(...evaluated.errors);
      warnings.push(...evaluated.warnings);
    } catch (error) {
      errors.push({
        code: 'runtime_evidence_invalid',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (phase === 'runtime' && options.runtimeEvidence === undefined) {
    errors.push({ code: 'runtime_evidence_missing', message: 'Capture getProfilerSnapshot() during real game interaction; static checks do not prove playback.' });
  }
  const nextStep = errors.length > 0
    ? 'Repair the reported diagnostics; rerun only after the affected inputs change.'
    : phase === 'preparation'
      ? 'Preparation checks passed. Hand off asset paths and pending gameplay hooks; continue integration when the gameplay owner supplies them. Playback is not verified.'
      : phase === 'integration'
        ? 'Static integration checks passed. Verify real gameplay in Play and submit runtimeEvidence; do not build a separate test player to claim game playback.'
        : 'Runtime evidence checks passed. Report the actual tested game interactions and any untested events.';
  return { ok: errors.length === 0, phase, nextStep, errors, warnings, instrumentedEventIds };
}

function hookFilesMatch(expected: string, actual: string): boolean {
  const left = expected.replace(/\\/g, '/').replace(/^\.\//, '');
  const right = actual.replace(/\\/g, '/').replace(/^\.\//, '');
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}
