// src/core/events.ts
// ============================================================================
// 契约 v1.1 · 本项目唯一的模块间通信契约
// ----------------------------------------------------------------------------
// 所有权：只有 S0（控制/架构会话）可以修改本文件。
// 其他会话需要新事件/新字段 → 在 handoff/<会话>.md 的「契约申请」一节提出，
// 由 S0 合并进 master 后广播。**禁止自建一套事件**（联调必炸）。
//
// v1.1 相对 v1.0（M0 票附录）**只做纯增量**：新增 4 个事件、Snapshot 新增 4 个字段、
// reduce() 补齐塔/熔岩/评分的快照回写。已存在的事件名与字段一律未改。
// ============================================================================

export type Vec3 = readonly [number, number, number];
export type Attr = 'arcane' | 'physical';   // arcane=法术(蓝) physical=物理(白金)
export type BodyPart = 'core' | 'back' | 'kneeL' | 'kneeR';
export type MatchPhase = 'wake' | 'prep' | 'boss1' | 'transition' | 'boss2' | 'rage' | 'ended';
export type SlotState = 'locked' | 'open' | 'occupied' | 'submerged';

export interface Events {
  // ── 玩家 ──
  PlayerSpawned:        { pos: Vec3 };
  PlayerMoved:          { pos: Vec3; yaw: number };
  PlayerDamaged:        { amount: number; hp: number; maxHp: number; source: string };
  PlayerDied:           { cause: string; deaths: number };
  PlayerRespawned:      { pos: Vec3 };
  PlayerDashed:         { dir: Vec3 };
  FormSwitched:         { form: Attr };
  OverheatChanged:      { value: number; overheated: boolean };

  // ── 战斗 ──
  DamageDealt:          { target: 'boss' | 'tower' | 'player'; amount: number; attr: Attr; part?: BodyPart; isCrit: boolean };
  ExecutionStarted:     { part: BodyPart };
  ExecutionEnded:       { part: BodyPart; damage: number };
  WeaknessProgress:     { part: BodyPart; value: number; max: number; executable: boolean };

  // ── Boss ──
  BossSpawned:          { hp: number; maxHp: number; phase: 1 | 2 };
  BossHpChanged:        { hp: number; maxHp: number; phase: 1 | 2 };
  BossPhaseChanged:     { from: 1 | 2; to: 1 | 2 };
  BossSkillStart:       { skill: string; stage: 'windup' | 'active' | 'recovery'; durationMs: number };
  BossSkillEnd:         { skill: string };
  BossSkillInterrupted: { skill: string; by: 'interrupt' | 'freeze' | 'stagger' };
  WeaknessExposed:      { part: BodyPart; attr: Attr; durationMs: number };
  WeaknessClosed:       { part: BodyPart };
  KneeBroken:           { side: 'L' | 'R' };

  // ── 塔 ──
  TowerPlaced:          { towerId: string; kind: string; slotId: string; pos: Vec3 };
  TowerUpgraded:        { towerId: string; level: number };
  TowerDestroyed:       { towerId: string; reason: 'sold' | 'broken' | 'drowned' };
  TowerTargetHit:       { towerId: string; kind: string; attr: Attr; amount: number };
  DebuffStackChanged:   { kind: 'sunder' | 'scorch'; stacks: number; attr: Attr };
  FreezeFull:           { durationMs: number };
  TauntStarted:         { towerId: string; durationMs: number };
  TauntEnded:           { towerId: string };

  // ── 塔 v1.1 新增 ──
  /** 塔耐久变化。**place() 之后必须立即发一次**用于初始化 hp（TowerPlaced 不带 hp）。 */
  TowerHpChanged:        { towerId: string; hp: number; maxHp: number };
  /** 寒晶冻结值进度，供 UI 进度环与 Boss 的 FreezeFull 判定共用。 */
  FreezeProgressChanged: { value: number; max: number };
  /** 塔位状态机：locked→open→occupied，熔岩上涨时 open/occupied → submerged。 */
  TowerSlotStateChanged: { slotId: string; state: SlotState };
  /** 塔请求打断 Boss 施法（震地锚）。Boss 模块收到后掷骰，成功才发 BossSkillInterrupted。 */
  TowerInterruptRequested: { towerId: string; skill: string; chance: number };

  // ── 流程 ──
  MatchPhaseChanged:    { phase: MatchPhase; tSec: number };
  MatchEnded:           { result: 'win' | 'lose'; reason: string; tSec: number };
  LavaLevelChanged:     { y: number; risePerSec: number };
  CoreHpChanged:        { hp: number; maxHp: number };
  MoteCountChanged:     { motes: number };
  TacticalViewChanged:  { open: boolean };
}

export type EventName = keyof Events;

export interface Snapshot {
  tSec: number;
  phase: MatchPhase;
  /** 当前阶段结束时刻（秒），倒计时 UI 用。ended 时为 0。 */
  phaseEndsAtSec: number;
  boss: { hp: number; maxHp: number; phase: 1 | 2; skill: string | null; weakness: BodyPart | null };
  towers: Array<{ id: string; kind: string; level: number; hp: number; pos: Vec3 }>;
  towerSlots: Array<{ slotId: string; state: SlotState }>;
  player: { pos: Vec3; yaw: number; hp: number; maxHp: number; form: Attr; overheat: number };
  lavaY: number;
  motes: number;
  coreHp: number;
  score: number;
}

export interface Bus {
  on<K extends EventName>(k: K, fn: (p: Events[K]) => void): () => void;
  emit<K extends EventName>(k: K, p: Events[K]): void;
  /** 只读快照，供渲染层与 UI 拉取，避免持有逻辑对象引用。 */
  snapshot: () => Snapshot;
  /**
   * **内部 API：只有拥有该状态的逻辑模块与单测可以调用。渲染层与 UI 严禁使用。**
   *
   * 用途：某些状态每帧都变（如玩家精确 pos/yaw），全靠 emit 太吵。
   * 由 owner 模块直接写入快照对应字段，保证 snapshot() 始终是最新值。
   *
   * v1.1 起固化为正式接口：P2-A 的 PlayerController 依赖它。
   */
  __setSnapshot(next: Snapshot): void;
}

type Handler = (payload: unknown) => void;

function initialSnapshot(): Snapshot {
  return {
    tSec: 0,
    phase: 'wake',
    phaseEndsAtSec: 0,
    boss: { hp: 0, maxHp: 0, phase: 1, skill: null, weakness: null },
    towers: [],
    towerSlots: [],
    player: { pos: [0, 0, 0], yaw: 0, hp: 0, maxHp: 0, form: 'arcane', overheat: 0 },
    lavaY: 0,
    motes: 0,
    coreHp: 0,
    score: 0,
  };
}

export function createBus(): Bus {
  const handlers = new Map<EventName, Set<Handler>>();
  const state = initialSnapshot();

  function upsertSlot(slotId: string, next: SlotState): void {
    const hit = state.towerSlots.find((s) => s.slotId === slotId);
    if (hit) hit.state = next;
    else state.towerSlots.push({ slotId, state: next });
  }

  function dropTower(towerId: string): void {
    const i = state.towers.findIndex((t) => t.id === towerId);
    if (i >= 0) state.towers.splice(i, 1);
  }

  // 只回写 payload 能完整确定的字段。逻辑层仍是权威，这里只是给渲染/UI 的投影。
  function reduce(name: EventName, payload: Events[EventName]): void {
    switch (name) {
      case 'PlayerSpawned':
      case 'PlayerRespawned': {
        const p = payload as Events['PlayerSpawned'];
        state.player = { ...state.player, pos: p.pos };
        break;
      }
      case 'PlayerMoved': {
        const p = payload as Events['PlayerMoved'];
        state.player = { ...state.player, pos: p.pos, yaw: p.yaw };
        break;
      }
      case 'PlayerDamaged': {
        const p = payload as Events['PlayerDamaged'];
        state.player = { ...state.player, hp: p.hp, maxHp: p.maxHp };
        break;
      }
      case 'PlayerDied': {
        state.player = { ...state.player, hp: 0 };
        break;
      }
      case 'FormSwitched': {
        const p = payload as Events['FormSwitched'];
        state.player = { ...state.player, form: p.form };
        break;
      }
      case 'OverheatChanged': {
        const p = payload as Events['OverheatChanged'];
        state.player = { ...state.player, overheat: p.value };
        break;
      }
      case 'BossSpawned':
      case 'BossHpChanged': {
        const p = payload as Events['BossSpawned'];
        state.boss = { ...state.boss, hp: p.hp, maxHp: p.maxHp, phase: p.phase };
        break;
      }
      case 'BossPhaseChanged': {
        const p = payload as Events['BossPhaseChanged'];
        state.boss = { ...state.boss, phase: p.to };
        break;
      }
      case 'BossSkillStart': {
        const p = payload as Events['BossSkillStart'];
        state.boss = { ...state.boss, skill: p.skill };
        break;
      }
      case 'BossSkillEnd': {
        state.boss = { ...state.boss, skill: null };
        break;
      }
      case 'WeaknessExposed': {
        const p = payload as Events['WeaknessExposed'];
        state.boss = { ...state.boss, weakness: p.part };
        break;
      }
      case 'WeaknessClosed': {
        state.boss = { ...state.boss, weakness: null };
        break;
      }
      // ── 塔（v1.1）──
      case 'TowerPlaced': {
        const p = payload as Events['TowerPlaced'];
        if (!state.towers.some((t) => t.id === p.towerId)) {
          state.towers.push({ id: p.towerId, kind: p.kind, level: 1, hp: 0, pos: p.pos });
        }
        upsertSlot(p.slotId, 'occupied');
        break;
      }
      case 'TowerUpgraded': {
        const p = payload as Events['TowerUpgraded'];
        const t = state.towers.find((x) => x.id === p.towerId);
        if (t) t.level = p.level;
        break;
      }
      case 'TowerHpChanged': {
        const p = payload as Events['TowerHpChanged'];
        const t = state.towers.find((x) => x.id === p.towerId);
        if (t) t.hp = p.hp;
        break;
      }
      case 'TowerDestroyed': {
        const p = payload as Events['TowerDestroyed'];
        dropTower(p.towerId);
        break;
      }
      case 'TowerSlotStateChanged': {
        const p = payload as Events['TowerSlotStateChanged'];
        upsertSlot(p.slotId, p.state);
        break;
      }
      // ── 流程 ──
      case 'MatchPhaseChanged': {
        const p = payload as Events['MatchPhaseChanged'];
        state.phase = p.phase;
        state.tSec = p.tSec;
        break;
      }
      case 'LavaLevelChanged': {
        const p = payload as Events['LavaLevelChanged'];
        state.lavaY = p.y;
        break;
      }
      case 'MoteCountChanged': {
        const p = payload as Events['MoteCountChanged'];
        state.motes = p.motes;
        break;
      }
      case 'CoreHpChanged': {
        const p = payload as Events['CoreHpChanged'];
        state.coreHp = p.hp;
        break;
      }
      default:
        break;
    }
  }

  return {
    on<K extends EventName>(k: K, fn: (p: Events[K]) => void): () => void {
      let set = handlers.get(k);
      if (!set) {
        set = new Set<Handler>();
        handlers.set(k, set);
      }
      const handler = fn as Handler;
      set.add(handler);
      return () => { handlers.get(k)?.delete(handler); };
    },
    emit<K extends EventName>(k: K, p: Events[K]): void {
      reduce(k, p);
      const set = handlers.get(k);
      if (!set) return;
      for (const handler of set) handler(p);
    },
    snapshot: () => state,
    __setSnapshot(next: Snapshot): void {
      Object.assign(state, next);
    },
  };
}

// ============================================================================
// 归属规则（写进注释，避免两边重复发布）
// ----------------------------------------------------------------------------
// 1. DebuffStackChanged 由 **Boss 模块统一发布**。塔只发 TowerTargetHit，
//    不得自行发布 DebuffStackChanged，否则碎甲/灼烙会双层叠加。
// 2. TowerInterruptRequested 由塔发布、Boss 响应：Boss 掷骰成功后自己发
//    BossSkillInterrupted{by:'interrupt'}，塔不得直接发 BossSkillInterrupted。
// 3. MatchEnded 由 flow 发布一次且仅一次；渲染/UI 只订阅，不得发布。
// 4. 渲染层与 UI 只允许 on() 订阅和 snapshot()，**禁止 emit()**。
// 5. 逻辑层（towers/flow/player/combat/boss）**禁止 import three**。
// ============================================================================
