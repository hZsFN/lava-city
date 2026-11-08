// src/game/CombatController.ts
// ============================================================================
// 整合层 · 玩家战斗编排
// ----------------------------------------------------------------------------
// 把 FormSwitch / WeaponPhysical / WeaponMagic 串起来：
//   · Q 切形态（0.5 s 内禁止攻击）
//   · 当前形态的左右键输入路由到对应武器
//   · 命中结果按方案一交给 applyBoss（Boss 自己算倍率/抗性并扣血）
// 只做编排，不实现任何伤害公式。
// ============================================================================

import type { Bus } from '../core/events';
import { FormSwitch, type FormSwitchConfig } from '../player/FormSwitch';
import { WeaponPhysical } from '../player/WeaponPhysical';
import { WeaponMagic } from '../player/WeaponMagic';
import type {
  AttackOutcome,
  MagicWeaponConfig,
  PhysicalWeaponConfig,
  ResolveWeaponHit,
  WeaponInput,
} from '../player/weaponTypes';

const NO_INPUT: WeaponInput = {
  lightPressed: false,
  lightHeld: false,
  heavyPressed: false,
  heavyHeld: false,
};

export interface CombatConfig {
  formSwitch: FormSwitchConfig;
  physical: PhysicalWeaponConfig;
  magic: MagicWeaponConfig;
}

export interface CombatDeps {
  bus: Bus;
  config: CombatConfig;
  /** 命中判定：由渲染/整合层用 three 射线实现 */
  resolveHit: ResolveWeaponHit;
  /** 把基础伤害交给 Boss 结算（方案一：倍率/抗性归 Boss） */
  applyBoss: (outcome: AttackOutcome) => void;
}

export interface CombatInput {
  weapon: WeaponInput;
  /** 本帧按了 Q（边沿） */
  toggleForm: boolean;
}

export class CombatController {
  readonly form: FormSwitch;
  private readonly physical: WeaponPhysical;
  private readonly magic: WeaponMagic;
  private readonly applyBoss: (outcome: AttackOutcome) => void;

  constructor(deps: CombatDeps) {
    this.form = new FormSwitch({ bus: deps.bus, config: deps.config.formSwitch });
    this.physical = new WeaponPhysical({
      config: deps.config.physical,
      resolveHit: deps.resolveHit,
    });
    this.magic = new WeaponMagic({
      bus: deps.bus,
      config: deps.config.magic,
      resolveHit: deps.resolveHit,
    });
    this.applyBoss = deps.applyBoss;
  }

  /** 推进一个固定逻辑步；返回本步产生的攻击结果（供表现层做特效） */
  update(dt: number, input: CombatInput): AttackOutcome[] {
    this.form.update(dt, input.toggleForm);

    const weaponInput = this.form.canAttack ? input.weapon : NO_INPUT;
    const weapon = this.form.form === 'physical' ? this.physical : this.magic;
    const outcome = weapon.update(dt, weaponInput);
    if (!outcome) return [];

    if (outcome.target === 'boss') this.applyBoss(outcome);
    return [outcome];
  }
}
