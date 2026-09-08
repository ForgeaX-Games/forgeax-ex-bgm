import type {
  EmitOutcome,
  EmitReceipt,
  ProfilerCounts,
  ProfilerEventCounts,
  ProfilerPostMessage,
  ProfilerSnapshot,
} from './types.ts';

function emptyCounts(): ProfilerCounts {
  return { total: 0, byOutcome: {}, byEvent: {} };
}

function cloneCounts(counts: ProfilerCounts): ProfilerCounts {
  const byEvent: Record<string, ProfilerEventCounts> = {};
  for (const [eventId, row] of Object.entries(counts.byEvent)) {
    byEvent[eventId] = { total: row.total, byOutcome: { ...row.byOutcome } };
  }
  return {
    total: counts.total,
    byOutcome: { ...counts.byOutcome },
    byEvent,
  };
}

function bumpOutcome(map: ProfilerEventCounts['byOutcome'], outcome: EmitOutcome): void {
  map[outcome] = (map[outcome] ?? 0) + 1;
}

export interface ProfilerVoiceSnap {
  playbackId: number;
  eventId: string;
  gameObjectId: string;
  computedVolumeDb: number;
  state: string;
}

export interface AudioProfiler {
  recordReceipt(receipt: EmitReceipt): void;
  setVoices(voices: ProfilerVoiceSnap[]): void;
  getSnapshot(): ProfilerSnapshot;
  toPostMessage(): ProfilerPostMessage;
  dispose(): void;
}

export function createProfiler(input: {
  projectId: string;
  capacity?: number;
}): AudioProfiler {
  const capacity = Math.max(1, input.capacity ?? 64);
  const receipts: EmitReceipt[] = [];
  let voices: ProfilerVoiceSnap[] = [];
  let counts = emptyCounts();

  return {
    recordReceipt(receipt) {
      receipts.push(receipt);
      while (receipts.length > capacity) receipts.shift();
      counts.total += 1;
      bumpOutcome(counts.byOutcome, receipt.outcome);
      const row = counts.byEvent[receipt.eventId] ?? { total: 0, byOutcome: {} };
      row.total += 1;
      bumpOutcome(row.byOutcome, receipt.outcome);
      counts.byEvent[receipt.eventId] = row;
    },
    setVoices(next) {
      voices = next.slice();
    },
    getSnapshot() {
      return {
        projectId: input.projectId,
        receipts: receipts.slice(),
        voices: voices.slice(),
        counts: cloneCounts(counts),
      };
    },
    toPostMessage() {
      const snapshot = this.getSnapshot();
      return {
        type: 'forgeax-audio-profiler',
        projectId: snapshot.projectId,
        receipts: snapshot.receipts,
        voices: snapshot.voices,
        counts: snapshot.counts,
      };
    },
    dispose() {
      receipts.length = 0;
      voices = [];
      counts = emptyCounts();
    },
  };
}
