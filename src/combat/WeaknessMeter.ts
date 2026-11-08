// src/combat/WeaknessMeter.ts
// 破绽值累积：弱点暴露期间，命中该部位的伤害按 design §8 的规则累加，
// 满 100 后进入 3 s「可击破」窗口。纯逻辑：不 import three。

import { weaknessContribution } from './Damage';
import type { Attr, BodyPart, Bus } from '../core/events';

const EPS = 1e-9;

export interface WeaknessConfig {
  max: number;
  executableWindowSec: number;
}

export interface WeaknessMeterDeps {
  bus: Bus;
  config: WeaknessConfig;
}

export class WeaknessMeter {
  private readonly bus: Bus;
  private readonly cfg: WeaknessConfig;

  private part: BodyPart | null = null;
  private attr: Attr | null = null;
  private value = 0;
  private exposureLeft = 0;
  private executable = false;
  private executableLeft = 0;

  private readonly unsubs: Array<() => void> = [];

  constructor(deps: WeaknessMeterDeps) {
    this.bus = deps.bus;
    this.cfg = deps.config;

    this.unsubs.push(
      this.bus.on('WeaknessExposed', (p) => {
        this.part = p.part;
        this.attr = p.attr;
        this.value = 0;
        this.exposureLeft = p.durationMs / 1000;
        this.executable = false;
        this.executableLeft = 0;
        this.emit();
      }),
    );

    this.unsubs.push(
      this.bus.on('WeaknessClosed', (p) => {
        if (this.part !== p.part) return;
        this.close();
      }),
    );

    this.unsubs.push(
      this.bus.on('DamageDealt', (p) => {
        if (p.target !== 'boss' || this.part === null || this.attr === null) return;
        if (p.part !== this.part) return;
        // 玩家本人伤害：塔来源的 0.5 系数由 TowerTargetHit 换算，不在此重复
        const gain = weaknessContribution({
          damageDealt: p.amount,
          attr: p.attr,
          weaknessAttr: this.attr,
          fromTower: false,
        });
        this.value = Math.min(this.cfg.max, this.value + gain);
        if (this.value >= this.cfg.max - EPS && !this.executable) {
          this.executable = true;
          this.executableLeft = this.cfg.executableWindowSec;
        }
        this.emit();
      }),
    );
  }

  get exposedPart(): BodyPart | null {
    return this.part;
  }

  get progress(): number {
    return this.value;
  }

  get max(): number {
    return this.cfg.max;
  }

  get isExecutable(): boolean {
    return this.executable;
  }

  update(dt: number): void {
    if (dt <= 0 || this.part === null) return;

    this.exposureLeft -= dt;
    if (this.exposureLeft <= EPS) {
      this.close();
      return;
    }

    if (this.executable) {
      this.executableLeft -= dt;
      if (this.executableLeft <= EPS) {
        this.executable = false;
        this.emit();
      }
    }
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }

  private close(): void {
    this.part = null;
    this.attr = null;
    this.value = 0;
    this.exposureLeft = 0;
    this.executable = false;
    this.executableLeft = 0;
  }

  private emit(): void {
    if (this.part === null) return;
    this.bus.emit('WeaknessProgress', {
      part: this.part,
      value: this.value,
      max: this.cfg.max,
      executable: this.executable,
    });
  }
}
