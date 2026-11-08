// ============================================================================
// 伊格纳斯（IgnisBoss）· 自包含实现
//
// 行为：从熔岩里升起的自走式冶炼炉，两阶段、四弱点、技能按时间驱动。
// 几何：全部来自 ./IgnisRig（Opus 交付，票 M3-03）。
// 通信：只发事件，不直接操作 UI/渲染层。
//
// 为什么不用 BossEntity：它的逻辑层（BossBrain/config/types/mathUtil/parts）
// 在 2026-11-08 的一次 stash 事故中丢失且从未进过 git，本文件是重写版。
// ============================================================================

import * as THREE from 'three/webgpu';
import { createIgnisRig } from './IgnisRig';
import type { IgnisBuild } from './IgnisRig';
import type { Bus, Vec3, BodyPart, Attr } from '../core/events';

// ── 常量 ────────────────────────────────────────────────────────────────────

const DEG = Math.PI / 180;

/** 四个弱点在世界坐标里的位置（阶段 I 局部坐标，root 未缩放时） */
const WEAKNESS_POS: Record<BodyPart, Vec3> = {
  core: [0, 5.6, 1.5],
  back: [0, 7.0, -2.1],
  kneeL: [-0.95, 2.2, 0.7],
  kneeR: [0.95, 2.2, 0.7],
};

const WEAKNESS_R: Record<BodyPart, number> = {
  core: 0.95,
  back: 0.95,
  kneeL: 0.44,
  kneeR: 0.44,
};

const WEAKNESS_ATTR: Record<BodyPart, Attr> = {
  core: 'physical',
  back: 'arcane',
  kneeL: 'arcane',
  kneeR: 'arcane',
};

type SkillId = 'rockSweep' | 'leapSlam' | 'coreDrain' | 'stonePillars' | 'magmaBreath' | 'lavaCharge';

interface SkillDef {
  windupMs: number;
  activeMs: number;
  recoveryMs: number;
  cooldownMs: number;
  damage: number;
}

const SKILLS: Record<SkillId, SkillDef> = {
  rockSweep: { windupMs: 900, activeMs: 350, recoveryMs: 1000, cooldownMs: 6000, damage: 35 },
  leapSlam: { windupMs: 1600, activeMs: 250, recoveryMs: 800, cooldownMs: 9000, damage: 50 },
  coreDrain: { windupMs: 2500, activeMs: 2500, recoveryMs: 600, cooldownMs: 20000, damage: 0 },
  stonePillars: { windupMs: 1200, activeMs: 400, recoveryMs: 600, cooldownMs: 8000, damage: 20 },
  magmaBreath: { windupMs: 1400, activeMs: 2500, recoveryMs: 900, cooldownMs: 11000, damage: 8 },
  lavaCharge: { windupMs: 1100, activeMs: 1800, recoveryMs: 700, cooldownMs: 14000, damage: 45 },
};

const PHASE1_HP = 1400;
const PHASE2_HP = 1400;
const HEIGHT_1 = 9;
const HEIGHT_2 = 11;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ── 主体 ────────────────────────────────────────────────────────────────────

export class IgnisBoss {
  readonly root = new THREE.Group();
  readonly build: IgnisBuild;

  private readonly bus: Bus;
  private readonly fxRoot = new THREE.Group();

  private hp = PHASE1_HP;
  private maxHp = PHASE1_HP;
  private phase: 1 | 2 = 1;

  private tMs = 0;
  private riseMs = 3000;        // 登场动画进度（先直接站好，便于调试）
  private sink = 0;             // 0 = 完全升起，1 = 沉在熔岩下
  private scaleNow = 1;

  private skill: SkillId | null = null;
  private skillStage: 'windup' | 'active' | 'recovery' = 'windup';
  private skillT = 0;
  private cooldowns: Record<SkillId, number> = {
    rockSweep: 0, leapSlam: 0, coreDrain: 0,
    stonePillars: 0, magmaBreath: 0, lavaCharge: 0,
  };
  private decideT = 0;
  private lastExposeMs = -1e9;

  private weakness: BodyPart | null = null;
  private weaknessLeftMs = 0;
  private markers = new Map<BodyPart, THREE.Mesh>();
  private coreLight: THREE.PointLight;
  private readonly stoneMat: THREE.MeshStandardMaterial;

  private targetPos: Vec3 = [0, 0, 18];
  private attackDir = new THREE.Vector3(0, 0, 1);

  constructor(bus: Bus) {
    this.bus = bus;
    this.root.name = 'boss:ignis';
    this.fxRoot.name = 'boss:ignis-fx';

    this.build = createIgnisRig();
    this.root.add(this.build.rig.root);

    // 阶段 II 专属网格先藏起来
    for (const m of this.build.phase2Meshes) m.visible = false;

    // 覆盖 IgnisRig 自带的岩石材质：它启用了 vertexColors，在这个场景的强橙光下
    // 会被染成粉红。这里统一换成近黑的玄武岩，让所有亮度都来自裂缝与熔岩反光。
    this.stoneMat = new THREE.MeshStandardMaterial({
      color: 0x060504,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true,
      vertexColors: false,
    });
    for (const m of this.build.stoneMeshes) m.material = this.stoneMat;

    // 自发光网格：IgnisRig 给的是纯 Basic 材质（不吃光、恒定满亮），
    // 在 Bloom 下会整片炸成粉色。压到 0.32 倍并改成受光的 Standard，
    // 只保留"裂缝里透出来的一线光"。
    for (const m of this.build.glowMeshes) {
      const old = m.material as THREE.MeshBasicMaterial;
      const c = old.color ? old.color.clone() : new THREE.Color(0xff5a12);
      m.material = new THREE.MeshStandardMaterial({
        color: c.clone().multiplyScalar(0.22),
        emissive: c,
        emissiveIntensity: 2.6,
        roughness: 0.7,
        metalness: 0,
        flatShading: true,
      });
    }

    // 弱点指示器：四颗自发光球，默认不可见
    for (const part of Object.keys(WEAKNESS_POS) as BodyPart[]) {
      const r = WEAKNESS_R[part];
      const mat = new THREE.MeshBasicMaterial({
        color: WEAKNESS_ATTR[part] === 'arcane' ? 0x4aa8ff : 0xf0e6cf,
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r * 1.25, 14, 10), mat);
      const p = WEAKNESS_POS[part];
      mesh.position.set(p[0], p[1], p[2]);
      mesh.visible = false;
      this.root.add(mesh);
      this.markers.set(part, mesh);
    }

    this.coreLight = new THREE.PointLight(0x4aa8ff, 120, 26, 2);
    this.coreLight.position.set(...WEAKNESS_POS.core);
    this.root.add(this.coreLight);

    // 熔岩底部照明：熔岩是唯一光源
    const underLight = new THREE.PointLight(0xff5a12, 260, 60, 2);
    underLight.position.set(0, 1.5, 2);
    this.root.add(underLight);

    // 登场：从熔岩里升起
    this.sink = 1.0;

    bus.on('PlayerMoved', (p) => {
      this.targetPos = p.pos;
    });
  }

  attachTo(scene: THREE.Scene): void {
    scene.add(this.root);
    scene.add(this.fxRoot);
    this.root.updateMatrixWorld(true);
  }

  detach(): void {
    this.root.removeFromParent();
    this.fxRoot.removeFromParent();
  }

  // ── 对外只读状态 ──────────────────────────────────────────────────────────

  get state(): { hp: number; maxHp: number; phase: 1 | 2; skill: SkillId | null; weakness: BodyPart | null } {
    return { hp: this.hp, maxHp: this.maxHp, phase: this.phase, skill: this.skill, weakness: this.weakness };
  }

  /** 供玩家攻击调用；返回是否命中弱点 */
  takeDamage(amount: number, attr: Attr, worldPoint?: Vec3): boolean {
    let hitPart: BodyPart | null = null;
    if (worldPoint) {
      for (const part of Object.keys(WEAKNESS_POS) as BodyPart[]) {
        const p = WEAKNESS_POS[part];
        const dx = worldPoint[0] - p[0];
        const dy = worldPoint[1] - p[1];
        const dz = worldPoint[2] - p[2];
        if (dx * dx + dy * dy + dz * dz <= WEAKNESS_R[part] * WEAKNESS_R[part] * 2.25) {
          hitPart = part;
          break;
        }
      }
    }

    const isWeak = this.weakness !== null && hitPart === this.weakness;
    const factor = isWeak && WEAKNESS_ATTR[hitPart as BodyPart] === attr ? 2.5 : isWeak ? 1.2 : 1.0;
    // 阶段 I：物理抗性 0、法术抗性 70%（用物理形态打）
    // 阶段 II：法术抗性 0、物理抗性 70%（切法术形态打）
    const resist = this.phase === 1
      ? (attr === 'arcane' ? 0.70 : 0.0)
      : (attr === 'physical' ? 0.70 : 0.0);
    const dealt = Math.max(1, Math.round(amount * factor * (1 - resist)));

    this.hp = Math.max(0, this.hp - dealt);
    this.bus.emit('DamageDealt', {
      target: 'boss', amount: dealt, attr, part: hitPart ?? undefined, isCrit: isWeak,
    });
    this.bus.emit('BossHpChanged', { hp: this.hp, maxHp: this.maxHp, phase: this.phase });

    if (this.hp === 0) this.die();
    return isWeak;
  }

  /** 外部直接推进阶段（调试用） */
  forcePhase2(): void {
    if (this.phase === 2) return;
    this.phase = 2;
    this.maxHp = PHASE2_HP;
    this.hp = PHASE2_HP;
    this.bus.emit('BossPhaseChanged', { from: 1, to: 2 });
    this.bus.emit('BossHpChanged', { hp: this.hp, maxHp: this.maxHp, phase: 2 });
    this.applyPhaseVisual();
    this.expose('back', 6000);
  }

  // ── 每帧 ──────────────────────────────────────────────────────────────────

  update(dtMs: number): void {
    this.tMs += dtMs;

    // 登场：3 秒从熔岩里升起
    if (this.riseMs < 3000) {
      this.riseMs += dtMs;
      const k = clamp(this.riseMs / 3000, 0, 1);
      this.sink = 1.0 - easeInOut(k);
    }

    // 缩放（阶段切换时拔高）
    const targetScale = this.phase === 2 ? HEIGHT_2 / HEIGHT_1 : 1;
    this.scaleNow += (targetScale - this.scaleNow) * Math.min(1, dtMs / 600);
    this.build.rig.root.scale.setScalar(this.scaleNow);
    this.root.position.y = -this.sink * 3.2;

    // 冷却
    for (const k of Object.keys(this.cooldowns) as SkillId[]) {
      if (this.cooldowns[k] > 0) this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dtMs);
    }

    this.updateWeakness(dtMs);
    this.updateSkill(dtMs);
    this.updateIdleAnim();

    // Director：25 秒没有弱点就强制补一个
    if (this.skill === null && this.tMs - this.lastExposeMs > 25000 && this.weakness === null) {
      this.expose('core', 2500);
    }
  }

  private updateIdleAnim(): void {
    const t = this.tMs * 0.001;
    const rig = this.build.rig;
    // 呼吸：躯干轻微起伏
    rig.torso.position.y = 4.5 + Math.sin(t * 1.1) * 0.08;
    // 头部缓慢左右看
    rig.head.rotation.y = Math.sin(t * 0.37) * 0.18;
    // 双臂自然下垂微摆
    if (this.skill !== 'rockSweep') {
      rig.shoulderL.rotation.x = Math.sin(t * 0.9) * 0.05;
      rig.shoulderR.rotation.x = Math.sin(t * 0.9 + 1.7) * 0.05;
    }
  }

  // ── 弱点 ──────────────────────────────────────────────────────────────────

  private expose(part: BodyPart, durationMs: number): void {
    if (this.weakness !== null && this.weakness !== part) this.closeWeakness();
    this.weakness = part;
    this.weaknessLeftMs = durationMs;
    this.lastExposeMs = this.tMs;
    const marker = this.markers.get(part);
    if (marker) marker.visible = true;
    if (part === 'core') this.coreLight.intensity = 320;
    this.bus.emit('WeaknessExposed', { part, attr: WEAKNESS_ATTR[part], durationMs });
  }

  private closeWeakness(): void {
    if (this.weakness === null) return;
    const part = this.weakness;
    this.weakness = null;
    this.weaknessLeftMs = 0;
    const marker = this.markers.get(part);
    if (marker) marker.visible = false;
    if (part === 'core') this.coreLight.intensity = 120;
    this.bus.emit('WeaknessClosed', { part });
  }

  private updateWeakness(dtMs: number): void {
    if (this.weakness === null) return;
    this.weaknessLeftMs -= dtMs;
    const marker = this.markers.get(this.weakness);
    if (marker) {
      const s = 1 + Math.sin(this.tMs * 0.012) * 0.12;
      marker.scale.setScalar(s);
    }
    if (this.weaknessLeftMs <= 0) this.closeWeakness();
  }

  // ── 技能 ──────────────────────────────────────────────────────────────────

  private updateSkill(dtMs: number): void {
    if (this.skill === null) {
      this.decideT -= dtMs;
      if (this.decideT <= 0) {
        this.decideT = 500;
        this.decide();
      }
      return;
    }

    const def = SKILLS[this.skill];
    this.skillT += dtMs;

    const total = def.windupMs + def.activeMs + def.recoveryMs;
    if (this.skillStage === 'windup' && this.skillT >= def.windupMs) {
      this.skillStage = 'active';
      this.bus.emit('BossSkillStart', { skill: this.skill, stage: 'active', durationMs: def.activeMs });
      this.onSkillActive(this.skill);
    } else if (this.skillStage === 'active' && this.skillT >= def.windupMs + def.activeMs) {
      this.skillStage = 'recovery';
      this.bus.emit('BossSkillStart', { skill: this.skill, stage: 'recovery', durationMs: def.recoveryMs });
    } else if (this.skillT >= total) {
      this.bus.emit('BossSkillEnd', { skill: this.skill });
      this.skill = null;
      this.skillT = 0;
      this.skillStage = 'windup';
    }

    this.animateSkill();
  }

  private decide(): void {
    const toPlayer = Math.hypot(
      this.targetPos[0] - this.root.position.x,
      this.targetPos[2] - this.root.position.z,
    );

    const candidates: Array<{ id: SkillId; score: number }> = [];

    if (this.phase === 1) {
      if (this.cooldowns.leapSlam <= 0 && toPlayer > 14) candidates.push({ id: 'leapSlam', score: 0.8 });
      if (this.cooldowns.rockSweep <= 0 && toPlayer >= 3 && toPlayer <= 12) candidates.push({ id: 'rockSweep', score: 0.75 });
      if (this.cooldowns.coreDrain <= 0) candidates.push({ id: 'coreDrain', score: 0.45 });
      if (this.cooldowns.stonePillars <= 0) candidates.push({ id: 'stonePillars', score: 0.3 });
    } else {
      if (this.cooldowns.lavaCharge <= 0 && toPlayer > 8) candidates.push({ id: 'lavaCharge', score: 0.8 });
      if (this.cooldowns.magmaBreath <= 0 && toPlayer <= 18) candidates.push({ id: 'magmaBreath', score: 0.7 });
      if (this.cooldowns.rockSweep <= 0 && toPlayer >= 3 && toPlayer <= 12) candidates.push({ id: 'rockSweep', score: 0.6 });
      if (this.cooldowns.stonePillars <= 0) candidates.push({ id: 'stonePillars', score: 0.3 });
    }

    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.score - a.score);
    this.startSkill(candidates[0].id);
  }

  private startSkill(id: SkillId): void {
    const def = SKILLS[id];
    this.skill = id;
    this.skillStage = 'windup';
    this.skillT = 0;
    this.cooldowns[id] = def.cooldownMs;
    this.bus.emit('BossSkillStart', { skill: id, stage: 'windup', durationMs: def.windupMs });

    // 面向玩家
    const dx = this.targetPos[0] - this.root.position.x;
    const dz = this.targetPos[2] - this.root.position.z;
    if (dx * dx + dz * dz > 0.01) {
      this.root.rotation.y = Math.atan2(dx, dz);
      this.attackDir.set(dx, 0, dz).normalize();
    }
  }

  private onSkillActive(id: SkillId): void {
    const def = SKILLS[id];

    if (id === 'rockSweep') {
      // 收招硬直 1 秒的内嵌小破绽
      window.setTimeout(() => {
        if (this.skill === null || this.skill === 'rockSweep') this.expose('core', 1000);
      }, def.activeMs + def.recoveryMs - 200);
    } else if (id === 'leapSlam') {
      window.setTimeout(() => this.expose('core', 3000), 260);
    } else if (id === 'coreDrain') {
      // 汲取：每 250ms 回 1%
      const ticks = Math.floor(def.activeMs / 250);
      for (let i = 0; i < ticks; i++) {
        window.setTimeout(() => {
          if (this.skill !== 'coreDrain') return;
          const heal = Math.round(this.maxHp * 0.01);
          this.hp = Math.min(this.maxHp, this.hp + heal);
          this.bus.emit('BossHpChanged', { hp: this.hp, maxHp: this.maxHp, phase: this.phase });
        }, i * 250);
      }
    } else if (id === 'lavaCharge') {
      // 冲撞：沿朝向推 18 米
      const start = this.root.position.clone();
      const dir = this.attackDir.clone();
      const dur = def.activeMs;
      const t0 = performance.now();
      const step = (): void => {
        const k = clamp((performance.now() - t0) / dur, 0, 1);
        this.root.position.x = start.x + dir.x * 18 * k;
        this.root.position.z = start.z + dir.z * 18 * k;
        if (k < 1) requestAnimationFrame(step);
        else if (this.skill === 'lavaCharge') this.expose('kneeL', 4000);
      };
      requestAnimationFrame(step);
    }
  }

  private animateSkill(): void {
    if (this.skill === null) return;
    const def = SKILLS[this.skill];
    const k = clamp(this.skillT / Math.max(1, def.windupMs + def.activeMs), 0, 1);
    const rig = this.build.rig;

    if (this.skill === 'rockSweep') {
      const swing = Math.sin(clamp(k * 1.6, 0, 1) * Math.PI) * 120 * DEG;
      rig.shoulderR.rotation.y = -swing;
      rig.elbowR.rotation.x = -Math.abs(swing) * 0.25;
    } else if (this.skill === 'leapSlam') {
      const up = Math.sin(clamp(k * 1.4, 0, 1) * Math.PI);
      this.root.position.y = -this.sink * 3.2 + up * 6;
      rig.shoulderL.rotation.x = -up * 0.9;
      rig.shoulderR.rotation.x = -up * 0.9;
    } else if (this.skill === 'coreDrain') {
      this.coreLight.intensity = 200 + Math.sin(this.tMs * 0.02) * 120;
    } else if (this.skill === 'magmaBreath') {
      rig.head.rotation.x = 0.28 + Math.sin(k * Math.PI) * 0.55;
    }
  }

  // ── 阶段 ──────────────────────────────────────────────────────────────────

  private applyPhaseVisual(): void {
    for (const m of this.build.phase2Meshes) m.visible = true;
    // 岩石整体偏红：直接把材质颜色往熔岩色推一档
    for (const m of this.build.stoneMeshes) {
      const mat = m.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.multiplyScalar(1.0);
        mat.emissive.setHex(0x3a1206);
        mat.emissiveIntensity = 0.55;
      }
    }
  }

  private die(): void {
    this.bus.emit('BossPhaseChanged', { from: this.phase, to: 2 });
    this.closeWeakness();
    this.skill = null;
  }
}
