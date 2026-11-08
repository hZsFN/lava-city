// src/towers/types.ts
// ============================================================================
// P2-B 共享类型层 · 由 S0（控制会话）维护，三路只读不改
// ----------------------------------------------------------------------------
// B1（塔位与塔实体）、B2（五种塔行为）、B3（流程与遥测）都 import 这里。
// 谁需要改这里的类型 → 写进 handoff 的「契约申请」，由 S0 改。
// ============================================================================

import type { Attr, BodyPart, Bus, MatchPhase, SlotState, Vec3 } from '../core/events';
import type { Rng } from '../core/rng';

export type { Attr, BodyPart, Bus, MatchPhase, SlotState, Vec3, Rng };

/** 五种塔的 id，必须与 config/towers.json 的 kinds 键一致 */
export type TowerKind = 'ballista' | 'rune' | 'frost' | 'quake' | 'totem';

export const TOWER_KINDS: readonly TowerKind[] = [
  'ballista',
  'rune',
  'frost',
  'quake',
  'totem',
] as const;

/** 塔位环层，对应 arena.json 的 slots[].ring */
export type SlotRing = 'mid' | 'tower' | 'outer';

/** 塔实例的只读视图（对外暴露用，不要暴露内部可变对象） */
export interface TowerView {
  id: string;
  kind: TowerKind;
  level: number;
  hp: number;
  maxHp: number;
  slotId: string;
  pos: Vec3;
  /** 已投入的总造价（用于计算拆除返还） */
  investedCost: number;
}

/** 塔位视图 */
export interface SlotView {
  slotId: string;
  ring: SlotRing;
  pos: Vec3;
  state: SlotState;
  /** 已占用的塔 id，null 表示空位 */
  towerId: string | null;
}

/** 每帧传给塔行为的上下文 */
export interface TowerUpdateCtx {
  dtSec: number;
  /** 本帧是否允许开火（wake/prep/ended 阶段为 false） */
  canFire: boolean;
  boss: {
    pos: Vec3;
    /** 当前暴露的弱点部位，null 表示无 */
    weakness: BodyPart | null;
    /** 弱点属性，用于判断塔的属性是否匹配 */
    weaknessAttr: Attr | null;
    /** Boss 当前是否在施法（震地锚只对施法中的 Boss 打断） */
    castingSkill: string | null;
    /** Boss 当前是否处于嘲讽中 */
    taunted: boolean;
  };
  playerPos: Vec3;
  /** 塔心位置（arena 原点） */
  corePos: Vec3;
}

/**
 * 塔行为接口：B2 为每种塔实现一个。
 * B1 的 TowerSystem 会在 update 时遍历所有塔，调用各自 behavior.update()。
 *
 * 行为**只负责发事件**，不直接改 Boss/玩家状态。
 */
export interface TowerBehavior {
  readonly kind: TowerKind;
  readonly attr: Attr | 'none';
  /** 造价，从 config 读 */
  readonly cost: number;
  /** 射程，从 config 读 */
  readonly range: number;
  /** 耐久上限，从 config 读 */
  readonly maxHp: number;

  /**
   * 建塔完成时调用一次（buildSec 结束后）。
   * 用于初始化内部计时器、发初始事件。
   */
  onPlaced?(self: TowerRuntime): void;

  /**
   * 每帧调用。行为在这里判断射程/冷却，决定是否开火，并 emit 事件。
   * 返回 void；所有副作用都通过 bus.emit 表达。
   */
  update(self: TowerRuntime, ctx: TowerUpdateCtx): void;

  /**
   * 受到伤害时调用（Boss 打塔）。返回新的 hp。
   * 默认实现由 B1 提供，行为可以覆写（如嘲讽图腾有特殊减伤）。
   */
  onDamaged?(self: TowerRuntime, amount: number): number;

  /** 塔被摧毁/拆除时的清理（发 TauntEnded 之类的收尾事件） */
  onRemoved?(self: TowerRuntime): void;
}

/** 塔运行时状态：B1 创建并持有，B2 的行为只读大部分字段、可写 cooldown */
export interface TowerRuntime {
  readonly id: string;
  readonly kind: TowerKind;
  readonly slotId: string;
  readonly pos: Vec3;
  level: number;
  hp: number;
  maxHp: number;
  investedCost: number;
  /** 开火冷却剩余秒数，行为自己维护 */
  cooldownSec: number;
  /** 行为自己的私有状态（碎甲命中计数、冻结值、嘲讽 CD 等） */
  readonly state: Record<string, number>;
  /** 事件总线，行为用它 emit */
  readonly bus: Bus;
  /** 可播种随机，行为用它做概率判定 */
  readonly rng: Rng;
  /** 塔的数值配置（config/towers.json 里 kinds[kind] 那一份） */
  readonly cfg: TowerKindConfig;
}

/** config/towers.json 里单个塔的配置形状（宽松类型，字段按需取） */
export interface TowerKindConfig {
  name: string;
  attr: Attr | 'none';
  cost: number;
  range: number;
  damage: number;
  intervalSec: number;
  hp: number;
  special: string;
  slowRatio?: number;
  tauntSec?: number;
  cooldownSec?: number;
  interruptChance?: number;
  sunderHitsPerStack?: number;
}

/** config/towers.json 整体形状 */
export interface TowersConfig {
  build: {
    buildSec: number;
    demolishSec: number;
    upgradeCostRatio: number;
    sellRefundRatio: number;
    maxLevel: number;
  };
  debuff: {
    maxStacks: number;
    resistPerStack: number;
  };
  freeze: {
    max: number;
    perHit: number;
    decayPerSec: number;
    stunSec: number;
  };
  kinds: Record<TowerKind, TowerKindConfig>;
}

/** config/arena.json 里单个塔位的形状 */
export interface SlotConfig {
  id: string;
  ring: SlotRing;
  pos: [number, number, number];
  unlockPhase: 1 | 2;
}

/** config/arena.json 整体形状 */
export interface ArenaConfig {
  tower: { diameter: number; height: number; floors: number };
  rings: { midRadius: number; outerRadius: number };
  elevationDeadzoneDeg: number;
  coreRadius: number;
  lava: {
    radius: number;
    startY: number;
    phase2RiseTo: number;
    rageRisePerSec: number;
    drownSlotY: number;
  };
  slots: SlotConfig[];
}

/** 建塔菜单的一个选项 */
export interface BuildOption {
  kind: TowerKind;
  name: string;
  cost: number;
  affordable: boolean;
  range: number;
  special: string;
  attr: Attr | 'none';
}

/** 建塔菜单状态 */
export interface BuildMenuState {
  slotId: string | null;
  options: BuildOption[];
}

/**
 * TowerSystem 门面：B1 实现，其他会话（S0 集成期、UI、QA）只依赖这个接口。
 */
export interface TowerSystem {
  init(deps: {
    bus: Bus;
    rng: Rng;
    towersCfg: TowersConfig;
    arenaCfg: ArenaConfig;
  }): void;

  /** 固定步长推进；内部遍历所有塔，调用 behavior.update() */
  update(dtSec: number, ctx: TowerUpdateCtx): void;

  /** 建塔。成功返回 true。失败（槽位不可用/熔核不足/未知 kind）返回 false 且不发事件。 */
  place(slotId: string, kind: TowerKind, motes: number): boolean;

  /** 升级。成功返回 true */
  upgrade(towerId: string, motes: number): boolean;

  /** 拆除。成功返回 true，返还熔核通过 MoteCountChanged 广播 */
  sell(towerId: string): boolean;

  /** 阶段切换：处理外环解锁 */
  setPhase(phase: MatchPhase): void;

  /** 熔岩高度变化：处理塔位淹没 */
  setLavaY(y: number): void;

  /** Boss/火雨对塔造成伤害 */
  damageTower(towerId: string, amount: number): void;

  /** 当前所有塔 */
  list(): TowerView[];

  /** 当前所有塔位 */
  slots(): SlotView[];

  /** 建塔菜单数据（纯数据，UI 直接消费） */
  menu(slotId: string | null, motes: number): BuildMenuState;

  /** 当前持有的熔核数（内部记账） */
  motes(): number;
}
