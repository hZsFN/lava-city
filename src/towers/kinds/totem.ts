// src/towers/kinds/totem.ts
// ============================================================================
// 嘲讽图腾 · 无伤害，拉 Boss 位置
// ----------------------------------------------------------------------------
// Boss 在射程内、当前没被嘲讽、冷却已好 → TauntStarted（持续 tauntSec）。
// 计时结束（或塔被拆/被毁）→ TauntEnded。
// 阶段 II 让 Boss 背对玩家、暴露背部弱点的唯一手段。
//
// 事件（本塔只发这两个）：
//   TauntStarted { towerId, durationMs }
//   TauntEnded   { towerId }
//
// 数值来源：src/core/config/towers.json（self.cfg 优先，模块级 CFG 兜底）
// ============================================================================

import towersJson from '../../core/config/towers.json';
import type { TowerBehavior, TowersConfig } from '../types';

const towersCfg = towersJson as unknown as TowersConfig;
const CFG = towersCfg.kinds.totem;

function dist3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const totemBehavior: TowerBehavior = {
  kind: 'totem',
  attr: CFG.attr,
  cost: CFG.cost,
  range: CFG.range,
  maxHp: CFG.hp,

  onPlaced(self) {
    self.state.tauntCooldown = 0;
    self.state.tauntRemainSec = 0;
  },

  update(self, ctx) {
    const dt = ctx.dtSec;
    const cooldownSec = self.cfg.cooldownSec ?? CFG.cooldownSec;
    const tauntSec = self.cfg.tauntSec ?? CFG.tauntSec;

    // 冷却始终推进
    self.state.tauntCooldown = Math.max(0, (self.state.tauntCooldown ?? 0) - dt);

    // 自己发起的嘲讽还在计时：只倒计时，结束时发 TauntEnded
    // 容差 1e-9：固定步长累加会有浮点残差（6.0 - 60 × 0.1 ≈ 1e-15），
    // 不留容差会让嘲讽永不结束。
    const remain = self.state.tauntRemainSec ?? 0;
    if (remain > 0) {
      const next = Math.max(0, remain - dt);
      if (next <= 1e-9) {
        self.state.tauntRemainSec = 0;
        self.bus.emit('TauntEnded', { towerId: self.id });
      } else {
        self.state.tauntRemainSec = next;
      }
      return;
    }

    // Boss 已被（别的图腾）嘲讽 → 不抢
    if (ctx.boss.taunted) return;
    if ((self.state.tauntCooldown ?? 0) > 0) return;
    if (dist3(self.pos, ctx.boss.pos) > self.cfg.range) return;

    const durationMs = Math.round((tauntSec ?? 0) * 1000);
    self.bus.emit('TauntStarted', { towerId: self.id, durationMs });
    self.state.tauntCooldown = cooldownSec ?? 0;
    self.state.tauntRemainSec = tauntSec ?? 0;
  },

  onRemoved(self) {
    // 塔被拆/被毁：嘲讽必须结束，否则 Boss 会一直盯着一个不存在的目标
    if ((self.state.tauntRemainSec ?? 0) > 0) {
      self.state.tauntRemainSec = 0;
      self.bus.emit('TauntEnded', { towerId: self.id });
    }
  },
};
