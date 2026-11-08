> v3.3.2 外链请优先阅读 [外链接力接入指南](外链接力接入指南.md)：使用官方 SDK，开头 await WL.ready()，结尾 await WL.complete/WL.fail。下面的同步 readSave/completeLevel 属于 A 轨 ZIP 兼容接口，不能用于外链。

# 无限世界接力黑客松 · 参赛团队官方交付包使用手册（v3.3.2）

> **版本 v3.3.2 · 更新日期 2026-11-08 · 协议 SAVE_STATE v3 · 取代 v3.3.1**
>
> **外链（B 轨）只认官方 SDK：** 入口引入 `https://world.dayquay.com/sdk/v1/worldline.js`，开头 `await WL.ready()`，结尾 `await WL.complete()` 或 `await WL.fail()`。`WL.readSave()` / `WL.completeLevel()` 只用于 A 轨 ZIP 或旧兼容，不要用于外链。
>
> **外链地址硬性要求：** 必须是长期有效的公开生产地址；禁止 IGA Pages 等临时预览链接（`*.preview.iga-pages.com`、`iga_token`/`iga_time`）。只在新标签页打开成功不算，必须能在 sandboxed iframe 里返回 200。
>
> **请整包分发，不要只打包示例目录。** 示例关卡靠 `../../shared/save-protocol.js` 引用协议库；只拷 `examples/01-minimal-html5-level/` 会 404。要么整包解压使用，要么把示例整目录连同 `shared/` 一起拷走。

欢迎参加「无限世界百人共创游戏接力黑客松」。所有队伍接续同一位主角：上一关的生命、理智、背包道具、线索和结束语，会原样交到下一关。

本交付包是标准化接入工具箱，支持原生 HTML5、Godot、Unity、Phaser，10 分钟接入并本地自测。

---

## 一、包内有什么

```text
participant-delivery-kit-v3.3.2/
├── VERSION.json                   # 包版本、协议版本、协议文件哈希
├── README.md                      # 本文档
├── AGENT.md                       # 开发宪章（时长 / 道具 / 禁止破甲 / 版权 / 打包）
├── 参赛团队 5 分钟接入指南.md      # 速查：读档、通关、字段表、外链注意事项
├── mock-runner.html               # 本地沙盒：模拟大厅 iframe，捕获握手与交接事件
├── global-items.json              # 有全局道具时修改并上传的声明示例
├── global-items.empty.template.json # 没有全局道具时也必须上传的空声明
├── seed-card.json                 # 初始存档样例（本地调试用）
├── shared/
│   └── save-protocol.js           # 协议核心库（不用改）
├── tools/
│   ├── pack.ps1                   # 把自己的关卡打成合规 ZIP
│   └── check.mjs                  # 一键自检（零依赖，Node 标准库）
├── adapters/                      # Unity / Godot / Phaser 桥接脚手架
└── examples/
    ├── 01-minimal-html5-level/    # 最小接力示例：读档 → 掉血复活 → 带道具通关
    └── 02-effect-relic/           # 道具效果示例：hp / max_hp / cleanse，全部 on_enter
```

---

## 二、核心协议库 `shared/save-protocol.js`

SAVE_STATE v3 的纯 JS 实现，负责读档、结算、交接、跳转。在你的入口页最顶部引入：

```html
<script src="shared/save-protocol.js"></script>
```

### 2.1 读档：只读，不要改写

```javascript
let save = WL.readSave();
// 大厅的存档可能在页面启动后才送达，必须更新玩法实际使用的变量和界面。
window.addEventListener('iw-save-ready', event => {
  save = event.detail;
  // 在这里按 save 更新角色、背包、assist 与开场界面。
});
window.addEventListener('iw-admin', event => {
  if (event.detail.save) {
    save = event.detail.save;
    // 在这里同步管理员治疗或复活后的角色与界面。
  }
});

save.player.hp          // 当前生命，可能只剩 1
save.player.max_hp      // 上限，最多 10
save.player.sanity      // 理智
save.player.status      // normal | wounded | cursed | dead | specter
save.player.curses      // 诅咒数组
save.player.deaths      // 连续阵亡次数
save.items              // 背包道具（最多 3 件）
save.clues              // 线索（最多 2 条）
save.exit_hook          // 上一关留下的结束语
save.prev_world         // 上一关世界名
save.next_world         // 下一关世界名
save.tombstone          // 墓碑：{ fallen_level, cause, epitaph }
save.settled            // 已结算的 on_enter 道具 id（平台维护）
```

**不要写死“主角满血 3 点”**，也不要把读到的存档改写成 9999 血。

### 2.2 道具：必须带合规 `effect`

跨关道具 1~3 件，`name` / `desc` / `type` 自由设计，但 `effect` 只能从下表挑一项：

| `effect.stat` | `value` 取值 | 作用 |
|---|---|---|
| `hp` | `1` 或 `2` | 进入下一关时回血（不超过上限） |
| `sanity` | `1` | 进入下一关时理智 +1 |
| `max_hp` | `1` | 进入下一关时生命上限 +1（最多 10） |
| `cleanse` | `true` | 进入下一关时净化 1 项诅咒 |
| `attack` | `1` | 常驻攻击加成，供下一关玩法读取 |

`trigger` 只能是 `on_enter`（进入下一关立即结算，且只结算一次）或 `passive`（常驻，不结算数值）。词条不合规会被平台丢弃，道具降级为纯装饰。

```javascript
WL.addItem(save, {
  id: "item_cyber_battery",
  name: "高能超导电池",
  type: "tool",
  desc: "从废弃能源站拆下来的电池",
  effect: { stat: "attack", value: 1, trigger: "passive" }
});

WL.addClue(save, "遗迹深处指向了远古的蒸汽神庙"); // 线索最多 2 条
```

**看完 `examples/02-effect-relic/` 就知道道具怎么写**：它把 `hp +1`、`max_hp +1`、`cleanse true` 三种 `on_enter` 效果和“只结算一次”都演示了一遍。

### 2.3 死亡与复活

```javascript
if (save.player.hp <= 0) {
  if (save.player.deaths >= 2) {
    WL.failLevel("力竭倒在机械守卫脚下"); // 认输：遗物 + 墓碑交给下一位
  } else {
    save = WL.respawn();                  // 就近复活，连续阵亡次数 +1
  }
}
```

连续阵亡 2~3 次后，用 `WL.assist(save)` 拿到放水档位 `0 / 1 / 2`，自行降攻或给提示。

### 2.4 通关交付

```javascript
WL.completeLevel(window.CONFIG || {}, save, {
  exitHook: "他推开气闸门，前方是一片被霓虹染红的雨夜都市..."
});
```

- `CONFIG` 由平台注入（世界名、下一关名等）。
- **下一关地址由平台决定，不要自己拼 `nextUrl`**。
- 正式大厅以本次游玩的 `acquiredItemIds` 为准，空数组也能通关；道具定义来自上传声明。离线旧示例仍使用完整道具格式。

---

## 三、本地调试：`mock-runner.html`

它模拟现场大屏：父页面用 iframe 加载你的关卡，并捕获 `IW_READY` / `IW_SAVE` / `IW_COMPLETE` / `IW_FAIL`。

1. **选择入口**：可以点“选择本地 HTML 文件”直接选你的 `index.html`，也可以填本地服务地址（推荐，相对资源更稳）。
2. **选择开局**：标准、残血、带遗物三种预设，也可以直接改 JSON。
3. **点“启动”**：左侧试玩，右侧看通信日志与卡片校验。
4. **注意**：本地 iframe 与线上一样没有 `allow-modals`，`alert()` / `confirm()` 会被拒绝；`top.location` 跳转也会失败。本地能跑不代表线上能跑，最终以真实大厅为准。

沙盒可用：先起本地服务再打开本页：

```bash
python -m http.server 8080
# 浏览器打开 http://localhost:8080/mock-runner.html
```

---

## 四、初始种子卡 `seed-card.json`

一份 v3 存档样例，用来本地测试“残血 / 带遗物 / 有墓碑”等开局。

- `player.hp` / `max_hp` / `sanity` / `status` / `curses` / `deaths`
- `items`（含 1 件 `sanity +1 passive` 的示例道具）
- `clues`、`exit_hook`、`prev_world`、`next_world`、`tombstone`、`settled`

它只是本地调试素材；**正式比赛的开局状态由主办方统一注入**，不要指望靠它改开局。

---

## 五、引擎适配器 `adapters/`

- **Unity WebGL**：`InfiniteWorldPlugin.jslib` 放 `Assets/Plugins/WebGL/`，`InfiniteWorldBridge.cs` 挂到常驻物体。
- **Godot 4**：`InfiniteWorldBridge.gd` 注册为 AutoLoad 单例。
- **Phaser 3**：`InfiniteWorldPhaserPlugin.ts` 注册到 `plugins.global`。

细节见 `adapters/README.md`。

---

## 六、打包与自检

### 6.1 打成合规 ZIP

```powershell
powershell -ExecutionPolicy Bypass -File tools/pack.ps1 -GameDir .\你的关卡目录 -Out .\提交.zip
```

脚本会：排除 `node_modules` / `.git` / 隐藏文件、检查根目录有 `index.html`、超过 12MB 或解压后超过 40MB 直接报错。

### 6.2 一键自检

```bash
node tools/check.mjs .\你的关卡目录
```

不带参数时，会对包内两个示例做体检（入口、相对引用、禁用 API、道具词条）。

---

## 七、提交前必检清单

- [ ] 合理的最佳解法下 4 分 30 秒内完成完整流程并到达结局，允许更短，无须凑满 4 分 30 秒。
- [ ] 主角只剩 1 点血进场也能通关；前 5 秒没有即死陷阱。
- [ ] 道具 1~3 件，线索 ≤ 2 条。
- [ ] 每件跨关道具的 `effect` 在词表内，`value` 合法，`cleanse` 用 `true`。
- [ ] 有 `WL.respawn()` 就近复活，也有 `WL.failLevel()` 认输交接，不会卡死。
- [ ] 不用 `alert()` / `confirm()` / `top.location` / `parent.location`。
- [ ] 台词不破甲，承接 `exit_hook`，通关时留新钩子。
- [ ] 音乐为 CC0 / 免版税 / AI 原创；美术无未授权知名 IP。
- [ ] ZIP 根目录有 `index.html`，≤ 12MB，解压 ≤ 40MB，≤ 250 个文件，单文件 ≤ 35MB。
- [ ] 用 `mock-runner.html` 跑通一次“进入 → 通关 / 阵亡交接”。
- [ ] （外链作品）`node tools/check.mjs <URL>` 通过；HTTPS、允许 iframe 嵌入、CSP `script-src` 放行 SDK、静态资源 CORS 正确；不是 IGA Pages/临时预览，iframe 内返回 200。

---

## 八、硬性约束（验收口径）

判据只有一句：**任何一条不满足，作品不得进入世界线。**

| # | 类别 | 硬性要求 | 验收怎么抓 |
|---|---|---|---|
| 1 | 包体 | ZIP ≤12MB；解压后 ≤40MB；≤250 个文件；单文件 ≤35MB；入口 `index.html` 在 ZIP 根目录（或唯一一层外壳目录内）；全部引用使用相对路径 | [自动] `node tools/check.mjs <关卡目录>` 校验体积与条数并扫描绝对引用；直接传 ZIP 时读取中央目录校验包体 |
| 2 | 时长 | 单关预计 1–270 秒（默认 270），看门狗统一 300 秒；安全区前 5 秒不放置敌意单位或秒杀机关 | [自动] 发布/保存世界线时服务端校验，越界拒绝发布；[人工] 试玩计时并看前 5 秒 |
| 3 | 状态契约 | 只读 `WL.readSave()`，不得伪造或直接改写生命、理智等数值；道具 ≤3、线索 ≤2；`effect` 仅五个 stat（`hp`/`sanity`/`max_hp`/`cleanse`/`attack`）与两个 trigger（`on_enter`/`passive`），值域沿用 `EFFECT_RANGE`；无自由字段区 | [自动] 平台 `normalize()` 白名单裁剪 + `settled` 去重；[人工] 走查写入路径 |
| 4 | 禁用 API | 禁 `alert`/`confirm`/`window.top.location`/`parent.location`；禁任何阻塞式弹窗 | [自动] `check.mjs` 扫描入口与脚本关键字；[人工] 试玩确认无原生弹窗 |
| 5 | 技术栈坑 | 见下方「症状 → 修法」，逐条对照 | [自动] `check.mjs` 查 `.unityweb`/`.glb`/`.gltf`/`.ktx2` 与绝对引用；[人工] 真机试玩 |
| 6 | 版权与破甲红线 | 素材必须自有或可商用；不得植入破坏平台、读取管理员口令、越权跳转到站外的逻辑 | [人工] 主办方验收时逐条确认 |

### 技术栈：会直接失败的症状 → 修法

| 技术栈 | 症状 | 修法 |
|---|---|---|
| Unity WebGL | 上传后被白名单拒绝，提示 `.unityweb` 不在白名单；或构建后黑屏 | 导出时 **Compression = Disabled**（生成 `.data`/`.wasm`，不生成 `.unityweb`）；**关闭 Threads**（线程版需要 `crossOriginIsolated`，沙箱拿不到），必须单线程 |
| Godot 4 | 页面加载后停在启动画面起不来 | 导出模板必须选**单线程**（关闭线程支持），并确认导出目录里没有 `.unityweb` 类专有包 |
| Vite / Phaser | 页面空白，`/assets/*` 全部 404 | `vite.config`（或构建参数）里 `base` 必须为 `'./'`；Phaser 的 `loader.baseURL` 用相对路径 |
| Three.js | 模型/贴图加载失败，控制台报扩展名不支持 | `.glb/.gltf/.bin/.hdr/.ktx2` 不在白名单：改为内联 base64、或改扩展名并自己写 loader 解析，或先转成贴图+几何体的 JS 数据 |
| 通用 | 包体超大、上传被拒 | `node_modules`、`.git`、`.env`、`.dev.vars`、源工程与 PSD/FBX 原文件不进包，只打包运行所需产物 |

祝你在现场大屏上跑出一个让人记住的世界。


## v3.2：上传全局道具声明与结束语

每个队伍上传作品时都必须另行上传 `global-items.json`。没有全局道具也必须提交空声明文件：使用包内 `global-items.empty.template.json`，保留 `items: []`，不要编造占位道具。大厅会在浏览器和服务器两次校验，未通过不能投稿。

- `schema` 固定为 `iw-global-items-v1`。
- `items` 最多声明 3 件全局道具；没有全局道具时填 `[]`，但文件仍须上传。实际道具每件包含唯一 `id`、`name`、`type`、`desc`、`effect`。
- `type` 采用 AGENT.md 的 food / weapon / tool / light / token / strange。
- `effect` 仍采用官方五种词条及既有取值范围；`trigger` 为 on_enter 或 passive。
- 声明不包含 `player`、当前血量、理智、存档、关序或下一关地址。道具的“回血 +1”是效果定义，具体玩家血量随实际游玩产生。
- 关卡内专用道具不列入全局道具声明。不要伪造整份交接存档。
- 大厅中的“结束语”是通关后显示的一句话，与道具声明文件分开填写。路线、上下关、存档封装和效果结算由平台处理。

本机校验：`node tools/check-manifest.mjs global-items.json`。队伍邀请码及上传排队方式见大厅。


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


## 2026-11-07 打包与提交修订

- `tools/pack.ps1` 将 ZIP 条目的 Windows 反斜杠统一为 `/`，并调用 `check.mjs` 对实际生成的 ZIP 预检。需要 Node.js 22 或更新版本。
- 提交前务必检查最终压缩包：`node tools/check.mjs ./提交.zip`。解包目录自检无法发现压缩工具写出的特殊条目名。
- ZIP 自检覆盖路径安全、规范化后重名、完整扩展名白名单、压缩体积、解压体积、单文件体积和文件数量；不通过时会列出具体条目并以非零退出码结束。
- 大厅兼容已有 ZIP 的 `\` 分隔符和开头 `./`，统一存储为 `/`。`..`、绝对路径、控制字符、隐藏密钥及 `% ? # :` 仍不允许，规范化后重名也会拒绝。
- 路径兼容不修改游戏脚本、资源内容、存档协议或道具交接规则。静态自检通过后仍需运行游戏和主办方试玩验收。

## v3.3.1 必填道具声明

每队必须提交道具声明文件。没有全局道具时，上传包内 `global-items.empty.template.json`（可重命名为 `global-items.json`），内容为 `{"schema":"iw-global-items-v1","items":[]}`。本机校验：`node tools/check-manifest.mjs global-items.empty.template.json`。声明为空也会保留玩家已有背包。

修改声明后仍需在 ZIP 模式选择原 ZIP 一起重新提交。平台更新本队同一份作品并重新进入验收；缺少 ZIP 会被拒绝，不会清空已提交游戏。


## v3.3.1 Unity WebGL 提交与试玩要求

平台的世界线试玩运行在隔离 iframe 中。Unity WebGL 必须按下面的发布产物提交，不能只上传一个 HTML：

1. 在 Unity WebGL 发布设置中使用 **Compression = Disabled**，关闭 Threads；提交后应看到 `.data`、`.framework.js`、`.loader.js`、`.wasm`，不要提交 `.unityweb`。
2. ZIP 必须同时包含入口 `index.html`、`Build/` 目录，以及 Unity 导出时生成的 `TemplateData/`、`StreamingAssets/` 等运行目录。不要移动、重命名或拆散 `Build/` 内文件。
3. 入口和资源全部使用相对路径。不要写 `/Build/...`、`/assets/...` 或指向作者电脑的盘符路径；在作者电脑用本地 HTTP 服务打开 `index.html`，不要只双击 `file://` 文件。
4. 提交前运行 `node tools/check.mjs <提交.zip>`。自检会检查 Unity 的四类 Build 文件、`.unityweb`、CSS 的相对资源和 ZIP 路径；自检通过后仍要在大厅点“立即试玩”确认加载完成。
5. 试玩页面如果停在黑屏或加载条，保留浏览器控制台和 Network 失败请求，先检查最终 ZIP 而不是重新上传同一个压缩包。

平台会在试玩时保留游戏隔离，不要求参赛者放开 iframe 权限。A 轨 ZIP 用 `WL.readSave()` / `WL.completeLevel()`；B 轨外链必须用官方 SDK 的 `await WL.ready()` 与 `await WL.complete()` / `WL.fail()`。


## v3.3.1 正式提交要求（2026-11-07，以本节为准）

- 选手下载的交付包是开发工具。投稿 ZIP 只放构建完成的网页运行文件，不要把交付包整个压进去；禁止 adapters/、tools/、examples/、node_modules/、.git/、源工程和密钥文件。
- ZIP 上限 12 MB，解压后 40 MB，最多 250 文件，单文件 35 MB。入口默认 index.html；自定义入口须在工具和大厅填写同一相对路径。
- 必须单独上传 global-items.json；没有跨关道具时使用 {"schema":"iw-global-items-v1","items":[]}。零收获可以通关，无须硬凑道具或线索。cleanse.value 只接受布尔 true，不能写数字 1。
- 正式提交前运行 `node tools/check.mjs <游戏.zip> <实际的global-items.json>`；自定义入口使用第四个参数，如 `node tools/check.mjs game.zip global-items.json pages/start.html`。应检查最终 ZIP，不能只检查目录。
- Unity WebGL：Compression Format 选 Disabled，关闭 Threads，完整保留 Build/ 和 TemplateData/，使用相对路径。不要提交 .unityweb、.br 或 .gz。使用本地 HTTP 服务实测，直接双击 index.html 不能替代网页部署测试。
- 通关调用 WL.completeLevel(window.CONFIG || {}, save, {acquiredItemIds:[]})，有实际收获时只填声明中对应的 ID。本地 mock-runner 也必须先选择本关声明 JSON；多文件/Unity 作品用本地 HTTP 地址。模拟器不能替代大厅实际试玩验收。
- 外链作品引入 https://world.dayquay.com/sdk/v1/worldline.js，完成 WL.ready()/WL.complete()/WL.fail() 的 SDK 握手，并允许 world.dayquay.com 的 iframe 嵌入；旧 IW_READY/IW_SAVE 仅兼容。主办方人工通关后验收。
- 投稿先验收，再由主办方明确发布世界线。通过验收不会自动进入公开路线。

示例各自带有 global-items.json 和 shared/save-protocol.js，可单独复制示例目录作为起点。在本地模拟器中，选择该示例目录内的声明文件；根目录的声明模板不能代替示例的实际声明。


## 外链作品的异步接入（v3.3.1）

外链投稿显示“外链待验收”，表示平台未扫描外站源码，不能据此判定缺接口。发布前必须在大厅 iframe 内验证读档、成功交接与失败交接。

外链在加载后才会收到存档。请使用官方 SDK：`await WL.ready()` 拿到入场 save 后再初始化玩法；也可监听 `iw-save-ready`，用 `event.detail` 更新实际游戏 save、assist 和开场面板。只在顶层调用一次 `WL.readSave()` 会保留握手前的默认值，不能替代 `ready()`。裁判恢复状态时监听 `iw-admin`，按 `detail.save` 同步实际游戏状态。SDK 在 localStorage 被沙箱拒绝时保留内存存档，不要求放宽 allow-same-origin；但作品自己的 localStorage/IndexedDB 不会被 SDK 接管。

成功通关传实际 acquiredItemIds；失败前也应将已获得的声明道具纳入 fallenSave.items，不能只维护关内的 ID Set。主办方的出口钩子由平台统一决定。外链应使用长期有效的托管地址，并与平台单独上传的 global-items.json 保持一致。

外链必须能在无登录 Cookie、无临时授权的隔离 iframe 中直接访问。仅在自己浏览器单独打开预览 URL 成功，不代表大厅内可用；遇到重定向后 401 请使用公开托管地址或上传 ZIP，不要要求平台放宽沙箱权限。


上传声明必须与当前游戏版本配套，不能直接使用交付包示例。格式校验通过只代表 JSON 合规，不能证明声明 ID 与作品一致。外链必须能在无登录 Cookie、无临时授权的隔离 iframe 中直接访问。


## 时长与完整流程验收（v3.3.1，以本节为准）

作者必须用自己实际可执行的正常通关路线，至少完整跑过一遍作品：从点击开始，经过开场、核心玩法、必经对话/过场，直到出现明确的结局。该完整过程须在 **4 分 30 秒（270 秒）内**完成，允许更短，无须凑满 4 分 30 秒。不能只验证能启动，不能只给出理论最短路径，也不能把裁判强制跳关或看门狗超时当作自然通关。

提交前填写包内 `完整流程自测记录.md`，记录运行环境、实际入口、自己的操作路线、总用时和到达的结局。随后在大厅验证接档及成功/失败交档。该记录是作者自测，不等同于主办方已验收。

后台预计时长为 **1–270 秒，默认 270 秒**。它用于编排参考，不会提前截断更短或更长的实玩过程。平台看门狗保持 **5 分钟（300 秒）**，预留 30 秒缓冲用于加载及交接，超时才执行遗物交接。看门狗是兜底，不能代替作品自己的结局。刷新、重载、治疗不重置本关看门狗。
