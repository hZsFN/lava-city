// src/render/ViewModel.ts
// 第一人称武器外观：长剑（物理）/ 双持法伤枪（法术）。
// 表现层：按 FormSwitched 切换；按整合层传入的 AttackOutcome 触发挥砍 / 后坐 / 弹道。

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Attr, Bus } from '../core/events';
import type { AttackOutcome } from '../player/weaponTypes';

export interface ViewModel {
  update(): void;
  /** 整合层每产生一次攻击结果就调一次（含未命中的空挥/空枪） */
  onAttack(outcome: AttackOutcome): void;
  dispose(): void;
}

const SWING_SEC = 0.28;
const RECOIL_SEC = 0.12;
const TRACER_SEC = 0.15;
const FLASH_SEC = 0.1;
const TRACER_POOL = 12;

interface Slot {
  group: THREE.Group;
  anim: number; // 剩余动画时间（秒）
  kind: 'swing' | 'recoil' | null;
  basePos: THREE.Vector3;
  baseRot: THREE.Euler;
}

export function createViewModel(deps: {
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  bus: Bus;
}): ViewModel {
  const { camera, scene, bus } = deps;
  // 武器挂在相机下：相机必须在场景图里才会被渲染
  if (!camera.parent) scene.add(camera);

  const root = new THREE.Group();
  root.name = 'viewmodel';
  camera.add(root);

  // 长剑：把模型放大到接近真实太刀长度，刀尖朝前偏右，挥砍时横扫过准星。
  const physical: Slot = {
    group: new THREE.Group(),
    anim: 0,
    kind: null,
    basePos: new THREE.Vector3(0.32, -0.42, -0.72),
    baseRot: new THREE.Euler(-Math.PI / 2 + 0.15, -0.35, 0),
  };
  // 法术形态：双持手枪。glTF 里 pistol_a / pistol_b 是两把完整枪（B 在 Y+0.15），
  // 这里拆成左右手两组，各自向准星方向内收 0.10 rad，视觉上弹道汇聚。
  const arcane: Slot = {
    group: new THREE.Group(),
    anim: 0,
    kind: null,
    basePos: new THREE.Vector3(0, -0.27, -0.64),
    baseRot: new THREE.Euler(0, 0, 0),
  };
  const gunRight = new THREE.Group();
  const gunLeft = new THREE.Group();
  gunRight.name = 'weapon-arcane-right';
  gunLeft.name = 'weapon-arcane-left';
  gunRight.position.set(0.3, 0, 0);
  gunLeft.position.set(-0.3, 0, 0);
  gunRight.rotation.set(0, Math.PI / 2 + 0.1, 0);
  gunLeft.rotation.set(0, Math.PI / 2 - 0.1, 0);
  gunRight.scale.setScalar(0.95);
  gunLeft.scale.setScalar(0.95);
  arcane.group.add(gunLeft, gunRight);
  root.add(physical.group, arcane.group);

  for (const slot of [physical, arcane]) {
    slot.group.position.copy(slot.basePos);
    slot.group.rotation.copy(slot.baseRot);
  }

  // ── 枪口：闪光灯 + 可见火球 ────────────────────────────────────────────────
  const flashL = new THREE.PointLight(0x5ab8ff, 0, 3, 2);
  const flashR = new THREE.PointLight(0x5ab8ff, 0, 3, 2);
  flashL.position.set(0.174, 0, 0);
  flashR.position.set(0.174, 0, 0);
  gunLeft.add(flashL);
  gunRight.add(flashR);

  const muzzleL = new THREE.Object3D();
  const muzzleR = new THREE.Object3D();
  muzzleL.position.set(0.174, 0, 0);
  muzzleR.position.set(0.174, 0, 0);
  gunLeft.add(muzzleL);
  gunRight.add(muzzleR);

  const flashGeo = new THREE.SphereGeometry(0.055, 8, 6);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0x9fd4ff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const muzzleFlashL = new THREE.Mesh(flashGeo, flashMat);
  const muzzleFlashR = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlashL.name = 'weapon-muzzle-flash-left';
  muzzleFlashR.name = 'weapon-muzzle-flash-right';
  muzzleFlashL.position.copy(muzzleL.position);
  muzzleFlashR.position.copy(muzzleR.position);
  muzzleFlashL.visible = false;
  muzzleFlashR.visible = false;
  gunLeft.add(muzzleFlashL);
  gunRight.add(muzzleFlashR);

  // ── 弹道拖尾：世界空间短光束，由枪口射向命中点 ─────────────────────────────
  const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0x9fd4ff,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const tracers: Array<{ mesh: THREE.Mesh; life: number }> = [];
  for (let i = 0; i < TRACER_POOL; i += 1) {
    const mesh = new THREE.Mesh(tracerGeo, tracerMat);
    mesh.name = `weapon-tracer-${i}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerCursor = 0;

  const tracerFrom = new THREE.Vector3();
  const tracerTo = new THREE.Vector3();
  const tracerDir = new THREE.Vector3();
  const tracerQuat = new THREE.Quaternion();
  const tracerUp = new THREE.Vector3(0, 1, 0);

  function spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const length = from.distanceTo(to);
    if (length < 0.05) return;
    tracerDir.subVectors(to, from).normalize();
    const slot = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % tracers.length;
    slot.mesh.position.copy(from).addScaledVector(tracerDir, length / 2);
    tracerQuat.setFromUnitVectors(tracerUp, tracerDir);
    slot.mesh.quaternion.copy(tracerQuat);
    slot.mesh.scale.set(0.012, length, 0.012);
    slot.mesh.visible = true;
    slot.life = TRACER_SEC;
  }

  let flashTimer = 0;
  let nextGun = 1; // 1 = 右手先开，之后左右交替

  const loader = new GLTFLoader();
  let pistolSource: THREE.Object3D | null = null;

  function fitModel(object: THREE.Object3D, slot: Slot, scale: number): void {
    object.scale.setScalar(scale);
    slot.group.add(object);
  }

  /** 把零件表拆成左右两把枪；弹匣/子弹是资产展示用的散件，不挂进第一人称。 */
  function mountPistols(source: THREE.Object3D): void {
    pistolSource = source;
    const parts = new Map<string, THREE.Object3D>();
    source.traverse((obj) => {
      if (obj !== source && obj.name) parts.set(obj.name, obj);
    });

    const right = [
      'service_pistol_pistol_a',
      'service_pistol_slide_a',
      'service_pistol_hammer_a',
      'service_pistol_trigger_a',
    ];
    const left = [
      'service_pistol_pistol_b',
      'service_pistol_slide_b',
      'service_pistol_hammer_b',
      'service_pistol_trigger_b',
    ];
    const yOffset = 0.15; // pistol_b 在资产里的纵向排布偏移

    for (const name of right) {
      const node = parts.get(name);
      if (node) gunRight.add(node);
    }
    for (const name of left) {
      const node = parts.get(name);
      if (!node) continue;
      node.position.y -= yOffset;
      gunLeft.add(node);
    }
  }

  loader.load(
    'models/longsword/model.gltf',
    (gltf) => fitModel(gltf.scene, physical, 1.35),
    undefined,
    (err) => console.error('[viewmodel] 长剑加载失败', err),
  );
  loader.load(
    'models/arcane-pistol/model.gltf',
    (gltf) => mountPistols(gltf.scene),
    undefined,
    (err) => console.error('[viewmodel] 法伤枪加载失败', err),
  );

  let form: Attr = bus.snapshot().player.form;
  applyForm();

  const unsubs: Array<() => void> = [];
  unsubs.push(
    bus.on('FormSwitched', (p) => {
      form = p.form;
      applyForm();
    }),
  );
  unsubs.push(
    bus.on('ExecutionStarted', () => {
      physical.anim = SWING_SEC;
      physical.kind = 'swing';
    }),
  );

  function applyForm(): void {
    physical.group.visible = form === 'physical';
    arcane.group.visible = form === 'arcane';
  }

  function swingSword(): void {
    physical.anim = SWING_SEC;
    physical.kind = 'swing';
  }

  function fireMagic(point?: readonly [number, number, number]): void {
    arcane.anim = RECOIL_SEC;
    arcane.kind = 'recoil';
    flashTimer = FLASH_SEC;
    flashL.intensity = 8;
    flashR.intensity = 8;
    muzzleFlashL.visible = true;
    muzzleFlashR.visible = true;
    muzzleFlashL.scale.setScalar(1);
    muzzleFlashR.scale.setScalar(1);

    const right = nextGun === 1;
    nextGun = right ? 0 : 1;
    const muzzle = right ? muzzleR : muzzleL;

    root.updateMatrixWorld(true);
    muzzle.getWorldPosition(tracerFrom);
    if (point) {
      tracerTo.set(point[0], point[1], point[2]);
    } else {
      camera.getWorldDirection(tracerDir);
      tracerTo.copy(camera.position).addScaledVector(tracerDir, 60);
    }
    spawnTracer(tracerFrom, tracerTo);
  }

  function onAttack(outcome: AttackOutcome): void {
    if (outcome.attr === 'physical') {
      swingSword();
      return;
    }
    fireMagic(outcome.point);
  }

  let last = performance.now();

  function update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    for (const slot of [physical, arcane]) {
      if (slot.anim > 0) slot.anim = Math.max(0, slot.anim - dt);
    }

    // 挥砍：自上向下劈砍。起手把刀从头顶前方高举过头，随挥砍大幅劈落、
    // 穿过准星落到前下方——比之前的侧向横扫幅度和角度都大很多。
    // swing = autoEase 给的是 0→1（动画剩余时间从满到 0），0 是起手、1 是收尾。
    const chopK = autoEase(physical.anim, SWING_SEC);
    const CHOP_RAISE = 1.2; // 起手高举幅度（rad），刀尖从水平抬到偏上
    const CHOP_SWING = 1.05; // 落刀下劈幅度（rad），从高举一路劈到水平线下
    const chop = chopK * (2 - chopK); // 轻微 ease-in：抬手快、劈落带加速
    physical.group.rotation.set(
      physical.baseRot.x + CHOP_RAISE - (CHOP_RAISE + CHOP_SWING) * chop,
      physical.baseRot.y + chop * 0.22,
      physical.baseRot.z,
    );
    // 劈砍带动身体：先略微后收再前压，刀往下沉、向前刺，幅度明显。
    physical.group.position.copy(physical.basePos);
    physical.group.position.x -= chop * 0.08;
    physical.group.position.y -= chop * 0.26;
    physical.group.position.z -= chop * 0.2;

    // 后坐：小幅抬头 + 后退，幅度比之前小很多。
    const recoilK = autoEase(arcane.anim, RECOIL_SEC);
    const kick = Math.sin(recoilK * Math.PI);
    arcane.group.rotation.set(arcane.baseRot.x - kick * 0.05, arcane.baseRot.y, arcane.baseRot.z);
    arcane.group.position.copy(arcane.basePos);
    arcane.group.position.z += kick * 0.02;

    // 枪口闪光
    if (flashTimer > 0) {
      flashTimer = Math.max(0, flashTimer - dt);
      const k = flashTimer / FLASH_SEC;
      flashL.intensity = 8 * k;
      flashR.intensity = 8 * k;
      const s = 0.8 + k * 0.8;
      muzzleFlashL.scale.setScalar(s);
      muzzleFlashR.scale.setScalar(s);
      muzzleFlashL.visible = k > 0;
      muzzleFlashR.visible = k > 0;
    } else {
      flashL.intensity = 0;
      flashR.intensity = 0;
      muzzleFlashL.visible = false;
      muzzleFlashR.visible = false;
    }

    // 弹道拖尾
    for (const tracer of tracers) {
      if (tracer.life <= 0) continue;
      tracer.life = Math.max(0, tracer.life - dt);
      if (tracer.life <= 0) tracer.mesh.visible = false;
    }

    // 未加载完成时组内为空，保持形态可见性即可
    physical.group.visible = form === 'physical';
    arcane.group.visible = form === 'arcane';
  }

  return {
    update,
    onAttack,
    dispose(): void {
      for (const unsub of unsubs) unsub();
      camera.remove(root);
      disposeTree(root);
      if (pistolSource) disposeTree(pistolSource);
      for (const tracer of tracers) scene.remove(tracer.mesh);
      tracerGeo.dispose();
      tracerMat.dispose();
      flashGeo.dispose();
      flashMat.dispose();
    },
  };
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) m.dispose();
  });
}

/** 动画剩余时间归一化后的 0→1→0 包络 */
function autoEase(left: number, total: number): number {
  if (left <= 0) return 0;
  return Math.min(1, left / total);
}
