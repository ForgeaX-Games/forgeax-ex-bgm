# ForgeaX 音频插件安装说明

本目录是 `@forgeax-extension/bgm` 的完整可分发插件。正式交付文件为
`ForgeaX-音频插件-forgeax-bgm-0.4.0.fxpack`，接收方不需要 ForgeaX 源码，也不需要
重新构建前端。

## 安装

1. 打开 ForgeaX 的“设置”。
2. 进入“扩展 / FXPack 导入”。
3. 填入 `.fxpack` 文件的绝对路径并点击“检查”。
4. 选择 `L1（用户级）`。如果已存在 `@forgeax-extension/bgm`，冲突策略选择
   “覆盖”。
5. 此包当前未签名；确认文件来自可信交付方后勾选确认并安装。
6. 插件注册表会自动刷新；若“音乐音效”没有立即出现，重启一次 ForgeaX。

也可以使用 ForgeaX 自带命令行安装：

```bash
forgeax-pack install ./ForgeaX-音频插件-forgeax-bgm-0.4.0.fxpack \
  --layer L1 \
  --policy overwrite \
  --ack-unsigned
```

## 生成服务配置

安装包包含插件逻辑、前端构建产物、AI 工具和技能说明。语音 / BGM / 音效生成
需要在 ForgeaX 根目录的 `.env` 配置 Seed Audio 与相关供应商密钥（见
`requestedEnv`）。缺少配置时插件仍可打开，但无法调用生成接口。

## 验证

- 插件管理中出现“音乐音效 / BGM & SFX”。
- 玩家端侧栏只有「语音生成」和「AI 音频」；中央是声音设计工作区。
- Agent 端存在 `generate-audio-assets`、`patch-audio-project`、
  `apply-audio-project` 与 `verify-audio-project`。
- AI 调用走 `generate-audio-assets → patch-audio-project → apply-audio-project`，
  不使用已下线的检索 / 挂载工具。

## 卸载或回退

删除用户级 `.forgeax/extensions/bgm` 后重启 ForgeaX，即可恢复使用 ForgeaX
内置的 L0 版本（如果该版本存在）。
