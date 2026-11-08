# 音频资产

`public/audio` 下分两批：

- `bgm-molten-heart.ogg`、`sfx-lava-rise.ogg`：由 `tools/gen-audio.py` 程序化合成，零第三方素材。
- P2-A 事件音效：来自 `熔心孤塔-音频V2/web`，已接入 `src/audio/AudioManager.ts`，映射见 `src/core/config/audio.json`。

| 文件 | 用途 | 触发 |
|---|---|---|
| `sfx-hit.ogg` | 玩家受击 | `PlayerDamaged`（`amount > 0`，同帧死亡让位给死亡音） |
| `sfx-player-low-health.ogg` | 低血警告 | `PlayerDamaged` 下穿 25% 阈值，5 s 冷却 |
| `sfx-player-death.ogg` | 玩家死亡 | `PlayerDied`（按 `deaths` 去重） |
| `sfx-lava-fall.ogg` | 坠入熔岩 | `PlayerDied.cause = lava`（替代通用死亡音） |
| `sfx-dash.ogg` | 冲刺 | `PlayerDashed` |
| `sfx-jump.ogg` | 起跳 | `AudioManager.update()`：离地边沿 |
| `sfx-land-light.ogg` / `sfx-land-heavy.ogg` | 轻/重落地 | `AudioManager.update()`：按下落高度互斥 |
| `sfx-footstep-stone-01…04.ogg` | 石地脚步 | `AudioManager.update()`：落地且水平累计距离达步幅，四变体轮换 |
| `sfx-form-switch.ogg` | 双形态切换 | `FormSwitched`（形态真变化时） |
| `sfx-overheat.ogg` | 过热泄压 | `OverheatChanged`（`false → true`） |
| `sfx-physical-shot-a/b.ogg` | 物理射击 A/B | `AudioManager.playShot('physical')`，待 CombatController 接入主循环 |
| `sfx-arcane-shot-a/b.ogg` | 法术射击 A/B | `AudioManager.playShot('arcane')`，待 CombatController 接入主循环 |
| `sfx-execution-ready.ogg` | 可击破信号 | `WeaknessProgress.executable` `false → true` |
| `sfx-execution-windup.ogg` | 击破凝力 | `ExecutionStarted` |
| `sfx-execution.ogg` | 击破主冲击 | `ExecutionEnded`（`damage > 0`） |
| `sfx-weakness-open.ogg` | 弱点显露 | `WeaknessExposed`（同一部位不重播） |
| `sfx-weakness-close.ogg` | 弱点收束 | `WeaknessClosed`（仅已记录为打开的部位） |
| `sfx-tactical-open.ogg` / `sfx-tactical-close.ogg` | 战术视图开关 | `TacticalViewChanged` 边沿 |
