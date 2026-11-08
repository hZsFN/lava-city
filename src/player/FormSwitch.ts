// src/player/FormSwitch.ts
// 物理形态 ↔ 法术形态切换：Q 触发，0.5 s 切换期间无法攻击。
// 纯逻辑：不 import three；切换完成时发 FormSwitched，快照由总线自动回写。

import type { Attr, Bus } from '../core/events';

const EPS = 1e-9;

export interface FormSwitchConfig {
  durationSec: number;
  initial: Attr;
}

export interface FormSwitchDeps {
  bus: Bus;
  config: FormSwitchConfig;
}

export class FormSwitch {
  private readonly bus: Bus;
  private readonly cfg: FormSwitchConfig;

  private current: Attr;
  private target: Attr;
  private timer = 0;

  constructor(deps: FormSwitchDeps) {
    this.bus = deps.bus;
    this.cfg = deps.config;
    this.current = this.cfg.initial;
    this.target = this.current;
  }

  get form(): Attr {
    return this.current;
  }

  /** 切换是否进行中 */
  get isSwitching(): boolean {
    return this.timer > EPS;
  }

  /** 切换期间禁止攻击 */
  get canAttack(): boolean {
    return !this.isSwitching;
  }

  /** 0..1 的切换进度 */
  get progress(): number {
    if (!this.isSwitching) return 0;
    return 1 - this.timer / this.cfg.durationSec;
  }

  /**
   * 推进一帧。request = 本帧按了 Q（边沿由输入层保证）。
   * 完成切换的那一帧返回新形态，否则 null。
   */
  update(dt: number, request: boolean): Attr | null {
    if (dt <= 0) return null;

    if (this.isSwitching) {
      this.timer -= dt;
      if (this.timer > EPS) return null;

      this.timer = 0;
      this.current = this.target;
      this.bus.emit('FormSwitched', { form: this.current });
      return this.current;
    }

    if (request) {
      this.target = this.current === 'physical' ? 'arcane' : 'physical';
      this.timer = this.cfg.durationSec;
    }

    return null;
  }
}
