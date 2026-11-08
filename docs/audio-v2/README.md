# 熔心孤塔 · 音频精修 V2

交付：2026-11-08 13:26:14 Asia/Shanghai。本轮围绕“Boss 更有力、更激昂，其他音乐精修，并按最新进度补声音”制作。

## 直接试听

- [V2 试听页](index.html)：顶部是新版 Boss 二阶段，接着是同响度 V1/V2 对比，支持仅看新增/精修/沿用。
- [Boss 二阶段 WAV](masters/bgm-boss-phase2.wav) / [OGG](web/bgm-boss-phase2.ogg)。
- [50.25秒同响度对比](preview/boss-ab.wav)：一阶段V1→V2，二阶段V1→V2；各12秒，间隔0.75秒。片段目标 -20 LUFS，避免仅因音量更响而误判编曲。
- [60秒新版精选](preview/showcase.wav)；[运行时素材包](runtime-audio.zip)。
- [完整清单](CATALOG.md)、[项目进度核查](PROJECT_PROGRESS.md)、[接入说明](INTEGRATION.md)、[变更说明](CHANGELOG.md)。

## 实际交付

共 **67项**：9段音乐、48项音效、7项UI、3项环境循环。其中 **7项音乐重制、28项新增、32项沿用**。

- `web/`：OGG游戏资源，3.42 MiB。
- `masters/`：44.1kHz PCM24 WAV，81.11 MiB。
- `runtime-audio.zip`：OGG与清单/接入资料，3.29 MiB；不是完整游戏包。
- `raw/`：新版素材保留Float32合成源，沿用素材维持V1的PCM16源；不虚称增加原有精度。
- `metadata/`、`tools/`：用途/事件候选、独立种子与可重跑程序；全部本地合成，无外部采样。
- `preview/`：精选、同响度对比及段落时标；`reports/`：测量与文件核对证据。

V1音频、清单和生成脚本保留在父目录；[V1试听](../index-v1.html)。原试听入口 `../index.html` 改为指向 V2。游戏原文件没有被本轮写入。

## 音乐变化

Boss一阶段/二阶段（150 BPM、32小节）与狂暴（160 BPM、16小节）以史诗预告片风格原创重写：3+3+2 十六分重音型贯穿底鼓/太鼓/低音/弦乐断奏，底鼓侧链压低和声层让节拍更鲜明；原创铜管主题、合唱、低铜切分刺音，熔岩色彩来自 braam 轰鸣、次低频冲击、岩浆气泡、上升嘶声与铁砧锻打。段落为 braam 开场→驱动→主题→半速蓄力→高八度高潮；不含任何外部旋律、和声进行、采样或音频。Boss音乐导出目标-16 LUFS，探索-20、布防-19、战术-22、其他音乐-18；保留瞬态和峰值余量。

探索、转阶段、胜利、失败同步重写；增加布防与战术曲。不同BPM曲之间用淡化切换；战术曲是预备素材，不能当作已运行的游戏功能。失败音乐同时考虑最新主线 `PlayerDied` 直接失败的路径，并与 `MatchEnded` 去重。准确时长/BPM及编曲记录见manifest。

## 进度驱动的增补

已通过GitHub连接器核验合并PR及master源码，区别当前本地分支与最新主线。血量归零直接失败、不再自动复活；因此新增低血警告而未制作常规复活声。新增石地脚步、跳落、落熔岩、资源/槽位反馈、倒计时、建造拒绝，以及可击破/打断/技能辨识等预备音效。Boss逻辑和音频播放仍待主循环接入，Q/F相关调用也不能假设已经连通。

## 验证与边界

- **67/67音频技术检查通过**，无解码失败、静音资产或削波，最大真峰值-2.69 dBTP。
- 10个循环长度精确，最大编码端点跳变0.013023 FS。短单发允许至多128采样的淡出尾差，要求起音对齐且省略尾低于-50dBFS；WAV保持准确编辑长度。
- 7首旧音乐均验证为内容变更，非简单增益副本；对比与精选也完成解码/峰值测量。
- 281个本地引用存在，JS语法、ZIP完整性、素材事件拼写通过。
- 浏览器控制通道仍报 `Transport closed`，未声称完成本轮浏览器实播或人耳听感验收；用户可在本地页播放。未修改游戏接入，尚无真实战斗混音验证。
- 原工作区基线覆盖3557文件；核对发现0变化、2新增、0缺失。原目录只读，未回滚其他开发活动；详见 `reports/originals-verification.json`。

## 复现

需要本机已有的Python、NumPy、SciPy、imageio-ffmpeg与Node；本轮没有安装依赖。

```powershell
python -B tools/generate_music.py
python -B tools/generate_battle_epic.py
python -B tools/generate_additional_sfx.py
python -B tools/export_and_verify.py
python -B tools/build_delivery.py
```

以上仅重写本V2目录的生成素材。沿用的32项源文件已保留，通常不必重生成。游戏打包只选用OGG；不要将母带与制作材料装进12MB的整游戏包限额。
