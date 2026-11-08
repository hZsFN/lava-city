// src/player/PlayerController.ts
// 第一人称玩家移动 / 碰撞 / 冲刺 / HP。纯逻辑层：禁止 import three，只通过事件总线通信。
// 物理：M0-01 约定先用手写 AABB（Rapier 推迟到 M2）；逻辑固定步长由调用方驱动（dt 已乘时间缩放）。
// 所有手感数值来自 config/player.json，代码不硬编码。

import { createBus, type Vec3 } from '../core/events';

type Bus = ReturnType<typeof createBus>;

/** 静态轴对齐包围盒（平台 / 墙体） */
export interface Aabb {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface PlayerWorld {
  colliders: Aabb[];
  /** 脚底低于该高度即判定落入熔岩 */
  lavaY: number;
}

/** 对应 config/player.json 中被本控制器使用的字段（键名与 M0 骨架一致） */
export interface PlayerConfig {
  gravity: number;
  snapToGround: number;
  maxHp: number;
  moveSpeed: number;
  dashSpeed: number;
  dashInvulnerableSec: number;
  dashCooldownSec: number;
  jumpHeight: number;
  radius: number;
  height: number;
  regenDelaySec: number;
  regenPerSec: number;
}

/** 每逻辑帧输入。yaw 为绕 Y 弧度，0 面向 -Z（与 three 相机一致） */
export interface PlayerInput {
  /** 右为正 */
  moveX: number;
  /** 前为正 */
  moveZ: number;
  yaw: number;
  jump: boolean;
  dash: boolean;
}

const IDLE_INPUT: PlayerInput = { moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false };
const EPS = 1e-4;

interface Vec2 {
  x: number;
  z: number;
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v.x, v.z);
  return len > EPS ? { x: v.x / len, z: v.z / len } : { x: 0, z: 0 };
}

/** yaw → 前 / 右单位向量（0 面向 -Z，+yaw 向左转） */
function basisFromYaw(yaw: number): { forward: Vec2; right: Vec2 } {
  return {
    forward: { x: -Math.sin(yaw), z: -Math.cos(yaw) },
    right: { x: Math.cos(yaw), z: -Math.sin(yaw) },
  };
}

export class PlayerController {
  private readonly bus: Bus;
  private readonly cfg: PlayerConfig;
  private readonly world: PlayerWorld;
  private readonly jumpVelocity: number;

  private x = 0;
  private y = 0;
  private z = 0;
  private yaw = 0;
  private vy = 0;
  private hp: number;
  private grounded = false;
  private dead = false;
  private deaths = 0;

  private dashTimer = 0;
  private dashCooldown = 0;
  private dashDir: Vec2 = { x: 0, z: 0 };
  private regenTimer = 0;

  private prevJump = false;
  private prevDash = false;

  constructor(opts: { bus: Bus; config: PlayerConfig; world: PlayerWorld; spawn: Vec3 }) {
    this.bus = opts.bus;
    this.cfg = opts.config;
    this.world = opts.world;
    this.hp = this.cfg.maxHp;
    // 由重力与跳跃高度反解初速度：h = v² / (2g)
    this.jumpVelocity = Math.sqrt(2 * -this.cfg.gravity * this.cfg.jumpHeight);

    [this.x, this.y, this.z] = opts.spawn;
    this.bus.emit('PlayerSpawned', { pos: this.pos });
  }

  get pos(): Vec3 {
    return [this.x, this.y, this.z];
  }

  get currentHp(): number {
    return this.hp;
  }

  get isDead(): boolean {
    return this.dead;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  get isDashing(): boolean {
    return this.dashTimer > 0;
  }

  /** 冲刺全程无敌（0.25 s） */
  get isInvulnerable(): boolean {
    return this.dashTimer > 0;
  }

  get deathCount(): number {
    return this.deaths;
  }

  /** 推进一个逻辑帧。dt 为已乘时间缩放的秒数 */
  update(dt: number, input: PlayerInput = IDLE_INPUT): void {
    if (this.dead) return;
    // 注：对象被冻结（战术视图）时由调用方传 dt=0
    if (dt <= 0) return;

    this.yaw = input.yaw;
    this.tickTimers(dt);
    this.handleDash(input);
    this.handleJump(input);
    this.integrateHorizontal(dt, input);
    this.integrateVertical(dt);

    if (this.y < this.world.lavaY) {
      this.die('lava');
      return;
    }

    this.regen(dt);

    this.bus.emit('PlayerMoved', { pos: this.pos, yaw: this.yaw });
    this.prevJump = input.jump;
    this.prevDash = input.dash;
  }

  /** 受击。无敌帧内或已死亡时返回 0 */
  takeDamage(amount: number, source: string): number {
    if (this.dead || this.isInvulnerable || amount <= 0) return 0;
    const applied = Math.min(amount, this.hp);
    this.hp -= applied;
    this.regenTimer = 0;
    this.bus.emit('PlayerDamaged', {
      amount: applied,
      hp: this.hp,
      maxHp: this.cfg.maxHp,
      source,
    });
    if (this.hp <= 0) this.die(source);
    return applied;
  }

  /** 就地死亡（熔岩 / 脚本），hp 归零 */
  kill(cause: string): void {
    if (this.dead) return;
    this.hp = 0;
    this.die(cause);
  }

  respawn(pos: Vec3): void {
    [this.x, this.y, this.z] = pos;
    this.vy = 0;
    this.hp = this.cfg.maxHp;
    this.dead = false;
    this.grounded = false;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.regenTimer = 0;
    this.prevJump = false;
    this.prevDash = false;
    this.bus.emit('PlayerRespawned', { pos });
  }

  private die(cause: string): void {
    this.dead = true;
    this.hp = 0;
    this.vy = 0;
    this.dashTimer = 0;
    this.grounded = false;
    this.deaths += 1;
    this.bus.emit('PlayerDied', { cause, deaths: this.deaths });
  }

  private tickTimers(dt: number): void {
    if (this.dashTimer > 0) this.dashTimer = Math.max(0, this.dashTimer - dt);
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    // 消除 0.25 - 15/60 这类浮点残差，避免多无敌一帧
    if (this.dashTimer < EPS) this.dashTimer = 0;
    if (this.dashCooldown < EPS) this.dashCooldown = 0;
  }

  private handleDash(input: PlayerInput): void {
    const pressed = input.dash && !this.prevDash;
    if (!pressed || this.dashTimer > 0 || this.dashCooldown > 0) return;

    let local = normalize({ x: input.moveX, z: input.moveZ });
    if (local.x === 0 && local.z === 0) local = { x: 0, z: 1 };
    // 输入是局部坐标，转到世界坐标
    const { forward, right } = basisFromYaw(input.yaw);
    const worldDir = normalize({
      x: forward.x * local.z + right.x * local.x,
      z: forward.z * local.z + right.z * local.x,
    });

    this.dashDir = worldDir;
    this.dashTimer = this.cfg.dashInvulnerableSec;
    this.dashCooldown = Math.max(this.cfg.dashCooldownSec, this.dashTimer);
    this.bus.emit('PlayerDashed', { dir: [worldDir.x, 0, worldDir.z] });
  }

  private handleJump(input: PlayerInput): void {
    if (!input.jump || this.prevJump || !this.grounded || this.isDashing) return;
    this.vy = this.jumpVelocity;
    this.grounded = false;
  }

  private integrateHorizontal(dt: number, input: PlayerInput): void {
    let vx: number;
    let vz: number;
    if (this.isDashing) {
      vx = this.dashDir.x * this.cfg.dashSpeed;
      vz = this.dashDir.z * this.cfg.dashSpeed;
    } else {
      const { forward, right } = basisFromYaw(input.yaw);
      const dir = normalize({ x: input.moveX, z: input.moveZ });
      vx = (forward.x * dir.z + right.x * dir.x) * this.cfg.moveSpeed;
      vz = (forward.z * dir.z + right.z * dir.x) * this.cfg.moveSpeed;
    }

    this.moveAxis('x', vx * dt);
    this.moveAxis('z', vz * dt);
  }

  /** 单轴移动 + 逐盒推出，避免穿墙 */
  private moveAxis(axis: 'x' | 'z', delta: number): void {
    if (delta === 0) return;
    if (axis === 'x') this.x += delta;
    else this.z += delta;

    const r = this.cfg.radius;
    for (const b of this.world.colliders) {
      if (!this.overlapsBody(b)) continue;
      if (axis === 'x') {
        this.x = delta > 0 ? b.minX - r : b.maxX + r;
      } else {
        this.z = delta > 0 ? b.minZ - r : b.maxZ + r;
      }
    }
  }

  private integrateVertical(dt: number): void {
    const wasGrounded = this.grounded;
    const oldY = this.y;
    this.vy += this.cfg.gravity * dt;
    let newY = oldY + this.vy * dt;
    this.grounded = false;

    if (this.vy <= 0) {
      // 下落：取脚底穿越的最高平台顶面
      let landY = -Infinity;
      for (const b of this.world.colliders) {
        if (!this.overlapsHorizontally(b)) continue;
        if (b.maxY <= oldY + EPS && b.maxY >= newY - EPS && b.maxY > landY) landY = b.maxY;
      }
      if (landY > -Infinity) {
        newY = landY;
        this.vy = 0;
        this.grounded = true;
      } else if (wasGrounded) {
        // 下台阶吸附（高度差 ≤ snapToGround）
        let snapY = -Infinity;
        const snap = this.cfg.snapToGround;
        for (const b of this.world.colliders) {
          if (!this.overlapsHorizontally(b)) continue;
          if (b.maxY <= oldY + EPS && b.maxY >= newY - snap && b.maxY > snapY) snapY = b.maxY;
        }
        if (snapY > -Infinity) {
          newY = snapY;
          this.vy = 0;
          this.grounded = true;
        }
      }
    } else {
      // 上升：撞头则贴顶
      let ceilY = Infinity;
      for (const b of this.world.colliders) {
        if (!this.overlapsHorizontally(b)) continue;
        const top = oldY + this.cfg.height;
        if (b.minY >= top - EPS && b.minY <= newY + this.cfg.height + EPS && b.minY < ceilY) {
          ceilY = b.minY;
        }
      }
      if (ceilY < Infinity) {
        newY = ceilY - this.cfg.height;
        this.vy = 0;
      }
    }

    this.y = newY;
  }

  private regen(dt: number): void {
    if (this.hp >= this.cfg.maxHp) {
      this.regenTimer = 0;
      return;
    }
    this.regenTimer += dt;
    if (this.regenTimer < this.cfg.regenDelaySec) return;
    this.hp = Math.min(this.cfg.maxHp, this.hp + this.cfg.regenPerSec * dt);
  }

  private overlapsHorizontally(b: Aabb): boolean {
    const r = this.cfg.radius;
    return this.x + r > b.minX + EPS && this.x - r < b.maxX - EPS
      && this.z + r > b.minZ + EPS && this.z - r < b.maxZ - EPS;
  }

  private overlapsBody(b: Aabb): boolean {
    if (!this.overlapsHorizontally(b)) return false;
    return this.y < b.maxY - EPS && this.y + this.cfg.height > b.minY + EPS;
  }
}
