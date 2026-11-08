import { describe, expect, it } from 'vitest';
import {
  ProjectileSystem,
  type ProjectileConfig,
  type ProjectileHit,
  type ProjectileWorld,
  type LiveProjectile,
} from '../../../src/combat/Projectiles';

const DT = 1 / 60;

const cfg: ProjectileConfig = {
  maxActive: 2,
  spark: { speedMps: 40, lifetimeSec: 1.2, radiusM: 0.15 },
  anchor: { speedMps: 25, lifetimeSec: 2, radiusM: 0.3 },
};

const missWorld: ProjectileWorld = { sweep: () => null };

function make(world: ProjectileWorld = missWorld) {
  const hits: Array<{ p: LiveProjectile; hit: ProjectileHit }> = [];
  const expiries: LiveProjectile[] = [];
  const system = new ProjectileSystem({
    world,
    config: cfg,
    onHit: (p, hit) => hits.push({ p, hit }),
    onExpire: (p) => expiries.push(p),
  });
  return { system, hits, expiries };
}

const spark = (over: Partial<Parameters<ProjectileSystem['spawn']>[0]> = {}) => ({
  kind: 'spark' as const,
  pos: [0, 0, 0] as const,
  dir: [0, 0, -1] as const,
  damage: 12,
  attr: 'arcane' as const,
  ...over,
});

describe('Projectiles · 飞行与生命周期', () => {
  it('按速度沿方向推进', () => {
    const { system } = make();
    system.spawn(spark());
    system.update(DT);
    expect(system.active[0].pos[2]).toBeCloseTo(-40 / 60, 6);
    expect(system.active[0].pos[1]).toBe(0);
  });

  it('方向自动归一化，速度不受长度影响', () => {
    const { system } = make();
    system.spawn(spark({ dir: [0, 0, -100] }));
    system.update(DT);
    expect(system.active[0].pos[2]).toBeCloseTo(-40 / 60, 6);
  });

  it('零向量方向回落到正前方', () => {
    const { system } = make();
    system.spawn(spark({ dir: [0, 0, 0] }));
    system.update(DT);
    expect(system.active[0].pos[2]).toBeCloseTo(-40 / 60, 6);
  });

  it('命中后回调并移出池子', () => {
    const world: ProjectileWorld = {
      sweep: (_from, to) => (to[2] <= -1 ? { target: 'boss', pos: [0, 0, -1] } : null),
    };
    const { system, hits } = make(world);
    system.spawn(spark());
    system.update(DT); // z = -0.667
    expect(hits).toHaveLength(0);
    system.update(DT); // z = -1.333 → 命中
    expect(hits).toHaveLength(1);
    expect(hits[0].hit.target).toBe('boss');
    expect(hits[0].p.damage).toBe(12);
    expect(system.count).toBe(0);
  });

  it('扫掠参数包含上一帧位置、当前位置与半径', () => {
    const calls: Array<{ from: readonly number[]; to: readonly number[]; r: number }> = [];
    const world: ProjectileWorld = {
      sweep: (from, to, radiusM) => {
        calls.push({ from, to, r: radiusM });
        return null;
      },
    };
    const { system } = make(world);
    system.spawn(spark());
    system.update(DT);
    expect(calls[0].from[2]).toBeCloseTo(0, 6);
    expect(calls[0].to[2]).toBeCloseTo(-40 / 60, 6);
    expect(calls[0].r).toBeCloseTo(0.15);
  });

  it('超时未命中触发 onExpire', () => {
    const { system, expiries, hits } = make();
    system.spawn(spark());
    for (let i = 0; i < 72; i += 1) system.update(DT);
    expect(hits).toHaveLength(0);
    expect(expiries).toHaveLength(1);
    expect(system.count).toBe(0);
  });

  it('岩锚使用自己的速度与半径', () => {
    const { system } = make();
    system.spawn(spark({ kind: 'anchor', damage: 80, attr: 'physical' }));
    const p = system.active[0];
    expect(p.speedMps).toBe(25);
    expect(p.radiusM).toBeCloseTo(0.3);
    system.update(DT);
    expect(p.pos[2]).toBeCloseTo(-25 / 60, 6);
  });

  it('dt=0 不推进', () => {
    const { system } = make();
    system.spawn(spark());
    system.update(0);
    expect(system.active[0].pos[2]).toBe(0);
    expect(system.active[0].ttlSec).toBeCloseTo(1.2);
  });
});

describe('Projectiles · 对象池', () => {
  it('池满拒绝生成', () => {
    const { system } = make();
    expect(system.spawn(spark())).not.toBeNull();
    expect(system.spawn(spark({ dir: [1, 0, 0] }))).not.toBeNull();
    expect(system.spawn(spark({ dir: [0, 0, 1] }))).toBeNull();
    expect(system.count).toBe(2);
  });

  it('释放后可以复用位置', () => {
    const { system } = make();
    system.spawn(spark());
    system.spawn(spark());
    expect(system.spawn(spark())).toBeNull();
    system.clear();
    expect(system.spawn(spark())).not.toBeNull();
    expect(system.count).toBe(1);
  });

  it('多发独立推进，互不影响', () => {
    const { system } = make();
    system.spawn(spark({ dir: [0, 0, -1] }));
    system.spawn(spark({ dir: [1, 0, 0] }));
    system.update(DT);
    expect(system.active[0].pos[2]).toBeLessThan(0);
    expect(system.active[1].pos[0]).toBeGreaterThan(0);
  });
});
