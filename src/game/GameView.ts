// src/game/GameView.ts
// ============================================================================
// 整合层 · 渲染表现（S0 维护）
// ----------------------------------------------------------------------------
// 职责：把逻辑状态「画出来」。只读快照与事件，不持有任何逻辑对象引用。
//
//   · 塔位标记（11 个圆盘，按状态变色）
//   · 已建塔（五种独立模型 + 岩石 PBR + 战斗状态动画）
//   · 第一人称相机（跟随玩家位置与朝向）
//
// 这里可以用 three，因为它属于渲染表现层，不是逻辑层。
// ============================================================================

import * as THREE from 'three/webgpu';
import type { Bus, SlotState, Vec3 } from '../core/events';
import type { AttackOutcome } from '../player/weaponTypes';
import type { TowerKind } from '../towers/types';
import type { Game } from './GameLoop';
import { createViewModel } from '../render/ViewModel';

/** 属性色：与 config/visual.json 的约定一致（法术蓝 / 物理白金） */
const ATTR_COLOR = {
  arcane: 0x4aa8ff,
  physical: 0xf2ead6,
  none: 0x8a7f74,
} as const;

const SLOT_COLOR: Record<SlotState, number> = {
  locked: 0x3a3028,
  open: 0xff8a3c,
  occupied: 0x6a5a4a,
  submerged: 0x2a1a14,
};

export interface GameView {
  /** 每帧调用：同步逻辑状态到场景对象 */
  sync(): void;
  /** 每次武器产生攻击结果（含空挥/空枪）时调用，驱动第一人称攻击表现 */
  onAttack(outcome: AttackOutcome): void;
  /** 释放 */
  dispose(): void;
  /** 切换俯视战术视角（true=俯视，false=第一人称） */
  setTactical(on: boolean): void;
  /** 当前是否处于俯视 */
  isTactical(): boolean;
  /** 屏幕坐标（CSS 像素）→ 命中的塔位 id，没打中返回 null */
  pickTowerSlot(clientX: number, clientY: number): string | null;
}

export function createGameView(deps: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  bus: Bus;
  game: Game;
  /** 只读视角源：相机直接读它，不经固定步长的逻辑帧 */
  aim: () => { yaw: number; pitch: number };
}): GameView {
  const { scene, camera, bus, game, aim } = deps;

  // 第一人称武器外观：长剑 / 法伤枪，跟随相机
  const viewModel = createViewModel({ camera, scene, bus });

  // ── 塔位标记 ──────────────────────────────────────────────────────────────
  const slotMeshes = new Map<string, THREE.Mesh>();
  const slotGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.18, 12);
  for (const slot of game.towers.slots()) {
    const mat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(SLOT_COLOR[slot.state]),
      roughness: 0.7,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(slotGeo, mat);
    mesh.position.set(slot.pos[0], slot.pos[1] + 0.1, slot.pos[2]);
    scene.add(mesh);
    slotMeshes.set(slot.slotId, mesh);
  }

  // ── 已建塔：五种独立轮廓 + 深色岩石 PBR，不再使用统一纯色方块 ─────────────
  const towerMeshes = new Map<string, TowerVisual>();
  // 贴图按需加载：没建过塔就不去 load 三张 JPG（无 DOM 的单测环境也不会在这里炸）
  let stoneTextures: StoneTextures | null = null;
  const getStoneTextures = (): StoneTextures => (stoneTextures ??= loadStoneTextures());

  function ensureTowerMesh(id: string, kind: TowerKind, pos: Vec3): TowerVisual {
    let visual = towerMeshes.get(id);
    if (visual) return visual;
    visual = createTowerVisual(kind, pos, getStoneTextures());
    scene.add(visual.root);
    towerMeshes.set(id, visual);
    return visual;
  }

  function removeTowerMesh(id: string): void {
    const visual = towerMeshes.get(id);
    if (!visual) return;
    scene.remove(visual.root);
    visual.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    for (const material of visual.materials) material.dispose();
    towerMeshes.delete(id);
  }

  // ── 事件订阅：建塔/拆塔即时响应 ─────────────────────────────────────────
  const unsubs: Array<() => void> = [];
  unsubs.push(bus.on('TowerPlaced', (p) => {
    ensureTowerMesh(p.towerId, p.kind as TowerKind, p.pos);
  }));
  unsubs.push(bus.on('TowerDestroyed', (p) => {
    removeTowerMesh(p.towerId);
  }));
  unsubs.push(bus.on('TowerTargetHit', (p) => {
    const visual = towerMeshes.get(p.towerId);
    if (visual) visual.attack = 1;
  }));
  unsubs.push(bus.on('TowerInterruptRequested', (p) => {
    const visual = towerMeshes.get(p.towerId);
    if (visual) visual.attack = 1;
  }));
  unsubs.push(bus.on('TauntStarted', (p) => {
    const visual = towerMeshes.get(p.towerId);
    if (visual) visual.attack = 1;
  }));
  unsubs.push(bus.on('TowerHpChanged', (p) => {
    const visual = towerMeshes.get(p.towerId);
    if (!visual) return;
    visual.maxHp = Math.max(1, p.maxHp);
    visual.hit = 1;
  }));
  unsubs.push(bus.on('TowerUpgraded', (p) => {
    const visual = towerMeshes.get(p.towerId);
    if (visual) visual.upgrade = 1;
  }));

  // ── 每帧同步 ─────────────────────────────────────────────────────────────
  const camDir = new THREE.Vector3();
  const eyeHeight = 1.7;
  // perf(#13)：alive 提到 sync 外复用，避免每帧新建 Set
  const alive = new Set<string>();
  // 塔动画计时（#11 的模型状态动画要按帧推进）
  let lastTowerFrame = performance.now() / 1000;

  function sync(): void {
    viewModel.update();

    // 1. 塔位状态色 + 准备期高亮脉冲（0:40–0:50「塔位亮起」）
    const snap = game.snapshot();
    const prepPulse =
      snap.phase === 'prep' ? 0.55 + Math.sin(performance.now() * 0.006) * 0.4 : 0;
    for (const slot of snap.towerSlots) {
      const mesh = slotMeshes.get(slot.slotId);
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshStandardNodeMaterial;
      mat.color.setHex(SLOT_COLOR[slot.state]);
      mat.emissive.setHex(SLOT_COLOR[slot.state]);
      mat.emissiveIntensity = slot.state === 'open' ? prepPulse : 0;
    }

    // 2. 已建塔（快照是唯一数据源；动画只消费事件，不回写逻辑）
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - lastTowerFrame));
    lastTowerFrame = now;
    alive.clear();
    for (const t of snap.towers) {
      alive.add(t.id);
      const visual = ensureTowerMesh(t.id, t.kind as TowerKind, t.pos);
      updateTowerVisual(visual, t.level, t.hp, now, dt);
    }
    for (const id of towerMeshes.keys()) {
      if (!alive.has(id)) removeTowerMesh(id);
    }

    // 3. 相机：第一人称 / 俯视战术视角
    if (tactical) {
      // 俯视：从正上方 95 米看下来（塔顶平台在 y=24，必须高于它才能看穿）
      camera.position.set(0, 95, tacticalTarget.z);
      camera.lookAt(tacticalTarget.x, 0, tacticalTarget.z);
      // 塔位做成发光环，俯视时一眼看清哪个能建
      const pulse = 0.6 + Math.sin(performance.now() * 0.004) * 0.35;
      for (const slot of snap.towerSlots) {
        const mesh = slotMeshes.get(slot.slotId);
        if (!mesh) continue;
        const mat = mesh.material as THREE.MeshStandardNodeMaterial;
        const open = slot.state === 'open';
        mat.emissive.setHex(open ? 0x66ffcc : 0x442222);
        mat.emissiveIntensity = open ? pulse : 0.1;
      }
    } else {
      const pos = game.playerPos();
      const view = aim();
      // 位置做一阶平滑：逻辑帧 60Hz、渲染帧率浮动，直接贴会让画面抖
      camera.position.set(pos[0], pos[1] + eyeHeight, pos[2]);
      const cp = Math.cos(view.pitch);
      camDir.set(
        -Math.sin(view.yaw) * cp,
        Math.sin(view.pitch),
        -Math.cos(view.yaw) * cp,
      );
      camera.lookAt(
        camera.position.x + camDir.x,
        camera.position.y + camDir.y,
        camera.position.z + camDir.z,
      );
    }
  }

  let tactical = false;
  const tacticalTarget = new THREE.Vector3(0, 0, 8);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  return {
    setTactical(on: boolean): void {
      tactical = on;
    },
    isTactical(): boolean {
      return tactical;
    },
    pickTowerSlot(clientX: number, clientY: number): string | null {
      // canvas 固定铺满视口，直接用窗口尺寸换算 NDC
      ndc.x = (clientX / window.innerWidth) * 2 - 1;
      ndc.y = -(clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const meshes = [...slotMeshes.values()];
      const hit = raycaster.intersectObjects(meshes, false)[0];
      if (!hit) return null;
      for (const [id, mesh] of slotMeshes) {
        if (mesh === hit.object) return id;
      }
      return null;
    },
    sync,
    onAttack: (outcome) => viewModel.onAttack(outcome),
    dispose(): void {
      viewModel.dispose();
      for (const unsub of unsubs) unsub();
      for (const id of [...towerMeshes.keys()]) removeTowerMesh(id);
      for (const texture of Object.values(stoneTextures ?? {})) texture.dispose();
      for (const mesh of slotMeshes.values()) {
        scene.remove(mesh);
        (mesh.material as THREE.Material).dispose();
      }
      slotMeshes.clear();
      slotGeo.dispose();
    },
  };
}

interface StoneTextures {
  diffuse: THREE.Texture;
  normal: THREE.Texture;
  roughness: THREE.Texture;
}

interface TowerVisual {
  root: THREE.Group;
  head: THREE.Group;
  levelTwo: THREE.Group;
  materials: THREE.Material[];
  stone: THREE.MeshStandardNodeMaterial;
  stoneColor: THREE.Color;
  glow: THREE.MeshStandardNodeMaterial;
  kind: TowerKind;
  bornAt: number;
  headBaseY: number;
  maxHp: number;
  attack: number;
  hit: number;
  upgrade: number;
}

/** Dark Rock 02 · Amal Kumar / Poly Haven · CC0 · https://polyhaven.com/a/dark_rock_02 */
function loadStoneTextures(): StoneTextures {
  const loader = new THREE.TextureLoader();
  const diffuse = loader.load('/textures/dark-rock-02/diffuse.jpg');
  const normal = loader.load('/textures/dark-rock-02/normal.jpg');
  const roughness = loader.load('/textures/dark-rock-02/roughness.jpg');
  diffuse.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [diffuse, normal, roughness]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.4, 1.4);
    texture.anisotropy = 8;
  }
  return { diffuse, normal, roughness };
}

function createTowerVisual(kind: TowerKind, pos: Vec3, textures: StoneTextures): TowerVisual {
  const root = new THREE.Group();
  root.name = `defense-tower-${kind}`;
  root.position.set(...pos);

  const stone = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0xa99c90),
    map: textures.diffuse,
    normalMap: textures.normal,
    normalScale: new THREE.Vector2(0.65, 0.65),
    roughnessMap: textures.roughness,
    roughness: 0.92,
    metalness: 0.04,
  });
  const metal = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x211c1a),
    roughness: 0.38,
    metalness: 0.72,
  });
  const glowColor =
    kind === 'ballista'
      ? ATTR_COLOR.physical
      : kind === 'rune' || kind === 'frost'
        ? ATTR_COLOR.arcane
        : kind === 'quake'
          ? 0xff7838
          : 0xff5a32;
  const glow = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(glowColor).multiplyScalar(0.35),
    emissive: new THREE.Color(glowColor),
    emissiveIntensity: 1.2,
    roughness: 0.3,
    metalness: 0.12,
  });
  const accentColor =
    kind === 'frost' ? 0x79d8ee : kind === 'rune' ? 0x263e54 : kind === 'ballista' ? 0x65472c : 0x392725;
  const accent = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(accentColor),
    emissive: new THREE.Color(glowColor),
    emissiveIntensity: kind === 'frost' ? 0.42 : 0.12,
    roughness: kind === 'frost' ? 0.18 : 0.48,
    metalness: kind === 'frost' ? 0.08 : 0.45,
  });
  const materials = [stone, metal, glow, accent];
  const head = new THREE.Group();
  root.add(head);

  // 所有塔共享低矮八角基座，保持与场景塔位的视觉衔接。
  addMesh(root, new THREE.CylinderGeometry(0.82, 0.94, 0.34, 8), stone, [0, 0.17, 0]);
  addMesh(root, new THREE.CylinderGeometry(0.72, 0.78, 0.13, 8), metal, [0, 0.405, 0]);
  addMesh(root, new THREE.TorusGeometry(0.63, 0.035, 5, 32), glow, [0, 0.48, 0], [Math.PI / 2, 0, 0]);

  let crownY = 2.35;
  if (kind === 'ballista') {
    // 弩炮：高底座、横向弩臂与长弩矢，远距离也能读出“物理输出”。
    addMesh(root, new THREE.CylinderGeometry(0.43, 0.61, 1.18, 8), stone, [0, 1.02, 0]);
    addMesh(root, new THREE.CylinderGeometry(0.58, 0.58, 0.15, 8), metal, [0, 1.64, 0]);
    head.position.y = 1.79;
    addMesh(head, new THREE.BoxGeometry(0.24, 0.22, 1.55), metal, [0, 0, 0.25]);
    addMesh(head, new THREE.BoxGeometry(1.72, 0.12, 0.16), accent, [0, 0.04, 0.64]);
    addMesh(head, new THREE.BoxGeometry(0.065, 0.065, 1.72), glow, [0, 0.17, 0.38]);
    for (const sign of [-1, 1]) {
      addMesh(head, new THREE.BoxGeometry(0.65, 0.1, 0.13), metal, [sign * 0.69, 0.04, 0.62], [0, sign * 0.38, 0]);
    }
    crownY = 2.15;
  } else if (kind === 'rune') {
    // 符文：三根倾斜支柱夹住悬浮晶体，突出法术聚能。
    addMesh(root, new THREE.CylinderGeometry(0.42, 0.62, 0.82, 8), stone, [0, 0.86, 0]);
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * Math.PI * 2;
      addMesh(
        root,
        new THREE.BoxGeometry(0.17, 1.25, 0.17),
        metal,
        [Math.cos(a) * 0.48, 1.35, Math.sin(a) * 0.48],
        [Math.sin(a) * 0.2, -a, -Math.cos(a) * 0.2],
      );
    }
    head.position.y = 1.65;
    addMesh(head, new THREE.OctahedronGeometry(0.47, 0), accent, [0, 0.36, 0]);
    addMesh(head, new THREE.TorusGeometry(0.68, 0.035, 5, 40), glow, [0, 0.18, 0], [Math.PI / 2, 0, 0]);
    addMesh(head, new THREE.TorusGeometry(0.53, 0.022, 5, 36), glow, [0, 0.42, 0], [0.45, 0, 0.3]);
    crownY = 2.65;
  } else if (kind === 'frost') {
    // 寒晶：非对称晶簇，和符文塔的单晶体轮廓明确区分。
    addMesh(root, new THREE.CylinderGeometry(0.56, 0.7, 0.62, 8), stone, [0, 0.76, 0]);
    head.position.y = 1.02;
    addMesh(head, new THREE.ConeGeometry(0.4, 1.72, 6), accent, [0, 0.86, 0]);
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI * 2 + 0.35;
      addMesh(
        head,
        new THREE.ConeGeometry(0.22, 1.05 + (i % 2) * 0.25, 5),
        accent,
        [Math.cos(a) * 0.43, 0.53, Math.sin(a) * 0.43],
        [Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3],
      );
    }
    addMesh(head, new THREE.OctahedronGeometry(0.19, 0), glow, [0, 0.58, 0]);
    crownY = 2.65;
  } else if (kind === 'quake') {
    // 震地锚：宽底座、四只锚脚和可下砸的重锤，强调控制而非输出。
    addMesh(root, new THREE.CylinderGeometry(0.69, 0.84, 0.62, 8), stone, [0, 0.77, 0]);
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      addMesh(root, new THREE.BoxGeometry(0.3, 0.24, 0.8), metal, [Math.cos(a) * 0.62, 0.42, Math.sin(a) * 0.62], [0, -a, 0]);
    }
    addMesh(root, new THREE.CylinderGeometry(0.25, 0.34, 1.15, 8), metal, [0, 1.46, 0]);
    head.position.y = 1.93;
    addMesh(head, new THREE.BoxGeometry(1.48, 0.42, 0.72), accent);
    addMesh(head, new THREE.BoxGeometry(1.04, 0.06, 0.76), glow, [0, -0.23, 0]);
    crownY = 2.35;
  } else {
    // 图腾：低矮梯形身、双眼与侧角，表现“吸引仇恨”的面孔。
    head.position.y = 0;
    addMesh(head, new THREE.CylinderGeometry(0.56, 0.72, 0.5, 6), stone, [0, 0.72, 0]);
    addMesh(head, new THREE.BoxGeometry(0.92, 0.75, 0.66), stone, [0, 1.28, 0]);
    addMesh(head, new THREE.BoxGeometry(0.7, 0.54, 0.58), accent, [0, 1.89, 0]);
    for (const sign of [-1, 1]) {
      addMesh(head, new THREE.ConeGeometry(0.17, 0.72, 5), metal, [sign * 0.63, 1.96, 0], [0, 0, -sign * Math.PI / 2]);
      addMesh(head, new THREE.BoxGeometry(0.16, 0.08, 0.035), glow, [sign * 0.2, 1.94, 0.305]);
    }
    addMesh(head, new THREE.BoxGeometry(0.09, 0.34, 0.035), glow, [0, 1.55, 0.35]);
    crownY = 2.55;
  }

  // 二级冠环：升级后无需看 UI 也能辨认。
  const levelTwo = new THREE.Group();
  levelTwo.visible = false;
  addMesh(levelTwo, new THREE.TorusGeometry(0.62, 0.025, 5, 36), glow, [0, crownY, 0], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2;
    addMesh(levelTwo, new THREE.OctahedronGeometry(0.09, 0), glow, [Math.cos(a) * 0.62, crownY, Math.sin(a) * 0.62]);
  }
  root.add(levelTwo);

  return {
    root,
    head,
    levelTwo,
    materials,
    stone,
    stoneColor: stone.color.clone(),
    glow,
    kind,
    bornAt: performance.now() / 1000,
    headBaseY: head.position.y,
    maxHp: 1,
    attack: 0,
    hit: 0,
    upgrade: 0,
  };
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function updateTowerVisual(visual: TowerVisual, level: number, hp: number, now: number, dt: number): void {
  const hpRatio = Math.max(0, Math.min(1, hp / visual.maxHp));
  const buildT = Math.max(0, Math.min(1, (now - visual.bornAt) / 0.5));
  const buildScale = Math.max(0.05, 1 - Math.pow(1 - buildT, 3));
  visual.root.scale.setScalar(buildScale * (1 + visual.upgrade * 0.07));
  visual.levelTwo.visible = level >= 2;

  visual.stone.color.copy(visual.stoneColor).multiplyScalar(0.48 + hpRatio * 0.52);
  visual.stone.emissive.setHex(0x8f1e08);
  visual.stone.emissiveIntensity = visual.hit * 0.42;
  visual.glow.emissiveIntensity = (0.85 + level * 0.25) * (0.3 + hpRatio * 0.7) + visual.attack * 1.8;

  const aimYaw = Math.atan2(-visual.root.position.x, -visual.root.position.z);
  if (visual.kind === 'ballista') {
    visual.head.rotation.y = aimYaw;
    visual.head.position.z = -visual.attack * 0.2;
  } else if (visual.kind === 'rune') {
    visual.head.rotation.y += dt * (0.65 + level * 0.18);
    visual.head.position.y = visual.headBaseY + Math.sin(now * 2.1) * 0.07;
    visual.head.scale.setScalar(1 + visual.attack * 0.12);
  } else if (visual.kind === 'frost') {
    visual.head.rotation.y = Math.sin(now * 0.8) * 0.12;
    visual.head.scale.setScalar(1 + visual.attack * 0.16);
  } else if (visual.kind === 'quake') {
    visual.head.rotation.y = aimYaw;
    visual.head.position.y = visual.headBaseY - visual.attack * 0.34;
  } else {
    visual.head.rotation.y = aimYaw + Math.sin(now * 1.6) * 0.06;
    visual.head.scale.setScalar(1 + visual.attack * 0.09);
  }
  visual.levelTwo.rotation.y = now * 0.45;

  visual.attack = Math.max(0, visual.attack - dt * 3.8);
  visual.hit = Math.max(0, visual.hit - dt * 5);
  visual.upgrade = Math.max(0, visual.upgrade - dt * 1.6);
}
