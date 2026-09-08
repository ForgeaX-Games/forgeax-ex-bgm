import type { AudioEventContext, GameObjectId, RuntimeFollowValue } from '../types.ts';

export const GLOBAL_GAME_OBJECT_ID: GameObjectId = '__global__';

export interface GameObjectRegistry {
  resolveId(context?: AudioEventContext): GameObjectId;
  ensure(id: GameObjectId): void;
  unregister(id: GameObjectId): void;
  setValue(id: GameObjectId, field: string, value: RuntimeFollowValue): void;
  getValue(id: GameObjectId, field: string): RuntimeFollowValue | undefined;
  /** Flat map key used by resolvePlayback: `${scope}:${field}` plus bare field for global. */
  valuesView(): Map<string, RuntimeFollowValue>;
  clearScopeState(id: GameObjectId, maps: Array<Map<string, unknown>>): void;
  dispose(): void;
}

export function createGameObjectRegistry(): GameObjectRegistry {
  const known = new Set<GameObjectId>([GLOBAL_GAME_OBJECT_ID]);
  const values = new Map<string, RuntimeFollowValue>();

  const keyOf = (id: GameObjectId, field: string): string => `${id}:${field}`;

  return {
    resolveId(context) {
      const id = context?.gameObjectId;
      if (typeof id === 'string' && id.trim()) {
        known.add(id);
        return id;
      }
      return GLOBAL_GAME_OBJECT_ID;
    },
    ensure(id) {
      if (id) known.add(id);
    },
    unregister(id) {
      if (id === GLOBAL_GAME_OBJECT_ID) return;
      known.delete(id);
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${id}:`)) values.delete(key);
      }
    },
    setValue(id, field, value) {
      if (!field) return;
      known.add(id);
      values.set(keyOf(id, field), value);
      if (id === GLOBAL_GAME_OBJECT_ID) values.set(field, value);
    },
    getValue(id, field) {
      return values.get(keyOf(id, field)) ?? (id === GLOBAL_GAME_OBJECT_ID ? values.get(field) : undefined);
    },
    valuesView() {
      return values;
    },
    clearScopeState(id, maps) {
      const prefix = `${id}:`;
      for (const map of maps) {
        for (const key of [...map.keys()]) {
          if (typeof key === 'string' && key.startsWith(prefix)) map.delete(key);
        }
      }
    },
    dispose() {
      known.clear();
      known.add(GLOBAL_GAME_OBJECT_ID);
      values.clear();
    },
  };
}
