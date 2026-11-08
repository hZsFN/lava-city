// src/game/TutorialBook.ts
// ============================================================================
// M4-01 教程书
// ----------------------------------------------------------------------------
// 硬要求：不是弹窗、不暂停游戏、不强制看完。
//   · 出生点右前方 2.2 m、高 0.9 m 悬浮，±0.06 m / 2.4 s 上下浮动
//   · 靠近 2.5 m 浮出「按 E 翻阅」；E 进入阅读态（镜头轻推近），三页翻完化火星
//   · 不按 E 也在 24 s 后自动消散，流程照走
// ============================================================================

import * as THREE from 'three/webgpu';
import type { TutorialConfig } from '../flow/types';
import type { Vec3 } from '../core/events';

interface Spark {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
}

export interface BookView {
  near: boolean;
  reading: boolean;
  pageIndex: number;
  pageTotal: number;
  pageText: string;
  /** 阅读态镜头焦点（世界坐标） */
  focus: Vec3;
  /** 阅读态镜头混合权重 0..1 */
  cameraBlend: number;
}

export class TutorialBook {
  readonly group = new THREE.Group();
  private readonly cfg: TutorialConfig;
  private readonly overlayLight: THREE.PointLight;
  private readonly sparkGroup = new THREE.Group();
  private readonly sparks: Spark[] = [];
  private readonly sparkMat: THREE.MeshBasicMaterial;
  private readonly coverMat: THREE.MeshStandardMaterial;
  private readonly pageMat: THREE.MeshStandardMaterial;
  private readonly rimMat: THREE.MeshStandardMaterial;
  private readonly bookRoot = new THREE.Group();
  private readonly basePos: THREE.Vector3;

  private elapsed = 0;
  private near = false;
  private reading = false;
  private page = 0;
  private dissolveT = -1;
  private cameraBlend = 0;
  private tutorialSeen = false;
  private lastPageAt = -1;

  constructor(scene: THREE.Scene, cfg: TutorialConfig, spawn: Vec3) {
    this.cfg = cfg;

    // 出生点右前方 2.2 m：x 向右、z 向前（yaw=0 面向 -Z）
    this.basePos = new THREE.Vector3(
      spawn[0] + cfg.offsetRightM,
      cfg.heightM,
      spawn[2] - cfg.offsetForwardM,
    );

    this.group.position.copy(this.basePos);
    this.group.rotation.y = 0.32;

    const g = cfg.geometry;
    const colors = cfg.colors;

    this.coverMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors.cover),
      roughness: 0.62,
      metalness: 0.12,
      emissive: new THREE.Color(colors.cover),
      emissiveIntensity: 0.16,
    });
    this.pageMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors.pages),
      roughness: 0.9,
      metalness: 0,
      emissive: new THREE.Color(colors.pages),
      emissiveIntensity: 0.06,
    });
    this.rimMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colors.edge),
      roughness: 0.35,
      metalness: 0.7,
      emissive: new THREE.Color(colors.edge),
      emissiveIntensity: 0.12,
    });

    const coverGeo = new THREE.BoxGeometry(g.widthM, g.coverThicknessM, g.depthM);
    const top = new THREE.Mesh(coverGeo, this.coverMat);
    top.position.y = g.coverThicknessM * 1.05;
    const bottom = new THREE.Mesh(coverGeo, this.coverMat);
    bottom.position.y = -g.coverThicknessM * 1.05;

    const pagesGeo = new THREE.BoxGeometry(
      g.widthM - g.pagesInsetM * 2,
      g.pagesThicknessM,
      g.depthM - g.pagesInsetM * 2,
    );
    const pages = new THREE.Mesh(pagesGeo, this.pageMat);

    // 细金线：比书页略大、比封面略薄的一圈金色夹层
    const rimGeo = new THREE.BoxGeometry(
      g.widthM - g.pagesInsetM * 0.6,
      g.pagesThicknessM * 0.55,
      g.depthM - g.pagesInsetM * 0.6,
    );
    const rim = new THREE.Mesh(rimGeo, this.rimMat);

    top.castShadow = true;
    bottom.castShadow = true;
    pages.castShadow = false;
    this.bookRoot.add(bottom, rim, pages, top);

    this.overlayLight = new THREE.PointLight(
      new THREE.Color(cfg.light.color),
      cfg.light.intensity,
      cfg.light.distance,
      2,
    );
    this.overlayLight.position.set(0, 0.42, 0);
    this.bookRoot.add(this.overlayLight);

    this.group.add(this.bookRoot);
    this.group.add(this.sparkGroup);
    scene.add(this.group);

    this.sparkMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(cfg.sparkColor),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  /**
   * 每帧推进。
   * @param phaseT 当前阶段内已过秒数（tutorial 段用于 24 s 自动消散）
   * @param playerPos 玩家脚底位置
   * @param phase 当前阶段 key
   */
  update(dtSec: number, phaseT: number, phase: string, playerPos: Vec3, locked: boolean): void {
    this.elapsed += dtSec;

    const inTutorial = phase === 'tutorial';
    if (inTutorial) this.tutorialSeen = true;

    // 只在教程段可见；进入 prep 时（或 24 s 到点）自动消散
    if (!inTutorial && this.tutorialSeen && this.dissolveT < 0) {
      this.startDissolve();
    }
    if (inTutorial && phaseT >= this.cfg.autoDissolveAfterSec && this.dissolveT < 0) {
      this.startDissolve();
    }
    // 翻到最后一页后停一会儿，书自己化成火星
    if (
      this.reading &&
      this.lastPageAt >= 0 &&
      this.elapsed - this.lastPageAt >= this.cfg.lastPageHoldSec &&
      this.dissolveT < 0
    ) {
      this.startDissolve();
    }
    this.group.visible = inTutorial || this.dissolveT >= 0;

    // 浮动 + 呼吸光
    const floatY = Math.sin((this.elapsed / this.cfg.floatPeriodSec) * Math.PI * 2) * this.cfg.floatAmplitudeM;
    this.group.position.y = this.basePos.y + floatY;
    if (this.dissolveT < 0) {
      this.overlayLight.intensity =
        this.cfg.light.intensity * (0.82 + Math.sin(this.elapsed * 2.1) * 0.18);
    }

    const dx = playerPos[0] - this.basePos.x;
    const dz = playerPos[2] - this.basePos.z;
    const dist = Math.hypot(dx, dz);
    this.near = inTutorial && this.dissolveT < 0 && dist <= this.cfg.pickupRadiusM;

    // 走远了自动合上书页（不暂停游戏，也不惩罚）
    if (this.reading && (dist > this.cfg.leaveRadiusM || locked || !inTutorial)) this.reading = false;

    const targetBlend = this.reading ? 1 : 0;
    const step = Math.min(1, dtSec / Math.max(0.001, this.cfg.cameraBlendSec));
    this.cameraBlend += (targetBlend - this.cameraBlend) * step;

    // 消散粒子
    if (this.dissolveT >= 0) {
      this.dissolveT += dtSec;
      const k = Math.min(1, this.dissolveT / (this.cfg.sparkMs / 1000));
      for (const s of this.sparks) {
        s.vy -= 3.2 * dtSec;
        s.mesh.position.x += s.vx * dtSec;
        s.mesh.position.y += s.vy * dtSec;
        s.mesh.position.z += s.vz * dtSec;
        s.mesh.rotation.x += dtSec * 6;
        s.mesh.rotation.z += dtSec * 4;
      }
      this.sparkMat.opacity = 1 - k;
      this.bookRoot.visible = false;
      this.overlayLight.intensity = this.cfg.light.intensity * (1 - k);
      if (k >= 1) this.sparkGroup.visible = false;
    }
  }

  /** 按 E：靠近时翻开/翻页；返回是否消费了这次输入 */
  interact(): boolean {
    if (!this.near) return false;
    if (this.dissolveT >= 0) return false;

    if (!this.reading) {
      this.reading = true;
      this.page = 0;
      return true;
    }

    this.page += 1;
    if (this.page >= this.cfg.pages.length) {
      this.reading = false;
      this.startDissolve();
      return true;
    }
    if (this.page === this.cfg.pages.length - 1) this.lastPageAt = this.elapsed;
    return true;
  }

  view(): BookView {
    return {
      near: this.near,
      reading: this.reading,
      pageIndex: Math.min(this.page, this.cfg.pages.length - 1),
      pageTotal: this.cfg.pages.length,
      pageText: this.cfg.pages[Math.min(this.page, this.cfg.pages.length - 1)] ?? '',
      focus: [this.group.position.x, this.group.position.y, this.group.position.z],
      cameraBlend: this.cameraBlend,
    };
  }

  disposed(): boolean {
    return this.dissolveT >= (this.cfg.sparkMs / 1000) + 0.5;
  }

  isVisible(): boolean {
    return this.group.visible && this.bookRoot.visible;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    this.coverMat.dispose();
    this.pageMat.dispose();
    this.rimMat.dispose();
    this.sparkMat.dispose();
  }

  private startDissolve(): void {
    if (this.dissolveT >= 0) return;
    this.dissolveT = 0;
    this.reading = false;
    this.lastPageAt = -1;

    const geo = new THREE.OctahedronGeometry(0.018, 0);
    for (let i = 0; i < this.cfg.sparkCount; i += 1) {
      const mesh = new THREE.Mesh(geo, this.sparkMat);
      mesh.position.set(
        (Math.random() - 0.5) * 0.22,
        (Math.random() - 0.5) * 0.06,
        (Math.random() - 0.5) * 0.18,
      );
      const a = Math.random() * Math.PI * 2;
      const s = 0.5 + Math.random() * 0.9;
      this.sparks.push({
        mesh,
        vx: Math.cos(a) * s * 0.6,
        vy: 0.9 + Math.random() * 1.1,
        vz: Math.sin(a) * s * 0.6,
      });
      this.sparkGroup.add(mesh);
    }
  }
}
