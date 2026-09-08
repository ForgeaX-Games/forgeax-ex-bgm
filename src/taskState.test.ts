import { describe, expect, test } from 'bun:test';

import {
  TASK_STATE_LABEL,
  taskStateOf,
  taskStateText,
  type TaskSnapshot,
  type TaskState,
} from './taskState.ts';

const EMPTY: TaskSnapshot = {
  ready: false,
  inflight: 0,
  results: 0,
  failures: 0,
  cancelled: false,
};

const hint = { emptyInput: '填写需求后生成' };

describe('规范 §07 七态', () => {
  test('七个状态词一个不缺，也不多造', () => {
    expect(Object.values(TASK_STATE_LABEL)).toEqual([
      '未开始', '可执行', '执行中', '等待确认', '已完成', '执行失败', '已取消',
    ]);
  });

  test('输入为空是未开始，填全就是可执行', () => {
    expect(taskStateOf(EMPTY)).toBe('idle');
    expect(taskStateOf({ ...EMPTY, ready: true })).toBe('ready');
  });

  test('在途优先于已出片：用户此刻要知道的是还在跑', () => {
    const state = taskStateOf({ ...EMPTY, ready: true, inflight: 1, results: 2 });
    expect(state).toBe('running');
    expect(taskStateText({ ...EMPTY, ready: true, inflight: 1, results: 2 }, hint))
      .toBe('执行中 · 1 条在生成,已出 2 条,可以继续加');
  });

  test('出了片就是已完成，即便同批有失败也照实说', () => {
    expect(taskStateOf({ ...EMPTY, results: 1 })).toBe('done');
    expect(taskStateText({ ...EMPTY, results: 2, failures: 1 }, hint))
      .toBe('已完成 · 已出 2 条,1 条失败可重试;选一条配入游戏事件');
  });

  test('全军覆没才是执行失败', () => {
    expect(taskStateOf({ ...EMPTY, failures: 3 })).toBe('failed');
  });

  test('中止过且没出片是已取消，不退回未开始', () => {
    expect(taskStateOf({ ...EMPTY, cancelled: true })).toBe('cancelled');
    expect(taskStateOf({ ...EMPTY, ready: true, cancelled: true })).toBe('cancelled');
  });

  test('已出片的一轮被中止后仍报已完成：片子还在，不该说取消', () => {
    expect(taskStateOf({ ...EMPTY, cancelled: true, results: 1 })).toBe('done');
  });

  test('等待确认压过一切', () => {
    expect(taskStateOf({ ...EMPTY, awaitingConfirm: true, inflight: 2 })).toBe('awaiting');
  });

  test('每个状态都带一句「现在怎么办」', () => {
    const states: TaskState[] = [
      'idle', 'ready', 'running', 'awaiting', 'done', 'failed', 'cancelled',
    ];
    const snapshots: Record<TaskState, TaskSnapshot> = {
      idle: EMPTY,
      ready: { ...EMPTY, ready: true },
      running: { ...EMPTY, inflight: 1 },
      awaiting: { ...EMPTY, awaitingConfirm: true },
      done: { ...EMPTY, results: 1 },
      failed: { ...EMPTY, failures: 1 },
      cancelled: { ...EMPTY, cancelled: true },
    };
    for (const state of states) {
      const text = taskStateText(snapshots[state], hint);
      expect(text.startsWith(`${TASK_STATE_LABEL[state]} · `)).toBe(true);
      expect(text.length).toBeGreaterThan(TASK_STATE_LABEL[state].length + 3);
    }
  });
});
