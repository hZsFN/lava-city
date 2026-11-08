// tests/unit/towers/kinds/helpers.ts
// ============================================================================
// 五种塔行为的单测脚手架。
// 不依赖 B1 的 TowerSystem：手工构造 TowerRuntime + TowerUpdateCtx，
// 用真实 createBus() 捕获行为 emit 的事件。
// ============================================================================

import towersJson from '../../../../src/core/config/towers.json';
import { createBus } from '../../../../src/core/events';
import type { Bus, EventName, Events, Vec3 } from '../../../../src/core/events';
import { createRng } from '../../../../src/core/rng';
import type {
  TowerBehavior,
  TowerKind,
  TowerRuntime,
  TowersConfig,
  TowerUpdateCtx,
} from '../../../../src/towers/types';

const towersCfg = towersJson as unknown as TowersConfig;

/** 单测关心的全部塔事件（外加两个「绝不该由塔发出」的负向断言目标） */
const WATCHED: EventName[] = [
  'FreezeProgressChanged',
  'FreezeFull',
  'TowerInterruptRequested',
  'TowerTargetHit',
  'TauntStarted',
  'TauntEnded',
  'DebuffStackChanged',
  'BossSkillInterrupted',
];

export interface Captured {
  name: EventName;
  payload: unknown;
}

export interface Harness {
  self: TowerRuntime;
  bus: Bus;
  seen: Captured[];
  /** 取出某事件的全部 payload */
  of<K extends EventName>(name: K): Array<Events[K]>;
  /** 某事件发生次数 */
  count(name: EventName): number;
  clear(): void;
}

export interface SelfOptions {
  id?: string;
  pos?: Vec3;
  seed?: number;
  state?: Record<string, number>;
}

/** 造一个假塔（字段与 B1 的 TowerRuntime 一致） */
export function makeSelf(kind: TowerKind, opts: SelfOptions = {}): Harness {
  const bus = createBus();
  const seen: Captured[] = [];
  for (const name of WATCHED) {
    bus.on(name, (payload) => {
      seen.push({ name, payload: payload as unknown });
    });
  }

  const cfg = towersCfg.kinds[kind];
  const self: TowerRuntime = {
    id: opts.id ?? `${kind}-1`,
    kind,
    slotId: `${kind}-slot`,
    pos: opts.pos ?? [0, 0, 0],
    level: 1,
    hp: cfg.hp,
    maxHp: cfg.hp,
    investedCost: cfg.cost,
    cooldownSec: 0,
    state: opts.state ?? {},
    bus,
    rng: createRng(opts.seed ?? 42),
    cfg,
  };

  return {
    self,
    bus,
    seen,
    of<K extends EventName>(name: K): Array<Events[K]> {
      return seen.filter((e) => e.name === name).map((e) => e.payload as Events[K]);
    },
    count(name: EventName): number {
      return seen.filter((e) => e.name === name).length;
    },
    clear(): void {
      seen.length = 0;
    },
  };
}

export interface CtxOptions {
  dtSec?: number;
  canFire?: boolean;
  bossPos?: Vec3;
  castingSkill?: string | null;
  taunted?: boolean;
}

/** 造一个假 ctx（默认：Boss 在原点、可开火、未施法、未被嘲讽） */
export function makeCtx(opts: CtxOptions = {}): TowerUpdateCtx {
  return {
    dtSec: opts.dtSec ?? 0.1,
    canFire: opts.canFire ?? true,
    boss: {
      pos: opts.bossPos ?? [0, 0, 0],
      weakness: null,
      weaknessAttr: null,
      castingSkill: opts.castingSkill ?? null,
      taunted: opts.taunted ?? false,
    },
    playerPos: [0, 0, 0],
    corePos: [0, 0, 0],
  };
}

/** 连续推进 n 帧（每帧 dt 秒） */
export function tick(
  behavior: TowerBehavior,
  harness: Harness,
  n: number,
  opts: CtxOptions = {},
): void {
  for (let i = 0; i < n; i++) {
    behavior.update(harness.self, makeCtx(opts));
  }
}

export { towersCfg };
