/**
 * 规范 §07 的统一任务状态语言。插件只维护当前任务，长期历史归系统。
 *
 *   未开始 → 可执行 → 执行中 → 等待确认 → 已完成
 *   另有两个终态:执行失败、已取消
 *
 * 状态词是给用户看的契约,不要在别处另造「生成中」「读取中」这类同义词。
 */

export type TaskState =
  | 'idle'
  | 'ready'
  | 'running'
  | 'awaiting'
  | 'done'
  | 'failed'
  | 'cancelled';

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  idle: '未开始',
  ready: '可执行',
  running: '执行中',
  awaiting: '等待确认',
  done: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};

export interface TaskSnapshot {
  /** 输入已填全,主操作可点。 */
  readonly ready: boolean;
  /** 在途生成条数。 */
  readonly inflight: number;
  /** 本轮已出的候选条数。 */
  readonly results: number;
  /** 本轮的失败条数。 */
  readonly failures: number;
  /** 用户中止过本轮。 */
  readonly cancelled: boolean;
  /** 卡在人工确认上(目前只有 v1→v2 结构迁移会用到)。 */
  readonly awaitingConfirm?: boolean;
}

/**
 * 一次任务只报一个状态。在途优先——用户此刻最需要知道的是「还在跑」,
 * 哪怕这一批里已经有出片或失败。
 */
export function taskStateOf(snapshot: TaskSnapshot): TaskState {
  if (snapshot.awaitingConfirm) return 'awaiting';
  if (snapshot.inflight > 0) return 'running';
  if (snapshot.results > 0) return 'done';
  if (snapshot.cancelled) return 'cancelled';
  if (snapshot.failures > 0) return 'failed';
  return snapshot.ready ? 'ready' : 'idle';
}

/**
 * 状态后面那半句「所以现在怎么办」。规范 §07 要求:执行中报阶段不报假进度,
 * 失败给重试入口,完成说下一步。
 */
export function taskStateDetail(
  state: TaskState,
  snapshot: TaskSnapshot,
  hint: { readonly emptyInput: string },
): string {
  switch (state) {
    case 'idle':
      return hint.emptyInput;
    case 'ready':
      return '可以生成了';
    case 'running':
      return snapshot.results > 0
        ? `${snapshot.inflight} 条在生成,已出 ${snapshot.results} 条,可以继续加`
        : `${snapshot.inflight} 条在生成,可以继续加`;
    case 'awaiting':
      return '等你确认后继续';
    case 'done':
      return snapshot.failures > 0
        ? `已出 ${snapshot.results} 条,${snapshot.failures} 条失败可重试;选一条配入游戏事件`
        : `已出 ${snapshot.results} 条,选一条配入游戏事件`;
    case 'failed':
      return '改一下描述再试,或换更短的时长';
    case 'cancelled':
      return '已停下,可以改输入重新生成';
  }
}

/** 状态位文案:`已完成 · 已出 2 条,选一条配入游戏事件`。 */
export function taskStateText(
  snapshot: TaskSnapshot,
  hint: { readonly emptyInput: string },
): string {
  const state = taskStateOf(snapshot);
  return `${TASK_STATE_LABEL[state]} · ${taskStateDetail(state, snapshot, hint)}`;
}
