// src/game/GameView.ts
// ============================================================================
// 整合层 · 渲染表现（S0 维护）
// ----------------------------------------------------------------------------
// 职责：把逻辑状态「画出来」。只读快照与事件，不持有任何逻辑对象引用。
//
//   · 塔位标记（11 个圆盘，按状态变色）
//   · 已建塔（方块 + 属性色）
//   · 第一人称相机（跟随玩家位置与朝向）
//
// 这里可以用 three，因为它属于渲染表现层，不是逻辑层。
// ============================================================================

import * as THREE from 'three/webgpu';
import type { Bus, SlotState, Vec3 } from '../core/events';
import type { Game } from './GameLoop';

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
  /** 释放 */
  dispose(): void;
}

export function createGameView(deps: {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  bus: Bus;
  game: Game;
}): GameView {
  const { scene, camera, bus, game } = deps;

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

  // ── 已建塔 ────────────────────────────────────────────────────────────────
  const towerMeshes = new Map<string, THREE.Mesh>();
  const towerGeo = new THREE.BoxGeometry(1.4, 3.2, 1.4);

  function ensureTowerMesh(id: string, kind: string, pos: Vec3): THREE.Mesh {
    let mesh = towerMeshes.get(id);
    if (mesh) return mesh;

    const attr =
      kind === 'ballista' || kind === 'quake'
        ? 'physical'
        : kind === 'totem'
          ? 'none'
          : 'arcane';
    const mat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(ATTR_COLOR[attr]),
      roughness: 0.5,
      metalness: 0.25,
      emissive: new THREE.Color(ATTR_COLOR[attr]),
      emissiveIntensity: 0.35,
    });
    mesh = new THREE.Mesh(towerGeo, mat);
    mesh.position.set(pos[0], pos[1] + 1.6, pos[2]);
    scene.add(mesh);
    towerMeshes.set(id, mesh);
    return mesh;
  }

  function removeTowerMesh(id: string): void {
    const mesh = towerMeshes.get(id);
    if (!mesh) return;
    scene.remove(mesh);
    (mesh.material as THREE.Material).dispose();
    towerMeshes.delete(id);
  }

  // ── 事件订阅：建塔/拆塔即时响应 ─────────────────────────────────────────
  const unsubs: Array<() => void> = [];
  unsubs.push(bus.on('TowerPlaced', (p) => {
    ensureTowerMesh(p.towerId, p.kind, p.pos);
  }));
  unsubs.push(bus.on('TowerDestroyed', (p) => {
    removeTowerMesh(p.towerId);
  }));

  // ── 每帧同步 ─────────────────────────────────────────────────────────────
  const camDir = new THREE.Vector3();
  const eyeHeight = 1.7;

  function sync(): void {
    // 1. 塔位状态色
    for (const slot of game.towers.slots()) {
      const mesh = slotMeshes.get(slot.slotId);
      if (!mesh) continue;
      const mat = mesh.material as THREE.MeshStandardNodeMaterial;
      mat.color = new THREE.Color(SLOT_COLOR[slot.state]);
    }

    // 2. 已建塔（快照是唯一数据源）
    const snap = game.snapshot();
    const alive = new Set<string>();
    for (const t of snap.towers) {
      alive.add(t.id);
      const mesh = ensureTowerMesh(t.id, t.kind, t.pos);
      // 塔被摧毁后耐久掉到 0 时压暗
      const mat = mesh.material as THREE.MeshStandardNodeMaterial;
      mat.emissiveIntensity = t.hp > 0 ? 0.35 : 0.05;
    }
    for (const id of [...towerMeshes.keys()]) {
      if (!alive.has(id)) removeTowerMesh(id);
    }

    // 3. 第一人称相机
    const pos = game.playerPos();
    const yaw = game.playerYaw();
    camera.position.set(pos[0], pos[1] + eyeHeight, pos[2]);
    camDir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    camera.lookAt(
      camera.position.x + camDir.x,
      camera.position.y,
      camera.position.z + camDir.z,
    );
  }

  return {
    sync,
    dispose(): void {
      for (const unsub of unsubs) unsub();
      for (const id of [...towerMeshes.keys()]) removeTowerMesh(id);
      for (const mesh of slotMeshes.values()) {
        scene.remove(mesh);
        (mesh.material as THREE.Material).dispose();
      }
      slotMeshes.clear();
      slotGeo.dispose();
      towerGeo.dispose();
    },
  };
}
