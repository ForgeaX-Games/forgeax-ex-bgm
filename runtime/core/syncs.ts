import type { GameObjectId } from '../types.ts';

export const GLOBAL_SCOPE: GameObjectId = '__global__';

export interface RtpcDefinition {
  id: string;
  name: string;
  min: number;
  max: number;
  defaultValue: number;
  scope: 'global' | 'gameObject';
  slewMsDefault: number;
}

export interface SwitchGroup {
  id: string;
  name: string;
  values: string[];
  defaultValue: string;
  rtpcId?: string;
}

export interface StateGroup {
  id: string;
  name: string;
  values: string[];
  defaultValue: string;
  transitions: Array<{ from: '*' | string; to: '*' | string; timeMs: number }>;
}

interface RtpcSlot {
  value: number;
  target: number;
  slewPerSecond: number;
}

export interface StateSnapshot {
  groupId: string;
  from: string;
  to: string;
  /** 0..1 progress of the configured transition time. */
  progress: number;
}

export interface GameSyncs {
  setState(groupId: string, value: string, audioTime: number): void;
  setSwitch(groupId: string, value: string, gameObjectId?: GameObjectId): void;
  setRTPC(rtpcId: string, value: number, gameObjectId?: GameObjectId, slewMs?: number): void;
  /** @deprecated Prefer setRTPC */
  setRtpc(rtpcId: string, value: number, gameObjectId?: GameObjectId, slewMs?: number): void;
  getRtpc(rtpcId: string, gameObjectId?: GameObjectId): number;
  getRTPC(rtpcId: string, gameObjectId?: GameObjectId): number;
  getSwitch(groupId: string, gameObjectId?: GameObjectId): string | undefined;
  getState(groupId: string): string | undefined;
  stateSnapshot(groupId: string, audioTime: number): StateSnapshot | undefined;
  tick(deltaSeconds: number): void;
  clearScope(gameObjectId: GameObjectId): void;
  dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createGameSyncs(input: {
  rtpcs?: RtpcDefinition[];
  switches?: SwitchGroup[];
  states?: StateGroup[];
} = {}): GameSyncs {
  const rtpcDefs = new Map((input.rtpcs ?? []).map((item) => [item.id, item]));
  const switchDefs = new Map((input.switches ?? []).map((item) => [item.id, item]));
  const stateDefs = new Map((input.states ?? []).map((item) => [item.id, item]));

  const rtpcValues = new Map<string, RtpcSlot>();
  const switchValues = new Map<string, string>();
  const stateValues = new Map<string, string>();
  const stateTransitions = new Map<string, { from: string; startedAt: number; durationSeconds: number }>();

  const key = (scope: GameObjectId, id: string): string => `${scope}:${id}`;

  const slotFor = (rtpcId: string, scope: GameObjectId): RtpcSlot => {
    const def = rtpcDefs.get(rtpcId);
    const scopeKey = key(scope, rtpcId);
    let slot = rtpcValues.get(scopeKey);
    if (!slot) {
      const initial = def?.defaultValue ?? 0;
      slot = { value: initial, target: initial, slewPerSecond: 0 };
      rtpcValues.set(scopeKey, slot);
    }
    return slot;
  };

  const transitionMs = (group: StateGroup, from: string, to: string): number => {
    let best: number | undefined;
    for (const rule of group.transitions) {
      const fromOk = rule.from === '*' || rule.from === from;
      const toOk = rule.to === '*' || rule.to === to;
      if (!fromOk || !toOk) continue;
      const specificity = (rule.from === '*' ? 0 : 1) + (rule.to === '*' ? 0 : 1);
      if (best === undefined || specificity > 0) best = rule.timeMs;
      if (specificity === 2) return rule.timeMs;
    }
    return best ?? 0;
  };

  const setRTPC = (
    rtpcId: string,
    value: number,
    gameObjectId?: GameObjectId,
    slewMs?: number,
  ): void => {
    const def = rtpcDefs.get(rtpcId);
    const scope = def?.scope === 'gameObject' && gameObjectId ? gameObjectId : GLOBAL_SCOPE;
    const slot = slotFor(rtpcId, scope);
    const bounded = def ? clamp(value, def.min, def.max) : value;
    const ms = slewMs ?? def?.slewMsDefault ?? 0;
    slot.target = bounded;
    if (ms <= 0) {
      slot.value = bounded;
      slot.slewPerSecond = 0;
    } else {
      slot.slewPerSecond = Math.abs(bounded - slot.value) / (ms / 1_000);
    }
  };

  const getRTPC = (rtpcId: string, gameObjectId?: GameObjectId): number => {
    const def = rtpcDefs.get(rtpcId);
    if (def?.scope === 'gameObject' && gameObjectId) {
      const scoped = rtpcValues.get(key(gameObjectId, rtpcId));
      if (scoped) return scoped.value;
    }
    return slotFor(rtpcId, GLOBAL_SCOPE).value;
  };

  return {
    setState(groupId, value, audioTime) {
      const group = stateDefs.get(groupId);
      const previous = stateValues.get(groupId) ?? group?.defaultValue ?? '';
      if (previous === value) return;
      stateValues.set(groupId, value);
      const ms = group ? transitionMs(group, previous, value) : 0;
      stateTransitions.set(groupId, {
        from: previous,
        startedAt: audioTime,
        durationSeconds: ms / 1_000,
      });
    },
    setSwitch(groupId, value, gameObjectId = GLOBAL_SCOPE) {
      switchValues.set(key(gameObjectId, groupId), value);
    },
    setRTPC,
    setRtpc: setRTPC,
    getRtpc: getRTPC,
    getRTPC,
    getSwitch(groupId, gameObjectId = GLOBAL_SCOPE) {
      return switchValues.get(key(gameObjectId, groupId))
        ?? switchValues.get(key(GLOBAL_SCOPE, groupId))
        ?? switchDefs.get(groupId)?.defaultValue;
    },
    getState(groupId) {
      return stateValues.get(groupId) ?? stateDefs.get(groupId)?.defaultValue;
    },
    stateSnapshot(groupId, audioTime) {
      const to = stateValues.get(groupId) ?? stateDefs.get(groupId)?.defaultValue;
      if (to === undefined) return undefined;
      const active = stateTransitions.get(groupId);
      if (!active) return { groupId, from: to, to, progress: 1 };
      if (active.durationSeconds <= 0) {
        return { groupId, from: active.from, to, progress: 1 };
      }
      const progress = clamp((audioTime - active.startedAt) / active.durationSeconds, 0, 1);
      return { groupId, from: active.from, to, progress };
    },
    tick(deltaSeconds) {
      if (deltaSeconds <= 0) return;
      for (const slot of rtpcValues.values()) {
        if (slot.value === slot.target) continue;
        if (slot.slewPerSecond <= 0) {
          slot.value = slot.target;
          continue;
        }
        const step = slot.slewPerSecond * deltaSeconds;
        const remaining = slot.target - slot.value;
        slot.value = Math.abs(remaining) <= step
          ? slot.target
          : slot.value + Math.sign(remaining) * step;
      }
    },
    clearScope(gameObjectId) {
      const prefix = `${gameObjectId}:`;
      for (const map of [rtpcValues, switchValues] as Array<Map<string, unknown>>) {
        for (const existing of [...map.keys()]) {
          if (existing.startsWith(prefix)) map.delete(existing);
        }
      }
    },
    dispose() {
      rtpcValues.clear();
      switchValues.clear();
      stateValues.clear();
      stateTransitions.clear();
    },
  };
}
