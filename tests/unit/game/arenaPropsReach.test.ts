import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import { PlayerController } from '../../../src/player/PlayerController';
import type { PlayerConfig, PlayerWorld } from '../../../src/player/PlayerController';
import { createGame, LOGIC_DT } from '../../../src/game/GameLoop';
import type { InputSource } from '../../../src/game/GameLoop';
import arenaPropsCfgJson from '../../../src/core/config/arena-props.json';
import playerCfgJson from '../../../src/core/config/player.json';
import type { ArenaPropsConfig } from '../../../src/game/ArenaProps';
import { placements, platformColliders } from '../../../src/game/ArenaProps';

// ============================================================================
// 票 M3-04 路径 A 的真验收：不是数 AABB 有几条，而是「人真的站得上去」。
//
// 直接用 PlayerController + 真实的 platformColliders 世界：
//   · 落地：把人从台面正上方丢下 → 必须停在台面高度，且 grounded；
//   · 走不上去：0.8 m 的低台直着走上去必须被挡（0.8 > snapToGround 0.45），
//     这正是票面「三级链 = 要不要花 3 秒爬上去」的前提。
// ============================================================================

const cfg = arenaPropsCfgJson as unknown as ArenaPropsConfig;
const playerCfg = playerCfgJson as unknown as PlayerConfig;
const platforms = placements(cfg).filter((p) => p.category === 'platform');

const IDLE: InputSource = {
  sample: () => ({ moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false }),
};

/** 与 GameLoop.buildPlayerWorld() 同构的世界：主平台 + 12 件跳跃平台 */
function world(): PlayerWorld {
  const ring = 23.2;
  return {
    colliders: [
      { minX: -ring, maxX: ring, minY: -2, maxY: 0, minZ: -ring, maxZ: ring },
      ...platformColliders(cfg),
    ],
    lavaY: -1.8,
  };
}

function makePlayer(spawn: [number, number, number]): PlayerController {
  return new PlayerController({
    bus: createBus(),
    config: playerCfg,
    world: world(),
    spawn,
  });
}

function tickFor(p: PlayerController, seconds: number, input = { moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false }): void {
  const steps = Math.round(seconds / LOGIC_DT);
  for (let i = 0; i < steps; i += 1) p.update(LOGIC_DT, input);
}

describe('game/ArenaProps 路 跳跃平台碰撞箱（真站得上）', () => {
  it('12 件平台全部能落地到自己的台面高度', () => {
    expect(platforms.length).toBe(12);

    for (const p of platforms) {
      const player = makePlayer([p.x, p.heightM + 1.5, p.z]);
      tickFor(player, 1.5);

      const pos = player.pos;
      expect(pos[0]).toBeCloseTo(p.x, 3);
      expect(pos[2]).toBeCloseTo(p.z, 3);
      // 停在台面，既没穿下去（y=0），也没悬空
      expect(pos[1]).toBeCloseTo(p.heightM, 2);
      expect(player.isGrounded).toBe(true);
    }
  });

  it('三级链的台面高度是 0.8 / 1.6 / 2.4，逐级 +0.8', () => {
    const byHeight = [...new Set(platforms.map((p) => p.heightM))].sort((a, b) => a - b);
    expect(byHeight).toEqual([0.8, 1.6, 2.4]);
  });

  it('0.8 m 的低台走不上去（必须跳），且不会卡进台子内部', () => {
    const l1 = platforms.find((p) => p.id === 'L1');
    expect(l1).toBeDefined();
    if (!l1) return;

    // 从塔心方向朝 L1 直走 2 s，不跳
    const len = Math.hypot(l1.x, l1.z);
    const dirX = l1.x / len;
    const dirZ = l1.z / len;
    const start: [number, number, number] = [l1.x - dirX * 3, 0, l1.z - dirZ * 3];

    const player = makePlayer(start);
    // yaw 使 forward = (-sin yaw, -cos yaw) 指向 (dirX, dirZ)
    const yaw = Math.atan2(-dirX, -dirZ);
    tickFor(player, 2, { moveX: 0, moveZ: 1, yaw, jump: false, dash: false });

    const pos = player.pos;
    expect(pos[1]).toBeLessThan(0.05); // 没爬上去
    // 被挡在台子外侧（半宽 0.9 + 玩家半径 0.35 → 距离中心 > 0.9）
    expect(Math.hypot(pos[0] - l1.x, pos[2] - l1.z)).toBeGreaterThan(0.9);
  });

  it('平台不压塔位：12 件平台中心离 11 个逻辑塔位都 ≥ 2.2 m', () => {
    const slotPos: Array<[number, number]> = [
      [20, 0], [0, 20], [-20, 0], [0, -20],
      [7.6, 0], [-3.8, 6.6], [-3.8, -6.6],
      [24, 24], [-24, 24], [-24, -24], [24, -24],
    ];
    for (const p of platforms) {
      for (const [sx, sz] of slotPos) {
        expect(Math.hypot(p.x - sx, p.z - sz)).toBeGreaterThanOrEqual(2.2);
      }
    }
  });

  it('整局 createGame 仍能跑完（碰撞箱没把玩家卡死）', () => {
    const game = createGame({ input: IDLE });
    for (let i = 0; i < 600; i += 1) game.tick(LOGIC_DT);
    const pos = game.playerPos();
    expect(Number.isFinite(pos[0])).toBe(true);
    expect(Number.isFinite(pos[1])).toBe(true);
    expect(Number.isFinite(pos[2])).toBe(true);
    expect(game.player.isDead).toBe(false);
  });
});
