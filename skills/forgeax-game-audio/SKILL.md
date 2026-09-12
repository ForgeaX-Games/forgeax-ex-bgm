---
name: forgeax-game-audio
description: Use when users ask to add BGM, SFX, or voice to a ForgeaX game; design or edit no-code audio event bindings; repair missing gameAudio events; or verify game audio coverage and playback.
---

# ForgeaX Game Audio

把音频任务一次做到“游戏事件真实可播放”。音频默认来自生成；插件另带一份起步清单兜底，两者都不是可检索的素材库。用户一句话即可，中间不要停下等人点击。

## 验证按交付阶段进行

玩法还在开发时，准备任务交付音频方案、真实资产路径和待接入事件，不需要等待主线代码写完。使用 `verify-audio-project` 的 `phase: "preparation"` 检查草稿与素材；尚不存在的挂点由玩法负责人补齐，不伪造调用来消除缺口。素材准备完成不等于整局游戏音频完成。

接入完成后使用 `phase: "integration"`；最终在真实游戏 Play 中触发行为，提交 `phase: "runtime"` 与 `runtimeEvidence`。工具会区分静态通过和播放证据通过。无需为正常交付自建 HTTP 服务、临时浏览器播放器、解码脚本或从全局目录借测试依赖；这些不能证明 ECS 游戏里的声音。现有校验结果在输入未变化时继续有效，只复验变更影响的部分。

项目没有 `scripts/audit-audio-bindings.ts` 时，直接使用上述工具，不寻找或重建同名脚本。缺少真实 Play 能力就报告“准备/静态接入已验证，实际播放待主线验收”，由有 Play 工具的主 Agent 完成该项；不要用模拟播放器宣称完整验收。

## 工作流

1. **确定目标游戏**
   - 从当前会话作用域、用户指定 slug 或 `.forgeax/games/` 推断唯一目标。
   - 目标不唯一且会导致写错游戏时才追问。
   - 唯一游戏目录是工具返回的 `gameDir`（即 `<project-root>/.forgeax/games/<slug>`）。读玩法代码、
     查资产、插桩都在这里做。磁盘别处的同名游戏目录不是它，不要读、不要比对、不要写。

2. **读取需求与代码**
   - 阅读 pillar、design、玩法说明和现有 `src/`。
   - 看已有音频入口、manifest、草稿和播放器实现；有用户改过的草稿就接着改，禁止覆盖。
   - 优先覆盖核心循环、失败反馈和高频交互；装饰性事件放后。
   - 自己读玩法代码，找出事件真正成立的位置。不要调用 `inspect-audio-events` 做发现——那个工具只给校验用，对新游戏返回空。

3. **先出音频方案，发给用户看，再动手生成**
   - 一屏写完：这局听感（例如仙侠打斗、轻松休闲）、必须有响动的瞬间、每条是一次性还是循环、
     2D 还是 3D、每条打算出几个变体、按什么维度拆。
   - **先把这一屏发给用户**，再继续。不阻塞等批准：发完就往下做，用户要改会打断你。
   - 同时把方案随第一次 `patch-audio-project` 落盘：顶层传 `plan.tone` 和 `plan.notes`，
     每条绑定传 `plannedVariants`。这样方案会进验收对账，而不是报告里的一段话。
   - 看挂点函数的参数：能区分武器、元素、材质、部位、伤害类型时，用 `follow.cases` 拆，
     一次调用就够，switch 组自动创建；游戏侧 emit 时带 `gameValues`。这是做出丰富度最省的办法。
   - 攻击动作声和命中声拆成两条；击败、拾取、稀有掉落不要复用同一条素材。
   - 找不到真实结算点的事件标成缺口，先不启用——启用了却没声音的绑定会让整包应用失败。

4. **生成缺失音频**
   - 对需要新声音的 BGM、SFX、语音，汇总后只调用一次 `generate-audio-assets`，每批最多 50 项。
   - 提供稳定 `eventId`、名称、类型和完整生成提示词；生成统一走 Seed Audio 1.0。
   - 工具返回的音频已直接保存到 `assets/audio/` 并写入 manifest，使用返回的真实 `assetId` 和 `file` 继续起草绑定。
   - 返回即凭据：拿到 `assetId`、`file`、`bytes`、`durationMs` 就直接进入下一步，不要再 `ls`、算哈希、
     glob 或读 sidecar 去确认文件存在。返回里的 `nextStep` 就是下一步。
   - 单项失败不影响其他项；保留失败原因。不要调用 `save-generated-audio`，也不要把 `forgeax:game-audio-prompt` 当成音频生成工具。
   - 不要让用户去编辑区点「生成」。生成工具就是 `generate-audio-assets`。
   - 已有可用文件时不要重复生成。
   - 高频短事件（命中、击败、拾取、界面）提示词必须写短、轻、无拖尾；长的史诗音只给稀有掉落或升级。
   - 生成结果若带 `durationWarning`，这条不能当命中/拾取/界面用；改提示词重生成，或改挂到 `rare-loot`。

4b. **起步清单：什么时候用自带音频**

   生成是默认路径。只在下面三种情况改用插件自带的起步清单：

   - `generate-audio-assets` 报 `seed-not-configured`，或连续失败到这一批做不下去；
   - 用户明确说要现成的、不想等生成、先随便有个声音；
   - 需要长环境床（森林、雨、城市），生成不擅长这类长循环。

   规范：

   - 先 `list-starter-audio` 拿清单，只能用返回里的 `id`，不许自己拼 id 或猜文件名。
     需要挂高频事件时传 `highFrequencyOnly: true`，直接把过长的排除掉。
   - 再 `use-starter-audio` 把选中的复制进游戏，一次提交本批全部条目。它的返回和
     `generate-audio-assets` 同形，之后照样走 `patch-audio-project`。
   - 挂高频事件（命中、拾取、界面、脚步）只能用 `highFrequencySafe: true` 的条目。
   - `ambient: true` 是长环境床，只能挂场景循环，绝不挂一次性事件。
   - `loop: true` 的条目要按循环绑定；BGM 全部是 32 秒床，一律循环使用。
   - 不要把它当素材库：不做按情绪/场景检索，不向用户罗列整份清单让他挑，不在插件里长期维护
     第二套资产库。选中即复制进游戏，游戏里播的必须是 `assets/audio/` 下的文件。
   - 不要用 `library/starter/` 里的路径当绑定资产，也不要让用户去编辑区找这份清单——它没有界面。
   - 起步音频只是兜底。用户后面要“更贴这局”的声音时，回到 `generate-audio-assets` 重做那几条。

5. **读取并起草共享音频项目**
   - 先调用 `get-audio-project`，保存返回的 `revision`。
   - 阅读 [音频项目合约](references/audio-project-contract.md)，再调用
     `patch-audio-project`；必须传 `expectedRevision`，只提交要增改的绑定和要删除的事件 ID。
   - 将步骤 4 生成的真实资产写入绑定，不编造 `assetId` 或文件。
   - 必须传 `archetype`（`impact`、`defeat`、`pickup`、`rare-loot`、`ui`、`footstep`、`weapon-fire`、`attack`、`hurt`、`jump`、`bgm-loop`、`ambient-loop`）。服务端据此填冷却、音量、空间、节奏对齐、声部上限和优先级，这些数字是按「一局响几百次还是几次」标定过的。原型会落盘，验收时会对账：音量偏离默认超过 50% 会被报出来，所以不要自己编，除非能说明听感理由。
   - 可以设计：声音/变体、延迟、冷却、概率、音量、Bus、2D/3D、单次/循环、
     淡入淡出、停止事件、简单条件、事件级声音感觉和“跟随游戏变化”。
   - Agent 只表达：`eventId`、`archetype`、默认 `assets`、`follow.field`、值到声音的映射或数值范围、`shaping`。不要自行生成底层音频节点。
   - 若 `patch-audio-project` 返回 `cooldown_needs_game_object`，要么在 emit 时带 `gameObjectId`，要么把冷却改成 0。
   - 每条绑定写 `provenance`：找到结算点就 `status: "wired"` 加上文件、函数和理由；找不到就 `status: "gap"` 且 `enabled: false`。
   - 不同值切换声音时使用 `follow.cases`；随数值连续改变时使用 `follow.range`。两者不能同时出现，每条绑定最多一种跟随规则。
   - `assets` 始终是安全默认声音。`follow.cases` 中的每个声音必须来自已生成真实资产；缺少明确映射时保留默认声音，不编造取值。
   - 事件级 EQ 使用 `shaping`，只在有听感依据时调整；默认保持 0 dB 和全频段，所有数值必须在合约范围内。
   - Agent 与玩家界面编辑的是同一份 `audio/project.draft.json`。发生
     `revision_conflict` 时重新调用 `get-audio-project`，合并用户改动，禁止覆盖。

6. **汇报草稿，不停下等待**
   - 清楚汇报建议绑定、触发时机、声音、空间方式、循环和条件。
   - 告知用户可在“音乐音效”工作区直接启停、增删和修改草稿；生成预览在「音频」页。
   - 不为此停下等待确认。用户之后改了草稿，再调用一次 `get-audio-project`，以最新 revision 为准。
   - 不创建 `ask-user` 确认卡，也不让用户点击批准；这条链一次指令跑完。

7. **应用草稿**
   - 调用 `apply-audio-project`，传入最新 `expectedRevision`；无需用户确认，直接写入。
   - 该工具只在游戏侧生成 `src/forgeax-audio/` 运行时和
     `audio/project.json`，不修改 ForgeaX Engine、ECS、Editor Gateway 或 ToolRegistry。
   - 不手写另一套播放器，不绕过工具直接改生成文件。

8. **绑定真实游戏事件**
   - 从 `src/forgeax-audio` 导入 `gameAudio`，在事件真正成立的位置调用
     `gameAudio.emit(eventId, context)` 或 `gameAudio.postEvent(eventId, context)`；
     `eventId` 必须是字面量。
   - 单次事件的游戏值放在 context，例如
     `gameAudio.emit('player.footstep', { surface: { material: 'grass' }, gameObjectId: 'player' })`。
     持续状态或连续参数使用 `gameAudio.setGameValue` / `setSwitch` / `setRTPC` / `setState`。
   - 只有 3D 绑定需要发声体/听者位置；可用 `setListener` 与 context.emitter。
   - 挂点规则：
     - 攻击动作声（挥砍破风、开火）挂在按键或动画起手，挥空也响。
     - 命中声挂在伤害或碰撞确认之后，不能挂在攻击输入上冒充命中。
     - 击败声挂在只执行一次的结算函数，不挂延迟移除、尸体清理或死亡动画结束。
     - 循环声在进入状态时 emit、离开时 stop；成对出现。
     - 同帧可能打中或打死多个对象时，emit 必须带 `gameObjectId`；2D 且冷却大于 0 时尤其如此，否则连杀只响第一声。
   - 插桩后再次 `patch-audio-project`，把每条事件的 `provenance` 更新成实际文件和函数。代码改了导致漂移时，以代码为准改清单。
   - 只做游戏源码的最小插桩，不改引擎底层，也不重写现有事件系统。
   - 存量 v1 草稿可用 `migrate-audio-project` 显式落成 v2；总线/同步/衰减/音乐分别用
     `define-bus`、`define-game-sync`、`define-attenuation`、`author-music` 增量修改。

9. **按本次职责验证后交付**
   - 素材准备委派：调用 `verify-audio-project`，显式传 `phase: "preparation"`。通过后交付资产、草稿与待接入事件；不存在的挂点保持 `provenance.status: "gap"` 和 `enabled: false`。不等待玩法代码，也不为了清空缺口修改他人负责的玩法。
   - 玩法接入完成：调用 `phase: "integration"`，修复真实资产、生成运行时和已启用事件挂点的问题。
   - 最终整局验收：有真实 Play 能力的负责人触发核心行为，将 profiler JSON 作为 `runtimeEvidence` 传给 `phase: "runtime"`。没有出声记录、AudioContext 锁定、冷却吞掉连杀都算失败。
   - 项目已有 typecheck、测试和构建可验证本次改动。缺少项目依赖或生成器输出自身报错时，保留首个错误和受影响文件，交给依赖/生成器负责人；不从 App、全局或其他游戏借编译器，不临时改 `types`、`skipLibCheck` 或排除文件来凑通过。
   - 不再依赖项目里未提供的审计脚本。统一使用 `verify-audio-project`；素材准备通过、静态接入通过、真实播放通过是三个不同结果。

## 完成标准

本次委派的阶段决定交付条件。素材准备完成须有落盘方案、真实资产、通过的 preparation 检查，以及明确的待接入事件与负责人；此时可以结束准备委派，不能声称整局音频已完成。

完整音频交付还须满足：启用绑定均有真实游戏触发点，生成运行时由插件维护，integration 检查通过；请求的核心声音在实际游戏中触发，runtime 检查通过。丰富度或音量告警说明保留原因。无法做真实 Play 时明确报告未验收，由主 Agent 接手，不能用模拟播放器补出通过证据。

## 交付时怎么说

用玩家听得懂的话收口，覆盖这五件事，每件一句：

1. **配了什么** —— 这局补了哪几类声音。不逐条念事件 ID。
2. **文件叫什么、在哪** —— 报目录（`assets/audio/`）和条数；只有一两条时才点名。
3. **游戏里现在响不响** —— 报验收依据：真机听过就说听到了；只过静态审计就明说「还没在游戏里听过」。别把「文件齐了、emit 写了」说成已经能响。
4. **哪里还差** —— 失败的、和保留没清的丰富度告警，说清为什么留。有缺口必须主动讲，不能塞进细节里。
5. **下一步做什么** —— 给一个具体动作：去声音事件改规则，或者再补哪几条。

revision、逐条事件的挂点（文件与函数）、验收报告的原始字段都是细节，用户问了再给，不要默认铺开。

## 禁止事项

- 不编造 `assetId` 或文件路径。
- 不在生成成功后再去核对文件（`ls`、`stat`、sha256、glob、读 sidecar）；生成返回就是事实。
- 不去 `gameDir` 以外的同名游戏目录读代码或对比资产。
- 不检索、挂载或引用已下线的素材库、自定义资产库或 Audio Plan 工具。
- 不调用 `search-audio`、`search-bgm`、`search-audio-v2`、`attach-audio`、`list-audio`、`list-custom-audio`、`resolve-audio-plan`、`apply-audio-plan`。
- 不调用 `inspect-audio-events` 做事件发现。
- 不把 Switch、State、Parameter 或 WebAudio 节点直接暴露给玩家；统一写成一条 `follow` 声音规则。
- 不以“文件已经下载”宣告任务完成。
- 不修改 ForgeaX Engine、ECS、Editor Gateway、ToolRegistry 等底层逻辑。
- 不绕过共享草稿直接编辑 `audio/project.json` 或 `src/forgeax-audio/` 生成文件。
- 不在 `apply-audio-project` 返回成功前插入游戏事件调用。
- 不在 revision 冲突时覆盖玩家从事件绑定编辑区做出的修改。
- 不因找不到扫描结果而放弃挂点；自己读玩法代码。
- 不让用户去编辑区点「生成」或粘贴提示词；对话里直接调用 `generate-audio-assets`。
- 不编造 `starterId`；只用 `list-starter-audio` 返回过的 id。
- 不把起步清单当检索库：不按情绪/场景搜，不整份罗列给用户挑，不拿它替代生成。
- 不把 `library/starter/` 的路径写进绑定；游戏里播的必须是 `assets/audio/` 下已复制的文件。
- 不把 `ambient: true` 或 `highFrequencySafe: false` 的条目挂到命中、拾取、界面、脚步上。
