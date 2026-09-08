import { evaluateCurve } from '../curves.ts';
import type {
  GameObjectId,
  RuntimeAudioAsset,
  RuntimeAudioNode,
  RuntimeSelectionScope,
} from '../types.ts';

export interface ResolvedContainerAsset extends RuntimeAudioAsset {
  metadata?: {
    blendWeights?: Array<{ layerIndex: number; weight: number }>;
  };
}

export interface ResolveNodeContext {
  gameObjectId: GameObjectId;
  getSwitch: (groupId: string) => string | undefined;
  getRtpc: (rtpcId: string) => number;
  random: () => number;
  /** Optional root key; nested nodes append path segments. */
  rootKey?: string;
}

export interface ContainerResolver {
  resolveNode(node: RuntimeAudioNode, ctx: ResolveNodeContext): ResolvedContainerAsset | undefined;
  clearScope(gameObjectId: GameObjectId): void;
  dispose(): void;
}

const GLOBAL_SCOPE_KEY = '__global__';

function scopeKeyFor(scope: RuntimeSelectionScope, gameObjectId: GameObjectId): string {
  return scope === 'gameObject' ? gameObjectId : GLOBAL_SCOPE_KEY;
}

function nodeIdentity(node: RuntimeAudioNode, path: string): string {
  return node.nodeKey ?? path;
}

function pickWeightedIndex(weights: number[], random: () => number): number {
  if (weights.length === 0) return 0;
  let total = 0;
  for (const weight of weights) total += Math.max(0, weight);
  if (total <= 0) return Math.min(weights.length - 1, Math.floor(random() * weights.length));
  let cursor = random() * total;
  for (let index = 0; index < weights.length; index++) {
    cursor -= Math.max(0, weights[index]!);
    if (cursor <= 0) return index;
  }
  return weights.length - 1;
}

function blendWeight(value: number, start: number, end: number): number {
  if (end <= start) return value >= start ? 1 : 0;
  if (value <= start || value >= end) return 0;
  const mid = (start + end) / 2;
  const half = (end - start) / 2;
  if (half <= 0) return 1;
  return Math.max(0, 1 - Math.abs(value - mid) / half);
}

export function createContainerResolver(): ContainerResolver {
  const sequenceCursor = new Map<string, number>();
  const avoidRings = new Map<string, number[]>();

  const resolveAt = (
    node: RuntimeAudioNode,
    ctx: ResolveNodeContext,
    path: string,
  ): ResolvedContainerAsset | undefined => {
    const nodeKey = nodeIdentity(node, path);

    if (node.kind === 'sound') {
      return { ...node.asset };
    }

    if (node.kind === 'sequence') {
      if (node.children.length === 0) return undefined;
      const key = `${nodeKey}:${scopeKeyFor(node.scope, ctx.gameObjectId)}`;
      const previous = sequenceCursor.get(key) ?? -1;
      let next = previous + 1;
      if (next >= node.children.length) {
        if (!node.loop) return undefined;
        next = 0;
      }
      sequenceCursor.set(key, next);
      return resolveAt(node.children[next]!, ctx, `${path}/${next}`);
    }

    if (node.kind === 'random') {
      if (node.children.length === 0) return undefined;
      const key = `${nodeKey}:${scopeKeyFor(node.scope, ctx.gameObjectId)}`;
      const ring = avoidRings.get(key) ?? [];
      const weights = node.children.map((_, index) => node.weights[index] ?? 1);
      const avoid = Math.max(0, Math.min(node.avoidRepeatCount, node.children.length - 1));
      const blocked = new Set(ring.slice(-avoid));
      const eligible = node.children
        .map((_, index) => index)
        .filter((index) => !blocked.has(index));
      const pool = eligible.length > 0 ? eligible : node.children.map((_, index) => index);
      const poolWeights = pool.map((index) => weights[index]!);
      const pickedLocal = pickWeightedIndex(poolWeights, ctx.random);
      const index = pool[pickedLocal]!;
      ring.push(index);
      while (ring.length > Math.max(avoid, 1) * 2) ring.shift();
      avoidRings.set(key, ring);
      return resolveAt(node.children[index]!, ctx, `${path}/${index}`);
    }

    if (node.kind === 'switch') {
      const value = ctx.getSwitch(node.groupId);
      const branch = (value !== undefined ? node.assignments[value] : undefined)
        ?? node.defaultNode;
      if (!branch) return undefined;
      return resolveAt(branch, ctx, `${path}/sw:${value ?? 'default'}`);
    }

    if (node.kind === 'blend') {
      if (node.layers.length === 0) return undefined;
      const value = ctx.getRtpc(node.rtpcId);
      const weights = node.layers.map((layer, layerIndex) => {
        const raw = blendWeight(value, layer.rangeStart, layer.rangeEnd);
        const shaped = layer.crossfadeCurve?.length
          ? evaluateCurve(layer.crossfadeCurve, raw, raw)
          : raw;
        return { layerIndex, weight: Math.max(0, shaped) };
      });
      const active = weights.filter((item) => item.weight > 0);
      const ranked = (active.length > 0 ? active : weights)
        .slice()
        .sort((a, b) => b.weight - a.weight);
      const primary = ranked[0];
      if (!primary) return undefined;
      const resolved = resolveAt(node.layers[primary.layerIndex]!.node, ctx, `${path}/bl:${primary.layerIndex}`);
      if (!resolved) return undefined;
      return {
        ...resolved,
        metadata: {
          blendWeights: weights,
        },
      };
    }

    return undefined;
  };

  return {
    resolveNode(node, ctx) {
      return resolveAt(node, ctx, ctx.rootKey ?? 'root');
    },
    clearScope(gameObjectId) {
      const suffix = `:${gameObjectId}`;
      for (const map of [sequenceCursor, avoidRings] as Array<Map<string, unknown>>) {
        for (const key of [...map.keys()]) {
          if (key.endsWith(suffix)) map.delete(key);
        }
      }
    },
    dispose() {
      sequenceCursor.clear();
      avoidRings.clear();
    },
  };
}
