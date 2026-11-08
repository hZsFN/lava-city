import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { createGame } from '../../../src/game/GameLoop';
import { createGameView } from '../../../src/game/GameView';

vi.mock('../../../src/render/ViewModel', () => ({
  createViewModel: () => ({ update() {}, onAttack() {}, dispose() {} }),
}));

describe('tower rendering hot path', () => {
  it('reuses material colors and reads slot snapshots without allocating slot views', () => {
    const game = createGame({ input: { sample: () => ({ moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false }) } });
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const view = createGameView({ scene, camera, bus: game.bus, game, aim: () => ({ yaw: 0, pitch: 0 }) });
    const slot = game.towers.slots()[0];
    const mesh = scene.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardNodeMaterial;
    const color = material.color;
    const emissive = material.emissive;
    const slots = vi.spyOn(game.towers, 'slots');
    game.bus.emit('TowerSlotStateChanged', { slotId: slot.slotId, state: 'open' });
    for (let frame = 0; frame < 120; frame += 1) view.sync();
    expect(slots).not.toHaveBeenCalled();
    expect(material.color).toBe(color);
    expect(material.emissive).toBe(emissive);
    expect(color.getHex()).toBe(0xff8a3c);
    view.setTactical(true);
    view.sync();
    expect(material.emissive).toBe(emissive);
    expect(emissive.getHex()).toBe(0x66ffcc);
    view.setTactical(false);
    view.sync();
    expect(emissive.getHex()).toBe(0xff8a3c);
    view.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
