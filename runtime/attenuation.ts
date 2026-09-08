import { evaluateCurve, type CurvePoint } from './curves.ts';
import type {
  AudioListenerTransform,
  AudioPoint,
  RuntimeAttenuation,
  RuntimeCurvePoint,
} from './types.ts';

export interface AttenuationEvaluation {
  distance: number;
  volumeDb: number;
  lowpassHz?: number;
  highpassHz?: number;
  auxSendDb?: number;
  spread?: number;
  coneVolumeDb: number;
  obstructionDb: number;
  occlusionDb: number;
}

function asCurve(points: RuntimeCurvePoint[] | undefined): CurvePoint[] | undefined {
  return points as CurvePoint[] | undefined;
}

function distance3(a: AudioPoint, b: AudioPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function normalize(v: AudioPoint): AudioPoint {
  const length = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function dot(a: AudioPoint, b: AudioPoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function coneAttenuation(
  emitter: AudioPoint,
  emitterForward: AudioPoint | undefined,
  listener: AudioListenerTransform,
  cone: NonNullable<RuntimeAttenuation['cone']>,
): { volumeDb: number; lowpassHz?: number } {
  if (!emitterForward) return { volumeDb: 0 };
  const toListener = normalize({
    x: listener.position.x - emitter.x,
    y: listener.position.y - emitter.y,
    z: listener.position.z - emitter.z,
  });
  const forward = normalize(emitterForward);
  const cosAngle = clamp01((dot(forward, toListener) + 1) / 2) * 2 - 1;
  const angleDeg = Math.acos(Math.min(1, Math.max(-1, cosAngle))) * (180 / Math.PI);
  if (angleDeg <= cone.innerAngleDeg / 2) return { volumeDb: 0 };
  if (angleDeg >= cone.outerAngleDeg / 2) {
    return { volumeDb: cone.outerVolumeDb, lowpassHz: cone.outerLowpassHz };
  }
  const t = (angleDeg - cone.innerAngleDeg / 2)
    / Math.max(1e-6, (cone.outerAngleDeg - cone.innerAngleDeg) / 2);
  return {
    volumeDb: cone.outerVolumeDb * t,
    lowpassHz: 20_000 + (cone.outerLowpassHz - 20_000) * t,
  };
}

/**
 * Distance + cone from emitter/listener transforms, plus obstruction/occlusion offsets.
 */
export function evaluateAttenuation(input: {
  attenuation: RuntimeAttenuation;
  emitter: AudioPoint & { forward?: AudioPoint };
  listener: AudioListenerTransform;
  /** 0..1 — maps to a simple linear dB / lowpass offset. */
  obstruction?: number;
  /** 0..1 — maps to a simple linear dB / lowpass offset. */
  occlusion?: number;
}): AttenuationEvaluation {
  const distance = distance3(input.emitter, input.listener.position);
  const clampedDistance = Math.min(distance, input.attenuation.maxDistance);
  const volumeDb = evaluateCurve(
    asCurve(input.attenuation.curves.outputVolumeDb),
    clampedDistance,
    0,
  );
  const lowpassFromDistance = input.attenuation.curves.lowpassHz
    ? evaluateCurve(asCurve(input.attenuation.curves.lowpassHz), clampedDistance)
    : undefined;
  const highpassHz = input.attenuation.curves.highpassHz
    ? evaluateCurve(asCurve(input.attenuation.curves.highpassHz), clampedDistance)
    : undefined;
  const auxSendDb = input.attenuation.curves.auxSendDb
    ? evaluateCurve(asCurve(input.attenuation.curves.auxSendDb), clampedDistance)
    : undefined;
  const spread = input.attenuation.curves.spread
    ? evaluateCurve(asCurve(input.attenuation.curves.spread), clampedDistance)
    : undefined;

  const cone = input.attenuation.cone
    ? coneAttenuation(input.emitter, input.emitter.forward, input.listener, input.attenuation.cone)
    : { volumeDb: 0 as number, lowpassHz: undefined as number | undefined };

  const obstruction = clamp01(input.obstruction ?? 0);
  const occlusion = clamp01(input.occlusion ?? 0);
  // Simple linear mappings kept intentionally tiny and predictable for tests.
  const obstructionDb = -24 * obstruction;
  const occlusionDb = -36 * occlusion;
  const obstructionLowpass = obstruction > 0 ? 20_000 - 14_000 * obstruction : undefined;
  const occlusionLowpass = occlusion > 0 ? 20_000 - 16_000 * occlusion : undefined;

  let lowpassHz = lowpassFromDistance;
  for (const candidate of [cone.lowpassHz, obstructionLowpass, occlusionLowpass]) {
    if (candidate === undefined) continue;
    lowpassHz = lowpassHz === undefined ? candidate : Math.min(lowpassHz, candidate);
  }

  return {
    distance,
    volumeDb: volumeDb + cone.volumeDb + obstructionDb + occlusionDb,
    lowpassHz,
    highpassHz,
    auxSendDb,
    spread,
    coneVolumeDb: cone.volumeDb,
    obstructionDb,
    occlusionDb,
  };
}
