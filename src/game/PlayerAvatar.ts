// src/game/PlayerAvatar.ts
// ============================================================================
// M4-01 传送演出的简化人形。第一人称阶段完全隐藏，只在 escape 段出现。
// ============================================================================

import * as THREE from 'three/webgpu';
import type { Vec3 } from '../core/events';

export class PlayerAvatar {
  readonly group = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(scene: THREE.Scene) {
    this.material = new THREE.MeshStandardMaterial({
      color: 0xdcecff,
      emissive: 0x9fe9ff,
      emissiveIntensity: 0.85,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 1,
      depthWrite: false,
    });

    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0): void => {
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(x, y, z);
      mesh.rotation.x = rx;
      mesh.rotation.z = rz;
      this.group.add(mesh);
    };

    // 躯干 / 头 / 四肢 —— 全部是盒子与胶囊，足够在 8 m 外读出人形
    add(new THREE.CapsuleGeometry(0.3, 0.78, 4, 10), 0, 1.04, 0);
    add(new THREE.SphereGeometry(0.22, 16, 12), 0, 1.82, 0);
    add(new THREE.CapsuleGeometry(0.09, 0.5, 3, 8), -0.42, 1.16, 0, 0, 0.18);
    add(new THREE.CapsuleGeometry(0.09, 0.5, 3, 8), 0.42, 1.16, 0, 0, -0.18);
    add(new THREE.CapsuleGeometry(0.12, 0.62, 3, 8), -0.17, 0.42, 0);
    add(new THREE.CapsuleGeometry(0.12, 0.62, 3, 8), 0.17, 0.42, 0);

    this.group.visible = false;
    scene.add(this.group);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  setPose(pos: Vec3, facingYaw: number, opacity: number): void {
    this.group.position.set(pos[0], pos[1], pos[2]);
    this.group.rotation.y = facingYaw;
    this.material.opacity = Math.max(0, Math.min(1, opacity));
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const geo of this.geometries) geo.dispose();
    this.material.dispose();
  }
}
