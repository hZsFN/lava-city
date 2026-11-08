// src/player/TacticalView.ts
// 战术视图：Tab 切换（时间 0.15×），打开时可用战术点远程搬塔。
// 纯逻辑：不 import three；搬塔动作由塔系统注入；时间缩放由主循环读取 timeScale。

import type { Bus } from '../core/events';

export interface TacticalViewConfig {
  /** 打开时的时间缩放（设计 §5.1：0.15×） */
  timeScale: number;
  /** 一次搬塔消耗的战术点 */
  relocateCost: number;
}

export interface TacticalViewDeps {
  bus: Bus;
  config: TacticalViewConfig;
  /** 执行搬塔；由塔系统判定槽位/合法性 */
  relocate: (towerId: string, slotId: string) => boolean;
}

export class TacticalView {
  private readonly bus: Bus;
  private readonly cfg: TacticalViewConfig;
  private readonly relocate: (towerId: string, slotId: string) => boolean;

  private opened = false;
  private tacticalPoints = 0;
  private freeRearranges = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(deps: TacticalViewDeps) {
    this.bus = deps.bus;
    this.cfg = deps.config;
    this.relocate = deps.relocate;

    // 每次击破 +1 战术点
    this.unsubs.push(
      this.bus.on('ExecutionEnded', () => {
        this.tacticalPoints += 1;
      }),
    );
    // 转阶段赠送 1 次免费全体重布
    this.unsubs.push(
      this.bus.on('BossPhaseChanged', () => {
        this.freeRearranges += 1;
      }),
    );
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** 主循环读取：打开时 0.15×，否则 1× */
  get timeScale(): number {
    return this.opened ? this.cfg.timeScale : 1;
  }

  get points(): number {
    return this.tacticalPoints;
  }

  get freeRearrangesLeft(): number {
    return this.freeRearranges;
  }

  /** toggle = 本帧按了 Tab（边沿由输入层保证） */
  update(toggle: boolean): void {
    if (!toggle) return;
    this.opened = !this.opened;
    this.bus.emit('TacticalViewChanged', { open: this.opened });
  }

  /**
   * 远程搬塔。仅打开时可操作；优先消耗免费重布，其次消耗战术点。
   * 搬塔失败会退还消耗。
   */
  tryRelocate(towerId: string, slotId: string): boolean {
    if (!this.opened) return false;

    const useFree = this.freeRearranges > 0;
    if (!useFree && this.tacticalPoints < this.cfg.relocateCost) return false;

    if (useFree) this.freeRearranges -= 1;
    else this.tacticalPoints -= this.cfg.relocateCost;

    const ok = this.relocate(towerId, slotId);
    if (!ok) {
      if (useFree) this.freeRearranges += 1;
      else this.tacticalPoints += this.cfg.relocateCost;
    }
    return ok;
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }
}
