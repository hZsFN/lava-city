// src/player/WeaponPhysical.ts
// 物理形态：熔岩重锤（三段 30/30/60、第三段击退）+ 岩锚（蓄力 1.0s、80、命中弱点拉拽）。
// 纯逻辑：不 import three；命中由整合层通过 resolveHit 注入；数值全部来自 config。

import { computeDamage } from '../combat/Damage';
import type { Bus } from '../core/events';
import type {
  AttackOutcome,
  PhysicalWeaponConfig,
  ResolveWeaponHit,
  WeaponInput,
} from './weaponTypes';

export interface WeaponPhysicalDeps {
  bus: Bus;
  config: PhysicalWeaponConfig;
  resolveHit: ResolveWeaponHit;
}

export class WeaponPhysical {
  private readonly bus: Bus;
  private readonly cfg: PhysicalWeaponConfig;
  private readonly resolveHit: ResolveWeaponHit;

  private combo = 0;
  private sinceSwing = Number.POSITIVE_INFINITY;
  private swingCooldown = 0;
  private charging = false;
  private charge = 0;

  constructor(deps: WeaponPhysicalDeps) {
    this.bus = deps.bus;
    this.cfg = deps.config;
    this.resolveHit = deps.resolveHit;
  }

  get isCharging(): boolean {
    return this.charging;
  }

  /** 0..1 的蓄力进度 */
  get chargeRatio(): number {
    if (!this.charging) return 0;
    return Math.min(1, this.charge / this.cfg.anchor.chargeSec);
  }

  /** 当前连击段位（0/1/2） */
  get comboIndex(): number {
    return this.combo;
  }

  update(dt: number, input: WeaponInput): AttackOutcome | null {
    if (dt <= 0) return null;

    this.swingCooldown = Math.max(0, this.swingCooldown - dt);
    this.sinceSwing += dt;
    if (!this.charging && this.sinceSwing > this.cfg.melee.comboWindowSec) {
      this.combo = 0;
    }

    if (this.charging) {
      this.charge += dt;
      // 释放：只有蓄满才投出岩锚，提前松手取消
      if (!input.heavyHeld) {
        this.charging = false;
        const full = this.charge >= this.cfg.anchor.chargeSec - 1e-9;
        this.charge = 0;
        return full ? this.fireAnchor() : null;
      }
      return null;
    }

    if (input.heavyPressed) {
      this.charging = true;
      this.charge = 0;
      return null;
    }

    if (input.lightPressed && this.swingCooldown <= 0) {
      return this.swing();
    }

    return null;
  }

  private swing(): AttackOutcome {
    const combo = this.cfg.melee.combo;
    const index = this.combo % combo.length;
    const base = combo[index] ?? 0;
    const hit = this.resolveHit({ kind: 'melee', rangeM: this.cfg.melee.range });

    const outcome: AttackOutcome = {
      kind: 'melee',
      damage: 0,
      isCrit: false,
      target: hit?.target ?? null,
      part: hit?.part,
    };

    if (hit) {
      const result = computeDamage({
        base,
        attr: 'physical',
        resist: hit.resist,
        debuffs: hit.debuffs,
        weakness: hit.weakness,
      });
      outcome.damage = result.amount;
      outcome.isCrit = result.isCrit;
      this.bus.emit('DamageDealt', {
        target: hit.target,
        amount: result.amount,
        attr: 'physical',
        part: hit.part,
        isCrit: result.isCrit,
      });
    }

    if (index === combo.length - 1) {
      outcome.knockback = this.cfg.melee.thirdKnockback;
    }

    this.combo = (index + 1) % combo.length;
    this.sinceSwing = 0;
    this.swingCooldown = this.cfg.melee.swingIntervalSec;
    return outcome;
  }

  private fireAnchor(): AttackOutcome {
    const hit = this.resolveHit({ kind: 'projectile', rangeM: Number.POSITIVE_INFINITY });

    const outcome: AttackOutcome = {
      kind: 'anchor',
      damage: 0,
      isCrit: false,
      target: hit?.target ?? null,
      part: hit?.part,
    };
    if (!hit) return outcome;

    const result = computeDamage({
      base: this.cfg.anchor.damage,
      attr: 'physical',
      resist: hit.resist,
      debuffs: hit.debuffs,
      weakness: hit.weakness,
    });
    outcome.damage = result.amount;
    outcome.isCrit = result.isCrit;
    if (this.cfg.anchor.pullToWeakness && hit.weakness && hit.pos) {
      outcome.pullTo = hit.pos;
    }

    this.bus.emit('DamageDealt', {
      target: hit.target,
      amount: result.amount,
      attr: 'physical',
      part: hit.part,
      isCrit: result.isCrit,
    });
    return outcome;
  }
}
