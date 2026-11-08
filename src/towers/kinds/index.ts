// src/towers/kinds/index.ts
// ============================================================================
// 五种塔的行为注册表
// ----------------------------------------------------------------------------
// 骨架由 S0 建立（保证 B1 的 TowerSystem 从第一天就能编译）；
// 具体实现由 B2 在各自文件里写，然后在这里登记。
//
// B2 的交付顺序：
//   1. frost.ts  （寒晶：冻结值，破绽机的核心）
//   2. quake.ts  （震地锚：打断，破绽机的另一半）
//   3. ballista.ts（弩炮：叠碎甲）
//   4. rune.ts   （符文：叠灼烙）
//   5. totem.ts  （嘲讽：阶段 II 背部弱点的唯一手段）
// ============================================================================

import type { TowerBehavior, TowerKind } from '../types';
import { ballistaBehavior } from './ballista';
import { frostBehavior } from './frost';
import { quakeBehavior } from './quake';
import { runeBehavior } from './rune';
import { totemBehavior } from './totem';

/**
 * 已实现的塔行为。
 * B2 每完成一个，就在下面 import 并加进这个对象。
 * 未实现的塔不在表里 → B1 的 place() 会返回 false（不会崩）。
 */
export const TOWER_BEHAVIORS: Partial<Record<TowerKind, TowerBehavior>> = {
  ballista: ballistaBehavior,
  rune: runeBehavior,
  frost: frostBehavior,
  quake: quakeBehavior,
  totem: totemBehavior,
};

/** 某个塔行为是否已实现 */
export function hasBehavior(kind: TowerKind): boolean {
  return TOWER_BEHAVIORS[kind] !== undefined;
}
