import { describe, expect, it } from 'vitest';
import { createGame, LOGIC_DT } from '../../../src/game/GameLoop';
import type { InputSource } from '../../../src/game/GameLoop';

// 整合层自测：验证三路交付物串起来后，一局能真的跑完。
// 这是「零件齐了」→「一局能跑」的验收证据。

const IDLE: InputSource = {
  sample: () => ({ moveX: 0, moveZ: 0, yaw: 0, jump: false, dash: false }),
};

/** 一直往前走，用来验证玩家确实在动 */
const WALK_FORWARD: InputSource = {
  sample: () => ({ moveX: 0, moveZ: 1, yaw: 0, jump: false, dash: false }),
};

describe('game/GameLoop · 整合层', () => {
  it('init 后能拿到完整快照（三路都接上了）', () => {
    const game = createGame({ input: IDLE });
    const snap = game.snapshot();

    // B3 时间轴：初始阶段 wake，塔心满血
    expect(snap.phase).toBe('wake');
    expect(snap.coreHp).toBe(1000);

    // B1 塔系统：11 个塔位已注册
    expect(game.towers.slots()).toHaveLength(11);

    // B2 五塔：全部可建
    expect(game.towers.slots().filter((s) => s.state === 'open')).toHaveLength(7);
  });

  it('固定步长：喂 1 秒真实时间，推进 60 步逻辑', () => {
    const game = createGame({ input: IDLE });
    let steps = 0;
    // 每次喂 1/60 秒，跑 60 次
    for (let i = 0; i < 60; i += 1) steps += game.tick(LOGIC_DT);
    expect(steps).toBeGreaterThanOrEqual(55); // 累加器浮点误差容忍
    expect(game.timeline.tSec()).toBeCloseTo(1, 1);
  });

  it('一帧喂超大 dt 时被 MAX_STEPS 限流，不会雪崩', () => {
    const game = createGame({ input: IDLE });
    const steps = game.tick(10); // 喂 10 秒
    expect(steps).toBeLessThanOrEqual(5); // MAX_STEPS_PER_FRAME
  });

  it('玩家在移动输入下位置会变化', () => {
    const game = createGame({ input: WALK_FORWARD });
    const before = game.playerPos();
    for (let i = 0; i < 60; i += 1) game.tick(LOGIC_DT);
    const after = game.playerPos();
    // 向前走 = -Z 方向
    expect(after[2]).toBeLessThan(before[2]);
  });

  it('阶段按 flow.json 推进：55 秒后处于 boss1', () => {
    const game = createGame({ input: IDLE });
    const phases: string[] = [];
    game.bus.on('MatchPhaseChanged', (p) => phases.push(p.phase));

    // 跑到 55 秒（boss1 从 50 s 开始）
    for (let i = 0; i < 55 * 60; i += 1) game.tick(LOGIC_DT);

    expect(phases).toContain('tutorial');
    expect(phases).toContain('prep');
    expect(phases).toContain('boss1');
    expect(game.timeline.phase()).toBe('boss1');
  });

  it('B2 五塔都能建出来并进入快照', () => {
    const game = createGame({ input: IDLE });
    const kinds = ['ballista', 'rune', 'frost', 'quake', 'totem'] as const;
    const openSlots = game.towers.slots().filter((s) => s.state === 'open');

    let placed = 0;
    for (let i = 0; i < kinds.length && i < openSlots.length; i += 1) {
      game.setMotes(99);
      if (game.placeTower(openSlots[i].slotId, kinds[i])) placed += 1;
    }

    expect(placed).toBe(5);
    expect(game.snapshot().towers).toHaveLength(5);
  });

  it('塔在 boss1 阶段会开火（发 TowerTargetHit）', () => {
    const game = createGame({ input: IDLE });
    const hits: Array<{ kind: string; amount: number }> = [];
    game.bus.on('TowerTargetHit', (p) => hits.push({ kind: p.kind, amount: p.amount }));

    // 先建一座弩炮（物理，射程 25，目标在原点）
    game.setMotes(99);
    const slot = game.towers.slots().find((s) => s.state === 'open');
    expect(slot).toBeDefined();
    game.placeTower(slot!.slotId, 'ballista');

    // 跑到 boss1 阶段（50 秒）再多跑 10 秒
    for (let i = 0; i < 60 * 60; i += 1) game.tick(LOGIC_DT);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].kind).toBe('ballista');
    expect(hits[0].amount).toBe(25);
  });

  it('跑满 270 秒会进狂暴，275 秒失败，MatchEnded 只发一次', () => {
    const game = createGame({ input: IDLE });
    let endedCount = 0;
    let result: string | null = null;
    game.bus.on('MatchEnded', (p) => {
      endedCount += 1;
      result = p.result;
    });

    // 跑到 280 秒（270 s 进 rage，275 s 熔岩吞没）
    for (let i = 0; i < 280 * 60; i += 1) game.tick(LOGIC_DT);

    expect(endedCount).toBe(1);
    expect(result).toBe('lose'); // 没打 Boss，狂暴失败
    expect(game.timeline.result()?.reason).toBe('lava_swallowed');
    expect(game.isOver()).toBe(true);
  });

  it('结束后 tick 不再推进', () => {
    const game = createGame({ input: IDLE });
    for (let i = 0; i < 280 * 60; i += 1) game.tick(LOGIC_DT);
    const tAfterEnd = game.timeline.tSec();

    for (let i = 0; i < 60; i += 1) game.tick(LOGIC_DT);
    expect(game.timeline.tSec()).toBe(tAfterEnd);
  });

  it('同一 seed 两局结果完全一致（可复现）', () => {
    function run(): number[] {
      const game = createGame({ input: WALK_FORWARD, seed: 42 });
      const trace: number[] = [];
      for (let i = 0; i < 300; i += 1) {
        game.tick(LOGIC_DT);
        trace.push(game.playerPos()[2]);
      }
      return trace;
    }
    expect(run()).toEqual(run());
  });
});
