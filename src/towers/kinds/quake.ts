// src/towers/kinds/quake.ts
// ============================================================================
// 震地锚塔 · 破绽机的另一半
// ----------------------------------------------------------------------------
// Boss 在射程内**施法时**，每 intervalSec 掷一次骰；命中则发
// TowerInterruptRequested，由 Boss 模块收到后再掷骰、成功才发
// BossSkillInterrupted —— 塔**不**直接发 BossSkillInterrupted。
//
// 节流口径（照 T-M2-02 单测 #4「冷却内只发一次」）：
//   · 每个装填周期只掷一次骰（掷不中也进装填，避免逐帧狂掷）
//   · 冷却内不重复请求
//
// 事件（本塔只发这一个）：
//   TowerInterruptRequested { towerId, skill, chance }
//
// 数值来源：src/core/config/towers.json（self.cfg 优先，模块级 CFG 兜底）
// ============================================================================

import towersJson from '../../core/config/towers.json';
import type { TowerBehavior, TowersConfig } from '../types';

const towersCfg = towersJson as unknown as TowersConfig;
const CFG = towersCfg.kinds.quake;

function dist3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const quakeBehavior: TowerBehavior = {
  kind: 'quake',
  attr: CFG.attr,
  cost: CFG.cost,
  range: CFG.range,
  maxHp: CFG.hp,

  onPlaced(self) {
    self.cooldownSec = 0;
  },

  update(self, ctx) {
    // 装填计时始终推进（与 Boss 是否在施法无关）
    if (self.cooldownSec > 0) {
      self.cooldownSec = Math.max(0, self.cooldownSec - ctx.dtSec);
      return;
    }

    // 只在 Boss 施法时掷骰
    const skill = ctx.boss.castingSkill;
    if (skill === null || skill === undefined) return;
    if (ctx.canFire === false) return;
    if (dist3(self.pos, ctx.boss.pos) > self.cfg.range) return;

    const chance = self.cfg.interruptChance ?? CFG.interruptChance;
    if (chance === undefined) return;

    // 无论掷中与否都进入装填：一次施法窗口内不逐帧重掷
    self.cooldownSec = self.cfg.intervalSec;
    if (self.rng() < chance) {
      self.bus.emit('TowerInterruptRequested', {
        towerId: self.id,
        skill,
        chance,
      });
    }
  },
};
