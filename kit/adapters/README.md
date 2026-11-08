# 引擎接力脚手架

- **Unity WebGL**：把 `InfiniteWorldPlugin.jslib` 放到 `Assets/Plugins/WebGL/`。把 `InfiniteWorldBridge.cs` 挂到名为 `InfiniteWorldBridge` 的场景对象上。等 `SaveLoaded` 或 `CurrentSave` 就绪后读属性；A 轨 ZIP 通关时调用 `FinishLevel(hook, items, clues)`，B 轨外链用 `FinishWithItemIds(ids)`。
- **Godot 4 Web**：将 `InfiniteWorldBridge.gd` 加为同名 Autoload。读取 `current_save` 或监听 `save_loaded`；A 轨 ZIP 用 `complete_level(hook, items, clues)`，B 轨外链用 `complete_with_item_ids(ids)`。
- **Phaser**：将 `InfiniteWorldPhaserPlugin.ts` 加入项目。在游戏配置的 `plugins.global` 注册 `{key: 'InfiniteWorld', plugin: InfiniteWorldPlugin, start: true}`。在场景用 `this.plugins.get('InfiniteWorld')` 获取插件，读取 `save` 或等待 `save-ready` 事件；A 轨 ZIP 用 `completeLevel(hook, items, clues)`，B 轨外链用 `completeWithItemIds(ids)`。

v3.3.2 起适配器优先走官方 SDK：
- **A 轨 ZIP**：平台注入桥 + 包内 `shared/save-protocol.js`；可用 `FinishLevel` / `complete_level` / `completeLevel` 旧路径。
- **B 轨外链**：入口引入 `https://world.dayquay.com/sdk/v1/worldline.js`；适配器会先 `await WL.ready()`，交档用 `FinishWithItemIds` / `complete_with_item_ids` / `completeWithItemIds`，并回传回执。
- 不要用 `FinishLevel` / `complete_level` / `completeLevel` 做外链正式交档；它们只保留 A 轨/旧兼容。

| 引擎 | 外链接档 | 外链交档 | 回执事件 |
| --- | --- | --- | --- |
| Unity | `SaveLoaded` | `FinishWithItemIds` | `HandoffCompleted` / `HandoffFailed` |
| Godot | `save_loaded` | `complete_with_item_ids` | `handoff_result` / `handoff_error` |
| Phaser | `save-ready` | `completeWithItemIds` | `handoff-result` / `handoff-error` |

首次集成请用实际大厅的作品入口和完整世界线验证。


## v3.2 正式交接规则（上传声明 + 实际取得 ID）

本节替代旧示例中“自行拼整份道具定义”“必须产出一件道具/线索”的要求。旧示例用于理解基础接口；正式大厅以本节和已上传的全局道具声明为准。

1. 上传作品时必须提交 `global-items.json`，最多声明 3 件全局道具，名称、介绍及标准 effect 在这里定义。没有全局道具时也必须提交 `global-items.empty.template.json` 空声明模板（`items: []`）。关内钥匙等局部机制不在这里声明。
2. 玩法只记录实际取得的道具 ID；未取得则不奖励。不需要在结束语中嵌 JSON，不上传玩家固定血量。
3. 通关时上报 `acquiredItemIds`。平台查验本关的声明，生成完整道具，继承原有背包，最多保留最近三件。未声明 ID、重复 ID 或超量数组会拒绝交接，原进度保留。
4. 没获得新道具时传 `[]`，允许正常通关，不凭空送奖励，也不强制写一条线索。
5. 角色生命、理智、诅咒等状态沿用游玩结果。回血 +1 是道具的效果；下一关以当时实际血量为基础结算，且同一入场效果只结算一次。
6. 结束语是一句叙事文本。关序、下一关、存档卡封装和效果结算均由平台处理。
7. 客户端只读接口不构成反作弊证明，作品是否按实际玩法上报仍须主办方试玩验收。

```javascript
let save = WL.readSave();
const acquired = new Set();
// 只在玩家实际拾取成功后执行：
function onPickUpOden() { acquired.add("myteam_warm_oden"); }
function onWin() {
  WL.completeLevel(window.CONFIG || {}, save, {
    acquiredItemIds: Array.from(acquired)
  });
}
```

`save` 必须来自当前游戏收到的系统存档，并反映真实游玩结果，禁止用固定满血状态覆盖它。游戏如使用其他引擎，调用适配器的 `FinishWithItemIds`（Unity）、`complete_with_item_ids`（Godot）、`completeWithItemIds`（Phaser）。

A 轨/旧兼容作品如直接 postMessage，发送 `{type:"IW_SAVE", save: currentSave, acquiredItemIds: [...]}`，`currentSave` 来自 `IW_INIT_SAVE`；不得自行编造道具效果、下一关地址或完整跨关卡片。服务端将使用当前路线快照中的声明。
