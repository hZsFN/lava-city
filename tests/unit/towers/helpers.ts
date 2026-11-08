// tests/unit/towers/helpers.ts
// ============================================================================
// B1 单测公共工具
// ----------------------------------------------------------------------------
// ⚠ 只用于测试：B2 的 TOWER_BEHAVIORS 目前是空对象，直接 place() 会一律返回 false。
// 为了在 B2 交付前就能验证 B1 的完整链路（place / update / 死区），
// 这里在**运行时**往注册表里塞一个假行为，测试结束后删掉。
// 不改 kinds/index.ts 一个字符（那是 B2 的作用域）。
// ============================================================================

import { createBus } from '../../../src/core/events';
import type { Bus, Events, EventName } from '../../../src/core/events';
import { createRng } from '../../../src/core/rng';
import { TOWER_BEHAVIORS } from '../../../src/towers/kinds/index';
import { createTowerSystem } from '../../../src/towers/TowerSystem';
import type { TowerSystemImpl } from '../../../src/towers/TowerSystem';
import arenaCfg from '../../../src/core/config/arena.json';
import towersCfg from '../../../src/core/config/towers.json';
import type {
  ArenaConfig,
  TowerBehavior,
  TowerKind,
  TowersConfig,
  TowerSystem,
  TowerUpdateCtx,
  Vec3,
} from '../../../src/towers/types';

export const towers = towersCfg as unknown as TowersConfig;
export const arena = arenaCfg as unknown as ArenaConfig;

/** 记录 bus 上所有事件，便于断言「一个事件都没发」 */
export interface Recorder {
  names: EventName[];
  payloads: Array<{ name: EventName; payload: unknown }>;
  of<K extends EventName>(k: K): Array<Events[K]>;
  reset(): void;
}

export function record(bus: Bus): Recorder {
  const names: EventName[] = [];
  const payloads: Array<{ name: EventName; payload: unknown }> = [];
  const all: EventName[] = [
    'TowerPlaced',
    'TowerUpgraded',
    'TowerDestroyed',
    'TowerHpChanged',
    'TowerSlotStateChanged',
    'TowerTargetHit',
    'MoteCountChanged',
    'FreezeProgressChanged',
  ];
  for (const name of all) {
    bus.on(name as EventName, (payload) => {
      names.push(name);
      payloads.push({ name, payload });
    });
  }
  return {
    names,
    payloads,
    of<K extends EventName>(k: K): Array<Events[K]> {
      return payloads.filter((p) => p.name === k).map((p) => p.payload as Events[K]);
    },
    reset(): void {
      names.length = 0;
      payloads.length = 0;
    },
  };
}

export interface FakeBehavior extends TowerBehavior {
  updates: TowerUpdateCtx[];
  placedCount: number;
  removedCount: number;
  /** 每次 update 时是否 emit TowerTargetHit（模拟「已命中」） */
  emitHit: boolean;
}

/** 造一个会记录调用次数的假行为 */
export function makeBehavior(kind: TowerKind, over: Partial<TowerBehavior> = {}): FakeBehavior {
  const cfg = towers.kinds[kind];
  const fake: FakeBehavior = {
    kind,
    attr: cfg.attr,
    cost: cfg.cost,
    range: cfg.range,
    maxHp: cfg.hp,
    updates: [],
    placedCount: 0,
    removedCount: 0,
    emitHit: true,
    onPlaced(self): void {
      fake.placedCount += 1;
      // 顺带验证 TowerRuntime 的 state / cfg / rng 可用
      self.state.placedFlag = 1;
    },
    update(self, ctx): void {
      fake.updates.push(ctx);
      if (fake.emitHit && ctx.canFire) {
        self.bus.emit('TowerTargetHit', {
          towerId: self.id,
          kind: self.kind,
          attr: self.attr === 'none' ? 'physical' : self.attr,
          amount: 1,
        });
      }
    },
    onRemoved(): void {
      fake.removedCount += 1;
    },
    ...over,
  };
  return fake;
}

/** 往注册表塞行为（测试结束后用 clearBehaviors 清理） */
export function installBehavior(kind: TowerKind, over: Partial<TowerBehavior> = {}): FakeBehavior {
  const fake = makeBehavior(kind, over);
  TOWER_BEHAVIORS[kind] = fake;
  return fake;
}

export function clearBehaviors(): void {
  for (const kind of Object.keys(TOWER_BEHAVIORS) as TowerKind[]) {
    delete TOWER_BEHAVIORS[kind];
  }
}

export interface Harness {
  sys: TowerSystem;
  impl: TowerSystemImpl;
  bus: Bus;
  rec: Recorder;
}

/** 建一个初始化好的 TowerSystem（固定种子，可复现） */
export function makeSystem(seed = 12345): Harness {
  const bus = createBus();
  const sys = createTowerSystem();
  sys.init({ bus, rng: createRng(seed), towersCfg: towers, arenaCfg: arena });
  return { sys, impl: sys as TowerSystemImpl, bus, rec: record(bus) };
}

export const corePos: Vec3 = [0, 0, 0];
export const playerPos: Vec3 = [0, 0, 8];

/** 造一份合法的 TowerUpdateCtx */
export function makeCtx(over: Partial<TowerUpdateCtx> = {}): TowerUpdateCtx {
  return {
    dtSec: 1 / 60,
    canFire: true,
    boss: {
      pos: [20, 0, 0],
      weakness: null,
      weaknessAttr: null,
      castingSkill: null,
      taunted: false,
    },
    playerPos,
    corePos,
    ...over,
  };
}

/** 找到某个 ring 的第一个塔位 id */
export function firstSlotOfRing(ring: 'mid' | 'tower' | 'outer'): string {
  const slot = arena.slots.find((s) => s.ring === ring);
  if (!slot) throw new Error(`arena.json 里没有 ring=${ring} 的塔位`);
  return slot.id;
}

export function slotPos(slotId: string): Vec3 {
  const slot = arena.slots.find((s) => s.id === slotId);
  if (!slot) throw new Error(`arena.json 里没有塔位 ${slotId}`);
  return slot.pos;
}
