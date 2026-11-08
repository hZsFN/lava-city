// src/game/FlowDirector.ts
// ============================================================================
// M4-01 演出总导演（表现层，允许 import three / DOM）
// ----------------------------------------------------------------------------
// 9 段：wake(dark) → wake(blur) → tutorial → prep → boss1 → transition
//       → boss2 → victory → escape；另有 rage / fail 兜底。
//
// 只订阅 Bus、只读 snapshot / 只操作场景与 DOM，不改任何玩法规则。
// 所有时间点、台词、时长、颜色、位移全部来自 src/core/config/flow.json。
// ============================================================================

import * as THREE from 'three/webgpu';
import type { Attr, Bus, MatchPhase, Snapshot, Vec3 } from '../core/events';
import type { FlowConfig, NarrationLine } from '../flow/types';
import type { Game } from './GameLoop';
import type { IgnisBoss } from '../boss/IgnisBoss';
import { TutorialBook } from './TutorialBook';
import { PlayerAvatar } from './PlayerAvatar';
import { FlowOverlay } from '../ui/FlowOverlay';
import type { HudView } from '../ui/Hud';
import type { AudioPlayer } from '../audio/AudioPlayer';
import { VISUAL } from '../render/config';
import playerCfgJson from '../core/config/player.json';
import type { PlayerConfig } from '../player/PlayerController';

const playerCfg = playerCfgJson as unknown as PlayerConfig;

interface LavaHost {
  setLavaY(y: number): void;
  lavaBaseY: number;
}

export interface FlowDirectorDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  bus: Bus;
  game: Game;
  boss: IgnisBoss;
  flowCfg: FlowConfig;
  lava: LavaHost;
  debug: boolean;
  onFail: (reason: string) => void;
  /** M5-02 音频：不传则演出静音（单测/无音频环境） */
  audio?: AudioPlayer | null;
}

interface Spark {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
}

interface ShardField {
  mesh: THREE.InstancedMesh;
  origin: THREE.Vector3;
  base: Array<{ x: number; y: number; z: number }>;
  vel: Array<{ x: number; y: number; z: number }>;
  delay: number[];
  age: number;
  material: THREE.MeshStandardMaterial;
}

export class FlowDirector {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly bus: Bus;
  private readonly game: Game;
  private readonly boss: IgnisBoss;
  private readonly cfg: FlowConfig;
  private readonly lava: LavaHost;
  private readonly overlay: FlowOverlay;
  private readonly audio: AudioPlayer | null;
  private readonly debugFlag: boolean;
  private readonly onFail: (reason: string) => void;

  private readonly book: TutorialBook;
  private readonly avatar: PlayerAvatar;
  private readonly dummy = new THREE.Object3D();
  private readonly baseFov: number;
  private readonly cameraEye = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly cameraFocus = new THREE.Vector3();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraNear = new THREE.Vector3();

  private readonly mouth = new THREE.Group();
  private readonly ripple: THREE.Mesh;
  private readonly mouthGlow: THREE.Mesh;
  private readonly mouthLight: THREE.PointLight;

  private readonly beam: THREE.Mesh;
  private readonly beamLight: THREE.PointLight;
  private readonly coreLight: THREE.PointLight;
  private readonly wash: THREE.HemisphereLight;
  private readonly coolKey: THREE.DirectionalLight;
  private readonly beamMaterial: THREE.MeshBasicMaterial;

  private readonly baseLights: Array<{ light: THREE.Light; intensity: number }> = [];
  private readonly sparks: Spark[] = [];
  private shards: ShardField | null = null;

  private readonly unsubs: Array<() => void> = [];
  private phase: MatchPhase = 'wake';
  private phaseStart = 0;
  private t = 0;
  private phaseT = 0;
  private readonly dynamicStarts = new Map<MatchPhase, number>();

  private bossVisible = false;
  private bossSpawnPending = false;
  private landingDone = false;
  private phase2Applied = false;
  private rageStart = -1;
  private escapePlayer: Vec3 = [0, 0, 0];
  private escapeStart = -1;
  private whiteAlpha = 0;

  private shakeT = 0;
  private shakeDur = 1;
  private shakePx = 0;

  private weakness: { part: string; attr: Attr; untilT: number } | null = null;

  private failStart = -1;
  private failRealStart = 0;
  private failFired = false;
  private readonly failReason: string;

  private disposed = false;

  constructor(deps: FlowDirectorDeps) {
    this.scene = deps.scene;
    this.camera = deps.camera;
    this.bus = deps.bus;
    this.game = deps.game;
    this.boss = deps.boss;
    this.cfg = deps.flowCfg;
    this.lava = deps.lava;
    this.debugFlag = deps.debug;
    this.onFail = deps.onFail;
    this.baseFov = VISUAL.camera.fov;
    this.failReason = deps.flowCfg.fail.reason;

    this.overlay = new FlowOverlay();
    this.audio = deps.audio ?? null;
    this.book = new TutorialBook(this.scene, this.cfg.tutorial, this.cfg.playerSpawn);
    this.avatar = new PlayerAvatar(this.scene);

    // 捕捉场景原有灯光（含 Boss 体内灯，转场压暗时一起降）
    this.scene.traverse((obj) => {
      const light = obj as THREE.Light;
      if (!light.isLight) return;
      this.baseLights.push({ light, intensity: light.intensity });
    });

    // ── 熔岩口（Boss 登场点）──────────────────────────────────────────────
    const mouthCfg = this.cfg.bossSpawn;
    this.mouth.position.set(...mouthCfg.mouthPos);
    const pitGeo = new THREE.CylinderGeometry(mouthCfg.mouthRadiusM, mouthCfg.mouthRadiusM * 0.92, 0.06, 36);
    const pitMat = new THREE.MeshStandardMaterial({
      color: 0x050302,
      roughness: 1,
      metalness: 0,
      emissive: 0x1a0603,
      emissiveIntensity: 0.4,
    });
    const pit = new THREE.Mesh(pitGeo, pitMat);
    pit.position.y = 0.035;
    this.mouth.add(pit);

    const ringGeo = new THREE.TorusGeometry(mouthCfg.mouthRadiusM * 0.92, 0.07, 6, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff5a12 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.07;
    this.mouth.add(ring);

    const glowGeo = new THREE.CircleGeometry(mouthCfg.mouthRadiusM * 0.86, 48);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff5a12,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mouthGlow = new THREE.Mesh(glowGeo, glowMat);
    this.mouthGlow.rotation.x = -Math.PI / 2;
    this.mouthGlow.position.y = 0.08;
    this.mouth.add(this.mouthGlow);

    this.mouthLight = new THREE.PointLight(0xff5a12, 0, mouthCfg.mouthRadiusM * 4, 2);
    this.mouthLight.position.y = 0.8;
    this.mouth.add(this.mouthLight);

    const rippleGeo = new THREE.TorusGeometry(mouthCfg.mouthRadiusM * 0.8, 0.1, 6, 64);
    const rippleMat = new THREE.MeshBasicMaterial({
      color: 0xffb070,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ripple = new THREE.Mesh(rippleGeo, rippleMat);
    this.ripple.rotation.x = Math.PI / 2;
    this.ripple.position.y = 0.1;
    this.ripple.visible = false;
    this.mouth.add(this.ripple);

    this.scene.add(this.mouth);

    // ── 胜利光柱 / 冷光洗地 ───────────────────────────────────────────────
    const vic = this.cfg.victoryShow;
    const beamGeo = new THREE.CylinderGeometry(vic.beamRadiusM * 0.72, vic.beamRadiusM, 1, 28, 1, true);
    beamGeo.translate(0, 0.5, 0);
    this.beamMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(vic.beamColor),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.beam = new THREE.Mesh(beamGeo, this.beamMaterial);
    this.beam.position.set(0, 0.8, 0);
    this.beam.scale.y = 0.001;
    this.beam.visible = false;
    this.scene.add(this.beam);

    this.beamLight = new THREE.PointLight(new THREE.Color(vic.beamColor), 0, 120, 2);
    this.beamLight.position.set(0, 4, 0);
    this.scene.add(this.beamLight);

    this.coreLight = new THREE.PointLight(0x8fe6ff, 0, 90, 2);
    this.coreLight.position.set(0, 3.2, 0);
    this.scene.add(this.coreLight);

    this.wash = new THREE.HemisphereLight(0xbdeaff, 0x0a1418, 0);
    this.scene.add(this.wash);

    // 胜利时从穹顶压下来的冷青主光：把整场从熔岩橙洗成冷色
    this.coolKey = new THREE.DirectionalLight(new THREE.Color(vic.washColor), 0);
    this.coolKey.position.set(0, 60, -26);
    this.coolKey.target.position.set(0, 0, 0);
    this.scene.add(this.coolKey);
    this.scene.add(this.coolKey.target);

    // Boss 先藏好，等 0:50 的熔岩口节拍
    this.boss.hideForShow();
    this.boss.root.position.set(...mouthCfg.mouthPos);

    this.phase = this.game.snapshot().phase;
    this.phaseStart = 0;

    // 第一帧就必须是全黑：黑屏不得晚于第一帧
    if (this.phase === 'wake') {
      this.overlay.setBlack(1);
      this.overlay.setBlur(0);
    }

    this.unsubs.push(
      this.bus.on('MatchPhaseChanged', (p) => this.onPhase(p.phase, p.tSec)),
    );
    this.unsubs.push(
      this.bus.on('WeaknessExposed', (p) => {
        this.weakness = { part: p.part, attr: p.attr, untilT: this.t + p.durationMs / 1000 };
      }),
    );
    this.unsubs.push(
      this.bus.on('WeaknessClosed', () => {
        this.weakness = null;
      }),
    );
    // 命中音效交给 AudioPlayer 的事件表（TowerTargetHit / PlayerDamaged / BossSkillStart），
    // 这里不再重复触发，否则同一帧两套音源会叠成爆音。
  }

  // ── 对外 ──────────────────────────────────────────────────────────────────

  update(dtSec: number, fps: number): void {
    if (this.disposed) return;
    const snap = this.game.snapshot();
    this.t = this.game.timeline.tSec();
    this.phase = snap.phase;
    this.phaseT = Math.max(0, this.t - this.phaseStart);

    this.updateWake();
    this.updateNarration();
    this.updateBossShow(dtSec);
    this.updateEnvironment(dtSec);
    this.updateSparks(dtSec);
    this.updateShards(dtSec);
    this.book.update(dtSec, this.phaseT, this.phase, this.game.playerPos(), this.locksPlayer());
    this.updateCamera(dtSec, snap, fps);
    this.updateBookDom();
    this.updateFail(dtSec);
    this.updateWeaknessPulse();
  }

  /** 渲染帧恢复演出镜头；不再次推进粒子、教程书或 Boss 演出时序。 */
  presentCamera(): void {
    if (this.disposed) return;
    this.updateCamera(0, this.game.snapshot(), 0);
    this.camera.updateWorldMatrix(true, false);
  }

  interact(): boolean {
    if (this.phase !== 'tutorial') return false;
    const ok = this.book.interact();
    if (ok) this.audio?.play('sfx-ui-confirm');
    return ok;
  }

  locksPlayer(): boolean {
    const p = this.phase;
    return p === 'wake' || p === 'transition' || p === 'victory' || p === 'escape';
  }

  bossDamageAllowed(): boolean {
    return this.phase === 'boss1' || this.phase === 'boss2';
  }

  bossCanHurtPlayer(): boolean {
    return this.phase === 'boss1' || this.phase === 'boss2' || this.phase === 'rage';
  }

  startFail(reason = this.failReason): void {
    if (this.failStart >= 0) return;
    this.failStart = 0;
    this.failRealStart = typeof performance !== 'undefined' ? performance.now() : 0;
    this.failFired = false;
    this.overlay.setBlack(0);
    this.overlay.setBlur(0);
    this.overlay.setWhite(0);
    this.overlay.setNarration(null);
    this.overlay.setPrompt(null);
    this.overlay.setPages(null);
    this.overlay.setFail(0, 0, this.cfg.fail.text);
    void reason;
  }

  isFailing(): boolean {
    return this.failStart >= 0;
  }

  hudView(fps: number): HudView {
    const snap = this.game.snapshot();
    return {
      snap,
      matchLengthSec: this.cfg.matchLengthSec,
      nowSec: this.game.timeline.tSec(),
      boss: this.bossVisible ? this.boss.state : null,
      weakness: this.weaknessPulse(snap),
      debug: this.debugFlag
        ? { fps, phase: snap.phase, tSec: this.game.timeline.tSec() }
        : null,
    };
  }

  flowSnapshot(): Record<string, unknown> {
    const view = this.book.view();
    return {
      phase: this.phase,
      tSec: this.t,
      phaseT: this.phaseT,
      bossVisible: this.boss.root.visible,
      bossHp: this.boss.state.hp,
      bossPhase: this.boss.state.phase,
      bookNear: view.near,
      bookReading: view.reading,
      bookPage: view.pageIndex,
      bookVisible: this.book.isVisible(),
      failing: this.failStart >= 0,
      white: this.whiteAlpha,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.unsubs) unsub();
    this.book.dispose();
    this.avatar.dispose();
    this.scene.remove(this.mouth);
    this.scene.remove(this.beam);
    this.scene.remove(this.beamLight);
    this.scene.remove(this.coreLight);
    this.scene.remove(this.wash);
    if (this.shards) {
      this.scene.remove(this.shards.mesh);
      this.shards.mesh.geometry.dispose();
      this.shards.material.dispose();
    }
    for (const s of this.sparks) {
      this.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
    }
  }

  // ── 阶段 ──────────────────────────────────────────────────────────────────

  private onPhase(phase: MatchPhase, tSec: number): void {
    const prev = this.phase;
    this.phase = phase;
    this.phaseStart = tSec;
    this.phaseT = 0;
    if (phase === 'victory' || phase === 'escape' || phase === 'rage') {
      this.dynamicStarts.set(phase, tSec);
    }

    if (phase === 'boss1' && prev !== 'boss1') {
      this.bossVisible = true;
      this.bossSpawnPending = true;
      this.landingDone = false;
      this.boss.hideForShow();
      this.boss.root.position.set(...this.cfg.bossSpawn.mouthPos);
    }

    if (phase === 'transition' && prev !== 'transition') {
      this.boss.freezeBrain();
      this.boss.beginSink(this.cfg.transition.sinkSec * 1000, this.cfg.transition.sinkDepthM);
      this.phase2Applied = false;
      this.audio?.play('sfx-lava-rise');
    }

    if (phase === 'boss2') {
      this.boss.setBrainEnabled(true);
      this.restoreLights();
    }

    if (phase === 'victory' && prev !== 'victory') {
      this.boss.freezeBrain();
      this.spawnShatter();
      this.audio?.play('sfx-execution');
      this.beam.visible = true;
      this.coreLight.intensity = 40;
      this.shake(this.cfg.victoryShow.shakeSec, this.cfg.victoryShow.shakePx);
    }

    if (phase === 'escape' && prev !== 'escape') {
      this.escapeStart = tSec;
      this.escapePlayer = this.game.playerPos();
      this.avatar.setVisible(true);
    }

    if (phase === 'rage' && prev !== 'rage') {
      this.rageStart = tSec;
      this.audio?.play('sfx-lava-rise');
    }

    if (phase === 'ended') {
      this.overlay.setPrompt(null);
      this.overlay.setPages(null);
    }
  }

  // ── 苏醒 ──────────────────────────────────────────────────────────────────

  private updateWake(): void {
    const w = this.cfg.wake;
    if (this.phase !== 'wake') {
      this.overlay.setBlack(0);
      this.overlay.setBlur(0);
      return;
    }

    if (this.t < w.darkEndSec) {
      this.overlay.setBlack(1);
      this.overlay.setBlur(0);
      return;
    }

    const span = Math.max(1e-6, w.blurEndSec - w.darkEndSec);
    const k = clamp01((this.t - w.darkEndSec) / span);
    this.overlay.setBlack(1 - k);
    this.overlay.setBlur(w.blurMaxPx * (1 - k));
  }

  // ── 旁白 ──────────────────────────────────────────────────────────────────

  private narrationStart(phase: MatchPhase): number | null {
    const fixed = this.cfg.phases.find((p) => p.phase === phase);
    if (fixed) return fixed.startSec;
    return this.dynamicStarts.get(phase) ?? null;
  }

  private activeNarration(): { line: NarrationLine; opacity: number } | null {
    for (const line of this.cfg.narration) {
      const phaseStart = this.narrationStart(line.phase);
      if (phaseStart === null) continue;
      const start = phaseStart + line.atSec;
      const elapsed = this.t - start;
      if (elapsed < 0) continue;
      const fade = Math.max(1, line.fadeMs) / 1000;
      const hold = Math.max(0, line.holdMs) / 1000;
      if (elapsed > fade * 2 + hold) continue;

      let opacity = 1;
      if (elapsed < fade) opacity = elapsed / fade;
      else if (elapsed > fade + hold) opacity = 1 - (elapsed - fade - hold) / fade;
      return { line, opacity: clamp01(opacity) };
    }
    return null;
  }

  private updateNarration(): void {
    if (this.failStart >= 0) return;
    const active = this.activeNarration();
    if (!active) {
      this.overlay.setNarration(null);
      return;
    }
    const speaker = active.line.speaker ?? null;
    this.overlay.setNarration({
      text: active.line.text,
      speaker,
      speakerName: this.cfg.speakers[speaker ?? ''] ?? '',
      opacity: active.opacity,
    });
  }

  // ── Boss 登场 / 转场 ─────────────────────────────────────────────────────

  private updateBossShow(dtSec: number): void {
    const spawn = this.cfg.bossSpawn;
    const tr = this.cfg.transition;

    // 熔岩口：准备期开始翻涌；转阶段随全场一起压暗
    const trDark =
      this.phase === 'transition' &&
      this.phaseT >= tr.darkStartSec &&
      this.phaseT < tr.restoreEndSec;
    const mouthDim = trDark ? tr.darkFactor : 1;
    const prepPulse = this.phase === 'prep' ? 0.55 + Math.sin(this.t * 5.4) * 0.45 : 0.16;
    this.mouthLight.intensity = (120 + prepPulse * 260) * mouthDim;
    this.mouthGlow.scale.setScalar(0.94 + prepPulse * 0.1);
    (this.mouthGlow.material as THREE.MeshBasicMaterial).opacity =
      (0.16 + prepPulse * 0.22) * mouthDim;

    // 0:50 的 0.6 s 涟漪 → 1.5 s 升起 → 落地震屏 + 火星
    if (this.phase === 'boss1' && this.bossSpawnPending) {
      const rippleK = clamp01(this.phaseT / Math.max(0.001, spawn.rippleSec));
      this.ripple.visible = true;
      this.ripple.scale.setScalar(0.7 + rippleK * 1.1);
      (this.ripple.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - rippleK);

      if (this.phaseT >= spawn.rippleSec) {
        this.bossSpawnPending = false;
        this.ripple.visible = false;
        this.boss.beginSpawn({
          durMs: spawn.riseSec * 1000,
          fromY: spawn.fromY,
          toY: spawn.toY,
          fromScale: spawn.fromScale,
          toScale: spawn.toScale,
        });
        this.audio?.play('sfx-lava-rise');
      }
    }

    if (this.phase === 'boss1' && !this.landingDone) {
      const landedAt = spawn.rippleSec + spawn.riseSec;
      if (this.phaseT >= landedAt) {
        this.landingDone = true;
        this.shake(spawn.shakeSec, spawn.shakePx);
        this.spawnSparks(
          [spawn.mouthPos[0], spawn.toY + 0.4, spawn.mouthPos[2]],
          spawn.sparkCount,
          0xff8a3a,
          6.5,
        );
        this.audio?.play('sfx-hit');
      }
    }

    // 转阶段：沉入 → 变暗 → 熔岩上涨 + 起身变高 → 复光
    if (this.phase === 'transition') {
      const riseStart = tr.riseStartSec;
      if (!this.phase2Applied && this.phaseT >= riseStart) {
        this.phase2Applied = true;
        this.boss.forcePhase2(false);
        this.boss.beginRise(
          (tr.riseEndSec - tr.riseStartSec) * 1000,
          tr.bossScale2,
        );
        this.audio?.play('sfx-lava-rise');
      }
      if (this.phaseT >= tr.riseEndSec) {
        this.boss.setBrainEnabled(true);
      }
    }

    if (this.phase === 'boss2') {
      this.boss.setBrainEnabled(true);
    }

    // 胜利：碎块 + 光柱
    if (this.phase === 'victory') {
      const v = this.cfg.victoryShow;
      const k = clamp01(this.phaseT / Math.max(0.001, v.beamGrowSec));
      this.beam.visible = true;
      this.beam.scale.y = v.beamFromM + (v.beamToM - v.beamFromM) * k;
      this.beamMaterial.opacity = 0.05 + (v.beamOpacity - 0.05) * k;
      this.beamLight.intensity = 60 + 600 * k;
      this.coreLight.intensity = 40 + 360 * k;
      this.wash.intensity = v.washIntensity * k;
      this.coolKey.intensity = 3.4 * k;
    }

    // 转阶段：塔心冷青光柱先亮起来（细一点），Boss 站起后收回
    if (this.phase === 'transition') {
      const lit = this.phaseT >= tr.darkStartSec && this.phaseT < tr.restoreEndSec;
      this.beam.visible = lit;
      if (lit) {
        this.beam.scale.y = 30;
        this.beamMaterial.opacity = 0.05;
      }
    } else if (this.phase === 'boss1' || this.phase === 'boss2') {
      this.beam.visible = false;
      this.beamMaterial.opacity = 0;
    }

    if (this.phase === 'escape') {
      this.beam.visible = true;
      this.beam.scale.y = this.cfg.victoryShow.beamToM;
      // 第三人称镜头会穿过光柱：压低不透明度，保证人形与塔身仍可读
      this.beamMaterial.opacity = 0.09;
      this.beamLight.intensity = 660;
      this.coreLight.intensity = 400;
      this.wash.intensity = this.cfg.victoryShow.washIntensity;
      this.coolKey.intensity = 3.4;
    }

    if (this.phase === 'rage') {
      const v = this.cfg.victoryShow;
      this.wash.intensity = 0.25;
      void v;
    }

    void dtSec;
  }

  // ── 环境（灯光 / 熔岩）──────────────────────────────────────────────────

  private updateEnvironment(dtSec: number): void {
    const tr = this.cfg.transition;
    const vic = this.cfg.victoryShow;

    let scale = 1;
    if (this.phase === 'transition') {
      if (this.phaseT < tr.darkStartSec) scale = 1;
      else if (this.phaseT < tr.darkEndSec) {
        scale = 1 + (tr.darkFactor - 1) * ((this.phaseT - tr.darkStartSec) / Math.max(1e-6, tr.darkEndSec - tr.darkStartSec));
      } else if (this.phaseT < tr.riseEndSec) scale = tr.darkFactor;
      else if (this.phaseT < tr.restoreEndSec) {
        scale = tr.darkFactor + (1 - tr.darkFactor) * ((this.phaseT - tr.riseEndSec) / Math.max(1e-6, tr.restoreEndSec - tr.riseEndSec));
      }
    } else if (this.phase === 'victory' || this.phase === 'escape') {
      // 胜利：暖光退到 45%，让冷青洗地成为主色
      scale = 0.45;
    }
    this.applyLightScale(scale);

    // 转场期间塔心的冷青光
    if (this.phase === 'transition' && this.phaseT >= tr.darkStartSec && this.phaseT < tr.restoreEndSec) {
      this.coreLight.intensity = 220 + Math.sin(this.t * 3.2) * 30;
    } else if (this.phase !== 'victory' && this.phase !== 'escape') {
      this.coreLight.intensity = 0;
    }

    // 熔岩海：转场 +2 m（10–13 s），狂暴每秒 +1 m
    const base = this.lava.lavaBaseY;
    if (this.phase === 'transition') {
      const k = clamp01(
        (this.phaseT - tr.lavaRiseStartSec) / Math.max(1e-6, tr.lavaRiseEndSec - tr.lavaRiseStartSec),
      );
      this.lava.setLavaY(base + tr.visualLavaRiseM * k);
    } else if (this.phase === 'rage' && this.rageStart >= 0) {
      const elapsed = Math.max(0, this.t - this.rageStart);
      this.lava.setLavaY(base + tr.visualLavaRiseM + this.cfg.rage.risePerSec * elapsed);
    } else if (this.phase === 'victory' || this.phase === 'escape') {
      this.lava.setLavaY(base + tr.visualLavaRiseM);
    } else if (this.phase === 'wake' || this.phase === 'tutorial' || this.phase === 'prep') {
      this.lava.setLavaY(base);
    }

    // 狂暴的红色边缘
    if (this.phase === 'rage') {
      this.overlay.setVignette(0.55 + Math.sin(this.t * 4) * 0.12);
    } else {
      this.overlay.setVignette(0);
    }

    // 胜利冷光洗地（Hemisphere + 冷青主光）
    if (this.phase === 'victory') {
      this.wash.intensity = vic.washIntensity * clamp01(this.phaseT / 6);
      if (this.phaseT < 0.1) this.coolKey.intensity = 0;
    } else if (this.phase === 'escape') {
      this.coolKey.intensity = 3.4;
    } else {
      this.coolKey.intensity = 0;
    }

    void dtSec;
  }

  private applyLightScale(scale: number): void {
    for (const entry of this.baseLights) entry.light.intensity = entry.intensity * scale;
  }

  private restoreLights(): void {
    this.applyLightScale(1);
  }

  // ── 镜头 ──────────────────────────────────────────────────────────────────

  private updateCamera(dtSec: number, snap: Snapshot, fps: number): void {
    void fps;
    const eye = playerCfg.movement.eyeHeight;
    const p = snap.player.pos;
    const eyePos = this.cameraEye.set(p[0], p[1] + eye, p[2]);
    const yaw = snap.player.yaw;
    const forward = this.cameraForward.set(-Math.sin(yaw), 0, -Math.cos(yaw));

    let fov = this.baseFov;
    let pos: THREE.Vector3 | null = null;
    let target: THREE.Vector3 | null = null;

    if (this.phase === 'wake') {
      const w = this.cfg.wake;
      const span = Math.max(1e-6, w.blurEndSec - w.darkEndSec);
      const k = clamp01((this.t - w.darkEndSec) / span);
      const pitch = THREE.MathUtils.degToRad(w.pitchStartDeg + (w.pitchEndDeg - w.pitchStartDeg) * k);
      const dir = this.cameraDirection.set(0, Math.sin(pitch), -Math.cos(pitch));
      pos = this.cameraPosition.copy(eyePos);
      target = this.cameraTarget.copy(eyePos).addScaledVector(dir, 12);
    } else if (this.phase === 'transition') {
      // 玩家不能动，镜头小幅跟随 Boss
      const bp = this.boss.root.position;
      const bossTarget = this.cameraFocus.set(bp.x, bp.y + 4.5, bp.z);
      pos = this.cameraPosition.copy(eyePos);
      target = this.cameraTarget.copy(eyePos).addScaledVector(forward, 12).lerp(bossTarget, 0.5);
    } else if (this.phase === 'victory') {
      // 镜头上抬，让塔顶与冲天光柱进入画面
      const k = clamp01(this.phaseT / 8);
      pos = this.cameraPosition.copy(eyePos);
      target = this.cameraTarget.set(0, 18 + k * 12, 0);
      fov = this.baseFov - 2 * k;
    } else if (this.phase === 'escape') {
      const esc = this.cfg.escape;
      const start = this.escapeStart >= 0 ? this.escapeStart : this.t;
      const k = clamp01((this.t - start) / Math.max(1e-6, this.cfg.victory.escapeDurationSec));
      const angle0 = Math.atan2(this.escapePlayer[0], this.escapePlayer[2]);
      const angle = angle0 + esc.orbitTurns * Math.PI * 2 * k;
      const rise = easeInOut(k);
      const px = this.escapePlayer[0] * (1 - rise);
      const pz = this.escapePlayer[2] * (1 - rise);
      const py = esc.avatarRiseToM * rise;
      this.avatar.setVisible(true);
      this.avatar.setPose(
        [px, py, pz],
        snap.player.yaw,
        avatarOpacity(k, esc.avatarFadeStartSec, esc.avatarFadeEndSec),
      );
      target = this.cameraTarget.set(px, py + 1.2, pz);
      const radius = esc.orbitRadiusM + (esc.orbitEndRadiusM - esc.orbitRadiusM) * rise;
      pos = this.cameraPosition.copy(target).add(
        this.cameraDirection.set(
          Math.sin(angle) * radius,
          esc.orbitHeightM,
          Math.cos(angle) * radius,
        ),
      );
      fov = this.baseFov;
    } else {
      // 教程书阅读态：镜头轻推近（不暂停游戏）
      const view = this.book.view();
      if (view.cameraBlend > 0.01) {
        const focus = this.cameraFocus.set(...view.focus);
        const dirToBook = this.cameraDirection.subVectors(focus, eyePos);
        const dist = dirToBook.length();
        const nearPos = this.cameraNear.copy(focus).addScaledVector(dirToBook.normalize(), -Math.min(1.5, dist * 0.55));
        nearPos.y += 0.18;
        pos = this.cameraPosition.copy(eyePos).lerp(nearPos, view.cameraBlend);
        target = this.cameraTarget.copy(eyePos).addScaledVector(forward, 12).lerp(focus, view.cameraBlend);
        fov = this.baseFov + (this.cfg.tutorial.readingFov - this.baseFov) * view.cameraBlend;
      }
    }

    if (pos && target) {
      this.camera.position.copy(pos);
      if (this.shakeT > 0) {
        const k = this.shakeT / Math.max(1e-6, this.shakeDur);
        const amp = this.shakePx * k * 0.012;
        this.camera.position.x += (Math.random() - 0.5) * amp * 2;
        this.camera.position.y += (Math.random() - 0.5) * amp * 2;
      }
      this.camera.lookAt(target);
    }

    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dtSec);

    if (Math.abs(this.camera.fov - fov) > 0.02) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // 书页提示 / 纸页（DOM）在 updateBookDom 里做
    // 传送白光
    if (this.phase === 'escape' && this.escapeStart >= 0) {
      const esc = this.cfg.escape;
      const elapsed = this.t - this.escapeStart;
      const wk = clamp01((elapsed - esc.whiteStartSec) / Math.max(1e-6, esc.whiteFadeSec));
      this.whiteAlpha = wk;
      this.overlay.setWhite(wk);
    } else if (this.phase !== 'escape') {
      this.whiteAlpha = 0;
      this.overlay.setWhite(0);
    }
  }

  private updateBookDom(): void {
    if (this.failStart >= 0) return;
    const view = this.book.view();
    this.overlay.setPrompt(view.near && !view.reading ? this.cfg.tutorial.prompt : null);
    this.overlay.setPages(
      view.reading
        ? {
            text: view.pageText,
            index: view.pageIndex,
            total: view.pageTotal,
            hint: this.cfg.tutorial.pageHint,
            opacity: 1,
          }
        : null,
    );
  }

  private shake(seconds: number, px: number): void {
    this.shakeT = seconds;
    this.shakeDur = Math.max(1e-6, seconds);
    this.shakePx = px;
  }

  // ── 火星 / 碎块 ──────────────────────────────────────────────────────────

  private spawnSparks(origin: Vec3, count: number, color: number, speed: number): void {
    const geo = new THREE.OctahedronGeometry(0.06, 0);
    for (let i = 0; i < count; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(origin[0], origin[1], origin[2]);
      this.scene.add(mesh);
      const a = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.5;
      this.sparks.push({
        mesh,
        vx: Math.cos(a) * speed * (0.6 + Math.random() * 0.6),
        vy: 2.5 + Math.random() * 3.2,
        vz: Math.sin(a) * speed * (0.6 + Math.random() * 0.6),
        age: 0,
        life: 0.9 + Math.random() * 0.5,
      });
    }
  }

  private updateSparks(dtSec: number): void {
    for (let i = this.sparks.length - 1; i >= 0; i -= 1) {
      const s = this.sparks[i];
      s.age += dtSec;
      s.vy -= 9.5 * dtSec;
      s.mesh.position.x += s.vx * dtSec;
      s.mesh.position.y += s.vy * dtSec;
      s.mesh.position.z += s.vz * dtSec;
      s.mesh.rotation.x += dtSec * 8;
      s.mesh.rotation.y += dtSec * 6;
      const k = clamp01(1 - s.age / s.life);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = k;
      s.mesh.scale.setScalar(0.6 + k * 0.8);
      if (s.age >= s.life) {
        this.scene.remove(s.mesh);
        (s.mesh.material as THREE.Material).dispose();
        this.sparks.splice(i, 1);
      }
    }
  }

  private spawnShatter(): void {
    if (this.shards) return;
    const cfg = this.cfg.victoryShow;
    const pose = this.boss.deathPose();
    const geo = new THREE.BoxGeometry(0.62, 0.62, 0.62);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0706,
      roughness: 0.95,
      metalness: 0.05,
      emissive: 0xff5a12,
      emissiveIntensity: 0.55,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, cfg.shardCount);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    const base: Array<{ x: number; y: number; z: number }> = [];
    const vel: Array<{ x: number; y: number; z: number }> = [];
    const delay: number[] = [];

    for (let i = 0; i < cfg.shardCount; i += 1) {
      const fy = Math.random();
      const x = (Math.random() - 0.5) * 5.2 * pose.scale;
      const y = fy * 9 * pose.scale;
      const z = (Math.random() - 0.5) * 4.2 * pose.scale;
      base.push({ x, y, z });
      const a = Math.random() * Math.PI * 2;
      const outward = 1.6 + Math.random() * 3.6;
      vel.push({
        x: Math.cos(a) * outward,
        y: 0.8 + Math.random() * 2.4,
        z: Math.sin(a) * outward,
      });
      delay.push(fy * cfg.shatterSec);
      this.dummy.position.set(pose.pos[0] + x, pose.pos[1] + y, pose.pos[2] + z);
      this.dummy.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      this.dummy.scale.setScalar(0.75 + Math.random() * 0.7);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;

    this.shards = {
      mesh,
      origin: new THREE.Vector3(pose.pos[0], pose.pos[1], pose.pos[2]),
      base,
      vel,
      delay,
      age: 0,
      material: mat,
    };
  }

  private updateShards(dtSec: number): void {
    const field = this.shards;
    if (!field) return;
    field.age += dtSec;
    const count = field.base.length;

    for (let i = 0; i < count; i += 1) {
      const t = field.age - field.delay[i];
      if (t < 0) continue;
      const b = field.base[i];
      const v = field.vel[i];
      const x = field.origin.x + b.x + v.x * t;
      const y = field.origin.y + b.y + v.y * t - 4.9 * t * t;
      const z = field.origin.z + b.z + v.z * t;
      this.dummy.position.set(x, y, z);
      this.dummy.rotation.set(t * 3 + i, t * 2.2 + i * 0.7, t * 1.7);
      this.dummy.scale.setScalar(0.8 + Math.sin(i) * 0.2);
      this.dummy.updateMatrix();
      field.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    field.mesh.instanceMatrix.needsUpdate = true;

    if (field.age > this.cfg.victoryShow.shardLifeSec) {
      const k = clamp01((field.age - this.cfg.victoryShow.shardLifeSec) / 1.5);
      field.material.transparent = true;
      field.material.opacity = 1 - k;
      if (k >= 1) {
        this.scene.remove(field.mesh);
        field.mesh.geometry.dispose();
        field.material.dispose();
        this.shards = null;
      }
    }
  }

  // ── 弱点方向 ──────────────────────────────────────────────────────────────

  private updateWeaknessPulse(): void {
    const w = this.weakness;
    if (!w || this.t > w.untilT) {
      this.weakness = null;
    }
  }

  private weaknessPulse(snap: Snapshot): HudView['weakness'] {
    const w = this.weakness;
    if (!w) return null;
    const p = snap.player.pos;
    const b = this.boss.root.position;
    const dx = b.x - p[0];
    const dz = b.z - p[2];
    const len = Math.hypot(dx, dz) || 1;
    const yaw = snap.player.yaw;
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const side = (dx / len) * rightX + (dz / len) * rightZ;
    const pulse = 0.62 + Math.sin(this.t * 6.5) * 0.3;
    const norm = Math.max(-1, Math.min(1, side));
    return {
      attr: w.attr,
      left: (0.16 + Math.max(0, -norm) * 0.9) * pulse,
      right: (0.16 + Math.max(0, norm) * 0.9) * pulse,
    };
  }

  // ── 失败 ──────────────────────────────────────────────────────────────────

  private updateFail(dtSec: number): void {
    if (this.failStart < 0) return;
    void dtSec;
    // 失败演出的 0.6 s / 3 s 是真实时间，不随逻辑帧率或 ?speed 缩放
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const elapsed = Math.max(0, (now - this.failRealStart) / 1000);
    const cfg = this.cfg.fail;
    const black = clamp01(elapsed / Math.max(1e-6, cfg.blackSec));
    const textK =
      elapsed <= cfg.blackSec
        ? 0
        : clamp01((elapsed - cfg.blackSec) / Math.max(1e-6, cfg.textFadeSec));
    this.overlay.setFail(black, textK, cfg.text);
    this.overlay.setNarration(null);
    this.overlay.setPrompt(null);
    this.overlay.setPages(null);

    if (!this.failFired && elapsed >= cfg.blackSec + cfg.handoffDelaySec) {
      this.failFired = true;
      this.onFail(this.failReason);
    }
  }

  // 供 main 做调试/证据快照
  debugState(): {
    phase: MatchPhase;
    tSec: number;
    phaseT: number;
    bossVisible: boolean;
    bossHp: number;
    failing: boolean;
  } {
    return {
      phase: this.phase,
      tSec: this.t,
      phaseT: this.phaseT,
      bossVisible: this.boss.root.visible,
      bossHp: this.boss.state.hp,
      failing: this.failStart >= 0,
    };
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function avatarOpacity(k: number, fadeStart: number, fadeEnd: number): number {
  if (k <= fadeStart) return 1;
  if (k >= fadeEnd) return 0;
  return 1 - (k - fadeStart) / Math.max(1e-6, fadeEnd - fadeStart);
}
