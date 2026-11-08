// src/towers/kinds/rune.ts
// ============================================================================
// 符文聚能塔 · 法术单体输出 + 灼烙
// ----------------------------------------------------------------------------
// 每 intervalSec 对 Boss 造成一次法术伤害。灼烙层数由 Boss 模块维护
// （它监听 TowerTargetHit 自己累加并发 DebuffStackChanged），本塔只发
// TowerTargetHit，绝不发 DebuffStackChanged。
//
// 事件（本塔只发这一个）：
//   TowerTargetHit { towerId, kind: 'rune', attr: 'arcane', amount }
//
// 数值来源：src/core/config/towers.json
// ============================================================================

import towersJson from '../../core/config/towers.json';
import type { Attr, TowerBehavior, TowersConfig } from '../types';

const towersCfg = towersJson as unknown as TowersConfig;
const CFG = towersCfg.kinds.rune;
/** 属性来自 config（枚举，不是可调数值） */
const ATTR = CFG.attr as Attr;

function dist3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const runeBehavior: TowerBehavior = {
  kind: 'rune',
  attr: CFG.attr,
  cost: CFG.cost,
  range: CFG.range,
  maxHp: CFG.hp,

  onPlaced(self) {
    self.cooldownSec = 0;
  },

  update(self, ctx) {
    if (ctx.canFire === false) return;
    if (dist3(self.pos, ctx.boss.pos) > self.cfg.range) return;

    self.cooldownSec -= ctx.dtSec;
    if (self.cooldownSec > 0) return;
    self.cooldownSec = self.cfg.intervalSec;

    self.bus.emit('TowerTargetHit', {
      towerId: self.id,
      kind: 'rune',
      attr: ATTR,
      amount: self.cfg.damage,
    });
  },
};
