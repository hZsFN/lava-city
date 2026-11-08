# 音频资产 · V2（全量）

> 全部由 `tools/gen-audio.py` 程序化合成，**零第三方素材**，无版权与署名要求。
> 共 **67 个 ogg，3.42 MB**。当前交付包（含武器模型 3.8 MB）合计约 **8.5 MB**，ZIP 上限 12 MB。

## 分类

| 类别 | 数量 | 体积 | 说明 |
|---|---|---|---|
| `bgm-*` | 9 | 2.53 MB | 分阶段 BGM，除《渊底》外都是 30–90 s 可循环 |
| `amb-*` | 2 | 0.21 MB | 环境铺底，全程循环 |
| `sfx-*` | 56 | 0.69 MB | 单次触发音效 |

## BGM（9）

| 文件 | 用在哪 | 大小 |
|---|---|---|
| `bgm-molten-heart.ogg` | 主 BGM《渊底》93 s 无缝循环，五层叠加 | 323 KB |
| `bgm-preparation.ogg` | 醒来 / 阅读 / 准备期 | 334 KB |
| `bgm-boss-phase1.ogg` | 阶段 I 战斗 | 594 KB |
| `bgm-phase-transition.ogg` | 转阶段过场（十余秒） | — |
| `bgm-boss-phase2.ogg` | 阶段 II 战斗 | 608 KB |
| `bgm-rage.ogg` | 狂暴段 | 304 KB |
| `bgm-victory.ogg` | 胜利与传送 | — |
| `bgm-defeat.ogg` | 失败 | — |
| `bgm-tactical.ogg` | 战术视图（若做） | — |

## 环境（2）

`amb-lava.ogg`（熔岩涌动，全程）、`amb-tower.ogg`（塔内低频共鸣）。

## 音效（56）

按用途分组，前缀即用途：

- **玩家**：`sfx-footstep-stone-01..04`（四种石材脚步轮播）、`sfx-dash`、`sfx-form-switch`、`sfx-player-death`、`sfx-player-low-health`
- **物理武器**：`sfx-physical-shot-a/b`、`sfx-execution-windup`、`sfx-execution-ready`、`sfx-execution`
- **法术武器**：`sfx-arcane-shot-a/b`
- **破绽**：`sfx-weakness-open`、`sfx-weakness-close`
- **Boss 技能**：`sfx-boss-windup`、`sfx-boss-rock-sweep`、`sfx-boss-slam`、`sfx-boss-breath`、`sfx-boss-fire`、`sfx-boss-fire-rain-impact`、`sfx-boss-stone-pillar`、`sfx-boss-lava-charge`、`sfx-boss-self-ignite`、`sfx-boss-core-drain`、`sfx-boss-interrupted`
- **塔**：`sfx-tower-ballista`、`sfx-tower-rune`、`sfx-tower-frost`、`sfx-tower-quake`、`sfx-tower-totem`、`sfx-tower-build`、`sfx-tower-upgrade`、`sfx-tower-sell`、`sfx-tower-destroy`
- **塔位**：`sfx-slot-unlock`、`sfx-slot-submerged`
- **界面**：`sfx-ui-confirm`、`sfx-ui-cancel`、`sfx-ui-error`、`sfx-tactical-open`、`sfx-tactical-close`
- **节奏提示**：`sfx-countdown-tick`、`sfx-countdown-final`、`sfx-core-warning`

## 《渊底》的构成（`bgm-molten-heart.ogg`）

五层，全部正弦与滤波噪声，没有一个采样：

1. **低频 drone** — D2(73.42 Hz) + A2(110 Hz)，各两路微失谐（±3 音分）制造缓慢拍频，像远处岩层在挤压。
2. **熔岩轰鸣** — brown noise 经 150 Hz 低通 + 18.7 秒周期的极慢振幅调制。
3. **心跳** — 52 BPM 起，S1 强 S2 弱。这是唯一「有生命」的元素。
4. **熔岩咕嘟** — 26 个随机气泡爆裂，70–190 Hz 快速上滑后衰减。
5. **高频紧张** — 9 处稀疏的玻璃摩擦音，用不和谐音程（D6/Eb6/G6）制造不安。

混响是多抽头反馈延迟，首尾 3 秒交叉淡化保证无缝循环。

## 重新生成

```bash
python tools/gen-audio.py      # 输出 wav 到 public/audio/
ffmpeg -i x.wav -c:a libvorbis -q:a 4 x.ogg
```
