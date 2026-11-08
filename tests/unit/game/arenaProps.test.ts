// tests/unit/game/arenaProps.test.ts
// ============================================================================
// 票 M3-04 验收：场地道具的纯逻辑层 + GameLoop 接线
// ----------------------------------------------------------------------------
// 纯 Node 单测（vitest environment: 'node'）：不加载 DOM、不 import three。
// 只读配置、只调纯函数，不碰渲染层。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { maxPlatformTopY, placements, platformColliders } from '../../../src/game/ArenaProps';
import type { ArenaPropsConfig, PropInstance } from '../../../src/game/ArenaProps';
import { createGame, LOGIC_DT } from '../../../src/game/GameLoop';
import type { InputSource } from '../../../src/game/GameLoop';

import arenaPropsCfgJson from '../../../src/core/config/arena-props.json';
import arenaCfgJson from '../../../src/core/config/arena.json';
import flowCfgJson from '../../../src/core/config/flow.json';

const cfg = arenaPropsCfgJson as unknown as ArenaPropsConfig;

/** 塔位坐标（arena.json slots[].pos 的 x/z；塔位在 y=12 的塔身上，这里只比水平距离） */
const slots = (arenaCfgJson as unknown as { slots: Array<{ id: string; pos: [number, number, number] }> })
  .slots;

/** 票面数值：单跳安全上限 0.9 m、相邻平台 safeWalkGap 3.0 m、塔位净空 2.2 m */
const SINGLE_JUMP_SAFE_M = 0.9;
const SAFE_WALK_GAP_M = 3.0;
const SLOT_CLEARANCE_M = 2.2;

const IDLE: InputSource = {
  sample: () => ({ moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false }),
};

/** 玩家出生点从 config 读，不硬编码（master 上是 [0,0,21]，旧分支是 [0,0,17.2]） */
const PLAYER_SPAWN = (flowCfgJson as unknown as { playerSpawn: [number, number, number] }).playerSpawn;

/** 按 id 取一个 placement；取不到直接抛，避免 undefined 静默通过 */
function byId(id: string) {
  const p = placements(cfg).find((q) => q.id === id);
  if (!p) throw new Error(`config 里没有实例 ${id}`);
  return p;
}

/** 平台实例按「同角度 = 同一条链」分组，链内按半径由近到远排序 */
function platformChains(): PropInstance[][] {
  const groups = new Map<number, PropInstance[]>();
  for (const inst of cfg.instances) {
    if (cfg.kinds[inst.kind]?.category !== 'platform') continue;
    const list = groups.get(inst.angleDeg) ?? [];
    list.push(inst);
    groups.set(inst.angleDeg, list);
  }
  return [...groups.values()].map((list) => [...list].sort((a, b) => a.radiusM - b.radiusM));
}

describe('game/ArenaProps · 平台碰撞箱', () => {
  it('platformColliders 只返回 12 个平台箱，全部贴地（minY = 0），顶面为 0.8/1.6/2.4', () => {
    const boxes = platformColliders(cfg);

    expect(boxes).toHaveLength(12);
    for (const b of boxes) {
      expect(b.minY).toBe(0);
      // 三级链：0.8 / 1.6 / 2.4
      expect([0.8, 1.6, 2.4]).toContain(b.maxY);
      // 每个箱子必须有正体积，否则玩家站不上去
      expect(b.maxX).toBeGreaterThan(b.minX);
      expect(b.maxZ).toBeGreaterThan(b.minZ);
    }

    // 12 个平台中每个高度档各 4 件
    const heights = boxes.map((b) => b.maxY);
    expect(heights.filter((h) => h === 0.8)).toHaveLength(4);
    expect(heights.filter((h) => h === 1.6)).toHaveLength(4);
    expect(heights.filter((h) => h === 2.4)).toHaveLength(4);

    // 最高台面 = 2.4 m（调试/验收用的公开投影）
    expect(maxPlatformTopY(cfg)).toBe(2.4);
  });

  it('三级链 L1/L2/L3 的台面高度逐级 +0.8，每跳都在 0.9 m 安全上限内', () => {
    const chain = [byId('L1'), byId('L2'), byId('L3')];

    expect(chain.map((p) => p.heightM)).toEqual([0.8, 1.6, 2.4]);

    for (let i = 1; i < chain.length; i += 1) {
      const step = chain[i].heightM - chain[i - 1].heightM;
      expect(step).toBeCloseTo(0.8, 6);
      expect(step).toBeLessThanOrEqual(SINGLE_JUMP_SAFE_M);
    }

    // 从地面直接跳 L2（1.6 m）超上限，必须先走 L1 —— 这是链条存在的理由
    expect(chain[1].heightM).toBeGreaterThan(SINGLE_JUMP_SAFE_M);
  });

  it('极坐标 → 世界坐标：L1（22.5°, 13.2 m）落在 (12.1952, 5.0514)', () => {
    const l1 = byId('L1');

    // x = r·cos(22.5°)，z = r·sin(22.5°)，与 Spire.addSlotPedestal 同一套换算
    expect(l1.x).toBeCloseTo(12.1952, 3); // 容差 1e-3
    expect(l1.z).toBeCloseTo(5.0514, 3);

    // 四象限对称：同半径的 L4 / L7 / L10 只是镜像
    expect(byId('L4').x).toBeCloseTo(-l1.x, 6);
    expect(byId('L4').z).toBeCloseTo(l1.z, 6);
    expect(byId('L7').x).toBeCloseTo(-l1.x, 6);
    expect(byId('L7').z).toBeCloseTo(-l1.z, 6);
    expect(byId('L10').x).toBeCloseTo(l1.x, 6);
    expect(byId('L10').z).toBeCloseTo(-l1.z, 6);
  });

  it('可达性：同一条链内相邻两级的水平间隙 ≤ 3.0 m（safeWalkGap）', () => {
    const chains = platformChains();

    expect(chains).toHaveLength(4); // 四条链，每条 3 件
    for (const chain of chains) {
      expect(chain).toHaveLength(3);

      for (let i = 1; i < chain.length; i += 1) {
        const a = byId(chain[i - 1].id);
        const b = byId(chain[i].id);
        const gap = Math.hypot(b.x - a.x, b.z - a.z);

        expect(gap).toBeLessThanOrEqual(SAFE_WALK_GAP_M);
        // 台阶高度差同时要能被单跳吃下
        expect(b.heightM - a.heightM).toBeLessThanOrEqual(SINGLE_JUMP_SAFE_M);
      }
    }

    // 链与链之间是另一回事：不要求可达（分处四个象限），这里只确认它们确实是分开的
    const firsts = chains.map((c) => byId(c[0].id));
    for (let i = 0; i < firsts.length; i += 1) {
      for (let j = i + 1; j < firsts.length; j += 1) {
        const gap = Math.hypot(firsts[i].x - firsts[j].x, firsts[i].z - firsts[j].z);
        expect(gap).toBeGreaterThan(SAFE_WALK_GAP_M);
      }
    }
  });

  it('不压塔位：12 个平台中心到 11 个逻辑塔位的水平距离都 ≥ 2.2 m', () => {
    const platforms = placements(cfg).filter((p) => p.category === 'platform');

    expect(platforms).toHaveLength(12);
    expect(slots).toHaveLength(11);

    for (const p of platforms) {
      for (const slot of slots) {
        const dx = p.x - slot.pos[0];
        const dz = p.z - slot.pos[2];
        const dist = Math.hypot(dx, dz);

        // 失败时把双方名字带出来，免得只看到一串数字
        expect(dist, `${p.id} ↔ 塔位 ${slot.id}`).toBeGreaterThanOrEqual(SLOT_CLEARANCE_M);
      }
    }
  });
});

describe('game/GameLoop · 平台碰撞箱接线', () => {
  it('createGame 后跑一步不抛错，玩家仍站在地面（y ≈ 0）没被平台弹起', () => {
    const game = createGame({ input: IDLE });

    // 用公开接口驱动一帧；平台箱若接错（例如顶面高度写反）会在这里炸或把玩家顶飞
    expect(() => game.tick(LOGIC_DT)).not.toThrow();

    const pos = game.playerPos();
    expect(pos[1]).toBeCloseTo(0, 3); // 出生点不在任何平台上，脚底 y = 0
    expect(game.player.isDead).toBe(false);
    expect(game.player.isGrounded).toBe(true);

    // 与纯逻辑层对齐：世界里的平台就是这 12 个、最高 2.4 m
    expect(platformColliders(cfg)).toHaveLength(12);
    expect(maxPlatformTopY(cfg)).toBe(2.4);
  });

  it('连续跑 60 帧仍然贴地（平台箱没让主平台吸附失效）', () => {
    const game = createGame({ input: IDLE });
    for (let i = 0; i < 60; i += 1) game.tick(LOGIC_DT);

    const pos = game.playerPos();
    expect(pos[1]).toBeCloseTo(0, 3);
    expect(game.player.isDead).toBe(false);
    expect(game.player.isGrounded).toBe(true);
  });

  it('平台真的进了世界：走向 L1 会被侧壁挡住，且永远走不进台面投影', () => {
    const l1 = byId('L1');
    // 从出生点朝 L1 走：yaw 约定 0 面向 -Z，前 = (-sin, -cos)
    const spawnX = PLAYER_SPAWN[0];
    const spawnZ = PLAYER_SPAWN[2];
    const len = Math.hypot(l1.x - spawnX, l1.z - spawnZ);
    const ux = (l1.x - spawnX) / len;
    const uz = (l1.z - spawnZ) / len;
    const yaw = Math.atan2(-ux, -uz);

    const walker = createGame({
      input: { sample: () => ({ moveX: 0, moveZ: 1, yaw, jump: false, dash: false }) },
    });
    let minDistWalking = Infinity;
    for (let f = 0; f < 60 * 6; f += 1) {
      walker.tick(LOGIC_DT);
      const p = walker.playerPos();
      minDistWalking = Math.min(minDistWalking, Math.hypot(p[0] - l1.x, p[2] - l1.z));
    }
    // 平台半宽 0.9 + 玩家半径 0.35 = 1.25 m 处被挡下（证明碰撞箱存在）
    expect(minDistWalking).toBeGreaterThan(1.2);
    expect(minDistWalking).toBeLessThan(1.3);
    expect(walker.playerPos()[1]).toBeCloseTo(0, 3); // 没跳上去
    expect(walker.player.isDead).toBe(false);
  });

  // 落地行为由 arenaPropsReach.test.ts 用「台面正上方自由落体」直接验证：
  // 那里能把玩家精确放到平台上方，不依赖走路 + 起跳的轨迹编排。
  // 本文件只负责证明「箱子确实被 GameLoop 接进了 PlayerWorld」。
});
