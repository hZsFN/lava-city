// src/towers/TowerSocket.ts
// ============================================================================
// 塔位状态机（B1）
// ----------------------------------------------------------------------------
// locked → open → occupied → open（拆除/被摧毁）
//                 └→ submerged（熔岩淹没，终态，不可再建）
//
// 状态变化只由本类负责，事件由 TowerSystem 统一发（避免两处 emit 重复）。
// 禁止 import three：位置用 Vec3 = readonly [number, number, number]。
// ============================================================================

import type { ArenaConfig, SlotConfig, SlotRing, SlotState, SlotView, Vec3 } from './types';

export interface TowerSocketInit {
  slotId: string;
  ring: SlotRing;
  pos: Vec3;
  /** 1 = 阶段 I 开放；2 = 阶段 II（transition 之后）开放 */
  unlockPhase: 1 | 2;
  /** 熔岩高度 >= 该值即淹没此塔位（由 TowerSystem 从 arena.lava 推导） */
  drownAtY: number;
}

export class TowerSocket {
  readonly slotId: string;
  readonly ring: SlotRing;
  readonly pos: Vec3;
  readonly unlockPhase: 1 | 2;
  readonly drownAtY: number;

  private _state: SlotState;
  private _towerId: string | null = null;

  constructor(init: TowerSocketInit) {
    this.slotId = init.slotId;
    this.ring = init.ring;
    this.pos = init.pos;
    this.unlockPhase = init.unlockPhase;
    this.drownAtY = init.drownAtY;
    this._state = init.unlockPhase === 1 ? 'open' : 'locked';
  }

  get state(): SlotState {
    return this._state;
  }

  get towerId(): string | null {
    return this._towerId;
  }

  get isOpen(): boolean {
    return this._state === 'open';
  }

  get isOccupied(): boolean {
    return this._state === 'occupied';
  }

  get isSubmerged(): boolean {
    return this._state === 'submerged';
  }

  /** 该位当前是否允许建塔 */
  get isBuildable(): boolean {
    return this._state === 'open' && this._towerId === null;
  }

  /** locked → open。其它状态一律返回 false（幂等，不会把 occupied/submerged 打回 open）。 */
  unlock(): boolean {
    if (this._state !== 'locked') return false;
    this._state = 'open';
    return true;
  }

  /** open → occupied。占用失败返回 false（已被占用/未开放/已淹没）。 */
  occupy(towerId: string): boolean {
    if (!this.isBuildable) return false;
    this._towerId = towerId;
    this._state = 'occupied';
    return true;
  }

  /** occupied → open（拆除或被摧毁）。槽位被淹没时不会回 open。 */
  release(): boolean {
    if (this._state !== 'occupied') return false;
    this._towerId = null;
    this._state = 'open';
    return true;
  }

  /**
   * 淹没：open / occupied → submerged（终态）。
   * locked 不参与淹没——契约注释写的是「open/occupied → submerged」，
   * 且阶段 II 解锁逻辑与淹没逻辑不应互相打架。
   */
  submerge(): boolean {
    if (this._state !== 'open' && this._state !== 'occupied') return false;
    this._towerId = null;
    this._state = 'submerged';
    return true;
  }

  view(): SlotView {
    return {
      slotId: this.slotId,
      ring: this.ring,
      pos: this.pos,
      state: this._state,
      towerId: this._towerId,
    };
  }
}

/** 把 config 里的 number[] 复制成只读三元组，避免外部数组被就地改动 */
function toVec3(p: readonly number[]): Vec3 {
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

/**
 * 由 arena.json 的 slots 建全部塔位。
 *
 * 淹没阈值推导：`drownAtY = lava.drownSlotY + max(0, slot.y - 最低塔位 y)`
 * - 平地塔位（M / E，y=0）→ drownSlotY（-0.6），即熔岩涨过 -0.6 就被淹；
 * - 塔身塔位（T，y=12）→ drownSlotY + 12 = 11.4，涨到那个高度才淹。
 * 目前 arena.json 没有 per-slot 淹没阈值字段，故用几何关系推导；
 * 若 S0 后续给 slots[] 增加 `drownAtY`，这里优先用它（见 handoff 跨目录请求）。
 */
export function createSockets(arenaCfg: ArenaConfig): TowerSocket[] {
  const slots: SlotConfig[] = arenaCfg?.slots ?? [];
  if (slots.length === 0) return [];

  let lowestY = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const y = slot.pos[1] ?? 0;
    if (y < lowestY) lowestY = y;
  }
  if (!Number.isFinite(lowestY)) lowestY = 0;

  const baseDrownY = arenaCfg?.lava?.drownSlotY;
  const drownBase = typeof baseDrownY === 'number' && Number.isFinite(baseDrownY) ? baseDrownY : 0;

  return slots.map((slot) => {
    const y = slot.pos[1] ?? 0;
    const explicit = (slot as SlotConfig & { drownAtY?: number }).drownAtY;
    const drownAtY =
      typeof explicit === 'number' && Number.isFinite(explicit)
        ? explicit
        : drownBase + Math.max(0, y - lowestY);
    return new TowerSocket({
      slotId: slot.id,
      ring: slot.ring,
      pos: toVec3(slot.pos),
      unlockPhase: slot.unlockPhase,
      drownAtY,
    });
  });
}
