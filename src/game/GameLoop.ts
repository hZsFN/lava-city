// src/game/GameLoop.ts
// ============================================================================
// 整合层 · 由 S0 维护
// ----------------------------------------------------------------------------
// 职责：把三路交付物串成一局能跑的游戏。只做接线，不实现任何玩法规则。
//
//   事件总线 createBus()               ← src/core/events.ts
//   时间轴   createMatchTimeline()      ← B3
//   塔系统   createTowerSystem()        ← B1 + B2
//   玩家     new PlayerController(...)  ← P2-A
//
// 固定步长：逻辑 60 Hz（1/60 s），渲染按 rAF 自然频率。
// 设计文档 §12.2：「固定步长逻辑与渲染解耦」。
// ============================================================================

import { createBus } from '../core/events';
import type { Attr, BodyPart, Bus, MatchPhase, Snapshot, Vec3 } from '../core/events';
import { createRng } from '../core/rng';
import { createMatchTimeline } from '../flow/MatchTimeline';
import type { FlowConfig, MatchTimeline } from '../flow/types';
import { createTowerSystem } from '../towers/TowerSystem';
import type { ArenaConfig, TowerKind, TowerSystem, TowersConfig } from '../towers/types';
import { PlayerController } from '../player/PlayerController';
import type { PlayerConfig, PlayerInput, PlayerWorld } from '../player/PlayerController';
import { Execution } from '../player/Execution';
import type { ExecutionConfig } from '../player/Execution';
import { WeaknessMeter } from '../combat/WeaknessMeter';
import type { WeaknessConfig } from '../combat/WeaknessMeter';

import flowCfgJson from '../core/config/flow.json';
import towersCfgJson from '../core/config/towers.json';
import arenaCfgJson from '../core/config/arena.json';
import playerCfgJson from '../core/config/player.json';

/** 逻辑固定步长：60 Hz */
export const LOGIC_DT = 1 / 60;

/** 单帧最多补多少逻辑步（防止后台切回来一次性补几千步导致卡死） */
const MAX_STEPS_PER_FRAME = 5;

const flowCfg = flowCfgJson as unknown as FlowConfig;
const towersCfg = towersCfgJson as unknown as TowersConfig;
const arenaCfg = arenaCfgJson as unknown as ArenaConfig;

/**
 * 玩家配置：直接使用 config/player.json。
 * P2-A 已把 PlayerConfig 统一成嵌套结构（physics / movement / hp），
 * 与 config 的字段完全对齐，因此这里不需要再做字段映射。
 */
function toPlayerConfig(raw: unknown): PlayerConfig {
  return raw as PlayerConfig;
}

/** 玩家活动世界：塔顶平台（用 arena.json 的尺寸算一个圆形平台的 AABB 包围） */
function buildPlayerWorld(): PlayerWorld {
  // 玩家活动范围跟中环石台对齐（visual.json 的 spire.midRing.outer），
  // 否则会走出石台边缘、悬空站在虚空上。
  const ring = 23.2;
  return {
    colliders: [
      // 塔顶主平台：一个方形包围盒，玩家站在上面
      { minX: -ring, maxX: ring, minY: -2, maxY: 0, minZ: -ring, maxZ: ring },
    ],
    lavaY: arenaCfg.lava.startY,
  };
}

/** 输入源：由 main.ts 提供（键盘/鼠标），或由测试提供（脚本化） */
export interface InputSource {
  sample(): PlayerInput;
  /** 可选：本帧是否按了 F（击破边沿） */
  consumeExecute?(): boolean;
}

/** Boss 的运行时只读视图（由 main.ts 从渲染实体投影出来，逻辑层不 import three） */
export interface BossRuntimeState {
  pos: Vec3;
  weakness: BodyPart | null;
  weaknessAttr: Attr | null;
  skill: string | null;
  taunted: boolean;
}

export interface Game {
  readonly bus: Bus;
  readonly timeline: MatchTimeline;
  readonly towers: TowerSystem;
  readonly player: PlayerController;
  readonly weakness: WeaknessMeter;
  readonly execution: Execution;
  /** 固定步长推进；返回实际推进的逻辑步数 */
  tick(dtSec: number): number;
  snapshot(): Snapshot;
  playerPos(): Vec3;
  playerYaw(): number;
  playerPitch(): number;
  isOver(): boolean;
  seed(): number;
  /** 调试用：手动建塔 */
  placeTower(slotId: string, kind: TowerKind): boolean;
  /**
   * 换塔：塔位已有塔时，先按 sellRefundRatio 折价卖掉旧塔，再建新塔。
   * 旧塔与想要的是同一种、或折返后仍买不起新塔 → 返回 false 且不动旧塔。
   */
  replaceTower(slotId: string, kind: TowerKind): boolean;
  /** 调试用：设置熔核数 */
  setMotes(n: number): void;
}

export interface GameDeps {
  input: InputSource;
  /** 可选：覆盖种子（便于复现） */
  seed?: number;
  /**
   * 入口血量（血量接力规则）：由 main.ts 从 WL 存档读入后注入。
   * 不传时才退回 config/player.json 的兜底值。
   */
  playerHp?: { hp: number; maxHp: number };
  /** Boss 的实时位置/弱点（未登场时返回 null） */
  bossState?: () => BossRuntimeState | null;
}

export function createGame(deps: GameDeps): Game {
  const seed = deps.seed ?? 0x1a7e4b;
  const bus = createBus();
  const rng = createRng(seed);

  // ── B3：时间轴（init 内部会立刻发首个阶段事件）─────────────────────────
  const timeline = createMatchTimeline();
  timeline.init({ bus, flowCfg, arenaCfg });

  // ── B1+B2：塔系统（自动订阅 MatchPhaseChanged / LavaLevelChanged）──────
  const towers = createTowerSystem();
  towers.init({ bus, rng, towersCfg, arenaCfg });

  // 补发初始塔位状态：B1 在 init 时创建了 11 个 socket，但只在实际变化时
  // 才发 TowerSlotStateChanged，导致快照的 towerSlots 初值为空（UI/调试取不到）。
  // 这是整合层的接线职责：把「已存在的初始状态」投影进只读快照。
  for (const slot of towers.slots()) {
    bus.emit('TowerSlotStateChanged', { slotId: slot.slotId, state: slot.state });
  }

  // Boss 弱点属性：由 Boss 自己通过事件公布，逻辑层只记录不猜测。
  // 之前这里写死 'arcane'，阶段 I 改成物理弱点后就成了错的。
  let weaknessAttr: 'arcane' | 'physical' | null = null;
  bus.on('WeaknessExposed', (p) => { weaknessAttr = p.attr; });
  bus.on('WeaknessClosed', () => { weaknessAttr = null; });

  // ── P2-A：玩家 ────────────────────────────────────────────────────────────
  // 出生点：master 侧读 flowCfg.playerSpawn，但 config 合同里还没有这个键，
  // 缺省退回塔心平台的同一坐标，等流配置补齐后再删掉这里的兜底。
  const spawn: Vec3 =
    (flowCfg as FlowConfig & { playerSpawn?: Vec3 }).playerSpawn ?? [0, 0, 17.2];

  const player = new PlayerController({
    bus,
    config: toPlayerConfig(playerCfgJson),
    world: buildPlayerWorld(),
    spawn,
    hp: deps.playerHp
      ? { current: deps.playerHp.hp, max: deps.playerHp.maxHp }
      : undefined,
  });

  // ── 破绽 / 击破：玩家侧资源与状态机 ─────────────────────────────────────
  const weaknessCfg = (playerCfgJson as { weakness?: WeaknessConfig }).weakness
    ?? { max: 100, executableWindowSec: 3 };
  const weakness = new WeaknessMeter({ bus, config: weaknessCfg });

  const executionCfg = (playerCfgJson as { execution?: ExecutionConfig }).execution
    ?? { windowSec: 3, durationSec: 1.2 };
  const execution = new Execution({
    bus,
    config: executionCfg,
    getBossMaxHp: () => Math.max(1, bus.snapshot().boss.maxHp),
  });

  // ── 开局熔核 ──────────────────────────────────────────────────────────────
  // 边界说明：B1 的 place()/upgrade() 接受「当前余额」参数并由它内部记账；
  // 但开局余额归 config（flow.json 的 motes.start）。整合层持有权威余额，
  // 订阅 MoteCountChanged 保持同步。这是「谁拥有资源」的明确划分。
  let motesBalance = flowCfg.motes.start;
  bus.on('MoteCountChanged', (p) => { motesBalance = p.motes; });

  let accumulator = 0;
  let over = false;
  bus.on('MatchEnded', () => { over = true; });

  /** 只有两段战斗阶段塔才开火；演出段（含转阶段）全部停火 */
  function canFireNow(phase: MatchPhase): boolean {
    return phase === 'boss1' || phase === 'boss2' || phase === 'rage';
  }

  function stepOnce(input: PlayerInput): void {
    // 1. 玩家（先决定位置，供塔做距离判定）
    player.update(LOGIC_DT, input);

    // 2. 时间轴（可能切阶段 → 触发 MatchPhaseChanged / LavaLevelChanged）
    timeline.update(LOGIC_DT);

    // 2.5 破绽累积 + 击破（F 为边沿输入）
    weakness.update(LOGIC_DT);
    execution.update(LOGIC_DT, deps.input.consumeExecute?.() ?? false);

    // 3. 塔：目标是 Boss 的真实位置与弱点（由 main 注入只读视图）；
    //    未注入时退回塔心原点占位，保证射程/冷却链路仍可跑
    const snap = bus.snapshot();
    const boss = deps.bossState
      ? deps.bossState()
      : {
          pos: [0, 0, 0] as Vec3,
          weakness: snap.boss.weakness,
          weaknessAttr: weaknessAttr,
          skill: snap.boss.skill,
          taunted: false,
        };
    towers.update(LOGIC_DT, {
      dtSec: LOGIC_DT,
      canFire: canFireNow(timeline.phase()) && boss !== null,
      boss: {
        pos: boss?.pos ?? [0, 0, 0],
        weakness: boss?.weakness ?? snap.boss.weakness,
        weaknessAttr: boss?.weaknessAttr ?? weaknessAttr,
        castingSkill: boss?.skill ?? snap.boss.skill,
        taunted: boss?.taunted ?? false,
      },
      playerPos: player.pos,
      corePos: [0, 0, 0],
    });
  }

  return {
    bus,
    timeline,
    towers,
    player,
    weakness,
    execution,

    tick(dtSec: number): number {
      if (over) return 0;
      accumulator += Math.min(dtSec, 0.25);
      const input = deps.input.sample();
      let steps = 0;

      while (accumulator >= LOGIC_DT && steps < MAX_STEPS_PER_FRAME) {
        stepOnce(input);
        accumulator -= LOGIC_DT;
        steps += 1;
      }

      // 补步上限触发时丢弃积压，避免雪崩
      if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0;
      return steps;
    },

    snapshot: () => bus.snapshot(),
    playerPos: () => player.pos,
    // yaw 在 P2-A 里是 private，从只读快照取（快照是唯一对外通道）
    // 实时取，不走快照：快照是事件驱动的，转向会滞后一帧到几帧，表现为视角"跳"
    playerYaw: () => player.yawAngle,
    playerPitch: () => player.pitchAngle,
    isOver: () => over,
    seed: () => seed,
    placeTower: (slotId, kind) => {
      const ok = towers.place(slotId, kind, motesBalance);
      if (ok) motesBalance = towers.motes();
      return ok;
    },
    replaceTower: (slotId, kind) => {
      const slot = towers.slots().find((s) => s.slotId === slotId);
      if (!slot) return false;

      // 空位直接建
      if (slot.state === 'open') {
        const okOpen = towers.place(slotId, kind, motesBalance);
        if (okOpen) motesBalance = towers.motes();
        return okOpen;
      }
      if (slot.state !== 'occupied' || !slot.towerId) return false;

      const old = towers.list().find((t) => t.id === slot.towerId);
      const cfg = towersCfgJson.kinds[kind];
      if (!old || !cfg) return false;
      // 已经是这种塔：不拆不建，免得白吃一次折价
      if (old.kind === kind) return false;

      const refundRatio = towersCfgJson.build?.sellRefundRatio ?? 0;
      const refund = Math.floor(old.investedCost * refundRatio);
      // 先算账：折返之后仍买不起 → 干脆不动旧塔（towers.place 自己也会再校验一次）
      if (motesBalance + refund < cfg.cost) return false;

      if (!towers.sell(old.id)) return false;
      motesBalance = towers.motes();
      const ok = towers.place(slotId, kind, motesBalance);
      motesBalance = towers.motes();
      return ok;
    },
    setMotes: (n) => {
      motesBalance = n;
      bus.emit('MoteCountChanged', { motes: n });
    },
  };
}
