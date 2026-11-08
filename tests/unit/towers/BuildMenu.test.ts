// tests/unit/towers/BuildMenu.test.ts
// 建塔菜单纯函数（票 T-M2-01 第 13 条）
import { describe, expect, it } from 'vitest';
import { buildOptions, costOfKind, createBuildMenu, normalizeMotes } from '../../../src/towers/BuildMenu';
import { TOWER_KINDS } from '../../../src/towers/types';
import { towers } from './helpers';

describe('normalizeMotes', () => {
  it('负数/NaN/Infinity 一律归 0，小数向下取整', () => {
    expect(normalizeMotes(-3)).toBe(0);
    expect(normalizeMotes(Number.NaN)).toBe(0);
    expect(normalizeMotes(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeMotes(3.9)).toBe(3);
    expect(normalizeMotes(6)).toBe(6);
  });
});

describe('buildOptions', () => {
  it('五种塔全在，顺序固定为 TOWER_KINDS，数值来自 config', () => {
    const opts = buildOptions(towers, 99);
    expect(opts.map((o) => o.kind)).toEqual([...TOWER_KINDS]);
    const ballista = opts.find((o) => o.kind === 'ballista')!;
    expect(ballista.name).toBe(towers.kinds.ballista.name);
    expect(ballista.cost).toBe(towers.kinds.ballista.cost);
    expect(ballista.range).toBe(towers.kinds.ballista.range);
    expect(ballista.special).toBe(towers.kinds.ballista.special);
    expect(ballista.attr).toBe(towers.kinds.ballista.attr);
  });

  it('熔核不足时 affordable: false（造价 3，只有 2）', () => {
    const opts = buildOptions(towers, 2);
    for (const o of opts) {
      if (o.cost > 2) expect(o.affordable).toBe(false);
      else expect(o.affordable).toBe(true);
    }
    // 嘲讽图腾造价 2 → 买得起；其余 3 → 买不起
    expect(opts.find((o) => o.kind === 'totem')!.affordable).toBe(true);
    expect(opts.find((o) => o.kind === 'ballista')!.affordable).toBe(false);
  });

  it('熔核恰好等于造价时 affordable: true', () => {
    const opts = buildOptions(towers, 3);
    for (const o of opts) {
      if (o.cost === 3) expect(o.affordable).toBe(true);
    }
  });

  it('熔核为 0 时全部 affordable: false', () => {
    expect(buildOptions(towers, 0).every((o) => o.affordable === false)).toBe(true);
  });

  it('config 缺 kinds 时返回空数组，不崩', () => {
    expect(buildOptions({} as never, 99)).toEqual([]);
  });
});

describe('createBuildMenu', () => {
  it('slotId 为 null 时菜单关闭，options 为空', () => {
    const menu = createBuildMenu(towers, 6, null);
    expect(menu.slotId).toBeNull();
    expect(menu.options).toEqual([]);
  });

  it('slotId 有值时返回 5 个选项，并带上 slotId', () => {
    const menu = createBuildMenu(towers, 6, 'M1');
    expect(menu.slotId).toBe('M1');
    expect(menu.options).toHaveLength(5);
    expect(menu.options.every((o) => o.affordable)).toBe(true);
  });
});

describe('costOfKind', () => {
  it('返回 config 里的造价；未知 kind 返回 null', () => {
    expect(costOfKind(towers, 'totem')).toBe(towers.kinds.totem.cost);
    expect(costOfKind(towers, 'ballista')).toBe(3);
    expect(costOfKind(towers, 'nope' as never)).toBeNull();
  });
});
