import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { Execution } from '../../../src/player/Execution';
import type { ExecutionConfig } from '../../../src/player/Execution';

const DT = 1 / 60;
const cfg: ExecutionConfig = { windowSec: 3, durationSec: 1.2 };

function make(bossMaxHp = 1000) {
  const bus = createBus();
  const started: Array<Events['ExecutionStarted']> = [];
  const ended: Array<Events['ExecutionEnded']> = [];
  bus.on('ExecutionStarted', (p) => started.push(p));
  bus.on('ExecutionEnded', (p) => ended.push(p));
  let maxHp = bossMaxHp;
  const execution = new Execution({ bus, config: cfg, getBossMaxHp: () => maxHp });
  return { bus, execution, started, ended, setMaxHp: (v: number) => { maxHp = v; } };
}

function openWeakness(bus: ReturnType<typeof createBus>, part: 'core' | 'back' = 'core') {
  bus.emit('WeaknessProgress', { part, value: 100, max: 100, executable: true });
}

function run(execution: Execution, frames: number, request = false): void {
  for (let i = 0; i < frames; i += 1) execution.update(DT, request);
}

describe('Execution · 击破流程', () => {
  it('没有弱点时按 F 无效', () => {
    const { execution, started } = make();
    execution.update(DT, true);
    expect(execution.canExecute).toBe(false);
    expect(started).toHaveLength(0);
  });

  it('弱点可击破时按 F 开始处决，1.2 s 后结算 12% 真伤', () => {
    const { bus, execution, started, ended } = make(1000);
    openWeakness(bus, 'core');
    expect(execution.canExecute).toBe(true);

    execution.update(DT, true);
    expect(execution.isExecuting).toBe(true);
    expect(started).toEqual([{ part: 'core' }]);
    expect(ended).toHaveLength(0);

    run(execution, 72); // 1.2 s
    expect(execution.isExecuting).toBe(false);
    expect(ended).toEqual([{ part: 'core', damage: 120 }]);
    expect(execution.canExecute).toBe(false);
  });

  it('结算时读取当前阶段最大 HP', () => {
    const { bus, execution, ended, setMaxHp } = make(1000);
    openWeakness(bus);
    execution.update(DT, true);
    setMaxHp(2000);
    run(execution, 72);
    expect(ended[0].damage).toBeCloseTo(240);
  });

  it('处决过程中再按 F 不会重复触发', () => {
    const { bus, execution, started } = make();
    openWeakness(bus);
    execution.update(DT, true);
    run(execution, 30, true);
    expect(started).toHaveLength(1);
  });

  it('弱点窗口 3 s 未按 F 自动关闭', () => {
    const { bus, execution, started } = make();
    openWeakness(bus);
    run(execution, 179);
    expect(execution.canExecute).toBe(true);
    run(execution, 1);
    expect(execution.canExecute).toBe(false);

    execution.update(DT, true);
    expect(started).toHaveLength(0);
  });

  it('WeaknessClosed 提前关闭窗口', () => {
    const { bus, execution } = make();
    openWeakness(bus);
    bus.emit('WeaknessClosed', { part: 'core' });
    expect(execution.canExecute).toBe(false);
  });

  it('非 executable 的进度事件不开窗', () => {
    const { bus, execution } = make();
    bus.emit('WeaknessProgress', { part: 'core', value: 40, max: 100, executable: false });
    expect(execution.canExecute).toBe(false);
  });

  it('重复的可击破事件会刷新窗口', () => {
    const { bus, execution } = make();
    openWeakness(bus);
    run(execution, 120); // 2 s
    openWeakness(bus); // 刷新回 3 s
    run(execution, 120); // 再 2 s
    expect(execution.canExecute).toBe(true);
  });
});
