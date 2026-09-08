# 起步音频（starter）

跟插件一起打包的一小批现成音频：100 条音效（MP3 192kbps）+ 30 条 BGM（OGG Vorbis
q5，每条 32 秒）。用于 Seed Audio 没配置、或用户要现成声音时，让游戏先有声音。

## 定位

**这不是素材库。** 没有界面入口，没有检索，只有 Agent 用的取用清单：

- `list-starter-audio` 列清单
- `use-starter-audio` 按 id 复制进当前游戏的 `assets/audio/` 并写 manifest

游戏里播的一律是游戏目录下的文件。任何绑定都不许引用本目录的路径。默认路径仍是
`generate-audio-assets` 生成。

## index.json

`index.json` 是这批字节唯一的可读描述，Agent 靠它区分 200ms 的点击音和三分钟的森林床。

| 字段 | 含义 |
| --- | --- |
| `id` | 取用 id，如 `sfx/ui/click-00` |
| `usage` | 这条声音是干什么的（策划原话） |
| `durationMs` | 实测时长。MP3 从帧头估算，OGG 从末页 granule 精确读出 |
| `loop` | 是否按循环绑定。BGM 全为 true；音效只有环境和带 `-loop` 的为 true |
| `ambient` | 长环境床，只挂场景循环，不挂一次性事件 |
| `highFrequencySafe` | 是否短到能挂命中/拾取/界面/脚步（≤1500ms） |
| `sourceAssetId` | 交付批次里的 id，用于追溯审核记录 |

改动音频文件后重建索引：

```bash
bun scripts/build-starter-library.ts          # 重建
bun scripts/build-starter-library.ts --check  # 校验是否与磁盘一致（进 build）
```

导入新的交付批次：

```bash
bun scripts/build-starter-library.ts \
  --import-sfx <含 sfx/ 与 manifest.csv 的目录> \
  --import-bgm <含 audio/ 与 manifest.json 的目录>
```

导入会把路径规范化成 ASCII（源批次里有中文目录、括号和逗号），并把交付批次的分类序号前缀
去掉——`7_ambient` 和 `7_vehicle` 这类撞号在这里不存在。

## 来源

ForgeaX 首发音频批次，经内部试听审核后保留。WAV 源文件不进仓库。
