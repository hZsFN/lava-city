// src/player/WeaponMagic.ts
// 法术形态：地脉法杖（火花 12/发 @5 发/s + 过热 4 s / 冷却 2 s；右键引导 1.2 s 地脉穿刺 90）。
// 纯逻辑：不 import three；命中由整合层注入；数值全部来自 config。

import { computeDamage } from '../combat/Damage';
import type { Bus } from '../core/events';
import type {
  AttackOutcome,
  MagicWeaponConfig,
  ResolveWeaponHit,
  WeaponInput,
} from './weaponTypes';

const EPS = 1e-9;

export interface WeaponMagicDeps {
  bus: Bus;
  config: MagicWeaponConfig;
  resolveHit: ResolveWeaponHit;
}

export class WeaponMagic {
  private readonly bus: Bus;
  private readonly cfg: MagicWeaponConfig;
  private readonly resolveHit: ResolveWeaponHit;

  private heat = 0;
  private overheated = false;
  private overheatTimer = 0;
  private sparkTimer = 0;
  private channeling = false;
  private charge = 0;

  constructor(deps: WeaponMagicDeps) {
    this.bus = deps.bus;
    this.cfg = deps.config;
    this.resolveHit = deps.resolveHit;
  }

  get isOverheated(): boolean {
    return this.overheated;
  }

  /** 0..1 过热条 */
  get heatRatio(): number {
    return this.heat;
  }

  get isChanneling(): boolean {
    return this.channeling;
  }

  /** 0..1 的引导进度 */
  get chargeRatio(): number {
    if (!this.channeling) return 0;
    return Math.min(1, this.charge / this.cfg.pierce.chargeSec);
  }

  update(dt: number, input: WeaponInput): AttackOutcome | null {
    if (dt <= 0) return null;

    if (this.overheated) {
      this.overheatTimer += dt;
      if (this.overheatTimer >= this.cfg.overheat.cooldownSec - EPS) {
        this.overheated = false;
        this.overheatTimer = 0;
        this.heat = 0;
        this.emitOverheat();
      }
      return null;
    }

    if (this.channeling) {
      this.charge += dt;
      if (!input.heavyHeld) {
        this.channeling = false;
        const full = this.charge >= this.cfg.pierce.chargeSec - EPS;
        this.charge = 0;
        return full ? this.firePierce() : null;
      }
      return null;
    }

    if (input.heavyPressed) {
      this.channeling = true;
      this.charge = 0;
      return null;
    }

    let outcome: AttackOutcome | null = null;
    if (input.lightHeld) {
      this.sparkTimer += dt;
      const interval = 1 / this.cfg.spark.ratePerSec;
      if (this.sparkTimer >= interval - EPS) {
        this.sparkTimer -= interval;
        outcome = this.fireSpark();
        this.heat = Math.min(1, this.heat + interval / this.cfg.overheat.fillSec);
        if (this.heat >= 1 - EPS) {
          this.overheated = true;
          this.overheatTimer = 0;
          this.sparkTimer = 0;
        }
        this.emitOverheat();
      }
    } else if (this.heat > 0) {
      // 停火自然散热
      this.heat = Math.max(0, this.heat - dt / this.cfg.overheat.fillSec);
      this.emitOverheat();
    }

    return outcome;
  }

  private fireSpark(): AttackOutcome {
    return this.fire('spark', this.cfg.spark.damage);
  }

  private firePierce(): AttackOutcome {
    return this.fire('pierce', this.cfg.pierce.damage);
  }

  private fire(kind: 'spark' | 'pierce', base: number): AttackOutcome {
    const hit = this.resolveHit({
      kind: kind === 'spark' ? 'projectile' : 'channel',
      rangeM: Number.POSITIVE_INFINITY,
    });

    const outcome: AttackOutcome = {
      kind,
      damage: 0,
      isCrit: false,
      target: hit?.target ?? null,
      part: hit?.part,
    };
    if (!hit) return outcome;

    const result = computeDamage({
      base,
      attr: 'arcane',
      resist: hit.resist,
      debuffs: hit.debuffs,
      weakness: hit.weakness,
    });
    outcome.damage = result.amount;
    outcome.isCrit = result.isCrit;

    this.bus.emit('DamageDealt', {
      target: hit.target,
      amount: result.amount,
      attr: 'arcane',
      part: hit.part,
      isCrit: result.isCrit,
    });
    return outcome;
  }

  private emitOverheat(): void {
    this.bus.emit('OverheatChanged', { value: this.heat, overheated: this.overheated });
  }
}
