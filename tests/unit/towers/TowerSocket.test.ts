// tests/unit/towers/TowerSocket.test.ts
// 塔位状态机（票 T-M2-01 第 1 条）
import { describe, expect, it } from 'vitest';
import { createSockets, TowerSocket } from '../../../src/towers/TowerSocket';
import { arena } from './helpers';

describe('TowerSocket · 初始状态', () => {
  it('初始 7 个 open（M1-M4、T1-T3）、4 个 locked（E1-E4）', () => {
    const sockets = createSockets(arena);
    expect(sockets).toHaveLength(11);

    const open = sockets.filter((s) => s.state === 'open').map((s) => s.slotId);
    const locked = sockets.filter((s) => s.state === 'locked').map((s) => s.slotId);

    expect(open).toEqual(['M1', 'M2', 'M3', 'M4', 'T1', 'T2', 'T3']);
    expect(locked).toEqual(['E1', 'E2', 'E3', 'E4']);
    expect(sockets.filter((s) => s.state === 'occupied')).toHaveLength(0);
    expect(sockets.filter((s) => s.state === 'submerged')).toHaveLength(0);
  });

  it('初始 towerId 全为 null，位置与 ring 来自 arena.json', () => {
    const sockets = createSockets(arena);
    for (const s of sockets) {
      expect(s.towerId).toBeNull();
    }
    const t1 = sockets.find((s) => s.slotId === 'T1');
    expect(t1?.ring).toBe('tower');
    expect(t1?.pos).toEqual([7.6, 12, 0]);
    expect(t1?.unlockPhase).toBe(1);
    expect(sockets.find((s) => s.slotId === 'E1')?.unlockPhase).toBe(2);
  });
});

describe('TowerSocket · 状态迁移', () => {
  it('locked → open（unlock 幂等，重复调用返回 false 且不改状态）', () => {
    const s = new TowerSocket({
      slotId: 'E1',
      ring: 'outer',
      pos: [24, 0, 24],
      unlockPhase: 2,
      drownAtY: -0.6,
    });
    expect(s.state).toBe('locked');
    expect(s.unlock()).toBe(true);
    expect(s.state).toBe('open');
    expect(s.unlock()).toBe(false);
    expect(s.state).toBe('open');
  });

  it('open → occupied → open', () => {
    const sockets = createSockets(arena);
    const s = sockets.find((x) => x.slotId === 'M1')!;
    expect(s.isBuildable).toBe(true);
    expect(s.occupy('M1-ballista-1')).toBe(true);
    expect(s.state).toBe('occupied');
    expect(s.towerId).toBe('M1-ballista-1');
    expect(s.isBuildable).toBe(false);

    expect(s.release()).toBe(true);
    expect(s.state).toBe('open');
    expect(s.towerId).toBeNull();
    expect(s.isBuildable).toBe(true);
  });

  it('locked 不能占用，occupied 不能重复占用', () => {
    const sockets = createSockets(arena);
    const e1 = sockets.find((x) => x.slotId === 'E1')!;
    expect(e1.occupy('x')).toBe(false);
    expect(e1.state).toBe('locked');

    const m1 = sockets.find((x) => x.slotId === 'M1')!;
    expect(m1.occupy('t1')).toBe(true);
    expect(m1.occupy('t2')).toBe(false);
    expect(m1.towerId).toBe('t1');
  });

  it('open/occupied → submerged 是终态，不能再回 open 也不能再建', () => {
    const sockets = createSockets(arena);
    const m1 = sockets.find((x) => x.slotId === 'M1')!;
    m1.occupy('t1');
    expect(m1.submerge()).toBe(true);
    expect(m1.state).toBe('submerged');
    expect(m1.towerId).toBeNull();
    expect(m1.release()).toBe(false);
    expect(m1.unlock()).toBe(false);
    expect(m1.occupy('t2')).toBe(false);
    expect(m1.isBuildable).toBe(false);
  });

  it('locked 不会被淹没（契约：open/occupied → submerged）', () => {
    const sockets = createSockets(arena);
    const e1 = sockets.find((x) => x.slotId === 'E1')!;
    expect(e1.submerge()).toBe(false);
    expect(e1.state).toBe('locked');
  });

  it('view() 是快照，改它不影响内部状态', () => {
    const sockets = createSockets(arena);
    const m1 = sockets.find((x) => x.slotId === 'M1')!;
    const v = m1.view();
    expect(v).toEqual({
      slotId: 'M1',
      ring: 'mid',
      pos: [20, 0, 0],
      state: 'open',
      towerId: null,
    });
    (v as { state: string }).state = 'submerged';
    expect(m1.state).toBe('open');
  });
});

describe('TowerSocket · 淹没阈值', () => {
  it('平地塔位（y=0）阈值 = lava.drownSlotY', () => {
    const sockets = createSockets(arena);
    for (const id of ['M1', 'M2', 'M3', 'M4', 'E1', 'E2', 'E3', 'E4']) {
      expect(sockets.find((s) => s.slotId === id)?.drownAtY).toBe(arena.lava.drownSlotY);
    }
  });

  it('塔身塔位（y=12）阈值 = drownSlotY + 12，熔岩涨到 -0.6 也不会淹塔身', () => {
    const sockets = createSockets(arena);
    const t1 = sockets.find((s) => s.slotId === 'T1')!;
    expect(t1.drownAtY).toBe(arena.lava.drownSlotY + 12);
    expect(t1.drownAtY).toBeGreaterThan(arena.lava.drownSlotY);
  });

  it('arena.slots 为空时返回空数组，不崩', () => {
    expect(createSockets({ ...arena, slots: [] })).toEqual([]);
  });
});
