import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { FlowDirector } from '../../../src/game/FlowDirector';
import { createGame } from '../../../src/game/GameLoop';
import type { IgnisBoss } from '../../../src/boss/IgnisBoss';
import type { FlowConfig } from '../../../src/flow/types';
import config from '../../../src/core/config/flow.json';

const book = vi.hoisted(() => ({ update: vi.fn(), blend: 0 }));
vi.mock('../../../src/ui/FlowOverlay', () => ({ FlowOverlay: class {
  setBlack() {} setBlur() {} setNarration() {} setWhite() {} setVignette() {}
  setPrompt() {} setPages() {} setFail() {}
} }));
vi.mock('../../../src/game/TutorialBook', () => ({ TutorialBook: class {
  update = book.update;
  view() { return { cameraBlend: book.blend, focus: [1, 2, -3], near: false, reading: false }; }
  dispose() {} isVisible() { return false; }
} }));
vi.mock('../../../src/game/PlayerAvatar', () => ({ PlayerAvatar: class {
  setVisible() {} setPose() {} dispose() {}
} }));

function setup() {
  const game = createGame({ input: { sample: () => ({ moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false }) } });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const boss = {
    root: new THREE.Group(), state: { hp: 100, phase: 1 },
    hideForShow() {}, freezeBrain() {}, beginSink() {}, setBrainEnabled() {},
  } as unknown as IgnisBoss;
  const show = new FlowDirector({ scene, camera, game, bus: game.bus, boss,
    flowCfg: config as unknown as FlowConfig, lava: { lavaBaseY: -22, setLavaY() {} },
    debug: false, onFail() {},
  });
  return { game, camera, show };
}

describe('render-frame camera composition', () => {
  beforeEach(() => { book.update.mockClear(); book.blend = 0; });
  it('restores the cinematic camera after base-view sync without advancing presentation time', () => {
    const { game, camera, show } = setup();
    show.update(1 / 60, 144);
    const expected = camera.quaternion.clone();
    const time = game.timeline.tSec();
    for (let frame = 0; frame < 144; frame += 1) {
      camera.position.set(0, 95, 8);
      camera.lookAt(0, 0, 0);
      show.presentCamera();
      expect(camera.quaternion.angleTo(expected)).toBeLessThan(1e-6);
    }
    expect(game.timeline.tSec()).toBe(time);
    expect(book.update).toHaveBeenCalledTimes(1);
    show.dispose();
  });
  it('preserves live input direction in normal gameplay', () => {
    const { game, camera, show } = setup();
    game.bus.emit('MatchPhaseChanged', { phase: 'prep', tSec: 0 });
    show.update(1 / 60, 144);
    camera.position.set(2, 3, 4);
    camera.lookAt(5, 6, 7);
    const expected = camera.quaternion.clone();
    show.presentCamera();
    expect(camera.quaternion.angleTo(expected)).toBeLessThan(1e-6);
    expect(camera.position.toArray()).toEqual([2, 3, 4]);
    show.dispose();
  });
  it('retains the tutorial reading blend on extra render frames', () => {
    const { game, camera, show } = setup();
    game.bus.emit('MatchPhaseChanged', { phase: 'tutorial', tSec: 0 });
    book.blend = 0.8;
    show.update(1 / 60, 144);
    const expected = camera.position.clone();
    camera.position.set(20, 20, 20);
    show.presentCamera();
    expect(camera.position.distanceTo(expected)).toBeLessThan(1e-10);
    expect(book.update).toHaveBeenCalledTimes(1);
    show.dispose();
  });
});
