# Phaser 接入

只在使用 Phaser 时阅读本文件夹。所有团队共同遵守的协议、道具声明、时长和自测要求见根目录 README、AGENT 和接入指南。

## 使用本目录的适配器

把 `InfiniteWorldPhaserPlugin.ts` 加入项目，在 `plugins.global` 注册 `{key: "InfiniteWorld", plugin: InfiniteWorldPlugin, start: true}`。场景里通过 `this.plugins.get("InfiniteWorld")` 获取插件，读取 `save` 或等待 `save-ready`。

A 轨 ZIP 可用 `completeLevel(hook, items, clues)`；B 轨外链用 `completeWithItemIds(ids)`，监听 `handoff-result` / `handoff-error`。

A 轨入口随包带 `shared/save-protocol.js`；B 轨入口引入官方 SDK `https://world.dayquay.com/sdk/v1/worldline.js`，由适配器异步等待 `WL.ready()`，结束时等待交接回执。不要用旧同步接口替代外链 SDK。

## 构建与提交

Vite 设置 `base: "./"`，Phaser 资源加载使用相对路径。投稿为构建后网页文件，不提交 TypeScript 源码和 node_modules。

保持包内资源路径和目录结构。只上传自己最终的游戏运行产物，不要把本工具包或整个技术栈目录一起投稿。使用根目录 `tools/check.mjs` 检查最终 ZIP，并在大厅“本队投稿 · 自助试玩”确认读档、成功和失败交接。

通关只上报实际获得的已声明道具 ID；没有获得传空数组。生命、理智和背包来自系统实时存档，不能写死满血。完整流程须在 4 分 30 秒内到达明确结局，看门狗为 5 分钟。
