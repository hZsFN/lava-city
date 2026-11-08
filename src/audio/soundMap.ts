// src/audio/soundMap.ts
// ============================================================================
// M5-02 音频资产地图
// ----------------------------------------------------------------------------
// 67 个文件（BGM 9 / 环境 2 / 音效 56）的**纯数据**：
//   - 文件名与分组（决定什么阶段解码哪一批）
//   - 每个音效的默认增益、是否关键（16 声部上限时不被丢弃）
//   - 阶段 → BGM 的曲目、增益、循环/渐弱规则
//   - 事件/技能/塔种类 → 音效的映射表
//
// 本文件不碰 Web Audio，也不 import three；加载与播放全部在 AudioPlayer.ts。
// ============================================================================

import type { MatchPhase } from '../core/events';

/** 资产总数：9 BGM + 2 环境 + 56 音效 */
export const TOTAL_SOUNDS = 67;

/** 同一音效的最小重复间隔（毫秒）——防止塔群齐射爆音 */
export const DEDUPE_MS = 50;

/** 同时播放的一次性音效上限；超出时丢弃最旧的非关键音效 */
export const MAX_VOICES = 16;

/** BGM 换轨交叉淡化时长（秒） */
export const BGM_CROSSFADE_SEC = 0.8;

// ── BGM（9）─────────────────────────────────────────────────────────────────

export const BGM_NAMES = [
  'bgm-molten-heart',
  'bgm-preparation',
  'bgm-boss-phase1',
  'bgm-phase-transition',
  'bgm-boss-phase2',
  'bgm-rage',
  'bgm-victory',
  'bgm-defeat',
  'bgm-tactical',
] as const;

export type BgmName = (typeof BGM_NAMES)[number];

// ── 环境铺底（2）───────────────────────────────────────────────────────────

export const AMBIENT_NAMES = ['amb-lava', 'amb-tower'] as const;

export type AmbientName = (typeof AMBIENT_NAMES)[number];

// ── 音效（56）──────────────────────────────────────────────────────────────
// 分组 = 分批解码的粒度：
//   combat  醒来/教程阶段（玩家 + 武器 + 破绽 + 命中）  26 个
//   towers  准备阶段（建塔/拆塔/塔开火/塔位）            11 个
//   ui      准备阶段（按钮/战术视图/倒计时/塔心告警）      8 个
//   boss    进战斗才解（Boss 技能 11 个）                11 个

const COMBAT_SFX = [
  'sfx-footstep-stone-01',
  'sfx-footstep-stone-02',
  'sfx-footstep-stone-03',
  'sfx-footstep-stone-04',
  'sfx-dash',
  'sfx-form-switch',
  'sfx-player-death',
  'sfx-player-low-health',
  'sfx-jump',
  'sfx-land-heavy',
  'sfx-land-light',
  'sfx-lava-fall',
  'sfx-lava-rise',
  'sfx-overheat',
  'sfx-freeze',
  'sfx-mote-gain',
  'sfx-physical-shot-a',
  'sfx-physical-shot-b',
  'sfx-arcane-shot-a',
  'sfx-arcane-shot-b',
  'sfx-execution-windup',
  'sfx-execution-ready',
  'sfx-execution',
  'sfx-weakness-open',
  'sfx-weakness-close',
  'sfx-hit',
] as const;

const TOWER_SFX = [
  'sfx-tower-ballista',
  'sfx-tower-rune',
  'sfx-tower-frost',
  'sfx-tower-quake',
  'sfx-tower-totem',
  'sfx-tower-build',
  'sfx-tower-upgrade',
  'sfx-tower-sell',
  'sfx-tower-destroy',
  'sfx-slot-unlock',
  'sfx-slot-submerged',
] as const;

const UI_SFX = [
  'sfx-ui-confirm',
  'sfx-ui-cancel',
  'sfx-ui-error',
  'sfx-tactical-open',
  'sfx-tactical-close',
  'sfx-countdown-tick',
  'sfx-countdown-final',
  'sfx-core-warning',
] as const;

const BOSS_SFX = [
  'sfx-boss-windup',
  'sfx-boss-rock-sweep',
  'sfx-boss-slam',
  'sfx-boss-breath',
  'sfx-boss-fire',
  'sfx-boss-fire-rain-impact',
  'sfx-boss-stone-pillar',
  'sfx-boss-lava-charge',
  'sfx-boss-self-ignite',
  'sfx-boss-core-drain',
  'sfx-boss-interrupted',
] as const;

export const SFX_NAMES = [...COMBAT_SFX, ...TOWER_SFX, ...UI_SFX, ...BOSS_SFX] as const;

export type SfxName = (typeof SFX_NAMES)[number];

export type SoundName = BgmName | AmbientName | SfxName;

export type SfxGroup = 'combat' | 'towers' | 'ui' | 'boss';

export const SFX_GROUP_NAMES: Record<SfxGroup, readonly SfxName[]> = {
  combat: COMBAT_SFX,
  towers: TOWER_SFX,
  ui: UI_SFX,
  boss: BOSS_SFX,
};

export const SFX_GROUP_OF: Record<SfxName, SfxGroup> = (() => {
  const table = {} as Record<SfxName, SfxGroup>;
  for (const group of Object.keys(SFX_GROUP_NAMES) as SfxGroup[]) {
    for (const name of SFX_GROUP_NAMES[group]) table[name] = group;
  }
  return table;
})();

// ── 文件路径 ───────────────────────────────────────────────────────────────
// 相对路径（`audio/...`），配合 vite 的 base:'./'；不要写成 `/audio/`。

export const SOUND_FILE: Record<SoundName, string> = (() => {
  const table = {} as Record<SoundName, string>;
  for (const name of [...BGM_NAMES, ...AMBIENT_NAMES, ...SFX_NAMES] as const) {
    table[name] = `audio/${name}.ogg`;
  }
  return table;
})();

// ── 阶段 → BGM ─────────────────────────────────────────────────────────────

export interface BgmCue {
  track: BgmName;
  gain: number;
  /** 默认 true；转场轨 false（播完接 next） */
  loop?: boolean;
  /** 不循环的轨道播完后接哪首（仅 transition） */
  next?: BgmName;
  /** 持续渐弱到 0 的秒数（仅 escape） */
  fadeOutSec?: number;
}

export const BGM_BY_PHASE: Partial<Record<MatchPhase, BgmCue>> = {
  wake: { track: 'bgm-preparation', gain: 0.30 },
  tutorial: { track: 'bgm-preparation', gain: 0.30 },
  prep: { track: 'bgm-preparation', gain: 0.35 },
  boss1: { track: 'bgm-boss-phase1', gain: 0.42 },
  transition: { track: 'bgm-phase-transition', gain: 0.45, loop: false, next: 'bgm-boss-phase2' },
  boss2: { track: 'bgm-boss-phase2', gain: 0.45 },
  rage: { track: 'bgm-rage', gain: 0.50 },
  victory: { track: 'bgm-victory', gain: 0.55 },
  escape: { track: 'bgm-victory', gain: 0.55, fadeOutSec: 10 },
};

/** 失败结算的 BGM（MatchEnded{result:'lose'}） */
export const DEFEAT_CUE: BgmCue = { track: 'bgm-defeat', gain: 0.55 };

/** 按曲目反查阶段 Cue（转场轨播完接下一首时用） */
export function bgmCueForTrack(track: BgmName): BgmCue {
  for (const cue of Object.values(BGM_BY_PHASE)) {
    if (cue && cue.track === track) return cue;
  }
  return { track, gain: 0.45 };
}

// ── 环境铺底 ───────────────────────────────────────────────────────────────

export const AMBIENCE = {
  lava: {
    name: 'amb-lava' as AmbientName,
    /** 基础增益 */
    gain: 0.12,
    /** 熔岩涨到上限时的增益 */
    floodGain: 0.22,
    /** 从基准液面到最大增益的上涨米数 */
    riseToMaxM: 3,
  },
  tower: {
    name: 'amb-tower' as AmbientName,
    gain: 0.08,
  },
} as const;

// ── 每个音效的默认增益 ─────────────────────────────────────────────────────

export const SFX_GAIN: Record<SfxName, number> = {
  // 玩家 / 移动
  'sfx-footstep-stone-01': 0.35,
  'sfx-footstep-stone-02': 0.35,
  'sfx-footstep-stone-03': 0.35,
  'sfx-footstep-stone-04': 0.35,
  'sfx-dash': 0.55,
  'sfx-form-switch': 0.60,
  'sfx-player-death': 0.85,
  'sfx-player-low-health': 0.25,
  'sfx-jump': 0.35,
  'sfx-land-heavy': 0.55,
  'sfx-land-light': 0.40,
  'sfx-lava-fall': 0.70,
  'sfx-lava-rise': 0.60,
  'sfx-overheat': 0.50,
  'sfx-freeze': 0.55,
  'sfx-mote-gain': 0.45,
  // 武器 / 破绽 / 命中
  'sfx-physical-shot-a': 0.55,
  'sfx-physical-shot-b': 0.55,
  'sfx-arcane-shot-a': 0.50,
  'sfx-arcane-shot-b': 0.50,
  'sfx-execution-windup': 0.60,
  'sfx-execution-ready': 0.70,
  'sfx-execution': 0.90,
  'sfx-weakness-open': 0.80,
  'sfx-weakness-close': 0.60,
  'sfx-hit': 0.60,
  // 塔
  'sfx-tower-ballista': 0.45,
  'sfx-tower-rune': 0.45,
  'sfx-tower-frost': 0.45,
  'sfx-tower-quake': 0.55,
  'sfx-tower-totem': 0.45,
  'sfx-tower-build': 0.70,
  'sfx-tower-upgrade': 0.65,
  'sfx-tower-sell': 0.55,
  'sfx-tower-destroy': 0.70,
  'sfx-slot-unlock': 0.60,
  'sfx-slot-submerged': 0.55,
  // 界面 / 节奏
  'sfx-ui-confirm': 0.50,
  'sfx-ui-cancel': 0.45,
  'sfx-ui-error': 0.55,
  'sfx-tactical-open': 0.40,
  'sfx-tactical-close': 0.40,
  'sfx-countdown-tick': 0.40,
  'sfx-countdown-final': 0.55,
  'sfx-core-warning': 0.30,
  // Boss
  'sfx-boss-windup': 0.80,
  'sfx-boss-rock-sweep': 0.70,
  'sfx-boss-slam': 0.85,
  'sfx-boss-breath': 0.70,
  'sfx-boss-fire': 0.35,
  'sfx-boss-fire-rain-impact': 0.65,
  'sfx-boss-stone-pillar': 0.70,
  'sfx-boss-lava-charge': 0.75,
  'sfx-boss-self-ignite': 0.80,
  'sfx-boss-core-drain': 0.70,
  'sfx-boss-interrupted': 0.70,
};

/**
 * 关键音效：16 声部打满时**不会**被丢弃。
 * P0（破绽/击破/受击/死亡）与 Boss 技能全部在列；塔与脚步是可丢弃的。
 */
export const CRITICAL_SFX: ReadonlySet<SfxName> = new Set<SfxName>([
  'sfx-weakness-open',
  'sfx-weakness-close',
  'sfx-execution',
  'sfx-execution-ready',
  'sfx-hit',
  'sfx-player-death',
  'sfx-player-low-health',
  'sfx-boss-windup',
  'sfx-boss-rock-sweep',
  'sfx-boss-slam',
  'sfx-boss-breath',
  'sfx-boss-fire-rain-impact',
  'sfx-boss-stone-pillar',
  'sfx-boss-lava-charge',
  'sfx-boss-self-ignite',
  'sfx-boss-core-drain',
  'sfx-boss-interrupted',
]);

// ── 轮播别名（同一族音效交替）─────────────────────────────────────────────

export const SFX_ROTATIONS = {
  footstep: [
    'sfx-footstep-stone-01',
    'sfx-footstep-stone-02',
    'sfx-footstep-stone-03',
    'sfx-footstep-stone-04',
  ],
  'physical-shot': ['sfx-physical-shot-a', 'sfx-physical-shot-b'],
  'arcane-shot': ['sfx-arcane-shot-a', 'sfx-arcane-shot-b'],
} as const satisfies Record<string, readonly SfxName[]>;

export type SfxAlias = keyof typeof SFX_ROTATIONS;

/** play() 接受的参数：具体文件，或会轮播的别名 */
export type PlayableSound = SfxName | SfxAlias;

// ── Boss 技能 → 音效 ───────────────────────────────────────────────────────

export interface SkillSfx {
  /** windup 阶段（起手）；没写就不出声 */
  windup?: SfxName;
  /** active 阶段 */
  active?: SfxName;
  /** 持续循环音（active 开始，BossSkillEnd/Interrupted 停） */
  loop?: SfxName;
  loopGain?: number;
}

export const SKILL_SFX: Record<string, SkillSfx> = {
  rockSweep: { active: 'sfx-boss-rock-sweep' },
  leapSlam: { windup: 'sfx-boss-windup', active: 'sfx-boss-slam' },
  magmaBreath: { active: 'sfx-boss-breath' },
  stonePillars: { active: 'sfx-boss-stone-pillar' },
  lavaCharge: { active: 'sfx-boss-lava-charge' },
  coreDrain: { active: 'sfx-boss-core-drain' },
  selfIgnite: { active: 'sfx-boss-self-ignite' },
  // 火雨：落点音 + 火焰持续（循环）
  fireRain: { active: 'sfx-boss-fire-rain-impact', loop: 'sfx-boss-fire', loopGain: 0.35 },
};

// ── 塔种类 → 开火音 ────────────────────────────────────────────────────────

export const TOWER_SFX_BY_KIND: Record<string, SfxName> = {
  ballista: 'sfx-tower-ballista',
  rune: 'sfx-tower-rune',
  frost: 'sfx-tower-frost',
  quake: 'sfx-tower-quake',
  totem: 'sfx-tower-totem',
};
