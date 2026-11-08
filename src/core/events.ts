// src/core/events.ts
export type Vec3 = readonly [number, number, number];
export type Attr = 'arcane' | 'physical';   // arcane=法术(蓝) physical=物理(白金)
export type BodyPart = 'core' | 'back' | 'kneeL' | 'kneeR';
export type MatchPhase = 'wake' | 'prep' | 'boss1' | 'transition' | 'boss2' | 'rage' | 'ended';

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
  tSec: number; phase: MatchPhase;
  boss: { hp: number; maxHp: number; phase: 1 | 2; skill: string | null; weakness: BodyPart | null };
  towers: Array<{ id: string; kind: string; level: number; hp: number; pos: Vec3 }>;
  player: { pos: Vec3; yaw: number; hp: number; maxHp: number; form: Attr; overheat: number };
  motes: number; coreHp: number;
}

type Handler = (payload: unknown) => void;

function initialSnapshot(): Snapshot {
  return {
    tSec: 0,
    phase: 'wake',
    boss: { hp: 0, maxHp: 0, phase: 1, skill: null, weakness: null },
    towers: [],
    player: { pos: [0, 0, 0], yaw: 0, hp: 0, maxHp: 0, form: 'arcane', overheat: 0 },
    motes: 0,
    coreHp: 0,
  };
}

export function createBus() {
  const handlers = new Map<EventName, Set<Handler>>();
  const state = initialSnapshot();

  // 只回写 payload 能完整确定的字段；towers 的耐久在 M2 塔系统接入前保持空表。
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
      case 'MatchPhaseChanged': {
        const p = payload as Events['MatchPhaseChanged'];
        state.phase = p.phase;
        state.tSec = p.tSec;
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
    // 只读快照，供渲染层与 UI 拉取，避免持有逻辑对象
    snapshot: () => state,
  };
}
