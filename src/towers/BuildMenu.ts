// src/towers/BuildMenu.ts
// ============================================================================
// 建塔菜单的**纯逻辑层**（B1）—— 不碰 DOM、不碰 three、无副作用
// ----------------------------------------------------------------------------
// UI 会话直接消费 BuildMenuState：每帧拿 slotId + motes 调一次即可。
// 造价/射程/特效全部来自 config/towers.json，不硬编码。
// ============================================================================

import { TOWER_KINDS } from './types';
import type { BuildMenuState, BuildOption, TowerKind, TowersConfig } from './types';

/** 熔核数归一化：非有限值按 0，负数按 0，小数向下取整 */
export function normalizeMotes(motes: number): number {
  if (typeof motes !== 'number' || !Number.isFinite(motes)) return 0;
  return Math.max(0, Math.floor(motes));
}

/**
 * 全部可建塔选项（按 TOWER_KINDS 固定顺序，UI 位置稳定）。
 * `affordable` 只判断熔核是否够；某塔行为是否已由 B2 实现不在菜单层判断
 * （BuildOption 没有 available 字段，见 handoff 契约申请）。
 */
export function buildOptions(towersCfg: TowersConfig, motes: number): BuildOption[] {
  const balance = normalizeMotes(motes);
  const kinds = towersCfg?.kinds;
  if (!kinds) return [];

  const options: BuildOption[] = [];
  for (const kind of TOWER_KINDS) {
    const cfg = kinds[kind];
    if (!cfg) continue;
    options.push({
      kind,
      name: cfg.name,
      cost: cfg.cost,
      affordable: balance >= cfg.cost,
      range: cfg.range,
      special: cfg.special,
      attr: cfg.attr,
    });
  }
  return options;
}

/**
 * 建塔菜单状态。
 * - `slotId === null` → 菜单未打开，options 为空数组（UI 直接不渲染）
 * - 其它情况 → 五个塔的选项；够不够钱看 `affordable`
 */
export function createBuildMenu(
  towersCfg: TowersConfig,
  motes: number,
  slotId: string | null,
): BuildMenuState {
  if (slotId === null) return { slotId: null, options: [] };
  return { slotId, options: buildOptions(towersCfg, motes) };
}

/** 某个 kind 的造价（config 里没有该 kind 时返回 null） */
export function costOfKind(towersCfg: TowersConfig, kind: TowerKind): number | null {
  const cfg = towersCfg?.kinds?.[kind];
  return cfg ? cfg.cost : null;
}
