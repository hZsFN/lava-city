// src/towers/TowerBase.ts
// ============================================================================
// 塔实例（B1）—— 实现 types.ts 的 TowerRuntime，B2 的行为只读它、写 cooldownSec / state
// ----------------------------------------------------------------------------
// 只管数据与建造计时，不碰事件、不碰 Boss：所有广播由 TowerSystem 统一发。
// 禁止 import three。
// ============================================================================

import { createRng } from '../core/rng';
import type { Bus, Rng, TowerKind, TowerKindConfig, TowerRuntime, TowerView, Vec3 } from './types';

export interface TowerBaseInit {
  id: string;
  kind: TowerKind;
  slotId: string;
  pos: Vec3;
  cfg: TowerKindConfig;
  bus: Bus;
  /** 每塔独立可播种随机的种子（由 TowerSystem 从系统 rng 抽取） */
  seed: number;
  /** 建塔花费（用于计算拆除返还） */
  investedCost: number;
  maxHp: number;
  /** 建造动画/延迟秒数（config.build.buildSec），> 0 时行为不更新 */
  buildSec: number;
}

export class TowerBase implements TowerRuntime {
  readonly id: string;
  readonly kind: TowerKind;
  readonly slotId: string;
  readonly pos: Vec3;
  readonly state: Record<string, number> = {};
  readonly bus: Bus;
  readonly rng: Rng;
  readonly cfg: TowerKindConfig;

  level = 1;
  hp: number;
  maxHp: number;
  investedCost: number;
  cooldownSec = 0;

  /** 建造剩余秒数；> 0 表示还在「建造中」，行为不更新、onPlaced 未触发 */
  buildRemainingSec: number;
  /** onPlaced 是否已经调用过（保证只调一次） */
  placed = false;

  constructor(init: TowerBaseInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.slotId = init.slotId;
    this.pos = init.pos;
    this.cfg = init.cfg;
    this.bus = init.bus;
    this.rng = createRng(init.seed);
    this.investedCost = init.investedCost;
    this.maxHp = init.maxHp;
    this.hp = init.maxHp;
    this.buildRemainingSec = Math.max(0, init.buildSec);
  }

  get isBuilt(): boolean {
    return this.buildRemainingSec <= 0;
  }

  get isAlive(): boolean {
    return this.hp > 0;
  }

  /** 推进建造计时；返回本帧是否「刚好建完」 */
  tickBuild(dtSec: number): boolean {
    if (this.buildRemainingSec <= 0) return false;
    const dt = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
    this.buildRemainingSec = Math.max(0, this.buildRemainingSec - dt);
    return this.buildRemainingSec <= 0;
  }

  /** 扣血并夹到 [0, maxHp]，返回剩余 hp */
  applyDamage(amount: number): number {
    const dmg = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    this.hp = Math.max(0, Math.min(this.maxHp, this.hp - dmg));
    return this.hp;
  }

  /** 对外只读视图（每次新建对象，外部改不到内部状态） */
  view(): TowerView {
    return {
      id: this.id,
      kind: this.kind,
      level: this.level,
      hp: this.hp,
      maxHp: this.maxHp,
      slotId: this.slotId,
      pos: this.pos,
      investedCost: this.investedCost,
    };
  }
}
