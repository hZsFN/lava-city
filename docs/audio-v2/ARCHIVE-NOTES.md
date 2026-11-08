# 音频 V2 交付档案 · 入库说明

> 归档日期：2026-11-08
> 来源：本地交付目录 `熔心孤塔-音频V2/`（交付时间 2026-11-08 13:26:14 Asia/Shanghai）
> 本文说明**这份档案在仓库里包含什么、不包含什么、为什么**，以及各文件对应到游戏里的哪里。

---

## 一、先说结论：运行时音频早就在库里了

`public/audio/` 下的 **67 个 OGG** 已经在 master 上（提交 `08036c1`，3.42 MB），
与本档案来源目录的 `web/` 逐文件 SHA256 一致 —— **运行时素材无需重复入库**。

本档案补的是**制作材料**：清单、元数据、验证证据、可重跑的合成脚本，以及两段试听样片。

M5-02（音频接入）票里「67 个音频文件已经在 `public/audio/`，缺的是把它接进游戏」这句话，
指的就是这批文件；接入本身见 `docs/tickets/M5-02-audio.md` 的接线记录。

---

## 二、入库了什么（95 个文件，2.27 MB）

| 路径 | 内容 | 作用 |
|---|---|---|
| `README.md` | 交付总说明 | 本轮改了什么、验了什么、边界在哪 |
| `CATALOG.md` | 67 项完整清单 | 每项的用途、时长、BPM、分类 |
| `CHANGELOG.md` | 变更说明 | 相对 V1 的增删改 |
| `INTEGRATION.md` | 接入说明 | 事件 → 音效映射、BGM 阶段表、加载策略 |
| `INTEGRATION-v1-reference.md` | V1 接入参考 | 历史对照，避免误读旧文档 |
| `manifest.json` | 机器可读总表（111 KB） | 每项的参数、事件候选、文件尺寸、校验值 |
| `PROJECT_PROGRESS.md` | 进度核查 | 对照主线源码核对交付范围的过程记录 |
| `STATUS.md` | 状态摘要 | 一页看完当前状态 |
| `metadata/` | 67 个 JSON | 每项资产的独立元数据（用途、事件候选、种子） |
| `reports/` | 6 个验证文件 | 技术检查、响度测量、文件核对证据 |
| `tools/` | 10 个 Python 脚本 | 可重跑的合成与导出程序（无外部采样） |
| `preview/boss-ab.ogg` | 50.25 s 同响度对比 | 一阶段 V1→V2、二阶段 V1→V2，各 12 s |
| `preview/showcase.ogg` | 60 s 新版精选 | 快速听全貌 |
| `preview/boss-ab-cues.json` | 对比段落时标 | 上述对比的分段位置 |
| `preview/cue-sheet.txt` | 时标表 | 人读版 |

---

## 三、故意没入库的（以及原因）

| 未入库 | 体积 | 原因 |
|---|---|---|
| `masters/` 67 个 WAV | 81.11 MB | 44.1 kHz PCM24 母带。公开仓库从 45 MB 涨到约 160 MB，代价与收益不成比例；OGG 成品已在 `public/audio/`，母带属于本地制作资产 |
| `preview/*.wav` 6 个 | 28.04 MB | 对比与精选的 WAV 版。试听用途用同目录的 OGG 已足够 |
| `web/` 67 个 OGG | 3.42 MB | 与 `public/audio/` 逐字节一致，重复入库无意义 |
| `index.html` | 440 KB | 试听页，链接指向 `masters/*.wav`、`web/*.ogg`、`runtime-audio.zip`；这些未入库，页面在仓库里会是断链状态。留在本地 |
| `runtime-audio.zip` | 3.29 MB | 由上述 OGG 与文档打包而成，内容重复 |

**需要母带时**：找交付目录 `熔心孤塔-音频V2/`，或用 `tools/` 里的脚本重新生成
（脚本是确定性的，种子记录在 `metadata/`）。

---

## 四、已知断链（阅读本目录文档时注意）

本目录下的 Markdown 是从交付目录原样搬过来的，里面的相对链接指向交付目录的结构，在仓库里不成立：

| 文档里的链接 | 实际对应 |
|---|---|
| `masters/*.wav` | 未入库，见第三节 |
| `web/*.ogg` | 对应仓库 `public/audio/*.ogg` |
| `preview/*.wav` | 未入库；用同目录 `preview/*.ogg` |
| `index.html` | 未入库 |
| `runtime-audio.zip` | 未入库 |

除上述链接外，文档内容与交付原件一致，未做改写。

---

## 五、复现方式

脚本未改，需本机 Python + NumPy + SciPy + imageio-ffmpeg + Node（本轮未安装任何依赖）：

```powershell
python -B tools/generate_music.py
python -B tools/generate_battle_epic.py
python -B tools/generate_additional_sfx.py
python -B tools/export_and_verify.py
python -B tools/build_delivery.py
```

脚本只写交付目录自己的 `masters/`、`web/`、`reports/`，不改游戏源码。

---

## 六、验证边界（照抄交付原件的口径，不夸大）

- 67/67 音频技术检查通过：无解码失败、无静音资产、无削波，最大真峰值 −2.69 dBTP。
- 10 个循环长度精确，最大编码端点跳变 0.013023 FS。
- 7 首旧音乐均验证为**内容变更**，非简单增益副本。
- 281 个本地引用存在；JS 语法、ZIP 完整性、素材事件拼写通过。
- **未做**：浏览器实播验收、人耳听感验收（当时控制通道报 `Transport closed`）。
- **未改**：游戏源码；真实战斗混音验证尚未进行。

详见 `reports/delivery-verification.json` 与 `reports/audio-verification.json`。
