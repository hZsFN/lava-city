// src/combat/Projectiles.ts
// 纯逻辑投射物系统：火花 / 岩锚的飞行、扫掠命中与生命周期。
// 不 import three；世界碰撞由整合层注入 sweep；对象池容量与弹速来自 config。

import type { Attr, BodyPart, Vec3 } from '../core/events';

const EPS = 1e-9;

export type ProjectileKind = 'spark' | 'anchor';

/** 每种投射物的手感参数（config/player.json 的 projectiles 段） */
export interface ProjectileKindConfig {
  speedMps: number;
  lifetimeSec: number;
  radiusM: number;
}

export interface ProjectileConfig {
  maxActive: number;
  spark: ProjectileKindConfig;
  anchor: ProjectileKindConfig;
}

export interface ProjectileSpec {
  kind: ProjectileKind;
  /** 生成点（世界坐标） */
  pos: Vec3;
  /** 飞行方向（内部归一化） */
  dir: Vec3;
  damage: number;
  attr: Attr;
}

export interface ProjectileHit {
  target: 'boss' | 'tower' | 'player';
  pos: Vec3;
  part?: BodyPart;
}

/** 世界查询：从 from 到 to 的胶囊/线段扫掠，返回最近命中 */
export interface ProjectileWorld {
  sweep(from: Vec3, to: Vec3, radiusM: number): ProjectileHit | null;
}

export interface LiveProjectile {
  readonly id: number;
  readonly kind: ProjectileKind;
  readonly damage: number;
  readonly attr: Attr;
  readonly dir: Vec3;
  readonly radiusM: number;
  readonly speedMps: number;
  pos: Vec3;
  prevPos: Vec3;
  ttlSec: number;
}

export interface ProjectileDeps {
  world: ProjectileWorld;
  config: ProjectileConfig;
  onHit?: (projectile: LiveProjectile, hit: ProjectileHit) => void;
  onExpire?: (projectile: LiveProjectile) => void;
}

export class ProjectileSystem {
  private readonly world: ProjectileWorld;
  private readonly cfg: ProjectileConfig;
  private readonly onHit?: (p: LiveProjectile, hit: ProjectileHit) => void;
  private readonly onExpire?: (p: LiveProjectile) => void;

  private readonly items: LiveProjectile[] = [];
  private nextId = 1;

  constructor(deps: ProjectileDeps) {
    this.world = deps.world;
    this.cfg = deps.config;
    this.onHit = deps.onHit;
    this.onExpire = deps.onExpire;
  }

  get active(): readonly LiveProjectile[] {
    return this.items;
  }

  get count(): number {
    return this.items.length;
  }

  /** 生成一发。池满返回 null */
  spawn(spec: ProjectileSpec): LiveProjectile | null {
    if (this.items.length >= this.cfg.maxActive) return null;

    const kindCfg = this.cfg[spec.kind];
    const dir = normalize(spec.dir);
    const projectile: LiveProjectile = {
      id: this.nextId,
      kind: spec.kind,
      damage: spec.damage,
      attr: spec.attr,
      dir,
      radiusM: kindCfg.radiusM,
      speedMps: kindCfg.speedMps,
      pos: [...spec.pos] as Vec3,
      prevPos: [...spec.pos] as Vec3,
      ttlSec: kindCfg.lifetimeSec,
    };
    this.nextId += 1;
    this.items.push(projectile);
    return projectile;
  }

  update(dt: number): void {
    if (dt <= 0 || this.items.length === 0) return;

    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const p = this.items[i];
      const step = p.speedMps * dt;
      p.prevPos = p.pos;
      p.pos = [p.pos[0] + p.dir[0] * step, p.pos[1] + p.dir[1] * step, p.pos[2] + p.dir[2] * step];
      p.ttlSec -= dt;

      const hit = this.world.sweep(p.prevPos, p.pos, p.radiusM);
      if (hit) {
        this.items.splice(i, 1);
        this.onHit?.(p, hit);
        continue;
      }

      if (p.ttlSec <= EPS) {
        this.items.splice(i, 1);
        this.onExpire?.(p);
      }
    }
  }

  clear(): void {
    this.items.length = 0;
  }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len <= EPS) return [0, 0, -1];
  return [v[0] / len, v[1] / len, v[2] / len];
}
