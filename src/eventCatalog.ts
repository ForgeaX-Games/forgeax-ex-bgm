/**
 * Preset sound events, grouped by the kind of game being made.
 *
 * The scanner can only find events the game already emits, which means a game
 * that has never made a sound gives zero candidates — the user has to write code
 * before they can start on audio. This catalog inverts that: pick the events you
 * know a shooter (or platformer, or …) needs, create them empty, and let the
 * agent go find the trigger points afterwards.
 */

import { createBindingDraft } from './audioBindingsEditor.ts';
import { isSafeAudioEventId, type AudioBinding, type AudioKind } from '../shared/audio-project.ts';

export type EventGenre = 'common' | 'shooter' | 'platformer' | 'puzzle' | 'casual';

export interface EventPreset {
  eventId: string;
  label: string;
  kind: AudioKind;
  /** Where in the game this fires — becomes the agent's instruction. */
  hint: string;
  /** Music and ambience keep playing; one-shots do not. */
  loop?: boolean;
}

export interface EventGenreGroup {
  id: EventGenre;
  name: string;
  blurb: string;
  presets: EventPreset[];
}

const sfx = (eventId: string, label: string, hint: string): EventPreset =>
  ({ eventId, label, kind: 'sfx', hint });
const music = (eventId: string, label: string, hint: string): EventPreset =>
  ({ eventId, label, kind: 'music', hint, loop: true });

export const EVENT_GENRES: EventGenreGroup[] = [
  {
    id: 'common',
    name: '通用',
    blurb: '几乎每个游戏都要的界面与流程声音',
    presets: [
      sfx('ui.click', '界面点击', '按钮、菜单项被点击时'),
      sfx('ui.hover', '悬停高亮', '指针移到可点元素上时'),
      sfx('ui.confirm', '确认', '确认、提交、购买成功时'),
      sfx('ui.cancel', '取消返回', '关闭弹窗或返回上一层时'),
      sfx('ui.toggle', '开关切换', '开关、勾选项被切换时'),
      sfx('ui.error', '操作失败', '输入非法或操作被拒绝时'),
      sfx('game.start', '开始游戏', '一局游戏开始的瞬间'),
      sfx('game.over', '游戏结束', '玩家失败或一局结束时'),
      sfx('level.complete', '过关', '通关结算画面出现时'),
      music('music.main', '主背景乐', '主菜单与常态玩法中循环播放'),
    ],
  },
  {
    id: 'shooter',
    name: '射击',
    blurb: '枪械、命中反馈与战斗音乐',
    presets: [
      sfx('weapon.fire', '开火', '每次射出子弹时'),
      sfx('weapon.reload', '换弹', '开始换弹动作时'),
      sfx('weapon.empty', '空仓', '弹药耗尽仍扣扳机时'),
      sfx('impact.flesh', '命中敌人', '子弹判定命中敌人时'),
      sfx('impact.wall', '命中环境', '子弹打在墙面或地面时'),
      sfx('enemy.death', '敌人死亡', '敌人生命归零时'),
      sfx('player.hurt', '玩家受伤', '玩家掉血时'),
      sfx('player.footstep', '玩家脚步', '玩家移动时按步频触发'),
      sfx('item.pickup', '拾取物资', '捡起弹药、血包或武器时'),
      sfx('grenade.explode', '爆炸', '手雷或爆炸物炸开时'),
      music('music.combat', '战斗音乐', '进入交战状态后循环播放'),
    ],
  },
  {
    id: 'platformer',
    name: '平台跳跃',
    blurb: '跳跃落地、收集与受伤',
    presets: [
      sfx('player.jump', '跳跃', '玩家起跳的瞬间'),
      sfx('player.double-jump', '二段跳', '空中再次起跳时'),
      sfx('player.land', '落地', '玩家接触地面时'),
      sfx('player.footstep', '脚步', '玩家在地面移动时'),
      sfx('player.hurt', '受伤', '玩家碰到伤害源时'),
      sfx('player.death', '死亡', '玩家生命归零或掉出场景时'),
      sfx('coin.pickup', '收集金币', '吃到金币或星星时'),
      sfx('powerup.get', '获得道具', '拿到强化道具时'),
      sfx('checkpoint.reach', '到达存档点', '经过检查点时'),
      sfx('spring.bounce', '弹簧弹起', '踩到弹簧或跳台时'),
      sfx('enemy.stomp', '踩踏敌人', '从上方踩死敌人时'),
      music('music.level', '关卡音乐', '关卡进行中循环播放'),
    ],
  },
  {
    id: 'puzzle',
    name: '解谜',
    blurb: '拿起放下、吸附与解开谜题',
    presets: [
      sfx('piece.pick', '拿起', '拿起方块、棋子或卡片时'),
      sfx('piece.place', '放下', '把它放到棋盘上时'),
      sfx('piece.snap', '吸附到位', '正确对位并吸附时'),
      sfx('piece.invalid', '放置失败', '位置非法被弹回时'),
      sfx('combo.clear', '消除', '成行成组被消除时'),
      sfx('hint.use', '使用提示', '玩家点开提示时'),
      sfx('undo.step', '撤销一步', '玩家撤回上一步操作时'),
      sfx('puzzle.solved', '解开谜题', '一关的谜题被解开时'),
      sfx('timer.warning', '倒计时告急', '剩余时间进入告急区间时'),
      music('music.ambient', '环境音乐', '思考过程中低强度循环播放'),
    ],
  },
  {
    id: 'casual',
    name: '休闲',
    blurb: '点击反馈、得分与奖励',
    presets: [
      sfx('tap.hit', '点中目标', '点击命中目标时'),
      sfx('tap.miss', '点空', '点击落空时'),
      sfx('score.up', '得分', '分数增加时'),
      sfx('combo.up', '连击提升', '连击数上升时'),
      sfx('item.collect', '收集', '收进道具或元素时'),
      sfx('level.up', '升级', '等级或阶段提升时'),
      sfx('reward.open', '开启奖励', '打开宝箱或领取奖励时'),
      sfx('fail.soft', '失败', '一次尝试失败但可重来时'),
      music('music.loop', '轻松循环乐', '玩法进行中循环播放'),
      music('ambience.day', '环境氛围', '场景环境音，长期循环'),
    ],
  },
];

export function genreGroup(genre: EventGenre): EventGenreGroup | undefined {
  return EVENT_GENRES.find((group) => group.id === genre);
}

export function presetsFor(genre: EventGenre): EventPreset[] {
  return genreGroup(genre)?.presets ?? [];
}

export function findPreset(eventId: string): EventPreset | undefined {
  for (const group of EVENT_GENRES) {
    const hit = group.presets.find((preset) => preset.eventId === eventId);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Accept a user-typed event, rejecting ids the project store would refuse.
 * Returns null rather than throwing: this runs on every keystroke's worth of
 * input the user submits.
 */
export function customPreset(eventId: string, label?: string): EventPreset | null {
  const id = eventId.trim();
  if (!isSafeAudioEventId(id)) return null;
  const existing = findPreset(id);
  if (existing) return existing;
  return {
    eventId: id,
    label: label?.trim() || id,
    kind: 'sfx',
    hint: '由用户自定义，请按事件名判断合适的触发点',
  };
}

/**
 * A preset becomes a disabled, soundless event.
 *
 * Disabled is not a detail: an enabled event with no clips fails verification
 * and blocks the whole apply, so an event the user has not filled in yet has to
 * stay out of the runtime until it has something to play.
 */
export function bindingFromPreset(preset: EventPreset): AudioBinding {
  const binding = createBindingDraft(preset.eventId, preset.label);
  return {
    ...binding,
    enabled: false,
    kind: preset.kind,
    playback: {
      ...binding.playback,
      bus: preset.kind,
      mode: preset.loop ? 'loop' : 'one-shot',
    },
  };
}

/**
 * The prompt behind「接入游戏」. The events already exist by the time this runs;
 * what the agent still has to do is find the places in the game that should
 * fire them, which is exactly the work the user would otherwise do by hand.
 */
export function wireIntoGamePrompt(slug: string, presets: EventPreset[]): string {
  const lines = presets.map((preset) => `- \`${preset.eventId}\`（${preset.label}）：${preset.hint}`);
  return [
    `请把下面这些声音事件接进游戏“${slug}”的代码里。`,
    '',
    '事件已经在音频编辑区建好了（还没装声音），需要你做的是在游戏逻辑里补上触发点：',
    ...lines,
    '',
    '做法：从 `src/forgeax-audio` 导入 `gameAudio`，在对应位置调用 `gameAudio.emit(\'事件名\')`；',
    '空间化的声音带上 `{ gameObjectId }`，循环音（音乐、环境音）在状态进入时 emit、离开时停。',
    '事件名必须和上面完全一致，不要另造名字，也不要改 `audio/` 下的任何配置。',
    '接完请告诉我每个事件接在了哪个文件的哪一行。',
  ].join('\n');
}
