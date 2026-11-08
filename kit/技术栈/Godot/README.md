# Godot 4 Web 接入

只在使用 Godot 4 Web 时阅读本文件夹。所有团队共同遵守的协议、道具声明、时长和自测要求见根目录 README、AGENT 和接入指南。

## 使用本目录的适配器

把 `InfiniteWorldBridge.gd` 加为同名 Autoload，读取 `current_save` 或等待 `save_loaded`。

A 轨 ZIP 可用 `complete_level(hook, items, clues)`；B 轨外链用 `complete_with_item_ids(ids)`，监听 `handoff_result` / `handoff_error`。

A 轨入口随包带 `shared/save-protocol.js`；B 轨入口引入官方 SDK `https://world.dayquay.com/sdk/v1/worldline.js`，由适配器异步等待 `WL.ready()`，结束时等待交接回执。不要用旧同步接口替代外链 SDK。

## 构建与提交

Web 导出使用单线程，完整提交 HTML、JS、WASM、PCK 等导出产物；不提交 Godot 源工程。

保持包内资源路径和目录结构。只上传自己最终的游戏运行产物，不要把本工具包或整个技术栈目录一起投稿。使用根目录 `tools/check.mjs` 检查最终 ZIP，并在大厅“本队投稿 · 自助试玩”确认读档、成功和失败交接。

通关只上报实际获得的已声明道具 ID；没有获得传空数组。生命、理智和背包来自系统实时存档，不能写死满血。完整流程须在 4 分 30 秒内到达明确结局，看门狗为 5 分钟。
