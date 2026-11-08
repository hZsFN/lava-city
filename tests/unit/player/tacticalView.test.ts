import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { TacticalView } from '../../../src/player/TacticalView';
import type { TacticalViewConfig } from '../../../src/player/TacticalView';

const cfg: TacticalViewConfig = { timeScale: 0.15, relocateCost: 1 };

function make(relocate: (towerId: string, slotId: string) => boolean = () => true) {
  const bus = createBus();
  const changed: Array<Events['TacticalViewChanged']> = [];
  const calls: Array<[string, string]> = [];
  bus.on('TacticalViewChanged', (p) => changed.push(p));
  const view = new TacticalView({
    bus,
    config: cfg,
    relocate: (towerId, slotId) => {
      calls.push([towerId, slotId]);
      return relocate(towerId, slotId);
    },
  });
  return { bus, view, changed, calls };
}

function gainPoints(bus: ReturnType<typeof createBus>, n: number): void {
  for (let i = 0; i < n; i += 1) bus.emit('ExecutionEnded', { part: 'core', damage: 100 });
}

describe('TacticalView · 开关与时间缩放', () => {
  it('初始关闭，时间正常', () => {
    const { view } = make();
    expect(view.isOpen).toBe(false);
    expect(view.timeScale).toBe(1);
  });

  it('Tab 打开，时间降到 0.15×', () => {
    const { view, changed, bus } = make();
    view.update(true);
    expect(view.isOpen).toBe(true);
    expect(view.timeScale).toBe(0.15);
    expect(changed).toEqual([{ open: true }]);
    expect(bus.snapshot()).toBeDefined();
  });

  it('再次 Tab 关闭，时间恢复', () => {
    const { view, changed } = make();
    view.update(true);
    view.update(true);
    expect(view.isOpen).toBe(false);
    expect(view.timeScale).toBe(1);
    expect(changed.map((c) => c.open)).toEqual([true, false]);
  });

  it('未按 Tab 不改变状态', () => {
    const { view, changed } = make();
    view.update(false);
    expect(view.isOpen).toBe(false);
    expect(changed).toHaveLength(0);
  });
});

describe('TacticalView · 战术点与搬塔', () => {
  it('每次击破 +1 战术点', () => {
    const { bus, view } = make();
    gainPoints(bus, 3);
    expect(view.points).toBe(3);
  });

  it('关闭时不能搬塔', () => {
    const { bus, view, calls } = make();
    gainPoints(bus, 1);
    expect(view.tryRelocate('t1', 'M1')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(view.points).toBe(1);
  });

  it('打开时搬塔消耗 1 点', () => {
    const { bus, view, calls } = make();
    gainPoints(bus, 1);
    view.update(true);
    expect(view.tryRelocate('t1', 'M2')).toBe(true);
    expect(calls).toEqual([['t1', 'M2']]);
    expect(view.points).toBe(0);
  });

  it('战术点不足时不能搬塔', () => {
    const { view, calls } = make();
    view.update(true);
    expect(view.tryRelocate('t1', 'M2')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('搬塔失败退还战术点', () => {
    const { bus, view } = make(() => false);
    gainPoints(bus, 1);
    view.update(true);
    expect(view.tryRelocate('t1', 'M2')).toBe(false);
    expect(view.points).toBe(1);
  });

  it('转阶段赠送 1 次免费重布，优先消耗免费次数', () => {
    const { bus, view } = make();
    gainPoints(bus, 1);
    bus.emit('BossPhaseChanged', { from: 1, to: 2 });
    expect(view.freeRearrangesLeft).toBe(1);

    view.update(true);
    expect(view.tryRelocate('t1', 'M2')).toBe(true);
    expect(view.points).toBe(1);
    expect(view.freeRearrangesLeft).toBe(0);

    // 下一次搬塔才消耗战术点
    expect(view.tryRelocate('t2', 'M3')).toBe(true);
    expect(view.points).toBe(0);
  });

  it('免费重布失败也会退还', () => {
    const { bus, view } = make(() => false);
    bus.emit('BossPhaseChanged', { from: 1, to: 2 });
    view.update(true);
    expect(view.tryRelocate('t1', 'M2')).toBe(false);
    expect(view.freeRearrangesLeft).toBe(1);
  });
});
