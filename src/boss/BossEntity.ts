import * as THREE from 'three/webgpu';
import type { Vec3 } from '../core/events';
import { createRng, hashSeed } from '../core/rng';
import { BOSS_CONFIG } from './config';
import type { BossConfig } from './types';
import { BossBrain } from './BossBrain';
import { clamp, DEG, easeInOut, lerp } from './mathUtil';
import { HIT_PARTS, HIT_PART_IDS } from './parts';
import type { HitPartId } from './parts';
import type { BossDebugApi, BossDebugState, BossSkillId, BossViewState, Bus, VfxSink } from './types';

const HIPS_Y = 3.2;
const TORSO_Y = 1.6;
const HEAD_Y = 0.85;
const SHOULDER_Y = 1.9;
const SHOULDER_X = 3.55;
const UPPER_ARM_LEN = 2.6;
const FORE_ARM_LEN = 2.4;
const LEG_X = 0.95;
const KNEE_OFFSET = new THREE.Vector3(0, -1.5, 0.55);
const FOOT_OFFSET = new THREE.Vector3(0, -1.4, -0.55);
const THIGH_LEN = 2.2;
const SHIN_LEN = 2.2;
const CORE_POS = new THREE.Vector3(0, 1.2, 2.4);
const SHELL_RADIUS = 1.16;
const BACK_CRACK_POS = new THREE.Vector3(0, 1.55, -2.72);
const MOUTH_HEIGHT = 8.3;

interface ArmRig {
  shoulder: THREE.Group;
  elbow: THREE.Group;
}

interface LegRig {
  root: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
}

interface Effect {
  obj: THREE.Object3D;
  ttl: number;
  total: number;
  tick?: (k: number, dtMs: number) => void;
}

/**
 * Boss 表现层 + 组合根。
 * attachTo(scene) 挂载 root，update(dtMs) 驱动逻辑/Boss 破绽计时/关节动画/VFX。
 */
export class BossEntity implements BossDebugApi, VfxSink {
  readonly root = new THREE.Group();
  readonly brain: BossBrain;

  private readonly cfg: BossConfig = BOSS_CONFIG;
  private readonly rng = createRng(hashSeed('ignis-shards'));
  private readonly fxRoot = new THREE.Group();
  private readonly rig = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly legL: LegRig;
  private readonly legR: LegRig;
  private readonly armL: ArmRig;
  private readonly armR: ArmRig;
  private readonly shellL = new THREE.Group();
  private readonly shellR = new THREE.Group();
  private readonly core: THREE.Mesh;
  private readonly coreLight: THREE.PointLight;
  private readonly backCrack: THREE.Mesh;
  private readonly kneeOrbL: THREE.Mesh;
  private readonly kneeOrbR: THREE.Mesh;
  private readonly eyeMat: THREE.MeshBasicMaterial;
  private readonly stoneMat: THREE.MeshStandardMaterial;
  private readonly obsidianMat: THREE.MeshStandardMaterial;
  private readonly lavaMat: THREE.MeshStandardMaterial;
  private readonly rockMeshes: THREE.Mesh[] = [];
  private readonly hitboxes = new Map<HitPartId, THREE.Mesh>();
  private readonly effects: Effect[] = [];

  private timeMs = 0;
  private scale = 1;
  private sink = -1.0;
  private shellOpen = 0;
  private materialPhase: 1 | 2 = 1;
  private transitionFxActive = false;

  constructor(bus: Bus) {
    this.root.name = 'boss:ignis';
    this.fxRoot.name = 'boss:ignis-fx';
    this.stoneMat = new THREE.MeshStandardMaterial({
      color: 0x3a302a,
      roughness: 0.94,
      metalness: 0.05,
      flatShading: true,
    });
    this.obsidianMat = new THREE.MeshStandardMaterial({
      color: 0x0a0806,
      roughness: 0.08,
      metalness: 0.95,
      flatShading: true,
    });
    this.lavaMat = new THREE.MeshStandardMaterial({
      color: 0x2a1512,
      roughness: 0.72,
      metalness: 0.06,
      flatShading: true,
      emissive: 0xff5a12,
      emissiveIntensity: 4.2,
    });
    const crack = createCrackTexture();
    this.lavaMat.map = crack;
    this.lavaMat.emissiveMap = crack;
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xff7a1e });

    this.root.add(this.rig);
    this.rig.add(this.hips);
    this.hips.position.y = HIPS_Y;
    this.hips.add(this.torso);
    this.torso.position.y = TORSO_Y;
    this.torso.add(this.chest);

    this.buildBody();
    this.legL = this.buildLeg(-1);
    this.legR = this.buildLeg(1);
    this.armL = this.buildArm(-1);
    this.armR = this.buildArm(1);

    const coreGeo = new THREE.SphereGeometry(0.95, 16, 12);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x4aa8ff });
    this.core = new THREE.Mesh(coreGeo, coreMat);
    this.core.position.copy(CORE_POS);
    this.chest.add(this.core);

    this.coreLight = new THREE.PointLight(0x4aa8ff, this.cfg.visual.coreLightIntensity, 30, 2);
    this.coreLight.position.copy(CORE_POS);
    this.chest.add(this.coreLight);

    this.buildShell();

    this.backCrack = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 2.2, 0.1),
      new THREE.MeshBasicMaterial({ color: 0xf0e6cf }),
    );
    this.backCrack.position.copy(BACK_CRACK_POS);
    this.backCrack.visible = false;
    this.torso.add(this.backCrack);

    this.kneeOrbL = this.buildKneeOrb(this.legL);
    this.kneeOrbR = this.buildKneeOrb(this.legR);

    this.brain = new BossBrain(bus, this.cfg, this);
    this.syncHitboxes();
    this.applyPhaseMaterials(1);
  }

  attachTo(scene: THREE.Scene): void {
    scene.add(this.root);
    scene.add(this.fxRoot);
    this.root.updateMatrixWorld(true);
  }

  update(dtMs: number): void {
    this.brain.update(dtMs);
    this.brain.weakness.update(dtMs);
    this.animate(dtMs);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.fxRoot.removeFromParent();
    this.clearEffects();
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
    });
  }

  // ── BossDebugApi ─────────────────────────────────────────

  getDebugState(): BossDebugState {
    return this.brain.getDebugState();
  }

  forceSkill(id: BossSkillId): void {
    this.brain.forceSkill(id);
  }

  setPhase(phase: 1 | 2): void {
    this.brain.setPhase(phase);
  }

  enterRage(): void {
    this.brain.enterRage();
  }

  interrupt(): void {
    this.brain.interrupt();
  }

  freezeFull(): void {
    this.brain.freezeFull();
  }

  breakKnee(side: 'L' | 'R'): void {
    this.brain.breakKnee(side);
  }

  setTaunt(on: boolean): void {
    this.brain.setTaunt(on);
  }

  setPlayerDistance(m: number): void {
    this.brain.setPlayerDistance(m);
  }

  setAiEnabled(on: boolean): void {
    this.brain.setAiEnabled(on);
  }

  damageSelf(): void {
    this.brain.damageSelf();
  }

  setHitboxesVisible(visible: boolean): void {
    for (const mesh of this.hitboxes.values()) mesh.visible = visible;
  }

  // ── VfxSink ──────────────────────────────────────────────

  pillarTelegraph(points: readonly Vec3[], radiusM: number, durationMs: number): void {
    for (const p of points) {
      const ring = makeRing(radiusM, 0xff8a3c, this.cfg.visual.telegraphOpacity);
      ring.position.set(p[0], 0.05, p[2]);
      this.addEffect(ring, durationMs);
    }
  }

  stonePillars(points: readonly Vec3[], radiusM: number, heightM: number): void {
    for (const p of points) {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radiusM * 0.72, radiusM, heightM, 6),
        this.stoneMat.clone(),
      );
      mesh.position.set(p[0], -heightM / 2, p[2]);
      const riseMs = this.cfg.visual.pillarRiseMs;
      this.addEffect(mesh, this.cfg.visual.pillarLifetimeMs, (k) => {
        const rise = clamp((k * this.cfg.visual.pillarLifetimeMs) / riseMs, 0, 1);
        mesh.position.y = -heightM / 2 + heightM * easeInOut(rise);
      });
    }
  }

  fireRainTelegraph(
    points: readonly Vec3[],
    radiusM: number,
    durationMs: number,
    intervalMs: number,
  ): void {
    points.forEach((p, i) => {
      const ring = makeRing(radiusM, 0xff4d1a, this.cfg.visual.telegraphOpacity);
      ring.position.set(p[0], 0.05, p[2]);
      this.addEffect(ring, durationMs + intervalMs * (i + 1));
    });
  }

  fireRainImpact(pos: Vec3, radiusM: number): void {
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.7, 0),
      new THREE.MeshStandardMaterial({
        color: 0x3a1a10,
        roughness: 0.8,
        metalness: 0.1,
        flatShading: true,
        emissive: 0xff5a12,
        emissiveIntensity: 2,
      }),
    );
    rock.position.set(pos[0], 26, pos[2]);
    const fallMs = this.cfg.visual.fireRainRockFallMs;
    this.addEffect(rock, fallMs, (k) => {
      rock.position.y = 26 * (1 - k);
      rock.rotation.x = k * 4;
      if (k >= 0.999) {
        rock.position.y = 0;
        this.shockwaveAny(pos, radiusM, 0xff6a1c);
      }
    });
  }

  shockwave(pos: Vec3, radiusM: number): void {
    this.shockwaveAny(pos, radiusM, 0xffb066);
  }

  breathCone(pos: Vec3, yaw: number, rangeM: number, halfAngleDeg: number, durationMs: number): void {
    const group = new THREE.Group();
    group.position.set(pos[0], MOUTH_HEIGHT * this.scale, pos[2]);
    group.rotation.y = yaw;
    const radius = Math.tan(halfAngleDeg * DEG) * rangeM;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(radius, rangeM, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff6a1c,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = rangeM / 2;
    group.add(cone);
    this.addEffect(group, durationMs, (k) => {
      const mat = cone.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.3 * (1 - Math.abs(k * 2 - 1) * 0.6);
    });
  }

  igniteBurst(pos: Vec3, radiusM: number): void {
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0xff9a3c,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    sphere.position.set(pos[0], 3.2, pos[2]);
    this.addEffect(sphere, this.cfg.visual.ringLifeMs, (k) => {
      const s = 0.6 + radiusM * easeInOut(k);
      sphere.scale.setScalar(s);
      const mat = sphere.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 * (1 - k);
    });
    this.shockwaveAny(pos, radiusM, 0xffb066);
  }

  drainAura(pos: Vec3, durationMs: number): void {
    const group = new THREE.Group();
    group.position.set(pos[0], 0, pos[2]);
    const ring = makeRing(2.4, 0x4aa8ff, 0.4);
    ring.position.y = 0.06;
    group.add(ring);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.9, 6.4, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x4aa8ff,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    beam.position.y = 3.2;
    group.add(beam);
    this.addEffect(group, durationMs, (k) => {
      const pulse = 0.6 + 0.4 * Math.sin(k * Math.PI * 8);
      const mat = beam.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.22 * pulse;
    });
  }

  // ── 造型 ─────────────────────────────────────────────────

  private buildBody(): void {
    // 岩丘：从熔岩里隆起的那一坨。上窄下宽，是整个身体的地基。
    const mound = new THREE.Mesh(new THREE.IcosahedronGeometry(3.4, 1), this.stoneMat);
    mound.scale.set(1.12, 1.15, 0.92);
    this.torso.add(mound);
    this.rockMeshes.push(mound);

    // 柱状节理：围绕躯干一圈的六棱岩柱，每根高度不一。
    // 这是"整块烧过的玄武岩"的来源 —— 单个球体永远做不出这种层次。
    const COLUMNS = 11;
    for (let i = 0; i < COLUMNS; i++) {
      const a = (i / COLUMNS) * Math.PI * 2;
      const r = 2.86;
      const h = 1.9 + ((i * 7) % 5) * 0.46;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.50, 0.64, h, 6), this.stoneMat);
      col.position.set(
        Math.cos(a) * r,
        -0.45 + ((i * 3) % 4) * 0.28,
        Math.sin(a) * r * 0.84,
      );
      col.rotation.set(0.05, -a, 0.04);
      this.torso.add(col);
      this.rockMeshes.push(col);

      // 柱缝里的熔岩：柱子挡住的地方看不见，露出的一线就是光
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.075, h * 1.32, 0.075), this.lavaMat);
      seam.position.set(
        Math.cos(a + 0.285) * 2.92,
        -0.45 + ((i * 3) % 4) * 0.28,
        Math.sin(a + 0.285) * 2.92 * 0.84,
      );
      seam.rotation.y = -a;
      this.torso.add(seam);
      this.rockMeshes.push(seam);
    }

    // 胸口炉膛：一圈八块小岩片围出的洞，洞底是熔岩色发光面
    const forgeBase = new THREE.Mesh(new THREE.BoxGeometry(2.1, 2.0, 0.18), this.lavaMat);
    forgeBase.position.set(0, 0.35, 2.62);
    this.torso.add(forgeBase);
    this.rockMeshes.push(forgeBase);

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.34, 0.62), this.stoneMat);
      lip.position.set(Math.cos(a) * 0.98, 0.35 + Math.sin(a) * 0.95, 2.72);
      lip.rotation.z = a;
      this.torso.add(lip);
      this.rockMeshes.push(lip);
    }

    // 颈部：一截被岩片包住的短柱，让头不是直接扣在球上
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.6, 1.5, 7), this.stoneMat);
    neck.position.set(0, 2.35, 0.2);
    this.torso.add(neck);
    this.rockMeshes.push(neck);

    // 底部的裙岩：更宽，制造"陷进熔岩里"的重量感
    const skirt = new THREE.Mesh(new THREE.DodecahedronGeometry(2.9, 0), this.stoneMat);
    skirt.scale.set(1.35, 0.72, 1.1);
    skirt.position.y = -2.4;
    this.torso.add(skirt);
    this.rockMeshes.push(skirt);

    // 肩甲：两块斜向外上的巨岩，剪影的锐角全靠它们
    for (const side of [-1, 1] as const) {
      const pauldron = new THREE.Group();
      pauldron.position.set(side * 2.9, SHOULDER_Y + 0.9, 0.1);
      pauldron.rotation.z = side * -0.5;
      const pad = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 0), this.stoneMat);
      pad.scale.set(1.15, 0.58, 1.0);
      pauldron.add(pad);
      this.torso.add(pauldron);
      this.rockMeshes.push(pad);

      const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.1, 0.26), this.obsidianMat);
      ridge.position.set(side * 0.5, -0.5, 0.5);
      ridge.rotation.z = side * 0.22;
      pauldron.add(ridge);
      this.rockMeshes.push(ridge);
    }

    // ── 脸：整只 Boss 的视觉中心 ──
    // 一大块裂开的岩壳，正面两个烧红的眼窝，下面一道横向裂缝当嘴。
    // 没有鼻子、没有下巴、没有表情 —— 它是一张石头长出来的脸。
    this.head.position.set(0, HEAD_Y, 1.55);
    this.torso.add(this.head);

    const face = new THREE.Mesh(new THREE.IcosahedronGeometry(2.35, 0), this.stoneMat);
    face.scale.set(1.38, 1.5, 0.52);
    this.head.add(face);
    this.rockMeshes.push(face);

    // 额头裂纹：从眉心向上劈开
    const browCrack = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.5, 0.16), this.lavaMat);
    browCrack.position.set(0.1, 1.15, 1.18);
    browCrack.rotation.z = 0.12;
    this.head.add(browCrack);
    this.rockMeshes.push(browCrack);

    for (const side of [-1, 1] as const) {
      // 眼窝：向内凹陷的黑洞
      const socket = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.62, 0),
        new THREE.MeshStandardMaterial({ color: 0x080402, roughness: 1, flatShading: true }),
      );
      socket.position.set(side * 1.0, 0.5, 1.12);
      socket.scale.set(1.0, 1.12, 0.55);
      this.head.add(socket);

      // 眼窝深处烧红的煤
      const ember = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), this.lavaMat);
      ember.position.set(side * 1.02, 0.46, 1.32);
      this.head.add(ember);
      this.rockMeshes.push(ember);

      // 眉骨：向外挑出一条硬棱，让眼窝有深度
      const brow = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.22, 0.34), this.stoneMat);
      brow.position.set(side * 1.02, 1.02, 1.24);
      brow.rotation.z = side * 0.26;
      this.head.add(brow);
      this.rockMeshes.push(brow);
    }

    // 嘴：一道横贯下半张脸的裂缝，里面是熔岩
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.24, 0.2), this.lavaMat);
    mouth.position.set(0, -1.15, 1.24);
    this.head.add(mouth);
    this.rockMeshes.push(mouth);

    // 嘴两侧各崩掉一块，露出参差的断面
    for (const side of [-1, 1] as const) {
      const chipped = new THREE.Mesh(new THREE.IcosahedronGeometry(0.46, 0), this.stoneMat);
      chipped.position.set(side * 1.42, -1.05, 1.12);
      chipped.rotation.set(0.4, side * 0.6, side * 0.3);
      this.head.add(chipped);
      this.rockMeshes.push(chipped);
    }
  }

  private buildArm(side: -1 | 1): ArmRig {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER_X, SHOULDER_Y, 0);
    this.torso.add(shoulder);

    // 上臂：相对细，带黑曜石棱
    const upper = new THREE.Mesh(
      new THREE.CylinderGeometry(0.60, 0.70, UPPER_ARM_LEN, 7),
      this.stoneMat,
    );
    upper.position.y = -UPPER_ARM_LEN / 2;
    shoulder.add(upper);
    this.rockMeshes.push(upper);

    const upperRidge = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, UPPER_ARM_LEN * 0.9, 0.2),
      this.obsidianMat,
    );
    upperRidge.position.set(side * 0.52, -UPPER_ARM_LEN / 2, 0.18);
    shoulder.add(upperRidge);
    this.rockMeshes.push(upperRidge);

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM_LEN;
    shoulder.add(elbow);

    const elbowRock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.86, 0), this.stoneMat);
    elbowRock.scale.set(1, 0.9, 1);
    elbow.add(elbowRock);
    this.rockMeshes.push(elbowRock);

    // 前臂：明显比上臂粗 —— 这是"锤子"而不是"人胳膊"
    const fore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.90, 1.05, FORE_ARM_LEN, 7),
      this.stoneMat,
    );
    fore.position.y = -FORE_ARM_LEN / 2;
    elbow.add(fore);
    this.rockMeshes.push(fore);

    // 前臂上三道熔岩裂缝
    for (const [dy, ang] of [[-0.4, 0.9], [-1.25, 2.4], [-2.0, 4.1]] as const) {
      const crackLine = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.86, 0.08), this.lavaMat);
      const r = 0.94;
      crackLine.position.set(Math.sin(ang) * r, dy, Math.cos(ang) * r);
      crackLine.rotation.y = ang;
      elbow.add(crackLine);
      this.rockMeshes.push(crackLine);
    }

    // 拳头：碎裂的多面体，不是光滑球
    const fist = new THREE.Mesh(new THREE.IcosahedronGeometry(1.16, 0), this.stoneMat);
    fist.position.y = -FORE_ARM_LEN - 0.35;
    fist.scale.set(1.08, 0.94, 1.12);
    elbow.add(fist);
    this.rockMeshes.push(fist);

    for (const ang of [0.4, 2.6, 4.6]) {
      const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.72, 0.09), this.lavaMat);
      knuckle.position.set(
        Math.sin(ang) * 0.92,
        -FORE_ARM_LEN - 0.35,
        Math.cos(ang) * 0.92,
      );
      knuckle.rotation.set(0.4, ang, 0.2);
      elbow.add(knuckle);
      this.rockMeshes.push(knuckle);
    }

    return { shoulder, elbow };
  }

  private buildLeg(side: -1 | 1): LegRig {
    const root = new THREE.Group();
    root.position.set(side * LEG_X, 0, 0);
    this.hips.add(root);

    const knee = new THREE.Group();
    knee.position.copy(KNEE_OFFSET);
    root.add(knee);

    const foot = new THREE.Group();
    foot.position.copy(FOOT_OFFSET);
    knee.add(foot);

    const thigh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.78, 0.9, THIGH_LEN, 8),
      this.stoneMat,
    );
    orientLimb(thigh, new THREE.Vector3(0, 0, 0), KNEE_OFFSET.clone(), THIGH_LEN);
    root.add(thigh);
    this.rockMeshes.push(thigh);

    const shin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.75, SHIN_LEN, 8),
      this.stoneMat,
    );
    orientLimb(shin, new THREE.Vector3(0, 0, 0), FOOT_OFFSET.clone(), SHIN_LEN);
    knee.add(shin);
    this.rockMeshes.push(shin);

    const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.6, 1.8), this.stoneMat);
    shoe.position.y = -0.1;
    foot.add(shoe);
    this.rockMeshes.push(shoe);

    return { root, knee, foot };
  }

  private buildShell(): void {
    const shellMat = this.stoneMat;
    const geoL = new THREE.SphereGeometry(SHELL_RADIUS, 8, 6, 0, Math.PI);
    const geoR = new THREE.SphereGeometry(SHELL_RADIUS, 8, 6, Math.PI, Math.PI);
    const halfL = new THREE.Mesh(geoL, shellMat);
    const halfR = new THREE.Mesh(geoR, shellMat);
    this.shellL.position.copy(CORE_POS);
    this.shellR.position.copy(CORE_POS);
    this.shellL.add(halfL);
    this.shellR.add(halfR);
    this.chest.add(this.shellL, this.shellR);
    this.rockMeshes.push(halfL, halfR);
  }

  private buildKneeOrb(leg: LegRig): THREE.Mesh {
    const orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.42, 0),
      new THREE.MeshBasicMaterial({ color: 0xfff0c0 }),
    );
    orb.position.set(0, 0, 0.14);
    orb.visible = false;
    leg.knee.add(orb);

    // 外面包两块岩片，暴露时就是它们翻开的视觉锚点
    for (const side of [-1, 1] as const) {
      const plate = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), this.stoneMat);
      plate.scale.set(0.9, 0.55, 0.75);
      plate.position.set(side * 0.42, 0.05, 0.1);
      plate.rotation.set(0.2, side * 0.5, side * 0.3);
      leg.knee.add(plate);
      this.rockMeshes.push(plate);
    }
    return orb;
  }

  private syncHitboxes(): void {
    const joints: Record<string, THREE.Object3D> = {
      chest: this.chest,
      torso: this.torso,
      legL: this.legL.root,
      legR: this.legR.root,
    };
    for (const id of HIT_PART_IDS) {
      const def = HIT_PARTS[id];
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(def.r, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3366, wireframe: true, transparent: true, opacity: 0.6 }),
      );
      mesh.name = `hitbox:${id}`;
      mesh.visible = false;
      mesh.position.set(...def.localOffset);
      mesh.userData.part = id;
      joints[def.joint].add(mesh);
      this.hitboxes.set(id, mesh);
    }
  }

  // ── 动画 ─────────────────────────────────────────────────

  private animate(dtMs: number): void {
    const v = this.brain.getView();

    // 阶段 I 半身埋在熔岩里，阶段 II 站起来 —— 这是身高从 9 m 变 11 m 的真正来源
    const targetSink = v.phase === 2 ? 0 : -1.0;
    this.sink += (targetSink - this.sink) * Math.min(1, dtMs / 900);

    this.root.position.set(v.pos[0], v.pos[1] + this.transitionY(v) + this.sink, v.pos[2]);
    this.root.rotation.y = v.yaw;

    const targetScale = v.phase === 2 ? this.cfg.phases[1].height / this.cfg.phases[0].height : 1;
    const k = Math.min(1, dtMs / this.cfg.visual.scaleEaseMs);
    this.scale += (targetScale - this.scale) * k;
    this.rig.scale.setScalar(this.scale);

    if (this.materialPhase !== v.phase) {
      this.applyPhaseMaterials(v.phase);
      this.materialPhase = v.phase;
    }
    if (v.transitionActive && !this.transitionFxActive) {
      this.transitionFxActive = true;
      this.spawnShards(v);
    } else if (!v.transitionActive) {
      this.transitionFxActive = false;
    }

    this.timeMs += dtMs;
    this.resetPose();
    this.poseIdle(v);
    this.poseSkill(v);
    this.updateWeakness(v, dtMs);
    this.updateEffects(dtMs);
  }

  private resetPose(): void {
    this.hips.position.y = HIPS_Y;
    this.torso.rotation.set(0, 0, 0);
    this.torso.scale.set(1, 1, 1);
    this.head.rotation.set(0, 0, 0);
    for (const arm of [this.armL, this.armR]) {
      arm.shoulder.rotation.set(0, 0, 0);
      arm.elbow.rotation.set(0, 0, 0);
    }
    for (const leg of [this.legL, this.legR]) {
      leg.root.rotation.set(0, 0, 0);
      leg.knee.rotation.set(0, 0, 0);
    }
  }

  private poseIdle(v: BossViewState): void {
    if (v.skill || v.mode !== 'idle') return;
    const t = this.timeMs / 1000;
    const breath = Math.sin(t * 1.9);
    this.hips.position.y = HIPS_Y + breath * 0.035;
    this.torso.scale.set(1 + breath * 0.008, 1 + breath * 0.012, 1 + breath * 0.008);
    this.head.rotation.y = Math.sin(t * 0.5) * 0.07;
    this.armL.shoulder.rotation.z = -0.07 - breath * 0.02;
    this.armR.shoulder.rotation.z = 0.07 + breath * 0.02;
  }

  private poseSkill(v: BossViewState): void {
    const p = v.stageProgress;
    if (v.mode === 'stunned') {
      this.hips.position.y = HIPS_Y - 1.3;
      this.torso.rotation.z = 0.26;
      this.torso.rotation.x = 0.2;
      this.head.rotation.x = 0.35;
      this.armL.shoulder.rotation.z = -0.35;
      this.armR.shoulder.rotation.z = 0.35;
      return;
    }
    if (v.mode === 'transition' || !v.skill || !v.stage) return;

    switch (v.skill) {
      case 'rockSweep':
        this.poseRockSweep(v.stage, p);
        break;
      case 'leapSlam':
        this.poseLeapSlam(v.stage, p);
        break;
      case 'coreDrain': {
        const pulse = 0.5 + 0.5 * Math.sin(this.timeMs * 0.008);
        this.armL.shoulder.rotation.z = -1.15 - pulse * 0.08;
        this.armR.shoulder.rotation.z = 1.15 + pulse * 0.08;
        this.armL.shoulder.rotation.x = -0.45;
        this.armR.shoulder.rotation.x = -0.45;
        this.torso.rotation.x = -0.08;
        this.hips.position.y = HIPS_Y + 0.08;
        break;
      }
      case 'stonePillars':
        if (v.stage === 'windup') {
          const k = easeInOut(p);
          this.armL.shoulder.rotation.x = -2.2 * k;
          this.armR.shoulder.rotation.x = -2.2 * k;
          this.torso.rotation.x = -0.16 * k;
        } else {
          this.armL.shoulder.rotation.x = 0.6;
          this.armR.shoulder.rotation.x = 0.6;
          this.torso.rotation.x = 0.32;
          this.hips.position.y = HIPS_Y - 0.5;
        }
        break;
      case 'magmaBreath':
        if (v.stage === 'windup') {
          this.torso.rotation.x = -0.2 * easeInOut(p);
          this.head.rotation.x = -0.15;
        } else {
          this.torso.rotation.x = 0.3;
          this.head.rotation.x = 0.2;
          this.armL.shoulder.rotation.z = -0.55;
          this.armR.shoulder.rotation.z = 0.55;
          this.armL.shoulder.rotation.x = 0.5;
          this.armR.shoulder.rotation.x = 0.5;
        }
        break;
      case 'lavaCharge':
        this.torso.rotation.x = v.stage === 'windup' ? 0.3 * easeInOut(p) : 0.5;
        this.hips.position.y = HIPS_Y - (v.stage === 'windup' ? 0.9 : 0.45);
        this.armL.shoulder.rotation.x = 0.9;
        this.armR.shoulder.rotation.x = 0.9;
        if (v.stage === 'active') {
          const run = Math.sin(this.timeMs * 0.022);
          this.legL.root.rotation.x = run * 0.5;
          this.legR.root.rotation.x = -run * 0.5;
          this.legL.knee.rotation.x = Math.max(0, -run) * 0.6;
          this.legR.knee.rotation.x = Math.max(0, run) * 0.6;
        }
        break;
      case 'fireRain':
        this.armL.shoulder.rotation.x = -2.45;
        this.armR.shoulder.rotation.x = -2.45;
        this.armL.shoulder.rotation.z = -0.35;
        this.armR.shoulder.rotation.z = 0.35;
        this.head.rotation.x = -0.3;
        this.torso.rotation.x = -0.12;
        break;
      case 'selfIgnite':
        if (v.stage === 'windup') {
          const k = easeInOut(p);
          this.hips.position.y = HIPS_Y - 0.6 * k;
          this.armL.shoulder.rotation.z = -0.3 * k;
          this.armR.shoulder.rotation.z = 0.3 * k;
          this.torso.rotation.x = 0.22 * k;
        } else {
          this.armL.shoulder.rotation.z = -1.35;
          this.armR.shoulder.rotation.z = 1.35;
          this.torso.rotation.x = -0.15;
        }
        break;
      default:
        break;
    }
  }

  private poseRockSweep(stage: 'windup' | 'active' | 'recovery', p: number): void {
    const arc = this.cfg.skills.rockSweep.arcDeg * DEG;
    if (stage === 'windup') {
      const k = easeInOut(p);
      this.armR.shoulder.rotation.x = -1.4 * k;
      this.armR.shoulder.rotation.y = -arc * k;
      this.torso.rotation.y = -0.28 * k;
      this.hips.position.y = HIPS_Y - 0.25 * k;
    } else if (stage === 'active') {
      const k = easeInOut(p);
      this.armR.shoulder.rotation.x = -1.4;
      this.armR.shoulder.rotation.y = lerp(-arc, arc, k);
      this.torso.rotation.y = lerp(-0.28, 0.34, k);
      this.hips.position.y = HIPS_Y - 0.25;
    } else {
      const k = easeInOut(p);
      this.armR.shoulder.rotation.x = -1.4 * (1 - k);
      this.armR.shoulder.rotation.y = arc * (1 - k);
      this.torso.rotation.y = 0.34 * (1 - k);
    }
  }

  private poseLeapSlam(stage: 'windup' | 'active' | 'recovery', p: number): void {
    if (stage === 'windup') {
      const crouch = easeInOut(clamp(p / 0.55, 0, 1));
      const air = clamp((p - 0.55) / 0.45, 0, 1);
      this.hips.position.y = HIPS_Y - 1.2 * crouch * (1 - air * 0.7);
      this.torso.rotation.x = 0.3 * crouch;
      this.armL.shoulder.rotation.x = 0.8 * crouch;
      this.armR.shoulder.rotation.x = 0.8 * crouch;
      this.legL.root.rotation.x = 0.5 * crouch;
      this.legR.root.rotation.x = 0.5 * crouch;
      this.legL.knee.rotation.x = -0.9 * air;
      this.legR.knee.rotation.x = -0.9 * air;
      return;
    }
    if (stage === 'active') {
      const k = easeInOut(p);
      this.hips.position.y = HIPS_Y - 1.5 + k * 0.6;
      this.torso.rotation.x = 0.4;
      this.armL.shoulder.rotation.x = -0.5;
      this.armR.shoulder.rotation.x = -0.5;
      return;
    }
    const k = easeInOut(p);
    this.hips.position.y = HIPS_Y - 0.9 * (1 - k);
    this.torso.rotation.x = 0.2 * (1 - k);
  }

  private updateWeakness(v: BossViewState, dtMs: number): void {
    const shellTarget =
      v.weakness === 'core' && v.weaknessDurationMs > this.cfg.visual.shellSmallMaxMs ? 1 : 0;
    const step = dtMs / this.cfg.visual.shellOpenMs;
    if (shellTarget > this.shellOpen) this.shellOpen = Math.min(1, this.shellOpen + step);
    else this.shellOpen = Math.max(0, this.shellOpen - step);
    const openRad = this.cfg.visual.shellOpenDeg * DEG * this.shellOpen;
    this.shellL.rotation.y = -openRad;
    this.shellR.rotation.y = openRad;

    const exposed = v.weakness === 'core';
    const pulse = 1 + Math.sin(this.timeMs * 0.012) * 0.1;
    this.core.scale.setScalar((exposed ? 1.22 : 1) * pulse);
    this.coreLight.intensity =
      this.cfg.visual.coreLightIntensity *
      (exposed ? 1 : this.cfg.visual.coreLightIdleScale) *
      pulse;
    this.backCrack.visible = v.weakness === 'back';
    this.kneeOrbL.visible = v.weakness === 'kneeL';
    this.kneeOrbR.visible = v.weakness === 'kneeR';
  }

  private transitionY(v: BossViewState): number {
    if (!v.transitionActive) return 0;
    const cfg = this.cfg.transition;
    const total = cfg.shardMs + cfg.sinkMs + cfg.holdMs + cfg.riseMs;
    const t = v.transitionProgress * total;
    if (t < cfg.shardMs) return 0;
    if (t < cfg.shardMs + cfg.sinkMs) {
      return -cfg.sinkDepthM * easeInOut((t - cfg.shardMs) / cfg.sinkMs);
    }
    if (t < cfg.shardMs + cfg.sinkMs + cfg.holdMs) return -cfg.sinkDepthM;
    const k = clamp((t - cfg.shardMs - cfg.sinkMs - cfg.holdMs) / cfg.riseMs, 0, 1);
    return -cfg.sinkDepthM * (1 - easeInOut(k));
  }

  private applyPhaseMaterials(phase: 1 | 2): void {
    const mat = phase === 2 ? this.lavaMat : this.stoneMat;
    for (const mesh of this.rockMeshes) mesh.material = mat;
    this.eyeMat.color.set(phase === 2 ? 0xffd27a : 0xff7a1e);
  }

  // ── 特效 ─────────────────────────────────────────────────

  private spawnShards(v: BossViewState): void {
    const cfg = this.cfg.transition;
    const count = cfg.shardCount;
    const mesh = new THREE.InstancedMesh(
      new THREE.DodecahedronGeometry(0.42, 0),
      this.stoneMat.clone(),
      count,
    );
    const dummy = new THREE.Object3D();
    const shards = Array.from({ length: count }, () => {
      const angle = this.rng() * Math.PI * 2;
      const radius = 0.8 + this.rng() * 2;
      const height = 3 + this.rng() * 3.2;
      const speed = cfg.shardSpeedMps * (0.45 + this.rng() * 0.9);
      return {
        pos: new THREE.Vector3(
          v.pos[0] + Math.cos(angle) * radius,
          height,
          v.pos[2] + Math.sin(angle) * radius,
        ),
        vel: new THREE.Vector3(Math.cos(angle) * speed, 2.5 + this.rng() * 5, Math.sin(angle) * speed),
        rot: new THREE.Vector3(this.rng() * 6, this.rng() * 6, this.rng() * 6),
        spin: new THREE.Vector3(
          (this.rng() - 0.5) * 8,
          (this.rng() - 0.5) * 8,
          (this.rng() - 0.5) * 8,
        ),
      };
    });
    this.addEffect(mesh, cfg.shardLifetimeMs, (_k, dtMs) => {
      const dt = dtMs / 1000;
      shards.forEach((s, i) => {
        s.vel.y -= 18 * dt;
        s.pos.addScaledVector(s.vel, dt);
        s.rot.addScaledVector(s.spin, dt);
        dummy.position.copy(s.pos);
        dummy.rotation.set(s.rot.x, s.rot.y, s.rot.z);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });
  }

  private shockwaveAny(pos: Vec3, radiusM: number, color: number): void {
    const ring = makeRing(1, color, 0.55);
    ring.position.set(pos[0], 0.07, pos[2]);
    const life = this.cfg.visual.ringLifeMs;
    this.addEffect(ring, life, (k) => {
      const s = 0.4 + radiusM * easeInOut(k);
      ring.scale.setScalar(s);
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 * (1 - k);
    });
  }

  private addEffect(obj: THREE.Object3D, ttlMs: number, tick?: (k: number, dtMs: number) => void): void {
    this.fxRoot.add(obj);
    this.effects.push({ obj, ttl: ttlMs, total: ttlMs, tick });
  }

  private updateEffects(dtMs: number): void {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const e = this.effects[i];
      e.ttl -= dtMs;
      const k = clamp(1 - e.ttl / e.total, 0, 1);
      e.tick?.(k, dtMs);
      if (e.ttl <= 0) {
        this.effects.splice(i, 1);
        e.obj.removeFromParent();
        e.obj.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose();
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (const m of mats) m.dispose();
          }
        });
      }
    }
  }

  private clearEffects(): void {
    for (const e of this.effects) {
      e.obj.removeFromParent();
      e.obj.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          for (const m of mats) m.dispose();
        }
      });
    }
    this.effects.length = 0;
  }
}

function makeRing(radiusM: number, color: number, opacity: number): THREE.Mesh {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.1, radiusM * 0.82), radiusM, 40),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  return ring;
}

function orientLimb(
  mesh: THREE.Mesh,
  from: THREE.Vector3,
  to: THREE.Vector3,
  baseHeight: number,
): void {
  const dir = to.clone().sub(from);
  const len = dir.length();
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.scale.set(1, Math.max(0.01, len / baseHeight), 1);
}

/** 程序化熔岩裂纹贴图：无外部资产，rs 播种便于复现。 */
function createCrackTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.fillStyle = '#1a0d0a';
  ctx.fillRect(0, 0, size, size);

  const rng = createRng(0x5eed11);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 42; i += 1) {
    let x = rng() * size;
    let y = rng() * size;
    let angle = rng() * Math.PI * 2;
    const segments = 6 + Math.floor(rng() * 18);
    for (let s = 0; s < segments; s += 1) {
      const nx = x + Math.cos(angle) * (4 + rng() * 12);
      const ny = y + Math.sin(angle) * (4 + rng() * 12);
      ctx.strokeStyle = rng() > 0.55 ? 'rgba(255,176,71,0.85)' : 'rgba(255,90,18,0.55)';
      ctx.lineWidth = 0.6 + rng() * 2.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx;
      y = ny;
      angle += (rng() - 0.5) * 1.6;
    }
  }
  ctx.globalCompositeOperation = 'source-over';

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}
