import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';

// 契约层的自测：保证事件总线 + 快照投影在四路并行开发期间行为稳定。
// 任何会话改坏了 Bus 语义，这里会立刻红。

describe('core/events · createBus', () => {
  it('订阅后能收到 payload，且取消订阅生效', () => {
    const bus = createBus();
    const seen: number[] = [];
    const off = bus.on('MoteCountChanged', (p) => seen.push(p.motes));

    bus.emit('MoteCountChanged', { motes: 6 });
    bus.emit('MoteCountChanged', { motes: 5 });
    off();
    bus.emit('MoteCountChanged', { motes: 4 });

    expect(seen).toEqual([6, 5]);
  });

  it('同一事件多个订阅者都会收到', () => {
    const bus = createBus();
    let a = 0;
    let b = 0;
    bus.on('MatchPhaseChanged', () => { a += 1; });
    bus.on('MatchPhaseChanged', () => { b += 1; });

    bus.emit('MatchPhaseChanged', { phase: 'prep', tSec: 20 });

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('snapshot 投影：阶段与时间被回写', () => {
    const bus = createBus();
    expect(bus.snapshot().phase).toBe('wake');

    bus.emit('MatchPhaseChanged', { phase: 'boss1', tSec: 40 });

    expect(bus.snapshot().phase).toBe('boss1');
    expect(bus.snapshot().tSec).toBe(40);
  });

  it('snapshot 投影：塔放置后出现在 towers，且槽位变 occupied', () => {
    const bus = createBus();

    bus.emit('TowerPlaced', { towerId: 't1', kind: 'ballista', slotId: 'M1', pos: [20, 0, 0] });
    bus.emit('TowerHpChanged', { towerId: 't1', hp: 600, maxHp: 600 });

    const snap = bus.snapshot();
    expect(snap.towers).toHaveLength(1);
    expect(snap.towers[0]).toMatchObject({ id: 't1', kind: 'ballista', level: 1, hp: 600 });
    expect(snap.towerSlots.find((s) => s.slotId === 'M1')?.state).toBe('occupied');
  });

  it('snapshot 投影：塔被拆除后从 towers 移除', () => {
    const bus = createBus();
    bus.emit('TowerPlaced', { towerId: 't1', kind: 'rune', slotId: 'M2', pos: [0, 0, 20] });
    bus.emit('TowerDestroyed', { towerId: 't1', reason: 'sold' });

    expect(bus.snapshot().towers).toHaveLength(0);
  });

  it('snapshot 投影：Boss 弱点开合', () => {
    const bus = createBus();
    bus.emit('WeaknessExposed', { part: 'core', attr: 'arcane', durationMs: 5000 });
    expect(bus.snapshot().boss.weakness).toBe('core');

    bus.emit('WeaknessClosed', { part: 'core' });
    expect(bus.snapshot().boss.weakness).toBeNull();
  });

  it('snapshot 投影：熔岩高度与塔心 HP', () => {
    const bus = createBus();
    bus.emit('LavaLevelChanged', { y: -1.2, risePerSec: 0.1 });
    bus.emit('CoreHpChanged', { hp: 880, maxHp: 1000 });

    expect(bus.snapshot().lavaY).toBe(-1.2);
    expect(bus.snapshot().coreHp).toBe(880);
  });

  it('未订阅的事件 emit 不抛错', () => {
    const bus = createBus();
    const payload: Events['PlayerDied'] = { cause: 'lava', deaths: 1 };
    expect(() => bus.emit('PlayerDied', payload)).not.toThrow();
  });

  it('处理函数里抛错会向上冒泡（不静默吞掉）', () => {
    const bus = createBus();
    bus.on('PlayerDied', () => { throw new Error('boom'); });
    expect(() => bus.emit('PlayerDied', { cause: 'lava', deaths: 1 })).toThrow('boom');
  });
});
