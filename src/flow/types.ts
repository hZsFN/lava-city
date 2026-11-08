// src/flow/types.ts
// ============================================================================
// 共享类型层（流程侧）· M4-01 起承载 9 段演出时间轴
// ----------------------------------------------------------------------------
// B3 实现 MatchTimeline / Scoring / Telemetry。
// B1 的 TowerSystem 需要 setPhase / setLavaY，通过 MatchPhase 与 lavaY 对接。
// ============================================================================

import type { Bus, MatchPhase } from '../core/events';

export type { Bus, MatchPhase };

/** config/flow.json 里单个阶段 */
export interface PhaseConfig {
  phase: MatchPhase;
  /** wake 段的内部节拍（dark / blur），只用于演出，不进入契约 */
  beat?: string;
  startSec: number;
  endSec: number;
}

/** config/flow.json 的评分档位 */
export interface GradeConfig {
  grade: 'S' | 'A' | 'B' | 'C';
  maxSec: number;
  minExecutions: number;
  minCorePct: number;
}

/** 一行旁白 / 台词。atSec 相对该 phase 第一次出现的开始时刻。 */
export interface NarrationLine {
  phase: MatchPhase;
  atSec: number;
  text: string;
  speaker?: 'boss' | 'narrator';
  fadeMs: number;
  holdMs: number;
}

export interface TutorialGeometry {
  widthM: number;
  coverThicknessM: number;
  depthM: number;
  pagesInsetM: number;
  pagesThicknessM: number;
}

export interface TutorialConfig {
  autoDissolveAfterSec: number;
  offsetRightM: number;
  offsetForwardM: number;
  heightM: number;
  floatAmplitudeM: number;
  floatPeriodSec: number;
  pickupRadiusM: number;
  leaveRadiusM: number;
  readingFov: number;
  cameraBlendSec: number;
  light: { color: string; intensity: number; distance: number };
  geometry: TutorialGeometry;
  colors: { cover: string; pages: string; edge: string };
  sparkCount: number;
  sparkMs: number;
  /** 最后一页停留多久后自动化成火星 */
  lastPageHoldSec: number;
  sparkColor: string;
  prompt: string;
  pageHint: string;
  pages: string[];
}

export interface WakeShowConfig {
  darkEndSec: number;
  blurEndSec: number;
  blurMaxPx: number;
  pitchStartDeg: number;
  pitchEndDeg: number;
}

export interface BossSpawnConfig {
  mouthPos: [number, number, number];
  mouthRadiusM: number;
  rippleSec: number;
  riseSec: number;
  fromY: number;
  toY: number;
  fromScale: number;
  toScale: number;
  shakeSec: number;
  shakePx: number;
  sparkCount: number;
}

export interface TransitionShowConfig {
  sinkSec: number;
  sinkDepthM: number;
  darkStartSec: number;
  darkEndSec: number;
  darkFactor: number;
  riseStartSec: number;
  riseEndSec: number;
  bossScale2: number;
  restoreEndSec: number;
  lavaRiseStartSec: number;
  lavaRiseEndSec: number;
  visualLavaRiseM: number;
}

export interface VictoryShowConfig {
  shatterSec: number;
  shardCount: number;
  shardLifeSec: number;
  beamFromM: number;
  beamToM: number;
  beamGrowSec: number;
  beamRadiusM: number;
  beamColor: string;
  beamOpacity: number;
  washColor: string;
  washIntensity: number;
  shakeSec: number;
  shakePx: number;
}

export interface EscapeShowConfig {
  orbitRadiusM: number;
  /** 玩家被吸到塔心后镜头拉远到的半径，避免穿进塔身 */
  orbitEndRadiusM: number;
  orbitHeightM: number;
  orbitTurns: number;
  avatarRiseToM: number;
  avatarFadeStartSec: number;
  avatarFadeEndSec: number;
  whiteStartSec: number;
  whiteFadeSec: number;
}

export interface FailShowConfig {
  blackSec: number;
  text: string;
  textFadeSec: number;
  handoffDelaySec: number;
  reason: string;
}

/** config/flow.json 整体形状 */
export interface FlowConfig {
  matchLengthSec: number;
  playerSpawn: [number, number, number];
  phases: PhaseConfig[];
  victory: { durationSec: number; escapeDurationSec: number };
  rage: { atSec: number; risePerSec: number; swallowAfterSec: number };
  core: { maxHp: number };
  motes: {
    start: number;
    perBossHpPct: number;
    perExecution: number;
  };
  score: { grades: GradeConfig[] };
  narration: NarrationLine[];
  speakers: Record<string, string>;
  wake: WakeShowConfig;
  tutorial: TutorialConfig;
  bossSpawn: BossSpawnConfig;
  transition: TransitionShowConfig;
  victoryShow: VictoryShowConfig;
  escape: EscapeShowConfig;
  fail: FailShowConfig;
  demo: { winAtSec: number; failAtSec: number };
}

/** 一局结束的原因 */
export type EndReason =
  | 'boss_defeated'
  | 'core_destroyed'
  | 'player_out_of_lives'
  | 'timeout'
  | 'lava_swallowed';

/** 一局的结果 */
export interface MatchResult {
  result: 'win' | 'lose';
  reason: EndReason;
  tSec: number;
}

/** 评分输入 */
export interface ScoreInput {
  tSec: number;
  executions: number;
  coreHpPct: number;
  deaths: number;
  won: boolean;
}

/** 评分结果 */
export interface ScoreResult {
  grade: 'S' | 'A' | 'B' | 'C';
  breakdown: Record<string, number>;
}

/**
 * 时间轴状态机：B3 实现。
 * S0 在集成期用它在 src/main.ts 里驱动一局。
 */
export interface MatchTimeline {
  init(deps: { bus: Bus; flowCfg: FlowConfig; arenaCfg: unknown }): void;

  /** 固定步长推进。返回本帧是否发生阶段切换 */
  update(dtSec: number): boolean;

  phase(): MatchPhase;
  tSec(): number;
  /** 当前阶段结束时刻；ended 时为 0 */
  endsAtSec(): number;
  /** 一局结束后才有值 */
  result(): MatchResult | null;
  /** 熔岩当前高度 */
  lavaY(): number;

  /** 外部通知：Boss 死了 → 进入 victory 演出（不是立即结算） */
  notifyBossDefeated(): void;
  /** 外部通知：塔心被打爆 */
  notifyCoreDestroyed(): void;
  /** 外部通知：玩家死亡数到上限 */
  notifyPlayerOutOfLives(): void;
  /** 外部伤害：塔心扣血 */
  applyCoreDamage(amount: number): void;
  /** 阶段 I 血量打空 → 跳到 transition */
  jumpToTransition(): void;
}

/** 遥测记录：每局一份 JSON */
export interface TelemetryRecord {
  version: 1;
  seed: number;
  result: 'win' | 'lose';
  reason: string;
  tSec: number;
  phaseTimes: Record<string, number>;
  executions: number;
  executionTimes: number[];
  damageBySource: { tower: number; player: number; execution: number };
  towerBuildOrder: Array<{ tSec: number; kind: string; slotId: string }>;
  deaths: number;
  coreHpPct: number;
  grade: 'S' | 'A' | 'B' | 'C';
}

export interface Telemetry {
  record(): TelemetryRecord;
  toJson(): string;
}
