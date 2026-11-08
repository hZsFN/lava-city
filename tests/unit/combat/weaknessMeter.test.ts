import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { WeaknessMeter } from '../../../src/combat/WeaknessMeter';

const DT = 1 / 60;

function make() {
  const bus = createBus();
  const progress: Array<Events['WeaknessProgress']> = [];
  bus.on('WeaknessProgress', (p) => progress.push(p));
  const meter = new WeaknessMeter({ bus, config: { max: 100, executableWindowSec: 3 } });
  return { bus, meter, progress };
}

const expose = (bus: ReturnType<typeof createBus>, part: 'core' | 'back' = 'core', ms = 5000) =>
  bus.emit('WeaknessExposed', { part, attr: part === 'core' ? 'arcane' : 'physical', durationMs: ms });

const hit = (
  bus: ReturnType<typeof createBus>,
  amount: number,
  attr: 'arcane' | 'physical',
  part: 'core' | 'back' = 'core',
) => bus.emit('DamageDealt', { target: 'boss', amount, attr, part, isCrit: false });

describe('WeaknessMeter · 破绽累积', () => {
  it('弱点暴露后从 0 开始', () => {
    const { bus, meter, progress } = make();
    expose(bus);
    expect(meter.progress).toBe(0);
    expect(meter.exposedPart).toBe('core');
    expect(progress.at(-1)).toMatchObject({ part: 'core', value: 0, executable: false });
  });

  it('匹配属性 +1/伤害点，不匹配 +0.25', () => {
    const { bus, meter } = make();
    expose(bus, 'core');
    hit(bus, 40, 'arcane');
    expect(meter.progress).toBeCloseTo(40);
    hit(bus, 40, 'physical');
    expect(meter.progress).toBeCloseTo(50);
  });

  it('命中非弱点部位不累加', () => {
    const { bus, meter } = make();
    expose(bus, 'core');
    hit(bus, 80, 'arcane', 'back');
    expect(meter.progress).toBe(0);
  });

  it('没有弱点暴露时伤害不累加', () => {
    const { bus, meter } = make();
    hit(bus, 80, 'arcane');
    expect(meter.progress).toBe(0);
  });

  it('满 100 进入可击破，3 s 后失效', () => {
    const { bus, meter, progress } = make();
    expose(bus, 'core');
    hit(bus, 100, 'arcane');
    expect(meter.progress).toBe(100);
    expect(meter.isExecutable).toBe(true);
    expect(progress.at(-1)).toMatchObject({ value: 100, executable: true });

    for (let i = 0; i < 179; i += 1) meter.update(DT);
    expect(meter.isExecutable).toBe(true);
    meter.update(DT);
    expect(meter.isExecutable).toBe(false);
  });

  it('WeaknessClosed 立即清空', () => {
    const { bus, meter } = make();
    expose(bus, 'core');
    hit(bus, 60, 'arcane');
    bus.emit('WeaknessClosed', { part: 'core' });
    expect(meter.progress).toBe(0);
    expect(meter.exposedPart).toBeNull();
  });

  it('暴露时间耗尽后自动清空', () => {
    const { bus, meter } = make();
    expose(bus, 'core', 1000);
    hit(bus, 40, 'arcane');
    for (let i = 0; i < 61; i += 1) meter.update(DT);
    expect(meter.exposedPart).toBeNull();
    expect(meter.progress).toBe(0);
  });

  it('切换弱点部位时重新计数', () => {
    const { bus, meter } = make();
    expose(bus, 'core');
    hit(bus, 60, 'arcane');
    bus.emit('WeaknessExposed', { part: 'back', attr: 'physical', durationMs: 5000 });
    expect(meter.progress).toBe(0);
    hit(bus, 30, 'physical', 'back');
    expect(meter.progress).toBeCloseTo(30);
  });
});
