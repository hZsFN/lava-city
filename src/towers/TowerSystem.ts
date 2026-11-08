// src/towers/TowerSystem.ts
// ============================================================================
// TowerSystem 门面（B1）—— 逐字实现 src/towers/types.ts 的 TowerSystem 接口
// ----------------------------------------------------------------------------
// 职责：塔位状态机 + 建/升/拆 + 耐久 + 阶段解锁 + 熔岩淹没 + 每帧分发到 B2 的行为。
// 事件归属（协议 §4.2）：TowerPlaced / TowerUpgraded / TowerDestroyed /
//   TowerHpChanged / TowerSlotStateChanged / MoteCountChanged 全部由本模块发。
//
// 禁止 import three；位置用 Vec3；随机全部来自 init 传入的可播种 rng。
// ============================================================================

import type { EventName, Events, Snapshot } from '../core/events';
import { hasBehavior, TOWER_BEHAVIORS } from './kinds/index';
import { TowerBase } from './TowerBase';
import { createSockets, TowerSocket } from './TowerSocket';
import { createBuildMenu, normalizeMotes } from './BuildMenu';
import type {
  ArenaConfig,
  BuildMenuState,
  Bus,
  MatchPhase,
  Rng,
  SlotView,
  TowerBehavior,
  TowerKind,
  TowersConfig,
  TowerSystem as TowerSystemFacade,
  TowerUpdateCtx,
  TowerView,
  Vec3,
} from './types';

/**
 * 仰角死区半径（米）：塔身塔位对水平距离小于该值的 Boss 无法命中。
 * 来源：`docs/tickets/M2-01-towers.md` §6「水平距离 < 4 m」。
 *
 * ⚠ `arena.json` 目前**没有**这个字段（只有 `elevationDeadzoneDeg: 25`），
 * 而硬规则要求数值全部从 config 读，因此这里按票面值兜底，并已提「跨目录请求」，
 * 等 S0 在 `arena.json` 增加 `elevationDeadzoneM` 后自动改用配置值（优先读配置）。
 */
export const DEFAULT_DEADZONE_RADIUS_M = 4;

/** 塔身塔位的最低高度（票面：「塔位 y > 6」），用于区分塔身与平地塔位 */
const TOWER_SLOT_MIN_Y = 6;

/** 阶段 II 起解锁外环塔位的阶段集合（transition 之后） */
const PHASE2_PHASES: ReadonlySet<MatchPhase> = new Set<MatchPhase>([
  'transition',
  'boss2',
  'rage',
  'ended',
]);

function horizontalDist(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dz * dz);
}

function toVec3(p: readonly number[] | undefined): Vec3 {
  if (!p || p.length < 3) return [0, 0, 0];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 给单个塔包一层事件总线：仰角死区内的 `TowerTargetHit` 被拦截，其余事件原样转发。
 *
 * 为什么放在 B1：死区是**塔位几何**的属性（塔身塔位 + Boss 贴塔基），
 * 不是某一种塔的行为，B2 不应为此重复实现。B1 在分发层拦掉命中，
 * 同时把 `ctx.canFire` 置 false，让行为自己也能提前收手（双保险）。
 */
function createGuardedBus(bus: Bus, blocked: () => boolean): Bus {
  return {
    on<K extends EventName>(k: K, fn: (p: Events[K]) => void): () => void {
      return bus.on(k, fn);
    },
    emit<K extends EventName>(k: K, p: Events[K]): void {
      if (k === 'TowerTargetHit' && blocked()) return;
      bus.emit(k, p);
    },
    snapshot(): Snapshot {
      return bus.snapshot();
    },
    __setSnapshot(next: Snapshot): void {
      bus.__setSnapshot(next);
    },
  };
}

export class TowerSystemImpl implements TowerSystemFacade {
  private bus!: Bus;
  private rng!: Rng;
  private towersCfg!: TowersConfig;
  private arenaCfg!: ArenaConfig;

  private sockets: TowerSocket[] = [];
  private socketById = new Map<string, TowerSocket>();
  private towers = new Map<string, TowerBase>();
  /** 每个塔对应的 B2 行为（place 时从注册表取，取不到就不允许建） */
  private behaviors = new Map<string, TowerBehavior>();
  /** 仰角死区当前被拦住的塔 id（每帧 update 重算） */
  private deadzoneBlocked = new Set<string>();

  private seq = 0;
  private _motes = 0;
  private _phase: MatchPhase = 'wake';
  /** 最近一次熔岩高度（用于「熔岩已涨上来之后才解锁的外环」判定） */
  private _lavaY = Number.NEGATIVE_INFINITY;
  private unsubscribes: Array<() => void> = [];
  private initialized = false;

  init(deps: {
    bus: Bus;
    rng: Rng;
    towersCfg: TowersConfig;
    arenaCfg: ArenaConfig;
  }): void {
    this.disposeSubscriptions();

    this.bus = deps.bus;
    this.rng = deps.rng;
    this.towersCfg = deps.towersCfg;
    this.arenaCfg = deps.arenaCfg;

    this.sockets = createSockets(deps.arenaCfg);
    this.socketById = new Map(this.sockets.map((s) => [s.slotId, s]));
    this.towers.clear();
    this.behaviors.clear();
    this.deadzoneBlocked.clear();
    this.seq = 0;
    this._motes = 0;
    this._phase = 'wake';
    this._lavaY = Number.NEGATIVE_INFINITY;
    this.initialized = true;

    // B3 只发事件，B1 订阅（协议 §8：两者不互相 import）
    this.unsubscribes.push(this.bus.on('MatchPhaseChanged', (p) => this.setPhase(p.phase)));
    this.unsubscribes.push(this.bus.on('LavaLevelChanged', (p) => this.setLavaY(p.y)));
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────

  list(): TowerView[] {
    return [...this.towers.values()].map((t) => t.view());
  }

  slots(): SlotView[] {
    return this.sockets.map((s) => s.view());
  }

  menu(slotId: string | null, motes: number): BuildMenuState {
    if (slotId === null) return createBuildMenu(this.towersCfg, motes, null);
    const socket = this.socketById.get(slotId);
    // 塔位不存在 / 未开放 / 已占用 / 已淹没 → 不提供选项
    if (!socket || !socket.isBuildable) return { slotId, options: [] };
    return createBuildMenu(this.towersCfg, motes, slotId);
  }

  motes(): number {
    return this._motes;
  }

  /** 供单测/集成期读取当前阶段（不属于对外契约，额外便利方法） */
  phase(): MatchPhase {
    return this._phase;
  }

  // ── 建 / 升 / 拆 ─────────────────────────────────────────────────────────

  place(slotId: string, kind: TowerKind, motes: number): boolean {
    if (!this.initialized) return false;

    const socket = this.socketById.get(slotId);
    if (!socket || !socket.isBuildable) return false;

    // B2 还没实现的塔 → false，不崩、不发事件
    if (!hasBehavior(kind)) return false;
    const behavior = TOWER_BEHAVIORS[kind];
    if (!behavior) return false;

    const cfg = this.towersCfg?.kinds?.[kind];
    if (!cfg) return false;

    const cost = cfg.cost;
    if (!Number.isFinite(cost) || cost < 0) return false;

    const balance = normalizeMotes(motes);
    if (balance < cost) return false;

    const build = this.towersCfg.build;
    const towerId = `${slotId}-${kind}-${++this.seq}`;

    const tower = new TowerBase({
      id: towerId,
      kind,
      slotId,
      pos: socket.pos,
      cfg,
      bus: this.createTowerBus(towerId),
      seed: this.nextSeed(),
      investedCost: cost,
      maxHp: finiteOr(cfg.hp, 0),
      buildSec: finiteOr(build?.buildSec, 0),
    });

    // 先占位：占位失败说明并发/状态不一致，回滚计数器并返回 false
    if (!socket.occupy(towerId)) {
      this.seq -= 1;
      return false;
    }

    this.towers.set(towerId, tower);
    this.behaviors.set(towerId, behavior);
    this._motes = balance - cost;

    // 契约要求：扣熔核 → TowerPlaced → TowerHpChanged（TowerPlaced 不带 hp）→ 槽位状态
    this.bus.emit('MoteCountChanged', { motes: this._motes });
    this.bus.emit('TowerPlaced', { towerId, kind, slotId, pos: tower.pos });
    this.bus.emit('TowerHpChanged', { towerId, hp: tower.hp, maxHp: tower.maxHp });
    this.bus.emit('TowerSlotStateChanged', { slotId, state: socket.state });
    return true;
  }

  upgrade(towerId: string, motes: number): boolean {
    const tower = this.towers.get(towerId);
    if (!tower) return false;

    const build = this.towersCfg.build;
    const maxLevel = finiteOr(build?.maxLevel, 1);
    if (tower.level >= maxLevel) return false;

    const cfg = this.towersCfg.kinds[tower.kind];
    if (!cfg) return false;

    const upgradeCost = this.upgradeCostOf(cfg.cost);
    const balance = normalizeMotes(motes);
    if (balance < upgradeCost) return false;

    tower.level += 1;
    tower.hp = tower.maxHp;
    tower.investedCost += upgradeCost;
    this._motes = balance - upgradeCost;

    this.bus.emit('MoteCountChanged', { motes: this._motes });
    this.bus.emit('TowerUpgraded', { towerId, level: tower.level });
    this.bus.emit('TowerHpChanged', { towerId, hp: tower.hp, maxHp: tower.maxHp });
    return true;
  }

  sell(towerId: string): boolean {
    const tower = this.towers.get(towerId);
    if (!tower) return false;

    const socket = this.socketById.get(tower.slotId);
    const behavior = this.behaviors.get(towerId);
    const refund = this.refundOf(tower.investedCost);

    // 先摘状态再广播：监听方回调里再 sell 一次也不会重入
    this.towers.delete(towerId);
    this.behaviors.delete(towerId);
    this.deadzoneBlocked.delete(towerId);
    this._motes += refund;

    behavior?.onRemoved?.(tower);
    this.bus.emit('TowerDestroyed', { towerId, reason: 'sold' });
    if (socket && socket.release()) {
      this.bus.emit('TowerSlotStateChanged', { slotId: socket.slotId, state: socket.state });
    }
    this.bus.emit('MoteCountChanged', { motes: this._motes });
    return true;
  }

  // ── 阶段 / 熔岩 ──────────────────────────────────────────────────────────

  setPhase(phase: MatchPhase): void {
    this._phase = phase;
    if (!PHASE2_PHASES.has(phase)) return;
    // 外环按 arena.json 的 slots 顺序依次解锁；已 open 的不会重复发事件
    for (const socket of this.sockets) {
      if (socket.unlockPhase !== 2) continue;
      if (!socket.unlock()) continue;
      // 极端情况：熔岩已经涨过该位阈值才解锁 → 直接判淹没，避免 UI 闪一下 open
      if (this._lavaY >= socket.drownAtY) {
        socket.submerge();
      }
      this.bus.emit('TowerSlotStateChanged', { slotId: socket.slotId, state: socket.state });
    }
  }

  setLavaY(y: number): void {
    if (typeof y !== 'number' || !Number.isFinite(y)) return;
    this._lavaY = y;
    for (const socket of this.sockets) {
      if (socket.isSubmerged) continue;
      if (y < socket.drownAtY) continue;

      // 位上有塔 → 先淹塔（reason: 'drowned'），再把槽位标 submerged
      const towerId = socket.towerId;
      if (towerId) this.destroyTower(towerId, 'drowned');
      if (socket.submerge()) {
        this.bus.emit('TowerSlotStateChanged', { slotId: socket.slotId, state: socket.state });
      }
    }
  }

  // ── 伤害 ─────────────────────────────────────────────────────────────────

  damageTower(towerId: string, amount: number): void {
    const tower = this.towers.get(towerId);
    if (!tower || tower.hp <= 0) return;

    const behavior = this.behaviors.get(towerId);
    if (behavior?.onDamaged) {
      const nextHp = behavior.onDamaged(tower, amount);
      tower.hp = Number.isFinite(nextHp)
        ? Math.max(0, Math.min(tower.maxHp, nextHp))
        : 0;
    } else {
      tower.applyDamage(amount);
    }

    this.bus.emit('TowerHpChanged', { towerId, hp: tower.hp, maxHp: tower.maxHp });
    if (tower.hp <= 0) this.destroyTower(towerId, 'broken');
  }

  // ── 每帧 ─────────────────────────────────────────────────────────────────

  update(dtSec: number, ctx: TowerUpdateCtx): void {
    if (!this.initialized) return;

    const dt = Number.isFinite(dtSec) ? Math.max(0, dtSec) : 0;
    const bossPos = toVec3(ctx?.boss?.pos);
    const deadzoneRadius = this.deadzoneRadius();

    // 1) 先重算死区，保证本帧行为 emit 时的拦截规则是最新的
    this.deadzoneBlocked.clear();
    for (const tower of this.towers.values()) {
      const socket = this.socketById.get(tower.slotId);
      const isTowerRing = socket?.ring === 'tower';
      const isHighSlot = tower.pos[1] > TOWER_SLOT_MIN_Y;
      if (isTowerRing && isHighSlot && horizontalDist(tower.pos, bossPos) < deadzoneRadius) {
        this.deadzoneBlocked.add(tower.id);
      }
    }

    // 2) 分发。先拷贝一层，行为里若触发 sell/销毁不会打乱迭代
    for (const tower of [...this.towers.values()]) {
      const behavior = this.behaviors.get(tower.id);
      if (!behavior) continue;

      tower.tickBuild(dt);
      // 建完（含 buildSec === 0 的首帧）立刻通知行为一次
      if (!tower.placed && tower.isBuilt) {
        tower.placed = true;
        behavior.onPlaced?.(tower);
      }
      if (!tower.isBuilt) continue;

      const canFire = Boolean(ctx?.canFire) && !this.deadzoneBlocked.has(tower.id);
      const towerCtx: TowerUpdateCtx = {
        dtSec: dt,
        canFire,
        boss: {
          pos: bossPos,
          weakness: ctx?.boss?.weakness ?? null,
          weaknessAttr: ctx?.boss?.weaknessAttr ?? null,
          castingSkill: ctx?.boss?.castingSkill ?? null,
          taunted: Boolean(ctx?.boss?.taunted),
        },
        playerPos: toVec3(ctx?.playerPos),
        corePos: toVec3(ctx?.corePos),
      };
      behavior.update(tower, towerCtx);
    }
  }

  /** 释放事件订阅（单测重复 init / 集成期卸载用） */
  dispose(): void {
    this.disposeSubscriptions();
    this.initialized = false;
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private createTowerBus(towerId: string): Bus {
    return createGuardedBus(this.bus, () => this.deadzoneBlocked.has(towerId));
  }

  private destroyTower(towerId: string, reason: 'sold' | 'broken' | 'drowned'): void {
    const tower = this.towers.get(towerId);
    if (!tower) return;

    const socket = this.socketById.get(tower.slotId);
    const behavior = this.behaviors.get(towerId);

    this.towers.delete(towerId);
    this.behaviors.delete(towerId);
    this.deadzoneBlocked.delete(towerId);

    behavior?.onRemoved?.(tower);
    this.bus.emit('TowerDestroyed', { towerId, reason });
    // 被淹的槽位由 setLavaY 负责转 submerged，这里不抢
    if (reason !== 'drowned' && socket && socket.release()) {
      this.bus.emit('TowerSlotStateChanged', { slotId: socket.slotId, state: socket.state });
    }
  }

  private upgradeCostOf(baseCost: number): number {
    const ratio = finiteOr(this.towersCfg?.build?.upgradeCostRatio, 0);
    return Math.floor(baseCost * ratio);
  }

  private refundOf(investedCost: number): number {
    const ratio = finiteOr(this.towersCfg?.build?.sellRefundRatio, 0);
    return Math.floor(investedCost * ratio);
  }

  private deadzoneRadius(): number {
    const fromCfg = (this.arenaCfg as ArenaConfig & { elevationDeadzoneM?: number })
      .elevationDeadzoneM;
    return finiteOr(fromCfg, DEFAULT_DEADZONE_RADIUS_M);
  }

  /** 每塔独立种子：从系统 rng 抽一个，保证整局可复现且各塔互不干扰 */
  private nextSeed(): number {
    const r = this.rng ? this.rng() : 0;
    return Math.floor(r * 0xffffffff) >>> 0;
  }

  private disposeSubscriptions(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
  }
}

/** 工厂函数：协议 §5 约定的对外入口 */
export function createTowerSystem(): TowerSystemFacade {
  return new TowerSystemImpl();
}
