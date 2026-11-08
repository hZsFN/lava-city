// src/render/ViewModel.ts
// 第一人称武器外观：长剑（物理）/ 法伤枪（法术）。
// 只负责表现：按 FormSwitched 切换、按 DamageDealt 触发挥砍/后坐与枪口闪光。

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Attr } from '../core/events';
import type { Bus } from '../core/events';

export interface ViewModel {
  update(): void;
  dispose(): void;
}

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

  const physical: Slot = {
    group: new THREE.Group(),
    anim: 0,
    kind: null,
    basePos: new THREE.Vector3(0.3, -0.34, -0.6),
    baseRot: new THREE.Euler(-Math.PI / 2, -0.25, -0.18),
  };
  const arcane: Slot = {
    group: new THREE.Group(),
    anim: 0,
    kind: null,
    basePos: new THREE.Vector3(0.24, -0.28, -0.52),
    baseRot: new THREE.Euler(0, Math.PI / 2, 0.04),
  };
  root.add(physical.group, arcane.group);

  for (const slot of [physical, arcane]) {
    slot.group.position.copy(slot.basePos);
    slot.group.rotation.copy(slot.baseRot);
  }

  // 枪口闪光
  const flash = new THREE.PointLight(0x5ab8ff, 0, 3, 2);
  flash.position.set(0.24, -0.22, -0.85);
  root.add(flash);
  let flashLeft = 0;

  const loader = new GLTFLoader();

  function fitModel(object: THREE.Object3D, slot: Slot, scale: number): void {
    object.scale.setScalar(scale);
    slot.group.add(object);
  }

  loader.load(
    'models/longsword/model.gltf',
    (gltf) => fitModel(gltf.scene, physical, 0.8),
    undefined,
    (err) => console.error('[viewmodel] 长剑加载失败', err),
  );
  loader.load(
    'models/arcane-pistol/model.gltf',
    (gltf) => fitModel(gltf.scene, arcane, 1.0),
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
    bus.on('DamageDealt', (p) => {
      if (p.target !== 'boss') return;
      if (p.attr === 'physical') {
        physical.anim = 0.22;
        physical.kind = 'swing';
      } else {
        arcane.anim = 0.14;
        arcane.kind = 'recoil';
        flashLeft = 0.08;
        flash.intensity = 9;
      }
    }),
  );
  unsubs.push(
    bus.on('ExecutionStarted', () => {
      physical.anim = 0.5;
      physical.kind = 'swing';
    }),
  );

  function applyForm(): void {
    physical.group.visible = form === 'physical';
    arcane.group.visible = form === 'arcane';
  }

  let last = performance.now();

  function update(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    for (const slot of [physical, arcane]) {
      if (slot.anim > 0) slot.anim = Math.max(0, slot.anim - dt);
    }

    // 挥砍：绕 Z 快速扫过
    const swingK = autoEase(physical.anim, 0.22);
    physical.group.rotation.copy(physical.baseRot);
    physical.group.rotation.z += Math.sin(swingK * Math.PI) * -0.85;
    physical.group.position.copy(physical.basePos);
    physical.group.position.z -= Math.sin(swingK * Math.PI) * 0.12;

    // 后坐：向后退一点再回位
    const recoilK = autoEase(arcane.anim, 0.14);
    arcane.group.rotation.copy(arcane.baseRot);
    arcane.group.rotation.x -= Math.sin(recoilK * Math.PI) * 0.18;
    arcane.group.position.copy(arcane.basePos);
    arcane.group.position.z += Math.sin(recoilK * Math.PI) * 0.05;

    if (flashLeft > 0) {
      flashLeft = Math.max(0, flashLeft - dt);
      flash.intensity = 9 * (flashLeft / 0.08);
    } else {
      flash.intensity = 0;
    }

    // 未加载完成时组内为空，保持形态可见性即可
    physical.group.visible = form === 'physical';
    arcane.group.visible = form === 'arcane';
  }

  return {
    update,
    dispose(): void {
      for (const unsub of unsubs) unsub();
      camera.remove(root);
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) m.dispose();
        }
      });
    },
  };
}

/** 动画剩余时间归一化后的 0→1→0 包络 */
function autoEase(left: number, total: number): number {
  if (left <= 0) return 0;
  return Math.min(1, left / total);
}
