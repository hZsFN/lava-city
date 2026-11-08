// src/player/Execution.ts
// 击破：弱点进入「可击破」后 3 s 内按 F 触发，1.2 s 处决，造成阶段最大 HP 12% 真伤。
// 纯逻辑：不 import three；阶段最大 HP 由整合层注入；数值来自 config。

import { executionDamage } from '../combat/Damage';
import type { BodyPart, Bus } from '../core/events';

const EPS = 1e-9;

export interface ExecutionConfig {
  /** 弱点「可击破」窗口（设计 §5.4：3 s） */
  windowSec: number;
  /** 处决演出/结算时长（设计 §5.4：1.2 s） */
  durationSec: number;
}

export interface ExecutionDeps {
  bus: Bus;
  config: ExecutionConfig;
  /** 当前阶段 Boss 最大 HP，用于 12% 真伤 */
  getBossMaxHp: () => number;
}

export interface ExecutionResult {
  part: BodyPart;
  damage: number;
}

export class Execution {
  private readonly bus: Bus;
  private readonly cfg: ExecutionConfig;
  private readonly getBossMaxHp: () => number;

  private part: BodyPart | null = null;
  private windowLeft = 0;
  private executing = false;
  private execLeft = 0;
  private readonly unsubs: Array<() => void> = [];

  constructor(deps: ExecutionDeps) {
    this.bus = deps.bus;
    this.cfg = deps.config;
    this.getBossMaxHp = deps.getBossMaxHp;

    // 弱点进入可击破 → 开窗（可重复刷新）
    this.unsubs.push(
      this.bus.on('WeaknessProgress', (p) => {
        if (!p.executable) return;
        this.part = p.part;
        this.windowLeft = this.cfg.windowSec;
      }),
    );
    this.unsubs.push(
      this.bus.on('WeaknessClosed', (p) => {
        if (this.part === p.part) this.closeWindow();
      }),
    );
  }

  /** 窗口内且未在处决中 */
  get canExecute(): boolean {
    return this.part !== null && !this.executing;
  }

  get isExecuting(): boolean {
    return this.executing;
  }

  /** 当前可击破部位 */
  get executablePart(): BodyPart | null {
    return this.part;
  }

  /**
   * 推进一帧。request = 本帧按了 F（边沿由输入层保证）。
   * 完成处决的那一帧返回结算结果。
   */
  update(dt: number, request: boolean): ExecutionResult | null {
    if (dt <= 0) return null;

    if (this.executing) {
      this.execLeft -= dt;
      if (this.execLeft > EPS) return null;

      const part = this.part;
      this.executing = false;
      this.closeWindow();
      if (!part) return null;

      const damage = executionDamage(this.getBossMaxHp());
      this.bus.emit('ExecutionEnded', { part, damage });
      return { part, damage };
    }

    if (this.part !== null) {
      this.windowLeft -= dt;
      if (this.windowLeft <= EPS) {
        this.closeWindow();
        return null;
      }
    }

    if (request && this.part !== null) {
      const part = this.part;
      this.executing = true;
      this.execLeft = this.cfg.durationSec;
      this.bus.emit('ExecutionStarted', { part });
    }

    return null;
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  private closeWindow(): void {
    this.part = null;
    this.windowLeft = 0;
  }
}
