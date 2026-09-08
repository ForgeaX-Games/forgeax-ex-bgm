export interface DecodeCacheOptions {
  maxBytes: number;
  decode: (url: string) => Promise<{ buffer: AudioBuffer; byteLength: number }>;
}

export interface DecodeCache {
  get(url: string): Promise<AudioBuffer>;
  peek(url: string): AudioBuffer | undefined;
  clear(): void;
  stats(): { entries: number; bytes: number };
}

interface Entry {
  buffer: AudioBuffer;
  byteLength: number;
  lastUsed: number;
}

export function createDecodeCache(options: DecodeCacheOptions): DecodeCache {
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<AudioBuffer>>();
  let bytes = 0;
  let clock = 0;

  const evict = (): void => {
    while (bytes > options.maxBytes && entries.size > 0) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, entry] of entries) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const removed = entries.get(oldestKey)!;
      entries.delete(oldestKey);
      bytes -= removed.byteLength;
    }
  };

  return {
    get(url) {
      const hit = entries.get(url);
      if (hit) {
        hit.lastUsed = ++clock;
        return Promise.resolve(hit.buffer);
      }
      const pending = inflight.get(url);
      if (pending) return pending;
      const load = options.decode(url).then(({ buffer, byteLength }) => {
        entries.set(url, { buffer, byteLength, lastUsed: ++clock });
        bytes += byteLength;
        inflight.delete(url);
        evict();
        return buffer;
      }, (error) => {
        inflight.delete(url);
        throw error;
      });
      inflight.set(url, load);
      return load;
    },
    peek(url) {
      return entries.get(url)?.buffer;
    },
    clear() {
      entries.clear();
      inflight.clear();
      bytes = 0;
    },
    stats() {
      return { entries: entries.size, bytes };
    },
  };
}

export const STREAM_THRESHOLD_MS = 30_000;

export function shouldStreamAsset(durationMs: number | undefined, thresholdMs = STREAM_THRESHOLD_MS): boolean {
  return typeof durationMs === 'number' && durationMs > thresholdMs;
}
