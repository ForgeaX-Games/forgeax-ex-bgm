import type { RuntimeBusNode } from '../types.ts';

export interface BusGraphState {
  busId: string;
  volumeDb: number;
  duckDb: number;
  activeVoices: number;
}

export interface BusGraph {
  buses(): RuntimeBusNode[];
  noteVoiceStart(busId: string): void;
  noteVoiceStop(busId: string): void;
  setVolumeDb(busId: string, volumeDb: number): void;
  /** Returns linear gain multipliers after ducking for each bus id. */
  tickDucking(audioTime: number): Map<string, number>;
  state(busId: string): BusGraphState | undefined;
  dispose(): void;
}

function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

export function defaultRuntimeBuses(): RuntimeBusNode[] {
  return [
    { id: 'bus:master', name: 'Master', volumeDb: 0, ducking: [] },
    { id: 'bus:sfx', name: 'SFX', parentId: 'bus:master', volumeDb: 0, ducking: [] },
    { id: 'bus:music', name: 'Music', parentId: 'bus:master', volumeDb: 0, ducking: [] },
    { id: 'bus:voice', name: 'Voice', parentId: 'bus:master', volumeDb: 0, ducking: [] },
  ];
}

/** Detect cycles including aux-less parent links. */
export function busGraphHasCycle(buses: RuntimeBusNode[]): boolean {
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
  return false;
}

/**
 * Logical bus graph + ducking. Physical Web Audio nodes stay in the port;
 * this module owns voice counts and duck automation curves.
 */
export function createBusGraph(buses: RuntimeBusNode[]): BusGraph {
  const list = buses.length ? buses : defaultRuntimeBuses();
  if (busGraphHasCycle(list)) {
    throw new Error('bus graph contains a cycle');
  }
  const states = new Map<string, BusGraphState>(
    list.map((bus) => [bus.id, {
      busId: bus.id,
      volumeDb: bus.volumeDb,
      duckDb: 0,
      activeVoices: 0,
    }]),
  );
  const byId = new Map(list.map((bus) => [bus.id, bus]));
  const duckProgress = new Map<string, number>(); // 0..1 toward ducked

  return {
    buses: () => list,
    noteVoiceStart(busId) {
      const state = states.get(busId);
      if (state) state.activeVoices += 1;
    },
    noteVoiceStop(busId) {
      const state = states.get(busId);
      if (state) state.activeVoices = Math.max(0, state.activeVoices - 1);
    },
    setVolumeDb(busId, volumeDb) {
      const state = states.get(busId);
      if (state) state.volumeDb = volumeDb;
    },
    tickDucking(_audioTime) {
      const gains = new Map<string, number>();
      for (const bus of list) {
        let target = 0;
        for (const rule of bus.ducking) {
          const source = states.get(rule.sourceBusId);
          if (source && source.activeVoices > 0) {
            target = Math.min(target, rule.volumeDb);
          }
        }
        const key = bus.id;
        const current = duckProgress.get(key) ?? 0;
        const attack = bus.ducking[0]?.attackMs ?? 50;
        const release = bus.ducking[0]?.releaseMs ?? 200;
        const step = target < current
          ? Math.min(1, (20 / Math.max(1, attack)))
          : Math.min(1, (20 / Math.max(1, release)));
        const next = target < -0.01
          ? Math.min(1, current + step)
          : Math.max(0, current - step);
        duckProgress.set(key, next);
        const state = states.get(bus.id)!;
        state.duckDb = target * next;
        gains.set(bus.id, dbToLinear(state.volumeDb + state.duckDb));
      }
      return gains;
    },
    state(busId) {
      return states.get(busId);
    },
    dispose() {
      states.clear();
      duckProgress.clear();
      byId.clear();
    },
  };
}

export function busIdForKind(kind: 'sfx' | 'music' | 'voice'): string {
  return `bus:${kind}`;
}
