> v3.3.2 外链请优先阅读 [外链接力接入指南](外链接力接入指南.md)：使用官方 SDK，开头 await WL.ready()，结尾 await WL.complete/WL.fail。下面的同步 readSave/completeLevel 属于 A 轨 ZIP 兼容接口。

# 无限世界接力黑客松 · 开发宪章与 AI 协同规范 (AGENT.md)

你正在为“无限世界游戏接力黑客松”开发一个关卡世界。
作为开发者（以及你的 AI 编程助手），你必须严格遵守以下规则边界、设计哲学与数据契约：

> **A 轨 / B 轨先选对（v3.3.2）**
> - **A 轨 ZIP**：平台注入桥，入口随包带 `shared/save-protocol.js`；用 `WL.readSave()` / `WL.completeLevel()`。
> - **B 轨外链**：入口引入 `https://world.dayquay.com/sdk/v1/worldline.js`；开局 `await WL.ready()`，结尾 `await WL.complete()` / `await WL.fail()`。**不要**用 `readSave()` 代替 `ready()`，也不要用 `completeLevel()` 代替 `complete()`。
> - **B 轨地址**：必须是长期有效的公开生产地址；禁止 IGA Pages 等临时预览/带 `iga_token`/`iga_time` 的链接。只在新标签页打开成功不算，必须能在 sandboxed iframe 里返回 200。
> - 下面第七章的代码是 A 轨示例；B 轨完整接法见《外链接力接入指南》。

---

### 一、 核心法则：未知的传承与动态自适应（严禁预设数值）

1. 【主角状态完全未知】：
   - 严禁在代码中写死或预设“主角一定是 3 点血/满状态进入”；
   - 上一个世界交接给你的主角状态完全不可控：他可能是满血，也可能是只剩 1 点血的残废状态，甚至理智扣减、带有负面诅咒；背包可能空空如也，也可能携带了前人留下的奇怪遗物。
   
2. 【禁止“索钥式”卡关设计（保证通用通关可能）】：
   - 严禁设计“必须拥有上一个世界的某件特定道具才能通关”的硬卡死逻辑（如：大门锁死，必须靠前人带来的特定钥匙才能开）；
   - **正确做法**：前人传下来的道具只能作为“增益彩蛋”（例如：带了前人武器伤害翻倍，没带武器也能靠关卡内的机制通关）。关卡必须在“零外部装备”的前提下依然能顺利通关。

3. 【开局安全区保障】：
   - 鉴于主角可能进门只剩 1 点 HP，关卡起点前 5 秒内严禁设置“开门杀”即死陷阱，必须给予玩家观察环境、读取线索的安全空间。

---

### 二、 双层道具规范与自描述数值契约（核心数据协议）

游戏中出现的道具必须严格分为两层：

#### 1. 关卡内道具（Local Items，不进背包，不带出关卡）：
- **定义**：仅在当前关卡内部起效的特异性道具（如：本关专属的红蓝门钥匙、二段跳药水、解密齿轮、临时动力源）；
- **规则**：关卡结束时直接在关卡内销毁，**严禁使用 `WL.addItem` 存入跨关交接卡**。

#### 2. 通用交接道具（Relic/Universal Items，跨关继承，限 1~3 件）：
- **定义**：通关时允许带入下一个世界的战利品；
- **自由度**：**道具名称（name）、外观图标、背景介绍（desc）完全由团队自由设计发挥**；
- **自描述数值约束**：通关打包放入背包时，**必须在 `effect` 字段中绑定组委会标准通用词条之一**，下一关系统底层将自动识别并生效数值，无需人工录库！

##### 📦 通用道具标准代码格式：
```javascript
WL.addItem(save, {
  id: "item_cyber_apple",          // 唯一ID（英文字符串）
  name: "赛博霓虹苹果",            // 【自由起名】
  type: "food",                    // 标签: "food" | "weapon" | "tool" | "light" | "token" | "strange"
  desc: "咬一口能恢复精神的仿生苹果", // 【自由写文案】
  effect: {                        // 【标准通用数值词条，必须符合下表规范】
    stat: "hp",                    // 影响属性: "hp" | "sanity" | "max_hp" | "cleanse" | "attack"
    value: 1,                      // 增减数值 (+1, +2, -1)
    trigger: "on_enter"            // 触发时机: "on_enter"(进下一关立即生效) | "passive"(常驻)
  }
});
```

##### 📋 组委会标准通用效果词条表（设计道具时挑一项绑定）：
| 效果词条 (`effect.stat`) | 取值范围 (`value`) | 作用说明 | 道具创意举例 |
|---|---|---|---|
| **`hp`** | `+1` 或 `+2` | 下一关开局自动在生命上限内回血 | “祖传急救喷雾”、“高热量军粮”、“能量棒” |
| **`sanity`** | `+1` | 下一关开局理智值恢复 1 点（防发疯） | “八音盒”、“宁神香薰”、“清醒剂” |
| **`max_hp`** | `+1` | 下一关开局主角生命上限扩充为 4 点 | “钛合金防弹插板”、“外骨骼胸甲” |
| **`cleanse`** | `true` | 下一关开局自动净化解除 1 项负面诅咒/创伤 | “净化圣水”、“记忆消除喷雾” |
| **`attack`** | `+1` | 攻击/伤害倍率加成（供下一关战斗玩法读取） | “炽炎短剑”、“激光手枪”、“重型管钳” |

---

### 三、 玩法自由与难度控制（重趣味，轻折磨）

1. 【玩法完全不限】：
   - 主办方不限制任何游戏类型：动作冒险、平台跳跃、密室解密、节奏音游、文字推理、射击甚至卡牌均可。

2. 【游戏时长硬红线】：
   - 单个关卡必须控制在 **最佳解法下 4 分 30 秒内完成完整流程并到达结局，允许更短**！本次活动为现场大屏快速连锁接力，禁止设计漫长的跑图和繁复的冗长文本。

3. 【允许死亡，但必须有合理的复活与通关安排】：
   - 我们完全支持关卡内包含硬核挑战和死亡，但**绝对禁止做死循环卡关的“受苦”关卡**；
   - **就近复活原则**：若包含死亡机制，必须在检查点就近快速复活（调用 `WL.respawn()`），严禁漫长黑屏或让玩家重新看片头；
   - **动态难度保底**：若玩家在关卡内连续阵亡 2~3 次，游戏应当适当放水（如怪物降攻、显示机关密码提示），确保在合理时间内能够顺利通关。

4. 【死亡认输也是一种史诗（优雅处理未通关）】：
   - 若玩家确实力竭无法突破，关卡必须提供认输/牺牲通道（调用 `WL.failLevel("关卡阵亡原因")`）；
   - 系统会自动将死者遗物打包，呼唤下一位“继承者”前来接力。**严禁在阵亡后死循环卡死、拒绝交接**。

---

### 四、 叙事沉浸与“禁止破甲”（严禁出戏）

1. 【禁止打破第四面墙（禁止破甲）】：
   - 本次黑客松是一场多元宇宙无限流接力；
   - 严禁在剧情、台词、UI 中出现恶搞破甲台词（如“你在打黑客松比赛”、“AI 生成的代码有 Bug”等破坏沉浸感的内容）；
   - 必须尊重并承接上一个世界的结束语（`exit_hook`），同时在通关时为下一棒留下一个富有悬念的收尾钩子。

---

### 五、 安全与公平防线（严禁逆向与恶意破坏）

1. 【禁止逆向与篡改前人数据】：
   - 只能通过 `WL.readSave()` 读取前人合法传过来的数据，严禁直接在代码中强行伪造 9999 血量等外挂级数值；
   - 传给后方的道具必须合规（最多保留 3 件通用道具、2 条线索）。
2. 【禁止 Iframe 逃逸与破坏】：
   - 严禁调用 `window.top.location`、`parent.location` 进行顶层跳转；
   - 严禁使用系统原生阻塞式弹窗（禁止 `alert()`、`confirm()`）。

---

### 六、 素材与版权合规防线（严禁侵权，防止直播被掐）

1. 【音乐音效红线】：
   - **绝对禁止使用任何商业发行的流行歌曲、明星单曲、商业游戏原版 OST**（现场有全网直播，侵权音乐会导致直播间被瞬间封禁！）；
   - 推荐使用：CC0 / 免费商用音效库（如 Kenney.nl, Freesound.org）或 Suno / Udio 等 AI 生成音乐。
2. 【美术资产红线】：
   - 严禁使用未授权的任天堂、迪士尼、原神等知名商业 IP 角色立绘；
   - 推荐使用：原创手绘、开源免费素材包、或 Midjourney / Stable Diffusion 等 AIGC 生成素材（须在提交表单中如实申报）。

---

### 七、 技术打包与调用三步范式

1. 纯静态 ZIP 包不得超过 12MB（解压后不得超过 40MB，文件数不得超过 250，单文件不得超过 35MB）；
2. 根目录下必须包含 `index.html` 入口文件；
3. **标准代码三步走（A 轨 ZIP）**（协议版本：SAVE_STATE v3）：
```javascript
// 1. 关卡初始化：读取小人属性并享受上一棒道具加成
const save = WL.readSave();

// 2. 关卡进行中：掉血判断
if (playerHp <= 0) {
  // 选项A: 就近复活重试
  WL.respawn();
  // 选项B: 多次力竭彻底认输交接
  WL.failLevel("力竭倒在机械守卫脚下");
  return;
}

// 3. 通关胜利：带走通用战利品，留下一句话给下家
function onGameWin() {
  WL.addItem(save, {
    id: "item_laser_gun",
    name: "过载等离子枪",
    type: "weapon",
    desc: "充满不稳定能量的未来武器",
    effect: { stat: "attack", value: 1, trigger: "passive" }
  });

  WL.completeLevel(CONFIG, save, {
    exitHook: "他收起等离子枪，纵身跃入前方光怪陆离的虫洞..."
    // 下一关地址由平台决定，不要自己拼 nextUrl
  });
}
```

B 轨外链的最小接法（不要用上面的 `readSave` / `completeLevel`）：

```javascript
const save = await WL.ready();
// ...玩法...
await WL.complete(save, { acquiredItemIds: ['team_lamp'] });
// 失败：await WL.fail('力竭倒地', save, { acquiredItemIds: [] });
```

道具效果的完整写法见 `examples/02-effect-relic/`（`hp` / `max_hp` / `cleanse` 三种 `on_enter` 效果）。

---

### 八、 硬性约束速查（验收口径）

判据只有一句：**任何一条不满足，作品不得进入世界线。**

| # | 类别 | 硬性要求 | 验收怎么抓 |
|---|---|---|---|
| 1 | 包体 | ZIP ≤12MB；解压后 ≤40MB；≤250 个文件；单文件 ≤35MB；入口 `index.html` 在 ZIP 根目录（或唯一一层外壳目录内）；全部引用使用相对路径 | [自动] `node tools/check.mjs <关卡目录>` 校验体积与条数并扫描绝对引用；直接传 ZIP 时读取中央目录校验包体 |
| 2 | 时长 | 单关预计 1–270 秒（默认 270），看门狗统一 300 秒；安全区前 5 秒不放置敌意单位或秒杀机关 | [自动] 发布/保存世界线时服务端校验，越界拒绝发布；[人工] 试玩计时并看前 5 秒 |
| 3 | 状态契约 | 只读 `WL.readSave()`，不得伪造或直接改写生命、理智等数值；道具 ≤3、线索 ≤2；`effect` 仅五个 stat（`hp`/`sanity`/`max_hp`/`cleanse`/`attack`）与两个 trigger（`on_enter`/`passive`），值域沿用 `EFFECT_RANGE`；无自由字段区 | [自动] 平台 `normalize()` 白名单裁剪 + `settled` 去重；[人工] 走查写入路径 |
| 4 | 禁用 API | 禁 `alert`/`confirm`/`window.top.location`/`parent.location`；禁任何阻塞式弹窗 | [自动] `check.mjs` 扫描入口与脚本关键字；[人工] 试玩确认无原生弹窗 |
| 5 | 技术栈坑 | 见下方「症状 → 修法」，逐条对照 | [自动] `check.mjs` 查 `.unityweb`/`.glb`/`.gltf`/`.ktx2` 与绝对引用；[人工] 真机试玩 |
| 6 | 版权与破甲红线 | 素材必须自有或可商用；不得植入破坏平台、读取管理员口令、越权跳转到站外的逻辑 | [人工] 主办方验收时逐条确认 |

#### 技术栈：会直接失败的症状 → 修法

| 技术栈 | 症状 | 修法 |
|---|---|---|
| Unity WebGL | 上传后被白名单拒绝，提示 `.unityweb` 不在白名单；或构建后黑屏 | 导出时 **Compression = Disabled**（生成 `.data`/`.wasm`，不生成 `.unityweb`）；**关闭 Threads**（线程版需要 `crossOriginIsolated`，沙箱拿不到），必须单线程 |
| Godot 4 | 页面加载后停在启动画面起不来 | 导出模板必须选**单线程**（关闭线程支持），并确认导出目录里没有 `.unityweb` 类专有包 |
| Vite / Phaser | 页面空白，`/assets/*` 全部 404 | `vite.config`（或构建参数）里 `base` 必须为 `'./'`；Phaser 的 `loader.baseURL` 用相对路径 |
| Three.js | 模型/贴图加载失败，控制台报扩展名不支持 | `.glb/.gltf/.bin/.hdr/.ktx2` 不在白名单：改为内联 base64、或改扩展名并自己写 loader 解析，或先转成贴图+几何体的 JS 数据 |
| 通用 | 包体超大、上传被拒 | `node_modules`、`.git`、`.env`、`.dev.vars`、源工程与 PSD/FBX 原文件不进包，只打包运行所需产物 |


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


## v3.3.1 Unity WebGL 提交与试玩要求

平台的世界线试玩运行在隔离 iframe 中。Unity WebGL 必须按下面的发布产物提交，不能只上传一个 HTML：

1. 在 Unity WebGL 发布设置中使用 **Compression = Disabled**，关闭 Threads；提交后应看到 `.data`、`.framework.js`、`.loader.js`、`.wasm`，不要提交 `.unityweb`。
2. ZIP 必须同时包含入口 `index.html`、`Build/` 目录，以及 Unity 导出时生成的 `TemplateData/`、`StreamingAssets/` 等运行目录。不要移动、重命名或拆散 `Build/` 内文件。
3. 入口和资源全部使用相对路径。不要写 `/Build/...`、`/assets/...` 或指向作者电脑的盘符路径；在作者电脑用本地 HTTP 服务打开 `index.html`，不要只双击 `file://` 文件。
4. 提交前运行 `node tools/check.mjs <提交.zip>`。自检会检查 Unity 的四类 Build 文件、`.unityweb`、CSS 的相对资源和 ZIP 路径；自检通过后仍要在大厅点“立即试玩”确认加载完成。
5. 试玩页面如果停在黑屏或加载条，保留浏览器控制台和 Network 失败请求，先检查最终 ZIP 而不是重新上传同一个压缩包。

平台会在试玩时保留游戏隔离，不要求参赛者放开 iframe 权限；作品只需要通过官方 `WL.readSave()`、`WL.completeLevel()` 和 `IW_READY` 接入接力协议。


## v3.3.1 正式提交要求（2026-11-07，以本节为准）

- 选手下载的交付包是开发工具。投稿 ZIP 只放构建完成的网页运行文件，不要把交付包整个压进去；禁止 adapters/、tools/、examples/、node_modules/、.git/、源工程和密钥文件。
- ZIP 上限 12 MB，解压后 40 MB，最多 250 文件，单文件 35 MB。入口默认 index.html；自定义入口须在工具和大厅填写同一相对路径。
- 必须单独上传 global-items.json；没有跨关道具时使用 {"schema":"iw-global-items-v1","items":[]}。零收获可以通关，无须硬凑道具或线索。cleanse.value 只接受布尔 true，不能写数字 1。
- 正式提交前运行 `node tools/check.mjs <游戏.zip> <实际的global-items.json>`；自定义入口使用第四个参数，如 `node tools/check.mjs game.zip global-items.json pages/start.html`。应检查最终 ZIP，不能只检查目录。
- Unity WebGL：Compression Format 选 Disabled，关闭 Threads，完整保留 Build/ 和 TemplateData/，使用相对路径。不要提交 .unityweb、.br 或 .gz。使用本地 HTTP 服务实测，直接双击 index.html 不能替代网页部署测试。
- A 轨 ZIP 通关调用 WL.completeLevel(window.CONFIG || {}, save, {acquiredItemIds:[]})；B 轨外链用 await WL.complete(save, {acquiredItemIds}) / WL.fail(...)。有实际收获时只填声明中对应的 ID。本地 mock-runner 也必须先选择本关声明 JSON；多文件/Unity 作品用本地 HTTP 地址。模拟器不能替代大厅实际试玩验收。
- 外链作品引入 https://world.dayquay.com/sdk/v1/worldline.js，完成 WL.ready()/WL.complete()/WL.fail() 的 SDK 握手，并允许 world.dayquay.com 的 iframe 嵌入；旧 IW_READY/IW_SAVE 仅兼容。主办方人工通关后验收。
- 投稿先验收，再由主办方明确发布世界线。通过验收不会自动进入公开路线。

示例各自带有 global-items.json 和 shared/save-protocol.js，可单独复制示例目录作为起点。在本地模拟器中，选择该示例目录内的声明文件；根目录的声明模板不能代替示例的实际声明。


## 外链作品的异步接入（v3.3.1）

外链投稿显示“外链待验收”，表示平台未扫描外站源码，不能据此判定缺接口。发布前必须在大厅 iframe 内验证读档、成功交接与失败交接。

外链在加载后才会收到存档。请使用官方 SDK：await WL.ready() 拿到入场 save 后再初始化玩法；也可监听 iw-save-ready，以 event.detail 更新实际游戏 save、assist 和开场面板。只在顶层调用一次 WL.readSave() 会保留握手前的默认值，不能替代 ready()。裁判恢复状态时监听 iw-admin，按 detail.save 同步实际游戏状态。SDK 在 localStorage 被沙箱拒绝时保留内存存档，不要求放宽 allow-same-origin；但作品自己的 localStorage/IndexedDB 不会被 SDK 接管。

成功通关传实际 acquiredItemIds；失败前也应将已获得的声明道具纳入 fallenSave.items，不能只维护关内的 ID Set。主办方的出口钩子由平台统一决定。外链应使用长期有效的托管地址，并与平台单独上传的 global-items.json 保持一致。


上传声明必须与当前游戏版本配套，不能直接使用交付包示例。格式校验通过只代表 JSON 合规，不能证明声明 ID 与作品一致。外链必须能在无登录 Cookie、无临时授权的隔离 iframe 中直接访问。


## 时长与完整流程验收（v3.3.1，以本节为准）

作者必须用自己实际可执行的正常通关路线，至少完整跑过一遍作品：从点击开始，经过开场、核心玩法、必经对话/过场，直到出现明确的结局。该完整过程须在 **4 分 30 秒（270 秒）内**完成，允许更短，无须凑满 4 分 30 秒。不能只验证能启动，不能只给出理论最短路径，也不能把裁判强制跳关或看门狗超时当作自然通关。

提交前填写包内 `完整流程自测记录.md`，记录运行环境、实际入口、自己的操作路线、总用时和到达的结局。随后在大厅验证接档及成功/失败交档。该记录是作者自测，不等同于主办方已验收。

后台预计时长为 **1–270 秒，默认 270 秒**。它用于编排参考，不会提前截断更短或更长的实玩过程。平台看门狗保持 **5 分钟（300 秒）**，预留 30 秒缓冲用于加载及交接，超时才执行遗物交接。看门狗是兜底，不能代替作品自己的结局。刷新、重载、治疗不重置本关看门狗。
