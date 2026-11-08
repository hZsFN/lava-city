// src/story/types.ts
// ============================================================================
// 剧情层契约 · 表里世界 / 五幕（迷惘 · 成长 · 舍弃 · 决绝 · 新生）
// ----------------------------------------------------------------------------
// 设计依据：docs/剧情/熔心孤塔_剧情设计.md
//
// **本文件不新增任何 events.ts 事件。** 剧情层是纯订阅者：
// 只听已有事件 + 自己的时钟，因此不需要改契约、不需要动 CONTRACT.lock。
//
// 分层：
//   src/story/StoryDirector.ts  纯 TS，无 three，可在 Node 下跑单测
//   src/ui/StoryPresenter.ts    DOM 字幕 + 里世界视觉（不碰 three 场景）
// ============================================================================

import type { Bus, MatchPhase } from '../core/events';

/** 世界层：surface=表世界（熔岩孤塔·现世），inner=里世界（熔心回廊·记忆） */
export type StoryWorld = 'surface' | 'inner';

/** 剧情层能监听的事件名（全部是 events.ts 里已有的，不新增） */
export type StoryEventName =
  | 'WeaknessExposed'
  | 'WeaknessClosed'
  | 'ExecutionStarted'
  | 'ExecutionEnded'
  | 'KneeBroken'
  | 'FreezeFull'
  | 'BossSkillInterrupted'
  | 'BossSkillStart'
  | 'PlayerDied'
  | 'PlayerDamaged'
  | 'TowerPlaced'
  | 'TowerDestroyed'
  | 'TauntStarted'
  | 'CoreHpChanged'
  | 'MatchEnded';

/** 事件载荷过滤：只匹配列出的字段（字符串/数字/布尔严格相等）。 */
export type EventMatch = Readonly<Record<string, string | number | boolean>>;

/** 触发条件。全部可从已有事件或本地时钟判定。 */
export type StoryTrigger =
  /** 关卡阶段切换（MatchPhaseChanged） */
  | { kind: 'phase'; phase: MatchPhase }
  /**
   * **阶段内进度**：进入 phase 后走过 pct% 时触发（0–100）。
   * 与 `tSec` 的区别：这是**相对游戏进程**的，阶段时长改了台词自动跟着走，
   * 玩家提前打完 Boss 也不会出现"台词还在讲准备期"的错位。
   */
  | { kind: 'phaseProgress'; phase: MatchPhase; pct: number }
  /** Boss 阶段切换（BossPhaseChanged） */
  | { kind: 'bossPhase'; to: 1 | 2 }
  /** Boss 血量首次跌破百分比（BossHpChanged / BossSpawned） */
  | { kind: 'bossHpBelow'; pct: number }
  /** 塔心血量首次跌破百分比（CoreHpChanged） */
  | { kind: 'coreHpBelow'; pct: number }
  /** 玩家血量首次跌破百分比（PlayerDamaged） */
  | { kind: 'playerHpBelow'; pct: number }
  /**
   * **熔岩液面**首次升到 y 以上（LavaLevelChanged）。
   * 这是本作最贴合叙事的进程信号：熔岩到脚踝、到膝盖、到胸口。
   */
  | { kind: 'lavaAbove'; y: number }
  /** 熔岩开始以 >= risePerSec 的速率上涨（LavaLevelChanged）。狂暴用。 */
  | { kind: 'lavaRising'; risePerSec: number }
  /** 某事件首次触发（可选载荷过滤） */
  | { kind: 'event'; event: StoryEventName; match?: EventMatch }
  /** 某事件累计触发第 n 次 */
  | { kind: 'count'; event: StoryEventName; n: number; match?: EventMatch }
  /** 绝对时刻（秒，从本局 0 起算；由 MatchPhaseChanged 校准）。**尽量少用，优先 phaseProgress。** */
  | { kind: 'tSec'; atSec: number }
  /** 前一条 cue 播完之后（可加延迟），用于成串的连续台词 */
  | { kind: 'afterCue'; id: string; delayMs?: number };

/** 时间窗：只在 [fromSec, toSec) 内允许触发。省略 = 全时段。 */
export interface StoryWindow {
  fromSec: number;
  toSec: number;
}

/** 一条剧情 cue = 一段字幕 + 一次世界层切换。 */
export interface StoryCue {
  id: string;
  trigger: StoryTrigger;
  /** 时间窗限制（秒）。用于把同一事件在不同阶段讲成不同的话。 */
  window?: StoryWindow;
  /** 触发后的最短间隔（毫秒）。防刷屏；省略则不限制。 */
  cooldownMs?: number;
  /** 只在第一局播放（真相、教学） */
  firstRunOnly?: boolean;
  /**
   * 第二局及以后改播这条 cue 的 id（多周目变体）。
   * **被引用的 cue 自动成为「变体专属」**：不参与常规触发扫描，只能被 altOnReplay 选中。
   */
  altOnReplay?: string;
  /** 优先级：高者打断低者；同优先级不打断。0=氛围 10=旁白 20=关键 25=揭示 30=转阶段/结局 */
  priority: number;
  /** 演出时长（毫秒）。到点自动收起。 */
  durationMs: number;
  /** 这条 cue 所处的世界层 */
  world: StoryWorld;
  /** 字幕结束后里世界继续维持的毫秒数（默认 0）。用于「一闪」之后的余韵。 */
  holdInnerMs?: number;
  /** 说话人。省略 = 旁白（无名字，用细体斜体）。 */
  speaker?: string;
  /** 正文。规范：标准 cue ≤ 2 行，关键 cue（durationMs ≥ 4000）≤ 3 行，单行 ≤ 22 汉字。 */
  text: string;
  /** 是否压上下黑边。省略时里世界自动压。 */
  letterbox?: boolean;
}

export interface StoryConfig {
  cues: StoryCue[];
  inner: {
    /** 进入里世界的淡入毫秒 */
    enterFadeMs: number;
    /** 退出里世界的淡出毫秒 */
    exitFadeMs: number;
    /** 每次进入里世界后，边缘结晶化强度累加（0..1 上限） */
    crystalPerVisit: number;
    /** 结晶化强度上限 */
    crystalMax: number;
  };
  /** 字幕最短显示时间（毫秒）。低于此时长的 cue 会被抬到该值。 */
  minShowMs: number;
}

/** 供表现层读取的只读状态。 */
export interface StoryState {
  /** 当前正在播的 cue（null = 无字幕） */
  cue: StoryCue | null;
  /** 当前 cue 已显示毫秒（打字机用） */
  shownMs: number;
  /** 当前世界层 */
  world: StoryWorld;
  /** 里世界剩余毫秒（0 = 不在里世界） */
  innerMsLeft: number;
  /** 进入里世界的累计次数（驱动结晶化视觉） */
  innerVisits: number;
  /** 本局已播放过的 cue id（按播放顺序） */
  played: readonly string[];
  /** 第几局（0 = 第一局） */
  runIndex: number;
}

export interface StoryDirector {
  init(deps: {
    bus: Bus;
    cfg: StoryConfig;
    runIndex?: number;
    /**
     * 阶段时长表（来自 flow.json）。`phaseProgress` 触发器靠它把
     * 「阶段内进度百分比」换算成实际时间。省略时该类 cue 静默不触发。
     */
    phaseDurations?: ReadonlyArray<{ phase: MatchPhase; startSec: number; endSec: number }>;
  }): void;
  /** 每帧推进（秒）。必须在逻辑 tick 之后调用。 */
  update(dtSec: number): void;
  /** 只读状态。表现层每帧读它，不要自己存副本。 */
  state(): StoryState;
  /** 调试/演出：按 id 强制播放，忽略触发条件与优先级。成功返回 true。 */
  force(cueId: string): boolean;
  /** 解除全部事件订阅。 */
  dispose(): void;
}

/** 表现层契约（src/ui/StoryPresenter.ts 实现）。 */
export interface StoryPresenter {
  /** 每帧调用。state 只读，dtSec 用于过渡插值。 */
  present(state: StoryState, dtSec: number): void;
  dispose(): void;
}
