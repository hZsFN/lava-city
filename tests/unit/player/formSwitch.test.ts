import { describe, expect, it } from 'vitest';
import { createBus } from '../../../src/core/events';
import type { Events } from '../../../src/core/events';
import { FormSwitch } from '../../../src/player/FormSwitch';
import type { FormSwitchConfig } from '../../../src/player/FormSwitch';

const DT = 1 / 60;
const cfg: FormSwitchConfig = { durationSec: 0.5, initial: 'physical' };

function make() {
  const bus = createBus();
  const switched: Array<Events['FormSwitched']> = [];
  bus.on('FormSwitched', (p) => switched.push(p));
  const form = new FormSwitch({ bus, config: cfg });
  return { bus, form, switched };
}

function run(form: FormSwitch, frames: number, request = false): void {
  for (let i = 0; i < frames; i += 1) form.update(DT, request);
}

describe('FormSwitch · 形态切换', () => {
  it('初始形态取自 config', () => {
    const { form } = make();
    expect(form.form).toBe('physical');
    expect(form.isSwitching).toBe(false);
    expect(form.canAttack).toBe(true);
  });

  it('按 Q 开始切换，0.5 s 后变为法术形态并发布事件', () => {
    const { form, switched } = make();
    form.update(DT, true);
    expect(form.isSwitching).toBe(true);
    expect(form.canAttack).toBe(false);
    expect(switched).toHaveLength(0);

    run(form, 30); // 0.5 s
    expect(form.isSwitching).toBe(false);
    expect(form.form).toBe('arcane');
    expect(switched).toEqual([{ form: 'arcane' }]);
    expect(form.canAttack).toBe(true);
  });

  it('切回物理形态', () => {
    const { form, switched } = make();
    form.update(DT, true);
    run(form, 30);
    form.update(DT, true);
    run(form, 30);
    expect(form.form).toBe('physical');
    expect(switched.map((s) => s.form)).toEqual(['arcane', 'physical']);
  });

  it('切换过程中再按 Q 不会叠加或反向', () => {
    const { form, switched } = make();
    form.update(DT, true);
    run(form, 15, true);
    expect(form.isSwitching).toBe(true);
    run(form, 15);
    expect(form.form).toBe('arcane');
    expect(switched).toHaveLength(1);
  });

  it('切换进度从 0 走到 1', () => {
    const { form } = make();
    form.update(DT, true);
    expect(form.progress).toBeCloseTo(0, 5);
    run(form, 15);
    expect(form.progress).toBeCloseTo(0.5, 2);
  });

  it('dt=0 时不推进', () => {
    const { form } = make();
    form.update(DT, true);
    form.update(0, false);
    expect(form.isSwitching).toBe(true);
    expect(form.form).toBe('physical');
  });
});
