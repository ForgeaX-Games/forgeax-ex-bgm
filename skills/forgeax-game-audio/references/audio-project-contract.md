# 音频项目合约

音频项目是 Agent 与玩家“事件绑定”编辑区共用的修订版草稿。它位于游戏目录，
但必须通过插件工具读写，不直接修改 JSON。

## 固定调用顺序

1. `get-audio-project`：读取共享草稿与当前 revision。先读代码自己找挂点，不要用扫描工具做发现。
2. `generate-audio-assets`：按方案批量生成缺失音频。
3. `patch-audio-project`：使用 `expectedRevision` 增改或删除绑定；能确定类型时传 `archetype`，让服务端填默认参数。
4. 汇报草稿，告知编辑区入口；不停下等待确认。
5. 用户改过草稿后再次 `get-audio-project`：接收最新 revision 和改动。
6. `apply-audio-project`：生成游戏侧运行时；无需用户确认。
7. 在真实游戏逻辑中插入 `gameAudio.emit(eventId, context)`。
8. `verify-audio-project`：验证资产、生成文件与字面量事件插桩。能跑真实一局时传入 `runtimeEvidence`（`getProfilerSnapshot()` JSON）。

## 绑定示例

```json
{
  "eventId": "combat.heavy_hit",
  "label": "重击命中",
  "enabled": true,
  "kind": "sfx",
  "archetype": "impact",
  "assets": [
    { "assetId": "live-real-id-a", "file": "heavy-hit-a.wav", "name": "重击 A" },
    { "assetId": "live-real-id-b", "file": "heavy-hit-b.wav", "name": "重击 B" }
  ],
  "variation": { "mode": "random-no-repeat" },
  "trigger": { "delayMs": 0, "cooldownMs": 80, "probability": 1, "rhythmLockMs": 0 },
  "playback": {
    "volume": 0.9,
    "bus": "sfx",
    "spatial": "3d",
    "mode": "one-shot",
    "fadeInMs": 0,
    "fadeOutMs": 60
  },
  "shaping": {
    "gainDb": 0,
    "pitchSemitones": 0,
    "highpassHz": 20,
    "lowpassHz": 16000,
    "eqLowDb": 2,
    "eqMidDb": 0,
    "eqHighDb": -1
  },
  "follow": {
    "field": "target.material",
    "defaultValue": "",
    "cases": [
      {
        "value": "metal",
        "assets": [{ "assetId": "live-metal-hit", "file": "metal-hit.wav" }]
      }
    ]
  },
  "conditions": [
    { "field": "damage", "operator": "gte", "value": 20 }
  ]
}
```

Agent 最少可以只传 `eventId`、`kind`、`archetype` 和真实 `assets`；冷却、音量、空间、节奏对齐由原型表补齐。显式字段优先于原型。

## 可编辑范围

- `enabled`：临时停用，不删除设计。缺口事件必须 `enabled: false`。
- `archetype`：事件原型，决定缺省冷却、音量、空间、播放模式和节奏对齐。
- `assets`：真实已挂载声音；可替换、增删和排序。
- `assets[].file`：规范形式是游戏相对路径，带目录前缀。可传 `foo.wav`、`audio/foo.wav` 或 `assets/audio/foo.mp3`；系统会把裸名升格为 `audio/foo.wav`，已带 `audio/` 或 `assets/audio/` 前缀的值原样保留。
- `variation.mode`：`single`、`sequential`、`random-no-repeat`。
- `trigger`：延迟/冷却为毫秒，概率为 0–1。`rhythmLockMs` 不传表示自动对齐连发，`0` 表示关闭，正数是固定间隔。
- `playback.volume`：线性音量 0–4；玩家界面以百分比显示。
- `playback.bus`：`sfx`、`music`、`voice`。
- `playback.spatial`：`2d` 或 `3d`。
- `playback.mode`：`one-shot` 或 `loop`；循环可配置 `stopEventId`。
- `fadeInMs` / `fadeOutMs`：0–60000 毫秒。
- `conditions`：事件 context 字段与 `eq/neq/gt/gte/lt/lte/in` 简单比较。
- `shaping`：事件级 Gain、Pitch、高低通和三段 EQ，统一作用于所有声音变体。EQ范围为 -12～12 dB。
- `follow.cases`：根据游戏值选择不同真实资产；未匹配时回退绑定顶层 `assets`。
- `follow.range`：把连续数值线性映射为音量、Pitch和低通。`min`必须小于`max`。
- 每条绑定最多一种`follow`规则；`cases`与`range`不能同时存在。
- 顶层`assets`不能为空，它是游戏没有传值或取值未知时的安全默认声音。启用的绑定在 apply 前必须已有真实文件。

## 修订与确认

- 每次 patch 都传最后读取的 `expectedRevision`。
- `revision_conflict` 表示玩家或另一个 Agent 已经修改草稿；重新读取并逐项合并。
- `apply-audio-project` 必须使用最新 revision；调用后直接执行，无需用户确认。
- apply 前草稿可反复编辑；apply 后继续编辑会产生新的 draft revision，不会静默覆盖已应用版本。

## 插桩纪律

- 从生成的 `src/forgeax-audio` 公开入口导入 `gameAudio`。
- 事件 ID 使用字面量，便于扫描与验证。
- context 只传条件或 3D 空间实际需要的数据。同帧多实例的事件必须带 `gameObjectId`。
- 离散的单次值随`gameAudio.emit` context传入；持续游戏状态或连续参数调用`gameAudio.setGameValue(field, value)`。
- 插桩位置代表事件真实完成：
  - 攻击动作声在输入或动画起手。
  - 命中在伤害或碰撞确认之后。
  - 击败在只执行一次的结算函数，不在延迟移除或尸体清理。
  - 循环声在进入状态时开、离开时停。
- 每条绑定用 `provenance` 记下挂点。`wired` 必须带相对源码路径；找不到就标 `gap` 并保持 `enabled: false`。
- 不修改引擎、ECS、网关、工具注册或生成运行时内部实现。
