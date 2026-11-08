import { describe, expect, it } from 'vitest';
import { hasBehavior, TOWER_BEHAVIORS } from '../../../../src/towers/kinds';
import { TOWER_KINDS } from '../../../../src/towers/types';
import type { TowerKind } from '../../../../src/towers/types';

describe('kinds 注册表', () => {
  it('五种塔全部登记', () => {
    for (const kind of TOWER_KINDS) {
      expect(hasBehavior(kind)).toBe(true);
      expect(TOWER_BEHAVIORS[kind]?.kind).toBe(kind);
    }
  });

  it('kind 字段与键一致，属性不越界', () => {
    for (const kind of TOWER_KINDS) {
      const b = TOWER_BEHAVIORS[kind];
      expect(b).toBeDefined();
      expect(['arcane', 'physical', 'none']).toContain(b!.attr);
      expect(b!.cost).toBeGreaterThan(0);
      expect(b!.range).toBeGreaterThan(0);
      expect(b!.maxHp).toBeGreaterThan(0);
    }
  });

  it('未实现的 kind 返回 false（B1 的 place 靠它兜底）', () => {
    expect(hasBehavior('not-a-kind' as TowerKind)).toBe(false);
  });

  it('每个行为都有 update 且能空跑不抛', () => {
    for (const kind of TOWER_KINDS) {
      const b = TOWER_BEHAVIORS[kind]!;
      expect(typeof b.update).toBe('function');
      expect(() =>
        b.update(
          {
            id: `${kind}-1`,
            kind,
            slotId: 's1',
            pos: [0, 0, 0],
            level: 1,
            hp: b.maxHp,
            maxHp: b.maxHp,
            investedCost: b.cost,
            cooldownSec: 0,
            state: {},
            bus: {
              on: () => () => {},
              emit: () => {},
              snapshot: () => ({}) as never,
              __setSnapshot: () => {},
            },
            rng: () => 0.5,
            cfg: {
              name: kind,
              attr: b.attr,
              cost: b.cost,
              range: b.range,
              damage: 0,
              intervalSec: 1,
              hp: b.maxHp,
              special: 'none',
            },
          },
          {
            dtSec: 1 / 60,
            canFire: true,
            boss: {
              pos: [0, 0, 0],
              weakness: null,
              weaknessAttr: null,
              castingSkill: null,
              taunted: false,
            },
            playerPos: [0, 0, 0],
            corePos: [0, 0, 0],
          },
        ),
      ).not.toThrow();
    }
  });
});
