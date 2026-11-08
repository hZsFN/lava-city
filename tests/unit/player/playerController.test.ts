import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import {
  PlayerController,
  type Aabb,
  type PlayerConfig,
  type PlayerInput,
  type PlayerWorld,
} from '../../../src/player/PlayerController';

const DT = 1 / 60;

// 注意：PlayerConfig 已由 P2-A 统一为嵌套结构（physics / movement / hp），
// 与 config/player.json 完全一致。原测试用的扁平字段已不匹配，此处同步更新。
const cfg: PlayerConfig = {
  physics: { gravity: -14, snapToGround: 0.45 },
  movement: {
    moveSpeed: 6.5,
    sprintSpeed: 11,
    dashIFramesSec: 0.25,
    dashCooldownSec: 0.8,
    jumpHeight: 1.2,
    radius: 0.35,
    height: 1.8,
  },
  hp: { maxHp: 100, hitInvulnerableSec: 1.2 },
};

const floor = (minZ = -20, maxZ = 20, top = 0): Aabb => ({
  minX: -20,
  maxX: 20,
  minY: top - 0.5,
  maxY: top,
  minZ,
  maxZ,
});

const world: PlayerWorld = { colliders: [floor()], lavaY: -10 };

const idle = (over: Partial<PlayerInput> = {}): PlayerInput => ({
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  jump: false,
  dash: false,
  ...over,
});

function make(
  opts: {
    world?: PlayerWorld;
    spawn?: [number, number, number];
    hp?: { current: number; max: number };
  } = {},
) {
  const bus = createBus();
  const events: Array<{ name: keyof Events; payload: unknown }> = [];
  const names: Array<keyof Events> = [
    'PlayerSpawned',
    'PlayerMoved',
    'PlayerDamaged',
    'PlayerDied',
    'PlayerDashed',
    'PlayerRespawned',
  ];
  for (const n of names) {
    (bus.on as <K extends keyof Events>(k: K, fn: (p: Events[K]) => void) => () => void)(
      n,
      (payload) => events.push({ name: n, payload }),
    );
  }
  const player = new PlayerController({
    bus,
    config: cfg,
    world: opts.world ?? world,
    spawn: opts.spawn ?? [0, 0, 0],
    hp: opts.hp,
  });
  return { bus, player, events };
}

const countOf = (events: Array<{ name: keyof Events }>, name: keyof Events) =>
  events.filter((e) => e.name === name).length;

function run(player: PlayerController, frames: number, input: PlayerInput = idle()): void {
  for (let i = 0; i < frames; i += 1) player.update(DT, input);
}

describe('PlayerController · 出生与移动', () => {
  it('出生发布 PlayerSpawned 并写入快照', () => {
    const { player, events, bus } = make({ spawn: [1, 2, 3] });
    expect(countOf(events, 'PlayerSpawned')).toBe(1);
    expect(player.pos).toEqual([1, 2, 3]);
    expect(player.currentHp).toBe(100);
    expect(bus.snapshot().player.pos).toEqual([1, 2, 3]);
  });

  it('PlayerMoved / PlayerDamaged 由 M0 总线自动同步进快照', () => {
    const { player, bus } = make();
    run(player, 1, idle({ moveZ: 1 }));
    expect(bus.snapshot().player.pos[2]).toBeCloseTo(-6.5 * DT, 3);
    player.takeDamage(30, 'boss');
    expect(bus.snapshot().player.hp).toBe(70);
    expect(bus.snapshot().player.maxHp).toBe(100);
  });

  it('重力下落并停在平台顶面', () => {
    const { player } = make({ spawn: [0, 3, 0] });
    run(player, 120);
    expect(player.isGrounded).toBe(true);
    expect(player.pos[1]).toBeCloseTo(0, 3);
  });

  it('按 yaw 前进（0 面向 -Z）', () => {
    const { player } = make();
    run(player, 30, idle({ moveZ: 1 }));
    expect(player.pos[2]).toBeCloseTo(-6.5 * 30 * DT, 2);
    expect(player.pos[0]).toBeCloseTo(0, 3);
  });

  it('斜向输入被归一化，速度不超过移速', () => {
    const { player } = make();
    run(player, 60, idle({ moveZ: 1, moveX: 1 }));
    const dist = Math.hypot(player.pos[0], player.pos[2]);
    expect(dist).toBeCloseTo(6.5 * 60 * DT, 1);
  });

  it('dt=0 时不移动、不发 PlayerMoved', () => {
    const { player, events } = make();
    player.update(0, idle({ moveZ: 1 }));
    expect(countOf(events, 'PlayerMoved')).toBe(0);
    expect(player.pos).toEqual([0, 0, 0]);
  });
});

describe('PlayerController · 跳跃与台阶', () => {
  it('跳跃高度接近 config 的 1.2 m，落回地面', () => {
    const { player } = make();
    run(player, 10, idle());
    expect(player.isGrounded).toBe(true);
    player.update(DT, idle({ jump: true }));
    let peak = 0;
    for (let i = 0; i < 120; i += 1) {
      player.update(DT, idle());
      peak = Math.max(peak, player.pos[1]);
    }
    expect(peak).toBeGreaterThan(1.0);
    expect(peak).toBeLessThan(1.35);
    expect(player.isGrounded).toBe(true);
    expect(player.pos[1]).toBeCloseTo(0, 3);
  });

  it('按住跳跃键不会在空中连跳', () => {
    const { player } = make();
    run(player, 10, idle());
    let peak = 0;
    for (let i = 0; i < 120; i += 1) {
      player.update(DT, idle({ jump: true }));
      peak = Math.max(peak, player.pos[1]);
    }
    expect(peak).toBeLessThan(1.35);
  });

  it('上升撞头时被顶面截断', () => {
    const ceiling: Aabb = { minX: -10, maxX: 10, minY: 2.9, maxY: 3.5, minZ: -10, maxZ: 10 };
    const { player } = make({ world: { colliders: [floor(), ceiling], lavaY: -10 } });
    run(player, 10, idle());
    player.update(DT, idle({ jump: true }));
    let peak = 0;
    for (let i = 0; i < 120; i += 1) {
      player.update(DT, idle());
      peak = Math.max(peak, player.pos[1]);
    }
    expect(peak).toBeLessThanOrEqual(2.9 - 1.8 + 1e-3);
    expect(player.pos[1]).toBeCloseTo(0, 3);
  });

  it('走下 0.2 m 台阶时吸附，不进入下落状态', () => {
    const upper = floor(0, 20, 0);
    const lower = floor(-20, 0, -0.2);
    const { player } = make({ world: { colliders: [upper, lower], lavaY: -10 }, spawn: [0, 0, 0.5] });
    run(player, 40, idle({ moveZ: 1 }));
    expect(player.pos[2]).toBeLessThan(-0.5);
    expect(player.isGrounded).toBe(true);
    expect(player.pos[1]).toBeCloseTo(-0.2, 3);
  });

  it('走出平台边缘会下落，但落到熔岩面就被托住', () => {
    const { player } = make({ world: { colliders: [floor(0, 20)], lavaY: -10 }, spawn: [0, 0, 1] });
    run(player, 90, idle({ moveZ: 1 }));
    // 熔岩不致死，掉到 lavaY 以下就被拉回 y=0
    expect(player.pos[1]).toBeGreaterThanOrEqual(-10);
  });
});

describe('PlayerController · 碰撞', () => {
  it('墙体阻挡横向移动', () => {
    const wall: Aabb = { minX: 2, maxX: 3, minY: 0, maxY: 3, minZ: -5, maxZ: 5 };
    const { player } = make({ world: { colliders: [floor(), wall], lavaY: -10 } });
    run(player, 60, idle({ moveX: 1 }));
    expect(player.pos[0]).toBeCloseTo(2 - 0.35, 2);
  });

  it('墙体阻挡前后移动（z 轴正反方向）', () => {
    const front: Aabb = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: -3, maxZ: -2 };
    const back: Aabb = { minX: -5, maxX: 5, minY: 0, maxY: 3, minZ: 2, maxZ: 3 };
    const w: PlayerWorld = { colliders: [floor(), front, back], lavaY: -10 };

    const a = make({ world: w });
    run(a.player, 60, idle({ moveZ: 1 }));
    expect(a.player.pos[2]).toBeCloseTo(-2 + 0.35, 2);

    const b = make({ world: w });
    run(b.player, 60, idle({ moveZ: -1 }));
    expect(b.player.pos[2]).toBeCloseTo(2 - 0.35, 2);
  });
});

describe('PlayerController · 冲刺', () => {
  it('冲刺发布 PlayerDashed，方向为归一化世界向量', () => {
    const { player, events } = make();
    player.update(DT, idle({ moveZ: 1, dash: true }));
    const dash = events.find((e) => e.name === 'PlayerDashed')?.payload as { dir: number[] };
    expect(dash.dir[0]).toBeCloseTo(0, 6);
    expect(dash.dir[1]).toBe(0);
    expect(dash.dir[2]).toBeCloseTo(-1, 6);
    expect(player.isDashing).toBe(true);
  });

  it('无方向输入时沿视线前冲', () => {
    const { player, events } = make();
    player.update(DT, idle({ yaw: Math.PI / 2, dash: true }));
    const dash = events.find((e) => e.name === 'PlayerDashed')?.payload as { dir: number[] };
    expect(dash.dir[0]).toBeCloseTo(-1, 6);
    expect(dash.dir[2]).toBeCloseTo(0, 6);
  });

  it('冲刺期间速度 11 m/s，持续时间 0.25 s', () => {
    const { player } = make();
    for (let i = 0; i < 15; i += 1) player.update(DT, idle({ moveZ: 1, dash: i === 0 }));
    expect(player.pos[2]).toBeCloseTo(-11 * 15 * DT, 2);
    // 第 16 帧起冲刺结束
    player.update(DT, idle());
    expect(player.isDashing).toBe(false);
  });

  it('冲刺全程无敌，结束后可受击', () => {
    const { player, events } = make();
    player.update(DT, idle({ dash: true }));
    expect(player.isInvulnerable).toBe(true);
    expect(player.takeDamage(20, 'boss')).toBe(0);
    expect(countOf(events, 'PlayerDamaged')).toBe(0);

    run(player, 20, idle());
    expect(player.isInvulnerable).toBe(false);
    expect(player.takeDamage(20, 'boss')).toBe(20);
    expect(player.currentHp).toBe(80);
  });

  it('冷却期内不能再次冲刺，冷却结束后可以', () => {
    const { player, events } = make();
    player.update(DT, idle({ dash: true }));
    player.update(DT, idle());
    player.update(DT, idle({ dash: true }));
    expect(countOf(events, 'PlayerDashed')).toBe(1);

    run(player, 50, idle());
    player.update(DT, idle({ dash: true }));
    expect(countOf(events, 'PlayerDashed')).toBe(2);
  });
});

describe('PlayerController · HP / 死亡 / 复活', () => {
  it('受击扣血并发布 PlayerDamaged', () => {
    const { player, events } = make();
    expect(player.takeDamage(30, 'boss')).toBe(30);
    expect(player.currentHp).toBe(70);
    const hit = events.find((e) => e.name === 'PlayerDamaged')?.payload as Events['PlayerDamaged'];
    expect(hit).toEqual({ amount: 30, hp: 70, maxHp: 100, source: 'boss' });
  });

  it('入口血量取自注入值，不写死 100', () => {
    const { player } = make({ hp: { current: 1, max: 150 } });
    expect(player.currentHp).toBe(1);
    // 塔心抗性（0.01/次）：1 血不会被一发命中带走
    expect(player.takeHit('boss')).toBeCloseTo(0.01, 10);
    expect(player.currentHp).toBeCloseTo(0.99, 10);
    expect(player.isDead).toBe(false);
  });

  it('Boss 命中扣 0.01 点（塔心抗性），受击后 1.2 s 内不能再次受击', () => {
    const { player, events } = make({ hp: { current: 10, max: 10 } });
    expect(player.takeHit('boss')).toBeCloseTo(0.01, 10);
    expect(player.currentHp).toBeCloseTo(9.99, 10);
    expect(player.isInvulnerable).toBe(true);
    // 无敌期内再来一次应被忽略
    expect(player.takeHit('boss')).toBe(0);
    expect(player.currentHp).toBeCloseTo(9.99, 10);
    // 1.2 s 后恢复可受击
    run(player, 72, idle());
    expect(player.isInvulnerable).toBe(false);
    expect(player.takeHit('boss')).toBeCloseTo(0.01, 10);
    expect(player.currentHp).toBeCloseTo(9.98, 10);
    expect(countOf(events, 'PlayerDamaged')).toBe(2);
  });

  it('入口血量为 0 时首帧判死', () => {
    const { player, events } = make({ hp: { current: 0, max: 100 } });
    player.update(DT, idle());
    expect(player.isDead).toBe(true);
    expect(countOf(events, 'PlayerDied')).toBe(1);
  });

  it('HP 归零发布 PlayerDied，之后不再移动、不再受击', () => {
    const { player, events } = make();
    player.takeDamage(250, 'boss');
    expect(player.isDead).toBe(true);
    expect(player.currentHp).toBe(0);
    const died = events.find((e) => e.name === 'PlayerDied')?.payload as Events['PlayerDied'];
    expect(died).toEqual({ cause: 'boss', deaths: 1 });
    expect(player.takeDamage(10, 'boss')).toBe(0);
    player.update(DT, idle({ moveZ: 1 }));
    expect(player.pos[2]).toBe(0);
  });

  it('kill 幂等，不重复计死亡次数', () => {
    const { player, events } = make();
    player.kill('lava');
    player.kill('lava');
    expect(player.deathCount).toBe(1);
    expect(countOf(events, 'PlayerDied')).toBe(1);
  });

  it('落入熔岩不再致死，人被托回地面', () => {
    const { player, events } = make({ world: { colliders: [], lavaY: 0 }, spawn: [0, 2, 0] });
    for (let i = 0; i < 120; i += 1) player.update(DT, idle());
    // 2026-11-08 规则变更：熔岩不结束本局，掉下去直接托回平台
    expect(player.isDead).toBe(false);
    expect(events.some((e) => e.name === 'PlayerDied')).toBe(false);
    expect(player.pos[1]).toBeGreaterThan(-0.01);
  });
});
