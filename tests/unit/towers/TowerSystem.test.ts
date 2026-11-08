// tests/unit/towers/TowerSystem.test.ts
// TowerSystem 门面：建 / 升 / 拆 / 耐久 / 阶段 / 淹没 / 死区 / 分发
// 对应票 T-M2-01 的 13 条验收（第 13 条在 BuildMenu.test.ts）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOWER_BEHAVIORS } from '../../../src/towers/kinds/index';
import type { TowerKind } from '../../../src/towers/types';
import {
  arena,
  clearBehaviors,
  installBehavior,
  makeCtx,
  makeSystem,
  slotPos,
  towers,
  type FakeBehavior,
  type Harness,
} from './helpers';

const ALL_KINDS: TowerKind[] = ['ballista', 'rune', 'frost', 'quake', 'totem'];

let h: Harness;
let fake: Record<string, FakeBehavior>;

beforeEach(() => {
  clearBehaviors();
  fake = {};
  for (const kind of ALL_KINDS) fake[kind] = installBehavior(kind);
  h = makeSystem(20261108);
});

afterEach(() => {
  clearBehaviors();
});

// ── 1. 初始塔位 ─────────────────────────────────────────────────────────────
describe('初始塔位', () => {
  it('7 个 open（M1-M4、T1-T3）+ 4 个 locked（E1-E4）', () => {
    const slots = h.sys.slots();
    expect(slots).toHaveLength(11);
    expect(slots.filter((s) => s.state === 'open').map((s) => s.slotId)).toEqual([
      'M1',
      'M2',
      'M3',
      'M4',
      'T1',
      'T2',
      'T3',
    ]);
    expect(slots.filter((s) => s.state === 'locked').map((s) => s.slotId)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
    ]);
    expect(slots.every((s) => s.towerId === null)).toBe(true);
  });

  it('init 时 motes 为 0，list 为空', () => {
    expect(h.sys.motes()).toBe(0);
    expect(h.sys.list()).toEqual([]);
  });
});

// ── 2. B2 未实现时不崩 ──────────────────────────────────────────────────────
describe('B2 行为未实现时', () => {
  it('注册表为空 → place 返回 false 且不发任何事件', () => {
    clearBehaviors();
    const h2 = makeSystem(1);
    expect(TOWER_BEHAVIORS.ballista).toBeUndefined();
    expect(h2.sys.place('M1', 'ballista', 10)).toBe(false);
    expect(h2.rec.names).toEqual([]);
    expect(h2.sys.list()).toEqual([]);
    expect(h2.sys.motes()).toBe(0);
    expect(h2.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('open');
  });

  it('update 在没有塔时是安全空转', () => {
    const h2 = makeSystem(1);
    clearBehaviors();
    expect(() => h2.sys.update(1 / 60, makeCtx())).not.toThrow();
    expect(h2.rec.names).toEqual([]);
  });
});

// ── 3. place 失败路径 ───────────────────────────────────────────────────────
describe('place 失败路径（一律 false + 零事件）', () => {
  it('locked 塔位 → false 且不发任何事件', () => {
    expect(h.sys.place('E1', 'ballista', 10)).toBe(false);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'E1')?.state).toBe('locked');
    expect(h.sys.motes()).toBe(0);
  });

  it('熔核不足 → false，熔核不变，零事件', () => {
    // ballista 造价 3，只有 2
    expect(h.sys.place('M1', 'ballista', 2)).toBe(false);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.motes()).toBe(0);
    expect(h.sys.list()).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('open');
  });

  it('不存在的塔位 → false，零事件', () => {
    expect(h.sys.place('NOPE', 'ballista', 10)).toBe(false);
    expect(h.rec.names).toEqual([]);
  });

  it('未知 kind → false，零事件', () => {
    expect(h.sys.place('M1', 'plasma' as TowerKind, 10)).toBe(false);
    expect(h.rec.names).toEqual([]);
  });

  it('同一塔位重复 place → 第二次 false', () => {
    expect(h.sys.place('M1', 'ballista', 6)).toBe(true);
    h.rec.reset();
    expect(h.sys.place('M1', 'rune', 6)).toBe(false);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.list()).toHaveLength(1);
    expect(h.sys.list()[0]?.kind).toBe('ballista');
  });
});

// ── 4. place 成功路径 ───────────────────────────────────────────────────────
describe('place 成功', () => {
  it('扣熔核 + 发 TowerPlaced / TowerHpChanged / TowerSlotStateChanged，hp === maxHp', () => {
    expect(h.sys.place('M1', 'ballista', 6)).toBe(true);

    // 熔核：6 - 3 = 3
    expect(h.sys.motes()).toBe(3);
    expect(h.rec.of('MoteCountChanged')).toEqual([{ motes: 3 }]);

    const placed = h.rec.of('TowerPlaced');
    expect(placed).toHaveLength(1);
    expect(placed[0].kind).toBe('ballista');
    expect(placed[0].slotId).toBe('M1');
    expect(placed[0].pos).toEqual(slotPos('M1'));
    expect(placed[0].towerId).toMatch(/^M1-ballista-\d+$/);

    const hp = h.rec.of('TowerHpChanged');
    expect(hp).toHaveLength(1);
    expect(hp[0].towerId).toBe(placed[0].towerId);
    expect(hp[0].hp).toBe(towers.kinds.ballista.hp);
    expect(hp[0].maxHp).toBe(towers.kinds.ballista.hp);

    expect(h.rec.of('TowerSlotStateChanged')).toEqual([{ slotId: 'M1', state: 'occupied' }]);

    const view = h.sys.list()[0]!;
    expect(view.level).toBe(1);
    expect(view.hp).toBe(view.maxHp);
    expect(view.investedCost).toBe(3);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.towerId).toBe(placed[0].towerId);
  });

  it('事件顺序：MoteCountChanged → TowerPlaced → TowerHpChanged → TowerSlotStateChanged', () => {
    h.sys.place('M1', 'ballista', 6);
    expect(h.rec.names).toEqual([
      'MoteCountChanged',
      'TowerPlaced',
      'TowerHpChanged',
      'TowerSlotStateChanged',
    ]);
  });

  it('towerId 一局内唯一（同 slot 拆了再建也不同）', () => {
    h.sys.place('M1', 'ballista', 6);
    const first = h.sys.list()[0]!.id;
    h.sys.sell(first);
    h.sys.place('M1', 'ballista', 6);
    const second = h.sys.list()[0]!.id;
    expect(second).not.toBe(first);
  });

  it('不同塔种按各自 config 的 cost / hp 记账', () => {
    const h2 = makeSystem(7);
    expect(h2.sys.place('M1', 'totem', 6)).toBe(true);
    // totem 造价 2，耐久 300
    expect(h2.sys.motes()).toBe(4);
    expect(h2.sys.list()[0]?.maxHp).toBe(towers.kinds.totem.hp);
    expect(h2.sys.list()[0]?.investedCost).toBe(towers.kinds.totem.cost);
  });
});

// ── 5. 升级 ─────────────────────────────────────────────────────────────────
describe('upgrade', () => {
  it('升级花费 = floor(cost * upgradeCostRatio)', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    const expected = Math.floor(towers.kinds.ballista.cost * towers.build.upgradeCostRatio);
    expect(expected).toBe(2);

    h.rec.reset();
    expect(h.sys.upgrade(id, 5)).toBe(true);
    expect(h.sys.motes()).toBe(5 - expected);
    expect(h.rec.of('TowerUpgraded')).toEqual([{ towerId: id, level: 2 }]);
    expect(h.rec.of('MoteCountChanged')).toEqual([{ motes: 5 - expected }]);
    expect(h.sys.list()[0]?.level).toBe(2);
    expect(h.sys.list()[0]?.investedCost).toBe(3 + expected);
  });

  it('升级后耐久回满', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    h.sys.damageTower(id, 500);
    expect(h.sys.list()[0]!.hp).toBe(100);
    h.sys.upgrade(id, 5);
    const v = h.sys.list()[0]!;
    expect(v.hp).toBe(v.maxHp);
  });

  it('到 maxLevel 后不再能升', () => {
    h.sys.place('M1', 'ballista', 20);
    const id = h.sys.list()[0]!.id;
    expect(h.sys.upgrade(id, 20)).toBe(true);
    expect(h.sys.list()[0]?.level).toBe(towers.build.maxLevel);

    h.rec.reset();
    expect(h.sys.upgrade(id, 20)).toBe(false);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.list()[0]?.level).toBe(towers.build.maxLevel);
  });

  it('熔核不足 / 塔不存在 → false 且零事件', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    h.rec.reset();
    expect(h.sys.upgrade(id, 1)).toBe(false);
    expect(h.sys.upgrade('nope', 99)).toBe(false);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.list()[0]?.level).toBe(1);
  });
});

// ── 6. 拆除 ─────────────────────────────────────────────────────────────────
describe('sell', () => {
  it('返还 floor(investedCost * sellRefundRatio)，investedCost 含升级花费', () => {
    h.sys.place('M1', 'ballista', 6); // cost 3 → motes 3
    const id = h.sys.list()[0]!.id;
    h.sys.upgrade(id, 3); // upgrade 2 → motes 1，invested 5

    const invested = h.sys.list()[0]!.investedCost;
    expect(invested).toBe(5);
    const expectedRefund = Math.floor(invested * towers.build.sellRefundRatio);
    expect(expectedRefund).toBe(3);

    h.rec.reset();
    expect(h.sys.sell(id)).toBe(true);
    expect(h.sys.motes()).toBe(1 + expectedRefund);
    expect(h.rec.of('TowerDestroyed')).toEqual([{ towerId: id, reason: 'sold' }]);
    expect(h.rec.of('TowerSlotStateChanged')).toEqual([{ slotId: 'M1', state: 'open' }]);
    expect(h.rec.of('MoteCountChanged')).toEqual([{ motes: 1 + expectedRefund }]);
    expect(h.sys.list()).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('open');
  });

  it('拆除后行为收到 onRemoved 一次', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    expect(fake.ballista.removedCount).toBe(0);
    h.sys.sell(id);
    expect(fake.ballista.removedCount).toBe(1);
  });

  it('不存在的塔 → false 且零事件', () => {
    h.rec.reset();
    expect(h.sys.sell('nope')).toBe(false);
    expect(h.rec.names).toEqual([]);
  });
});

// ── 7. 耐久 ─────────────────────────────────────────────────────────────────
describe('damageTower', () => {
  it('受伤发 TowerHpChanged，hp 单调下降且不为负', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    h.rec.reset();
    h.sys.damageTower(id, 100);
    expect(h.rec.of('TowerHpChanged')).toEqual([
      { towerId: id, hp: towers.kinds.ballista.hp - 100, maxHp: towers.kinds.ballista.hp },
    ]);
    expect(h.sys.list()[0]?.hp).toBe(500);
  });

  it('耐久归零 → TowerDestroyed{reason:broken} + 槽位回 open', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    h.rec.reset();
    h.sys.damageTower(id, 99999);

    const destroyed = h.rec.of('TowerDestroyed');
    expect(destroyed).toEqual([{ towerId: id, reason: 'broken' }]);
    expect(h.rec.of('TowerSlotStateChanged')).toEqual([{ slotId: 'M1', state: 'open' }]);
    expect(h.sys.list()).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('open');
    expect(fake.ballista.removedCount).toBe(1);
  });

  it('塔不存在 / 已归零后再打 → 不再发事件', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    h.sys.damageTower(id, 99999);
    h.rec.reset();
    h.sys.damageTower(id, 100);
    h.sys.damageTower('nope', 100);
    expect(h.rec.names).toEqual([]);
  });

  it('behavior.onDamaged 可覆写伤害（嘲讽图腾减伤）', () => {
    const h2 = makeSystem(3);
    clearBehaviors();
    installBehavior('totem', {
      onDamaged(self): number {
        return self.hp - 10; // 固定只掉 10
      },
    });
    h2.sys.place('M1', 'totem', 6);
    const id = h2.sys.list()[0]!.id;
    h2.sys.damageTower(id, 999);
    expect(h2.sys.list()[0]?.hp).toBe(towers.kinds.totem.hp - 10);
  });
});

// ── 8. 阶段解锁 ─────────────────────────────────────────────────────────────
describe('setPhase', () => {
  it("setPhase('boss2') → 4 个 E 位依次变 open，发 4 条 TowerSlotStateChanged", () => {
    h.rec.reset();
    h.sys.setPhase('boss2');

    expect(h.rec.of('TowerSlotStateChanged')).toEqual([
      { slotId: 'E1', state: 'open' },
      { slotId: 'E2', state: 'open' },
      { slotId: 'E3', state: 'open' },
      { slotId: 'E4', state: 'open' },
    ]);
    const eSlots = h.sys.slots().filter((s) => s.ring === 'outer');
    expect(eSlots.every((s) => s.state === 'open')).toBe(true);
  });

  it('重复 setPhase 不会重复发事件（幂等）', () => {
    h.sys.setPhase('boss2');
    h.rec.reset();
    h.sys.setPhase('boss2');
    h.sys.setPhase('rage');
    expect(h.rec.names).toEqual([]);
  });

  it("'transition' 之后也解锁（阶段 II 起点）", () => {
    h.rec.reset();
    h.sys.setPhase('transition');
    expect(h.rec.of('TowerSlotStateChanged')).toHaveLength(4);
  });

  it('阶段 I 不解锁外环', () => {
    for (const p of ['wake', 'prep', 'boss1'] as const) {
      h.rec.reset();
      h.sys.setPhase(p);
      expect(h.rec.names).toEqual([]);
    }
    expect(h.sys.slots().filter((s) => s.state === 'locked')).toHaveLength(4);
  });

  it('订阅 MatchPhaseChanged 后自动解锁（B3 只发事件）', () => {
    h.rec.reset();
    h.bus.emit('MatchPhaseChanged', { phase: 'boss2', tSec: 145 });
    expect(h.rec.of('TowerSlotStateChanged')).toHaveLength(4);
    expect(h.sys.slots().filter((s) => s.state === 'open')).toHaveLength(11);
  });
});

// ── 9. 熔岩淹没 ─────────────────────────────────────────────────────────────
describe('setLavaY', () => {
  it('y >= drownSlotY → 平地塔位 submerged，其上塔发 TowerDestroyed{reason:drowned}', () => {
    h.sys.place('M1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;
    h.rec.reset();

    h.sys.setLavaY(arena.lava.drownSlotY);

    const drowned = h.rec.of('TowerDestroyed');
    expect(drowned).toEqual([{ towerId: id, reason: 'drowned' }]);
    expect(h.sys.list()).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('submerged');
    // M1-M4 被淹；E1-E4 此时还是 locked（契约：open/occupied → submerged，locked 不参与）
    expect(
      h.sys
        .slots()
        .filter((s) => s.state === 'submerged')
        .map((s) => s.slotId),
    ).toEqual(['M1', 'M2', 'M3', 'M4']);
    // 塔身塔位（y=12）不会被淹
    expect(
      h.sys
        .slots()
        .filter((s) => s.ring === 'tower')
        .every((s) => s.state === 'open'),
    ).toBe(true);
  });

  it('熔岩已涨上来之后才解锁外环 → 直接是 submerged，不会闪 open', () => {
    h.sys.setLavaY(arena.lava.drownSlotY);
    h.rec.reset();
    h.sys.setPhase('boss2');

    const e = h.sys.slots().filter((s) => s.ring === 'outer');
    expect(e.every((s) => s.state === 'submerged')).toBe(true);
    // 每个 E 位只发一条事件，且是 submerged
    expect(h.rec.of('TowerSlotStateChanged')).toEqual([
      { slotId: 'E1', state: 'submerged' },
      { slotId: 'E2', state: 'submerged' },
      { slotId: 'E3', state: 'submerged' },
      { slotId: 'E4', state: 'submerged' },
    ]);
  });

  it('y 低于 drownSlotY 时什么都不发生', () => {
    h.sys.place('M1', 'ballista', 6);
    h.rec.reset();
    h.sys.setLavaY(arena.lava.drownSlotY - 0.01);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('occupied');
  });

  it('被淹塔位不能再建，也不再重复发 drowned', () => {
    h.sys.place('M1', 'ballista', 6);
    h.sys.setLavaY(arena.lava.drownSlotY);
    h.rec.reset();

    expect(h.sys.place('M1', 'ballista', 99)).toBe(false);
    h.sys.setLavaY(arena.lava.drownSlotY + 1);
    expect(h.rec.names).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('submerged');
  });

  it('塔身塔位（y=12）在 drownSlotY 高度不会被淹', () => {
    h.sys.place('T1', 'ballista', 6);
    h.rec.reset();
    h.sys.setLavaY(arena.lava.drownSlotY);
    // 只会有 M1-M4 的槽位事件，T1 不产生任何事件
    expect(h.rec.of('TowerSlotStateChanged').map((p) => p.slotId)).toEqual([
      'M1',
      'M2',
      'M3',
      'M4',
    ]);
    expect(h.rec.of('TowerDestroyed')).toEqual([]);
    expect(h.sys.slots().find((s) => s.slotId === 'T1')?.state).toBe('occupied');
    expect(h.sys.list()).toHaveLength(1);
  });

  it('订阅 LavaLevelChanged 后自动淹没（B3 只发事件）', () => {
    h.sys.place('M1', 'ballista', 6);
    h.rec.reset();
    h.bus.emit('LavaLevelChanged', { y: arena.lava.drownSlotY, risePerSec: 0 });
    expect(h.rec.of('TowerDestroyed')).toHaveLength(1);
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('submerged');
  });

  it('非有限值不会崩也不会改状态', () => {
    h.rec.reset();
    expect(() => h.sys.setLavaY(Number.NaN)).not.toThrow();
    expect(h.rec.names).toEqual([]);
  });
});

// ── 10. 仰角死区 ────────────────────────────────────────────────────────────
describe('仰角死区（塔身塔位）', () => {
  it('Boss 水平距 < 4 m 时塔身塔位不产生 TowerTargetHit', () => {
    h.sys.place('T1', 'ballista', 6);
    const id = h.sys.list()[0]!.id;

    // 先跑够 buildSec 让塔建完
    h.sys.update(1, makeCtx({ boss: { ...makeCtx().boss, pos: [0, 0, 50] } }));
    expect(fake.ballista.placedCount).toBe(1);
    expect(id).toMatch(/^T1-ballista-/);

    // Boss 贴塔基：T1 在 [7.6,12,0]，Boss 在 [7.6,0,0] → 水平距 0
    h.rec.reset();
    h.sys.update(1 / 60, makeCtx({ boss: { ...makeCtx().boss, pos: [7.6, 0, 0] } }));
    expect(h.rec.of('TowerTargetHit')).toEqual([]);
    // 行为确实被调用过，只是 canFire 被关掉
    expect(fake.ballista.updates.at(-1)?.canFire).toBe(false);
  });

  it('Boss 水平距 >= 4 m 时塔身塔位正常命中', () => {
    h.sys.place('T1', 'ballista', 6);
    h.sys.update(1, makeCtx({ boss: { ...makeCtx().boss, pos: [0, 0, 50] } }));

    h.rec.reset();
    h.sys.update(1 / 60, makeCtx({ boss: { ...makeCtx().boss, pos: [7.6, 0, 4.1] } }));
    expect(h.rec.of('TowerTargetHit')).toHaveLength(1);
    expect(fake.ballista.updates.at(-1)?.canFire).toBe(true);
  });

  it('中环塔位（ring=mid）不受死区影响，即使 Boss 贴在塔位上', () => {
    h.sys.place('M1', 'ballista', 6);
    h.sys.update(1, makeCtx({ boss: { ...makeCtx().boss, pos: [20, 0, 0] } }));

    h.rec.reset();
    h.sys.update(1 / 60, makeCtx({ boss: { ...makeCtx().boss, pos: [20, 0, 0] } }));
    expect(h.rec.of('TowerTargetHit')).toHaveLength(1);
    expect(fake.ballista.updates.at(-1)?.canFire).toBe(true);
  });

  it('死区在拦截层吞掉 TowerTargetHit（行为即使无视 canFire 也打不出去）', () => {
    clearBehaviors();
    installBehavior('ballista', {
      update(self): void {
        // 故意无视 ctx.canFire，强行开火
        self.bus.emit('TowerTargetHit', {
          towerId: self.id,
          kind: self.kind,
          attr: 'physical',
          amount: 1,
        });
      },
    });
    const h2 = makeSystem(11);
    h2.sys.place('T1', 'ballista', 6);
    h2.sys.update(1, makeCtx({ boss: { ...makeCtx().boss, pos: [7.6, 0, 0] } }));
    h2.rec.reset();
    h2.sys.update(1 / 60, makeCtx({ boss: { ...makeCtx().boss, pos: [7.6, 0, 0] } }));
    expect(h2.rec.of('TowerTargetHit')).toEqual([]);

    // 同一座塔，Boss 拉开距离后就能打出去（证明拦截只由距离决定）
    h2.rec.reset();
    h2.sys.update(1 / 60, makeCtx({ boss: { ...makeCtx().boss, pos: [7.6, 0, 20] } }));
    expect(h2.rec.of('TowerTargetHit')).toHaveLength(1);
  });

  it('canFire=false 时任何塔都不开火（阶段未开始）', () => {
    h.sys.place('M1', 'ballista', 6);
    h.sys.update(1, makeCtx());
    h.rec.reset();
    h.sys.update(1 / 60, makeCtx({ canFire: false }));
    expect(h.rec.of('TowerTargetHit')).toEqual([]);
  });
});

// ── 11. update 分发 ─────────────────────────────────────────────────────────
describe('update 分发', () => {
  it('buildSec 期间不调 behavior.update，建完后调 onPlaced 一次', () => {
    h.sys.place('M1', 'ballista', 6);
    expect(fake.ballista.placedCount).toBe(0);

    // buildSec = 0.5；先跑 0.25 s 还没建完
    h.sys.update(0.25, makeCtx());
    expect(fake.ballista.updates).toHaveLength(0);
    expect(fake.ballista.placedCount).toBe(0);

    // 再跑 0.3 s → 建完，本帧就开始 update
    h.sys.update(0.3, makeCtx());
    expect(fake.ballista.placedCount).toBe(1);
    expect(fake.ballista.updates).toHaveLength(1);

    // 后续帧不再重复 onPlaced
    h.sys.update(0.1, makeCtx());
    expect(fake.ballista.placedCount).toBe(1);
    expect(fake.ballista.updates).toHaveLength(2);
  });

  it('多塔各自分发到自己的行为，dtSec 原样透传', () => {
    h.sys.place('M1', 'ballista', 30);
    h.sys.place('M2', 'rune', 30);
    h.sys.update(0.6, makeCtx({ dtSec: 0.6 }));

    expect(fake.ballista.updates).toHaveLength(1);
    expect(fake.rune.updates).toHaveLength(1);
    expect(fake.ballista.updates[0]?.dtSec).toBeCloseTo(0.6);
    expect(fake.rune.updates[0]?.dtSec).toBeCloseTo(0.6);
    // 其它塔的行为没被误调
    expect(fake.frost.updates).toHaveLength(0);
  });

  it('ctx 的 boss / player / core 字段被完整透传', () => {
    h.sys.place('M1', 'ballista', 6);
    h.sys.update(1, makeCtx({ dtSec: 1 }));
    const ctx = fake.ballista.updates.at(-1)!;
    expect(ctx.boss.pos).toEqual([20, 0, 0]);
    expect(ctx.playerPos).toEqual([0, 0, 8]);
    expect(ctx.corePos).toEqual([0, 0, 0]);
    expect(ctx.boss.weakness).toBeNull();
    expect(ctx.boss.taunted).toBe(false);
  });

  it('TowerRuntime 的 state / cfg / rng / bus 对行为可用', () => {
    clearBehaviors();
    let seen: Record<string, unknown> = {};
    installBehavior('ballista', {
      update(self): void {
        seen = {
          kind: self.kind,
          slotId: self.slotId,
          cfgCost: self.cfg.cost,
          rng: typeof self.rng,
          busEmit: typeof self.bus.emit,
          stateWritable: (self.state.probe = 1),
        };
      },
    });
    const h2 = makeSystem(5);
    h2.sys.place('M1', 'ballista', 6);
    h2.sys.update(1, makeCtx());
    expect(seen.kind).toBe('ballista');
    expect(seen.slotId).toBe('M1');
    expect(seen.cfgCost).toBe(towers.kinds.ballista.cost);
    expect(seen.rng).toBe('function');
    expect(seen.busEmit).toBe('function');
    expect(seen.stateWritable).toBe(1);
  });

  it('行为在 update 里卖塔不会打乱迭代', () => {
    clearBehaviors();
    const holder: { sys: typeof h.sys | null } = { sys: null };
    let sold = false;
    installBehavior('ballista', {
      update(self): void {
        if (!sold && holder.sys) {
          sold = true;
          holder.sys.sell(self.id);
        }
      },
    });
    const h2 = makeSystem(9);
    holder.sys = h2.sys;
    h2.sys.place('M1', 'ballista', 6);
    h2.sys.place('M2', 'ballista', 6);
    h2.sys.update(1, makeCtx());
    expect(sold).toBe(true);
    expect(h2.sys.list()).toHaveLength(1);
    expect(() => h2.sys.update(1 / 60, makeCtx())).not.toThrow();
  });

  it('未初始化时 update 是安全空转', () => {
    const h2 = makeSystem(1);
    h2.sys.dispose();
    expect(() => h2.sys.update(1 / 60, makeCtx())).not.toThrow();
  });
});

// ── 12. menu ────────────────────────────────────────────────────────────────
describe('menu', () => {
  it('空塔位返回 5 个选项，数值来自 config', () => {
    const menu = h.sys.menu('M1', 6);
    expect(menu.slotId).toBe('M1');
    expect(menu.options).toHaveLength(5);
    expect(menu.options.every((o) => o.affordable)).toBe(true);
  });

  it('熔核不足时 affordable: false', () => {
    const menu = h.sys.menu('M1', 1);
    expect(menu.options.every((o) => o.affordable === false)).toBe(true);
  });

  it('locked / 已占用 / 已淹没 塔位不提供选项', () => {
    expect(h.sys.menu('E1', 99).options).toEqual([]);
    h.sys.place('M1', 'ballista', 6);
    expect(h.sys.menu('M1', 99).options).toEqual([]);
    h.sys.setLavaY(arena.lava.drownSlotY);
    expect(h.sys.menu('M2', 99).options).toEqual([]);
  });

  it('slotId 为 null 时菜单关闭', () => {
    const menu = h.sys.menu(null, 6);
    expect(menu.slotId).toBeNull();
    expect(menu.options).toEqual([]);
  });
});

// ── 13. 外部改不动内部状态 ──────────────────────────────────────────────────
describe('视图隔离', () => {
  it('list() / slots() 返回副本，改它不影响系统', () => {
    h.sys.place('M1', 'ballista', 6);
    const list = h.sys.list();
    (list[0] as { hp: number }).hp = -1;
    (list[0] as { level: number }).level = 99;
    expect(h.sys.list()[0]?.hp).toBe(towers.kinds.ballista.hp);
    expect(h.sys.list()[0]?.level).toBe(1);

    const slots = h.sys.slots();
    (slots.find((s) => s.slotId === 'M1') as { state: string }).state = 'locked';
    expect(h.sys.slots().find((s) => s.slotId === 'M1')?.state).toBe('occupied');
  });

  it('重复 init 会重置全部状态', () => {
    h.sys.place('M1', 'ballista', 6);
    h.sys.setPhase('boss2');
    h.sys.init({ bus: h.bus, rng: () => 0.5, towersCfg: towers, arenaCfg: arena });

    expect(h.sys.list()).toEqual([]);
    expect(h.sys.motes()).toBe(0);
    expect(h.sys.slots().filter((s) => s.state === 'locked')).toHaveLength(4);
  });
});
