export interface SchedulerOptions {
  eventPeriodMs?: number;
  lookaheadMs?: number;
  controlPeriodMs?: number;
  nowAudio: () => number;
  scheduleTimer: (run: () => void, delayMs: number) => unknown;
  cancelTimer: (handle: unknown) => void;
}

export interface LookaheadScheduler {
  scheduleAt(dueAudioTime: number, run: (startAudioTime: number) => void): string;
  cancel(id: string): void;
  onControlFrame(cb: (audioTime: number) => void): () => void;
  start(): void;
  stop(): void;
}

interface Item {
  id: string;
  dueAudioTime: number;
  run: (startAudioTime: number) => void;
}

/**
 * Dual-clock scheduler. Wall timers only wake the loop; audio starts always
 * receive an exact AudioContext (or injected) time. Never call source.start()
 * from a bare setTimeout callback without a computed startAudioTime.
 */
export function createLookaheadScheduler(options: SchedulerOptions): LookaheadScheduler {
  const eventPeriodMs = options.eventPeriodMs ?? 25;
  const lookaheadMs = options.lookaheadMs ?? 100;
  const controlPeriodMs = options.controlPeriodMs ?? 20;
  const queue: Item[] = [];
  const control: Array<(audioTime: number) => void> = [];
  let eventTimer: unknown;
  let controlTimer: unknown;
  let running = false;
  let seq = 0;

  const sortQueue = (): void => {
    queue.sort((a, b) => a.dueAudioTime - b.dueAudioTime);
  };

  const drainEvents = (): void => {
    if (!running) return;
    const horizon = options.nowAudio() + lookaheadMs / 1_000;
    while (queue.length > 0 && queue[0]!.dueAudioTime <= horizon) {
      const item = queue.shift()!;
      item.run(item.dueAudioTime);
    }
  };

  const tickControl = (): void => {
    if (!running) return;
    const audioTime = options.nowAudio();
    for (const cb of control) cb(audioTime);
  };

  const arm = (): void => {
    if (!running) return;
    options.cancelTimer(eventTimer);
    options.cancelTimer(controlTimer);
    eventTimer = options.scheduleTimer(() => {
      drainEvents();
      if (running) eventTimer = options.scheduleTimer(function loop() {
        drainEvents();
        if (running) eventTimer = options.scheduleTimer(loop, eventPeriodMs);
      }, eventPeriodMs);
    }, 0);
    controlTimer = options.scheduleTimer(function loop() {
      tickControl();
      if (running) controlTimer = options.scheduleTimer(loop, controlPeriodMs);
    }, controlPeriodMs);
  };

  return {
    scheduleAt(dueAudioTime, run) {
      const id = `sched-${++seq}`;
      queue.push({ id, dueAudioTime, run });
      sortQueue();
      // Due immediately within horizon — drain on next microtask via timer 0.
      if (running && dueAudioTime <= options.nowAudio() + lookaheadMs / 1_000) {
        eventTimer = options.scheduleTimer(() => drainEvents(), 0);
      }
      return id;
    },
    cancel(id) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    onControlFrame(cb) {
      control.push(cb);
      return () => {
        const index = control.indexOf(cb);
        if (index >= 0) control.splice(index, 1);
      };
    },
    start() {
      if (running) return;
      running = true;
      arm();
    },
    stop() {
      running = false;
      options.cancelTimer(eventTimer);
      options.cancelTimer(controlTimer);
      queue.length = 0;
      control.length = 0;
    },
  };
}
