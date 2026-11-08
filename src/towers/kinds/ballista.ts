// src/towers/kinds/ballista.ts
// ============================================================================
// 弩炮塔 · 物理单体输出 + 碎甲
// ----------------------------------------------------------------------------
// 每 intervalSec 对 Boss 造成一次物理伤害；每命中 sunderHitsPerStack 次算 1 层碎甲。
// **碎甲层数由 Boss 模块维护**（它监听 TowerTargetHit 自己累加并发
// DebuffStackChanged），本塔只发 TowerTargetHit，绝不发 DebuffStackChanged。
//
// 事件（本塔只发这一个）：
//   TowerTargetHit { towerId, kind: 'ballista', attr: 'physical', amount }
//
// 数值来源：src/core/config/towers.json
// ============================================================================

import towersJson from '../../core/config/towers.json';
import type { Attr, TowerBehavior, TowersConfig } from '../types';

const towersCfg = towersJson as unknown as TowersConfig;
const CFG = towersCfg.kinds.ballista;
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

export const ballistaBehavior: TowerBehavior = {
  kind: 'ballista',
  attr: CFG.attr,
  cost: CFG.cost,
  range: CFG.range,
  maxHp: CFG.hp,

  onPlaced(self) {
    self.state.sunderHits = 0;
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
      kind: 'ballista',
      attr: ATTR,
      amount: self.cfg.damage,
    });

    // 碎甲计数：满 sunderHitsPerStack 次归零（层数本身由 Boss 侧记）
    const perStack = self.cfg.sunderHitsPerStack ?? CFG.sunderHitsPerStack;
    const hits = (self.state.sunderHits ?? 0) + 1;
    if (perStack !== undefined && perStack > 0 && hits >= perStack) {
      self.state.sunderHits = 0;
    } else {
      self.state.sunderHits = hits;
    }
  },
};
