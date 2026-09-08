import type { AudioPort } from './types.ts';

export type UnlockState = 'locked' | 'unlocking' | 'ready' | 'unavailable';

export interface AudioReadiness {
  state(): UnlockState;
  isReady(): boolean;
  whenReady(): Promise<void>;
  markReady(): void;
  markUnavailable(reason: string): void;
  tryUnlock(): Promise<UnlockState>;
}

export function createAudioReadiness(port: Pick<AudioPort, 'unlock' | 'isReady'>): AudioReadiness {
  let current: UnlockState = port.isReady?.() ? 'ready' : 'locked';
  let reason = '';
  const waiters: Array<() => void> = [];

  const settle = (next: UnlockState): void => {
    current = next;
    if (next === 'ready' || next === 'unavailable') {
      for (const resolve of waiters.splice(0)) resolve();
    }
  };

  return {
    state: () => current,
    isReady: () => current === 'ready' || Boolean(port.isReady?.()),
    whenReady() {
      if (current === 'ready' || current === 'unavailable') return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    markReady() { settle('ready'); },
    markUnavailable(message) {
      reason = message;
      settle('unavailable');
    },
    async tryUnlock() {
      if (current === 'ready') return current;
      if (!port.unlock) {
        settle('ready');
        return current;
      }
      settle('unlocking');
      try {
        await port.unlock();
        settle(port.isReady?.() === false ? 'locked' : 'ready');
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        settle('unavailable');
      }
      void reason;
      return current;
    },
  };
}
