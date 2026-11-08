# Unity WebGL 接入

只在使用 Unity WebGL 时阅读本文件夹。所有团队共同遵守的协议、道具声明、时长和自测要求见根目录 README、AGENT 和接入指南。

## 使用本目录的适配器

把 `InfiniteWorldPlugin.jslib` 放到 `Assets/Plugins/WebGL/`，将 `InfiniteWorldBridge.cs` 挂到名为 `InfiniteWorldBridge` 的场景对象。等待 `SaveLoaded` 或 `CurrentSave` 就绪后读取系统存档。

A 轨 ZIP 可用 `FinishLevel(hook, items, clues)`；B 轨外链用 `FinishWithItemIds(ids)`，监听 `HandoffCompleted` / `HandoffFailed`。

A 轨入口随包带 `shared/save-protocol.js`；B 轨入口引入官方 SDK `https://world.dayquay.com/sdk/v1/worldline.js`，由适配器异步等待 `WL.ready()`，结束时等待交接回执。不要用旧同步接口替代外链 SDK。

## 构建与提交

导出 Compression = Disabled，关闭 Threads。完整提交 Build/、TemplateData/ 等运行目录；不提交 `.unityweb`、C# 源码或 Unity 工程。

保持包内资源路径和目录结构。只上传自己最终的游戏运行产物，不要把本工具包或整个技术栈目录一起投稿。使用根目录 `tools/check.mjs` 检查最终 ZIP，并在大厅“本队投稿 · 自助试玩”确认读档、成功和失败交接。

通关只上报实际获得的已声明道具 ID；没有获得传空数组。生命、理智和背包来自系统实时存档，不能写死满血。完整流程须在 4 分 30 秒内到达明确结局，看门狗为 5 分钟。
