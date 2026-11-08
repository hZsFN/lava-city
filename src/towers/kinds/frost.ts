// src/towers/kinds/frost.ts
// ============================================================================
// 寒晶塔 · 破绽机核心
// ----------------------------------------------------------------------------
// 射程内每 intervalSec 累积一次冻结值；冻结值满 freeze.max → FreezeFull，
// Boss 模块收到后自己发 WeaknessExposed / BossSkillInterrupted，塔不碰 Boss 状态。
//
// 事件（本塔只发这两个）：
//   FreezeProgressChanged { value, max }   —— 每次累积（含满值那一次）
//   FreezeFull { durationMs }              —— 满值瞬间，随后冻结值归零
//
// 数值来源：src/core/config/towers.json
//   · 周期/射程/耐久/属性 → self.cfg（模块级 CFG 仅作类型兜底）
//   · 冻结参数（max/perHit/decayPerSec/stunSec）→ config 顶层 freeze 段
//     （TowerKindConfig 没有 freeze 字段，不为此改 types.ts）
// ============================================================================

import towersJson from '../../core/config/towers.json';
import type { TowerBehavior, TowersConfig } from '../types';

const towersCfg = towersJson as unknown as TowersConfig;
const CFG = towersCfg.kinds.frost;
const FREEZE = towersCfg.freeze;

/** 冻结值进度上限，与 UI 进度环 / Boss 判定共用 */
const MAX = FREEZE.max;

function dist3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const frostBehavior: TowerBehavior = {
  kind: 'frost',
  attr: CFG.attr,
  cost: CFG.cost,
  range: CFG.range,
  maxHp: CFG.hp,

  onPlaced(self) {
    self.state.freezeValue = 0;
    self.cooldownSec = 0;
  },

  update(self, ctx) {
    const dt = ctx.dtSec;
    const canFire = ctx.canFire !== false;
    const inRange = dist3(self.pos, ctx.boss.pos) <= self.cfg.range;

    // 打不到目标（不在射程 / 本帧禁止开火）时，冻结值按 decayPerSec 逐帧衰减，
    // 不低于 0。冷却期间不衰减，否则「每次 +8、每秒 -6」会让冻结值永远涨不上去。
    if (!canFire || !inRange) {
      self.state.freezeValue = Math.max(
        0,
        (self.state.freezeValue ?? 0) - FREEZE.decayPerSec * dt,
      );
      return;
    }

    self.cooldownSec -= dt;
    if (self.cooldownSec > 0) return;
    self.cooldownSec = self.cfg.intervalSec;

    const value = Math.min(MAX, (self.state.freezeValue ?? 0) + FREEZE.perHit);
    self.state.freezeValue = value;
    self.bus.emit('FreezeProgressChanged', { value, max: MAX });

    if (value >= MAX) {
      self.bus.emit('FreezeFull', { durationMs: Math.round(FREEZE.stunSec * 1000) });
      // 冻结达成后进度归零；不补发一条 0 进度，保持「一次累积一条进度事件」
      self.state.freezeValue = 0;
    }
  },
};
