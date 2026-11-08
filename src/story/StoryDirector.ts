// src/story/StoryDirector.ts
// ============================================================================
// 剧情触发引擎 · 表里世界的节拍器
// ----------------------------------------------------------------------------
// 纯 TS 逻辑层：**不 import three、不 bus.emit**，只 bus.on 订阅 + 自己的时钟。
// 因此可在 Node 下直接跑单测（vitest environment: 'node'）。
//
// 设计依据：docs/剧情/熔心孤塔_剧情设计.md
// 契约：src/story/types.ts（逐字实现，不改）
//
// 核心思想：本作单局只有 4:30，没有时间播过场。所以剧情不"停下来讲"，
// 而是在战斗最激烈的那一瞬"渗出来"——Boss 转阶段、弱点暴露、击破、膝盖碎裂、
// 冻结满、玩家死亡，这些时刻自动把画面切进里世界，给一句台词，再切回来。
//
// 本文件只负责「什么时候说什么」，不负责「长什么样」（那是 src/ui/StoryPresenter.ts）。
//
// 三条实现纪律：
//   1. 时钟以 MatchPhaseChanged 的 tSec 为权威（时间轴在 flow 手里）。
//   2. 一条 cue 的「消费」与「播放」分开记：被优先级挡下时算没播，
//      允许之后重试；一旦播过就消费掉，避免同一条台词反复冒出来。
//   3. altOnReplay 的替换集中在 resolveCue 一处，变体 cue 不参与常规扫描。
// ============================================================================

import type { Bus, MatchPhase } from '../core/events';
import type {
  StoryConfig,
  StoryCue,
  StoryDirector as StoryDirectorContract,
  StoryEventName,
  StoryState,
  StoryWorld,
} from './types';

// 阶段时长的兜底来源。逻辑层允许 import config/*.json（项目既有惯例，
// 见 towers/flow 模块）。这样即使调用方忘记传 phaseDurations，
// phaseProgress 触发器也不会整段失效——那是"写了却没播"的最坏情况。
import flowCfgJson from '../core/config/flow.json';

/** flow.json 里与阶段时长相关的形状。 */
interface FlowPhaseLike {
  phase: string;
  startSec: number;
  endSec: number;
}

/** 一个阶段可能被拆成多段（如 wake 的 dark / blur），这里合并成 [首段起, 末段止]。 */
function buildPhaseSpans(
  phases: ReadonlyArray<FlowPhaseLike>,
): Map<MatchPhase, { startSec: number; endSec: number }> {
  const map = new Map<MatchPhase, { startSec: number; endSec: number }>();
  for (const p of phases) {
    const key = p.phase as MatchPhase;
    const hit = map.get(key);
    if (!hit) {
      map.set(key, { startSec: p.startSec, endSec: p.endSec });
    } else {
      // 同名的多段合并：起点取最小、终点取最大，保证 phaseProgress 的
      // 百分比覆盖这一整段「语义阶段」（dark+blur 合起来才是"醒来"）。
      hit.startSec = Math.min(hit.startSec, p.startSec);
      hit.endSec = Math.max(hit.endSec, p.endSec);
    }
  }
  return map;
}

/** 从 flow.json 构建兜底阶段跨度表。 */
function fallbackPhaseSpans(): Map<MatchPhase, { startSec: number; endSec: number }> {
  const phases = (flowCfgJson as unknown as { phases?: FlowPhaseLike[] }).phases ?? [];
  return buildPhaseSpans(phases);
}

/** 事件载荷的宽松只读视图（只取我们关心的字段）。 */
type Payload = Record<string, unknown>;

/** 一条 cue 的运行时状态。 */
interface CueRuntime {
  cue: StoryCue;
  /** 已播放次数 */
  playedCount: number;
  /** 上次播放时刻（秒），-Infinity = 从未 */
  lastPlayedAt: number;
}

/** 需要监听的全部事件名（与 types.ts 的 StoryEventName 一致）。 */
const STORY_EVENTS: StoryEventName[] = [
  'WeaknessExposed',
  'WeaknessClosed',
  'ExecutionStarted',
  'ExecutionEnded',
  'KneeBroken',
  'FreezeFull',
  'BossSkillInterrupted',
  'BossSkillStart',
  'PlayerDied',
  'PlayerDamaged',
  'TowerPlaced',
  'TowerDestroyed',
  'TauntStarted',
  'CoreHpChanged',
  'MatchEnded',
];

/** 载荷过滤：match 里列出的每个字段都必须严格相等。 */
function payloadMatches(payload: Payload, match: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!match) return true;
  for (const key of Object.keys(match)) {
    if (payload[key] !== match[key]) return false;
  }
  return true;
}

export function createStoryDirector(): StoryDirectorContract {
  let bus: Bus | null = null;
  let cfg: StoryConfig | null = null;
  let runIndex = 0;
  let disposed = false;

  /** 内部时钟（秒）。由 update 推进，由 MatchPhaseChanged 校准。 */
  let clock = 0;

  // ── 当前播放状态 ──────────────────────────────────────────────────────────
  let current: StoryCue | null = null;
  /** 当前 cue 已显示毫秒 */
  let shownMs = 0;
  /** 当前 cue 正文剩余毫秒 */
  let remainMs = 0;
  /** 正文结束后里世界继续维持的剩余毫秒（余韵） */
  let innerHoldLeft = 0;
  let world: StoryWorld = 'surface';
  let innerVisits = 0;

  const played: string[] = [];

  // ── 运行时表 ──────────────────────────────────────────────────────────────
  const runtimes = new Map<string, CueRuntime>();
  /** 变体专属：被别的 cue 的 altOnReplay 引用，不参与常规触发扫描。 */
  const variantIds = new Set<string>();
  /** 已消费的 cue（按原 cue id 记；播过或已由其变体代播）。 */
  const consumed = new Set<string>();
  /** bossHpBelow / coreHpBelow 已触发过的阈值（同一阈值只触发一次）。 */
  const firedThresholds = new Set<string>();
  /** count 类 cue 各自的计数。 */
  const countProgress = new Map<string, number>();

  /** afterCue 武装表：cueId → 剩余毫秒。 */
  const armedAfter = new Map<string, number>();

  // ── 阶段进度追踪（phaseProgress 触发器用）────────────────────────────────
  /**
   * 各阶段的**语义跨度**（秒）。同名多段会合并成一段：
   * 例如 flow.json 里 wake 分成 dark(0–8) 与 blur(8–16)，
   * 合并后 wake = 0–16，这样 `wake 50%` 落在 8 秒处，符合"醒来"这个语义阶段。
   */
  const phaseSpans = new Map<MatchPhase, { startSec: number; endSec: number }>();
  /** 当前阶段 */
  let currentPhase: MatchPhase | null = null;
  /** 进入当前阶段（首个同名段）的时刻（秒） */
  let phaseEnteredAt = 0;
  /** 当前阶段的语义跨度（秒），0 = 未知 */
  let phaseSpanSec = 0;
  /** 当前阶段已判定的最高进度（防重复扫描） */
  let phaseLastPct = 0;

  const unsubs: Array<() => void> = [];

  function cueById(id: string): StoryCue | null {
    const rt = runtimes.get(id);
    return rt ? rt.cue : null;
  }

  /**
   * 多周目替换：runIndex > 0 且该 cue 声明了 altOnReplay 时，改播变体。
   * 返回实际要播的 cue（变体或自身）。
   */
  function resolveCue(cue: StoryCue): StoryCue {
    if (runIndex > 0 && cue.altOnReplay) {
      const alt = cueById(cue.altOnReplay);
      if (alt) return alt;
    }
    return cue;
  }

  function inWindow(cue: StoryCue): boolean {
    if (!cue.window) return true;
    return clock >= cue.window.fromSec && clock < cue.window.toSec;
  }

  function cooldownOk(cue: StoryCue): boolean {
    if (!cue.cooldownMs) return true;
    const rt = runtimes.get(cue.id);
    if (!rt) return false;
    if (rt.lastPlayedAt === -Infinity) return true;
    return (clock - rt.lastPlayedAt) * 1000 >= cue.cooldownMs;
  }

  /**
   * 一次性判定：没有 cooldownMs 的 cue 播过即消费，不再重试。
   * 带 cooldownMs 的 cue（如玩家死亡）是可重复的，不记消费。
   */
  function isOneShot(cue: StoryCue): boolean {
    return cue.cooldownMs === undefined;
  }

  function markConsumed(cue: StoryCue): void {
    if (isOneShot(cue)) consumed.add(cue.id);
  }

  /** 把「以 parentId 为父」的 afterCue 全部武装起来。**在父 cue 播完之后调用。** */
  function armAfterCues(parentId: string): void {
    if (!cfg) return;
    for (const rt of runtimes.values()) {
      const t = rt.cue.trigger;
      if (t.kind !== 'afterCue') continue;
      if (t.id !== parentId) continue;
      if (variantIds.has(rt.cue.id)) continue;
      armedAfter.set(rt.cue.id, t.delayMs ?? 0);
    }
  }

  /**
   * 尝试播放一条 cue。
   * `origin` 是触发源（用于记录消费与 afterCue 武装）；实际播出的可能是它的变体。
   * 返回 true = 真的播了。
   */
  function tryPlay(origin: StoryCue, opts: { force?: boolean } = {}): boolean {
    const force = opts.force === true;
    if (!cfg) return false;

    // 变体专属 cue 只能经由 altOnReplay 进入，不能被常规扫描直接播
    if (!force && variantIds.has(origin.id)) return false;

    // 一次性 cue 播过就不再播（带 cooldownMs 的 cue 不进 consumed，可重复）
    if (!force && consumed.has(origin.id)) return false;

    const target = force ? origin : resolveCue(origin);

    // 优先级：只有严格大于当前 cue 才打断
    if (!force && current && target.priority <= current.priority) return false;

    if (!force) {
      if (!inWindow(target)) return false;
      if (!cooldownOk(target)) return false;
      if (target.firstRunOnly && runIndex > 0) return false;
    }

    // ── 真正开始播放 ──────────────────────────────────────────────────────
    const duration = Math.max(target.durationMs, cfg.minShowMs);

    current = target;
    shownMs = 0;
    remainMs = duration;
    innerHoldLeft = 0;
    world = target.world;

    if (target.world === 'inner') innerVisits += 1;

    const rt = runtimes.get(target.id);
    if (rt) {
      rt.playedCount += 1;
      rt.lastPlayedAt = clock;
    }

    // 消费：原 cue 与其变体都记为已消费，避免常规扫描反复重试
    markConsumed(origin);
    markConsumed(target);
    if (!played.includes(target.id)) played.push(target.id);

    return true;
  }

  /** 推进 afterCue 倒计时；到点的按优先级从高到低尝试。 */
  function updateAfterCues(dtMs: number): void {
    if (armedAfter.size === 0) return;
    const due: string[] = [];
    for (const [id, remain] of armedAfter) {
      const next = remain - dtMs;
      if (next <= 0) due.push(id);
      else armedAfter.set(id, next);
    }
    if (due.length === 0) return;
    for (const id of due) armedAfter.delete(id);
    due.sort((a, b) => (cueById(b)?.priority ?? 0) - (cueById(a)?.priority ?? 0));
    for (const id of due) {
      const cue = cueById(id);
      if (cue) tryPlay(cue);
    }
  }

  /** 扫描 tSec 类（时间驱动）。 */
  function scanTimeDriven(): void {
    if (!cfg) return;
    for (const cue of cfg.cues) {
      const t = cue.trigger;
      if (t.kind !== 'tSec') continue;
      if (consumed.has(cue.id)) continue;
      if (clock >= t.atSec) tryPlay(cue);
    }
  }

  /** MatchPhaseChanged：校准时钟 + 记录阶段起点 + 触发 phase 类。 */
  function onPhase(phase: MatchPhase, tSec: number): void {
    if (Number.isFinite(tSec)) clock = Math.max(clock, tSec);

    const span = phaseSpans.get(phase);

    // 同一 phase 可能被拆成多段广播（wake 的 dark / blur 各发一次）。
    // 只有「首次进入这个语义阶段」才重置进度；后续同名段继续沿用起点，
    // 否则 blur 段会把进度打回 0，dark 段里该说的话永远等不到。
    if (currentPhase !== phase) {
      phaseEnteredAt = span ? span.startSec : Number.isFinite(tSec) ? tSec : clock;
      phaseLastPct = 0;
    }
    // 必须先算 span 再更新 currentPhase：上面那个判断依赖它还是旧值。
    currentPhase = phase;
    phaseSpanSec = span ? span.endSec - span.startSec : 0;

    if (!cfg) return;
    const hits = cfg.cues
      .filter((c) => c.trigger.kind === 'phase' && c.trigger.phase === phase)
      .sort((a, b) => b.priority - a.priority);
    for (const cue of hits) tryPlay(cue);
  }

  /** 每帧推进阶段进度，跨过 pct 阈值时触发 phaseProgress 类。 */
  function updatePhaseProgress(): void {
    if (!cfg) return;
    const phase = currentPhase;
    if (!phase) return;

    const span = phaseSpanSec;
    // 时长未知（配置缺失）时不做进度判定，避免除零或误触发
    const pct = span > 0 ? Math.min(100, ((clock - phaseEnteredAt) / span) * 100) : 0;

    // 只在 pct 前进时判定，且必须真的跨过某条 cue 的阈值
    if (pct <= phaseLastPct) return;
    phaseLastPct = pct;
    onPhaseProgress(phase, pct);
  }

  /** BossPhaseChanged。 */
  function onBossPhase(to: 1 | 2): void {
    if (!cfg) return;
    const hits = cfg.cues
      .filter((c) => c.trigger.kind === 'bossPhase' && c.trigger.to === to)
      .sort((a, b) => b.priority - a.priority);
    for (const cue of hits) tryPlay(cue);
  }

  /** 血量阈值类（boss / core / player 共用）。 */
  function onHp(which: 'boss' | 'core' | 'player', hp: number, maxHp: number): void {
    if (!cfg || maxHp <= 0) return;
    const pct = (hp / maxHp) * 100;
    const kind =
      which === 'boss' ? 'bossHpBelow' : which === 'core' ? 'coreHpBelow' : 'playerHpBelow';
    const hits = cfg.cues
      .filter((c) => c.trigger.kind === kind)
      .sort((a, b) => b.priority - a.priority);

    for (const cue of hits) {
      const t = cue.trigger;
      if (t.kind !== kind) continue;
      if (consumed.has(cue.id)) continue;
      const key = `${cue.id}@${t.pct}`;
      if (firedThresholds.has(key)) continue;
      if (pct >= t.pct) continue;
      firedThresholds.add(key);
      tryPlay(cue);
    }
  }

  /**
   * 阶段内进度：进入 phase 后走过 pct% 时触发。
   *
   * 这是「配合游戏进程」的核心触发器。相比 tSec：
   *   · 阶段时长改了，台词自动跟着走，不用重算秒数；
   *   · 玩家提前打完 Boss 切走阶段，未播的进度 cue 自然作废（不会错位）；
   *   · 台词锚在「这一段仗打到什么程度」，而不是「墙上钟走了几秒」。
   */
  function onPhaseProgress(phase: MatchPhase, pct: number): void {
    if (!cfg) return;
    const hits = cfg.cues
      .filter(
        (c) =>
          c.trigger.kind === 'phaseProgress' &&
          c.trigger.phase === phase &&
          pct >= c.trigger.pct,
      )
      .sort((a, b) => b.priority - a.priority);
    for (const cue of hits) tryPlay(cue);
  }

  /** 熔岩液面：跨过某高度 / 开始上涨。 */
  function onLava(y: number, risePerSec: number): void {
    if (!cfg) return;

    // ── lavaAbove：首次升到 y 以上 ──
    const aboveCues = cfg.cues
      .filter((c) => c.trigger.kind === 'lavaAbove' && y >= c.trigger.y)
      .sort((a, b) => b.priority - a.priority);
    for (const cue of aboveCues) tryPlay(cue);

    // ── lavaRising：上涨速率达到阈值 ──
    const riseCues = cfg.cues
      .filter((c) => c.trigger.kind === 'lavaRising' && risePerSec >= c.trigger.risePerSec)
      .sort((a, b) => b.priority - a.priority);
    for (const cue of riseCues) tryPlay(cue);
  }

  /** 通用事件：event 类（首次）与 count 类（第 n 次）。 */
  function onEvent(name: StoryEventName, payload: Payload): void {
    if (!cfg) return;

    // ── event 类 ──
    const eventCues = cfg.cues
      .filter((c) => c.trigger.kind === 'event' && c.trigger.event === name)
      .sort((a, b) => b.priority - a.priority);

    for (const cue of eventCues) {
      const t = cue.trigger;
      if (t.kind !== 'event') continue;
      if (consumed.has(cue.id)) continue;
      if (!payloadMatches(payload, t.match)) continue;
      // 只在真的播出去时才消费；被优先级挡下的留待下次同类事件重试，
      // 避免"写了却没播"——这是剧情层最不可接受的失败。
      tryPlay(cue);
    }

    // ── count 类 ──
    const countCues = cfg.cues
      .filter((c) => c.trigger.kind === 'count' && c.trigger.event === name)
      .sort((a, b) => b.priority - a.priority);

    for (const cue of countCues) {
      const t = cue.trigger;
      if (t.kind !== 'count') continue;
      if (consumed.has(cue.id)) continue;
      if (!payloadMatches(payload, t.match)) continue;
      const n = (countProgress.get(cue.id) ?? 0) + 1;
      countProgress.set(cue.id, n);
      if (n < t.n) continue;
      tryPlay(cue);
    }
  }

  // ── 对外接口 ──────────────────────────────────────────────────────────────

  function init(deps: {
    bus: Bus;
    cfg: StoryConfig;
    runIndex?: number;
    /** 阶段时长表（来自 flow.json）。phaseProgress 触发器用它换算进度。 */
    phaseDurations?: ReadonlyArray<{ phase: MatchPhase; startSec: number; endSec: number }>;
  }): void {
    // 重复 init 时先清掉旧订阅
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;

    bus = deps.bus;
    cfg = deps.cfg;
    runIndex = deps.runIndex ?? 0;
    disposed = false;

    clock = 0;
    current = null;
    shownMs = 0;
    remainMs = 0;
    innerHoldLeft = 0;
    world = 'surface';
    innerVisits = 0;
    played.length = 0;
    consumed.clear();
    firedThresholds.clear();
    countProgress.clear();
    armedAfter.clear();

    runtimes.clear();
    variantIds.clear();
    for (const cue of cfg.cues) {
      runtimes.set(cue.id, { cue, playedCount: 0, lastPlayedAt: -Infinity });
      if (cue.altOnReplay) variantIds.add(cue.altOnReplay);
    }

    // 阶段跨度表：phaseProgress 触发器靠它把「进度百分比」换算成时间。
    // 优先用调用方传入的；缺失时回落到 flow.json，保证「忘传配置」不会让
    // 整幕台词静默消失。同名多段（wake 的 dark/blur）会合并成一个语义跨度。
    phaseSpans.clear();
    for (const [k, v] of fallbackPhaseSpans()) phaseSpans.set(k, v);
    if (deps.phaseDurations && deps.phaseDurations.length > 0) {
      phaseSpans.clear();
      for (const [k, v] of buildPhaseSpans(deps.phaseDurations)) phaseSpans.set(k, v);
    }
    currentPhase = null;
    phaseEnteredAt = 0;
    phaseSpanSec = 0;
    phaseLastPct = 0;

    const b = bus;

    // **关键**：时间轴（flow）在 createGame 内部就已 init 并发出首个
    // MatchPhaseChanged{wake,0}。剧情层通常在之后才 init，因此会错过那个事件。
    // 这里从只读快照补读当前阶段，否则 phaseProgress 触发器永远没有起点，
    // 第一幕台词会整段消失。这是「剧情必须咬住游戏进程」的硬前提。
    const snap = b.snapshot();
    if (snap && snap.phase) {
      currentPhase = snap.phase;
      const span = phaseSpans.get(snap.phase);
      phaseEnteredAt = span ? span.startSec : Number.isFinite(snap.tSec) ? snap.tSec : 0;
      clock = Math.max(clock, phaseEnteredAt);
      phaseSpanSec = span ? span.endSec - span.startSec : 0;
    }

    unsubs.push(b.on('MatchPhaseChanged', (p) => {
      if (disposed) return;
      // 注意：**不要**在这里先写 currentPhase。onPhase 内部要靠
      // 「currentPhase 是否已等于新阶段」来判断是不是首次进入该语义阶段，
      // 提前赋值会让那个判断永远为假，导致 phaseEnteredAt 从不重置、
      // 阶段进度永远算错（表现为整幕台词不触发）。由 onPhase 统一维护。
      onPhase(p.phase, p.tSec);
    }));
    unsubs.push(b.on('BossPhaseChanged', (p) => {
      if (!disposed) onBossPhase(p.to);
    }));
    unsubs.push(b.on('BossSpawned', (p) => {
      if (!disposed) onHp('boss', p.hp, p.maxHp);
    }));
    unsubs.push(b.on('BossHpChanged', (p) => {
      if (!disposed) onHp('boss', p.hp, p.maxHp);
    }));
    unsubs.push(b.on('CoreHpChanged', (p) => {
      if (!disposed) onHp('core', p.hp, p.maxHp);
    }));
    unsubs.push(b.on('PlayerDamaged', (p) => {
      if (!disposed) onHp('player', p.hp, p.maxHp);
    }));
    unsubs.push(b.on('LavaLevelChanged', (p) => {
      if (!disposed) onLava(p.y, p.risePerSec);
    }));

    for (const name of STORY_EVENTS) {
      unsubs.push(
        b.on(name, (payload) => {
          if (!disposed) onEvent(name, payload as unknown as Payload);
        }),
      );
    }
  }

  function update(dtSec: number): void {
    if (disposed) return;
    const dt = Math.max(0, dtSec);
    const dtMs = dt * 1000;
    clock += dt;

    // 1. 推进当前 cue
    if (current) {
      shownMs += dtMs;
      remainMs -= dtMs;
      if (remainMs <= 0) {
        // 正文结束：先武装以它为父的 afterCue（必须在清空 current 之前判断，
        // 且必须在「播完」这一刻武装而不是「开播」那一刻，否则子 cue 会在
        // 父 cue 还没播完时就来抢位置，被优先级挡掉后永久丢失）。
        const finished = current;
        const hold = finished.holdInnerMs ?? 0;

        current = null;
        shownMs = 0;
        remainMs = 0;

        if (hold > 0 && world === 'inner') {
          innerHoldLeft = hold;
        } else {
          innerHoldLeft = 0;
          world = 'surface';
        }

        armAfterCues(finished.id);
      }
    } else if (innerHoldLeft > 0) {
      // 2. 余韵倒计时
      innerHoldLeft -= dtMs;
      if (innerHoldLeft <= 0) {
        innerHoldLeft = 0;
        world = 'surface';
      }
    }

    // 3. afterCue 倒计时
    updateAfterCues(dtMs);

    // 4. 阶段进度（phaseProgress：配合游戏进程的核心触发器）
    updatePhaseProgress();

    // 5. tSec 扫描（兼容旧的绝对时刻 cue）
    scanTimeDriven();
  }

  function state(): StoryState {
    return {
      cue: current,
      shownMs,
      world,
      innerMsLeft: current && world === 'inner' ? remainMs : innerHoldLeft,
      innerVisits,
      played: played.slice(),
      runIndex,
    };
  }

  function force(cueId: string): boolean {
    if (disposed) return false;
    const cue = cueById(cueId);
    if (!cue) return false;
    return tryPlay(cue, { force: true });
  }

  function dispose(): void {
    disposed = true;
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    bus = null;
    current = null;
    shownMs = 0;
    remainMs = 0;
    innerHoldLeft = 0;
    world = 'surface';
    armedAfter.clear();
  }

  return { init, update, state, force, dispose };
}
