// src/audio/AudioManager.ts
// ============================================================================
// P2-A 事件音效适配层（player + combat）
// ----------------------------------------------------------------------------
// 职责：订阅事件总线 → 按 config/audio.json 的映射播放对应 OGG。
// 不参与玩法判定、不持有逻辑对象；只读快照用于初始化去重状态。
//
// 已接事件：
//   PlayerDamaged                 → sfx-hit（amount > 0，同帧死亡让位给死亡音）
//   PlayerDamaged 低血跨越        → sfx-player-low-health（5 s 冷却）
//   PlayerDied                    → sfx-player-death；cause=lava 用 sfx-lava-fall
//   PlayerDashed                  → sfx-dash
//   FormSwitched                  → sfx-form-switch（形态真变化时）
//   OverheatChanged(false→true)   → sfx-overheat
//   WeaknessProgress(executable)  → sfx-execution-ready
//   ExecutionStarted              → sfx-execution-windup
//   ExecutionEnded(damage > 0)     → sfx-execution
//   WeaknessExposed/Closed        → sfx-weakness-open / sfx-weakness-close
//   TacticalViewChanged           → sfx-tactical-open / sfx-tactical-close
//   update() 读玩家移动状态       → 四变体脚步 / 起跳 / 轻重落地
//
// 射击音入口：契约没有「发射」事件，WeaponPhysical / WeaponMagic 只返回 AttackOutcome。
// 等 CombatController 接入主循环后，由调用方在每个 AttackOutcome 产生时调用 playShot(attr)。
//
// 浏览器策略：首次用户手势前不创建 AudioContext，也不补播解锁前积压的事件。
// ============================================================================

import type { Attr, BodyPart, Bus, Vec3 } from '../core/events';
import audioCfgJson from '../core/config/audio.json';

type BusName = 'music' | 'sfx' | 'ui' | 'ambience';

interface SfxDef {
  src: string;
  bus: BusName;
  gain: number;
  cooldownMs?: number;
  maxVoices?: number;
}

interface PlayerMotionConfig {
  stepLengthM: number;
  heavyLandDropM: number;
  footsteps: string[];
  jump: string;
  landLight: string;
  landHeavy: string;
}

interface AudioConfig {
  masterVolume: number;
  buses: Record<BusName, number>;
  sfx: Record<string, SfxDef>;
  shots: Record<Attr, string[]>;
  playerMotion?: PlayerMotionConfig;
  lowHealth?: { thresholdRatio: number };
  /** 事件名 → 素材 ID；只放 P2-A 已接的事件 */
  triggers: Record<string, string>;
}

const cfg = audioCfgJson as unknown as AudioConfig;

/** 只读移动状态：PlayerController 的结构满足该接口 */
export interface MotionSource {
  readonly pos: Vec3;
  readonly isGrounded: boolean;
  readonly isDashing: boolean;
  readonly isDead: boolean;
}

export interface AudioManager {
  /** 首次用户手势调用；成功后可播放。重复调用安全 */
  unlock(): Promise<boolean>;
  isUnlocked(): boolean;
  /** 每帧调用：按玩家移动状态调度脚步 / 起跳 / 落地 */
  update(): void;
  /** 直接播放某个素材（受冷却与并发上限约束） */
  play(id: string): boolean;
  /** 物理/法术射击入口：随机 A/B 变体且避免连续同一变体 */
  playShot(attr: Attr): boolean;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  dispose(): void;
}

export function createAudioManager(deps: { bus: Bus; motion?: MotionSource }): AudioManager {
  const { bus, motion } = deps;

  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  const busGains = new Map<BusName, GainNode>();
  const buffers = new Map<string, AudioBuffer>();
  const loading = new Set<string>();
  const lastPlayedAt = new Map<string, number>();
  const voiceCount = new Map<string, number>();
  const activeSources = new Set<AudioBufferSourceNode>();
  const unsubs: Array<() => void> = [];

  let unlocked = false;
  let disposed = false;

  // ── 去重状态 ──────────────────────────────────────────────────────────────
  let lastDeaths = -1;
  let lastOverheated = false;
  let lastForm: Attr = bus.snapshot().player.form;
  const openParts = new Set<BodyPart>();
  const executableParts = new Set<BodyPart>();
  let lastPhysical = -1;
  let lastArcane = -1;
  let lastTacticalOpen = false;
  let lowHealthArmed = true;

  // ── 移动声状态 ────────────────────────────────────────────────────────────
  let motionReady = false;
  let wasGrounded = false;
  let airborne = false;
  let firstLanding = true;
  let peakY = 0;
  let prevX = 0;
  let prevZ = 0;
  let stepTravel = 0;
  let lastFootstep = -1;

  // ── 资源 ──────────────────────────────────────────────────────────────────

  async function load(id: string): Promise<void> {
    if (!ctx || disposed || buffers.has(id) || loading.has(id)) return;
    const def = cfg.sfx[id];
    if (!def) return;

    loading.add(id);
    try {
      const url = new URL(`${import.meta.env.BASE_URL}${def.src}`, document.baseURI).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      if (!disposed) buffers.set(id, buffer);
    } catch (error) {
      console.warn(`[audio] 载入失败：${id}`, error);
    } finally {
      loading.delete(id);
    }
  }

  function preload(): void {
    for (const id of Object.keys(cfg.sfx)) void load(id);
  }

  // ── 播放 ──────────────────────────────────────────────────────────────────

  function play(id: string): boolean {
    if (!unlocked || disposed || !ctx || !master) return false;

    const def = cfg.sfx[id];
    if (!def) return false;

    const buffer = buffers.get(id);
    // 尚未解码完成：直接丢弃，不排进队列补播
    if (!buffer) {
      void load(id);
      return false;
    }

    const nowMs = ctx.currentTime * 1000;
    const last = lastPlayedAt.get(id);
    if (typeof last === 'number' && nowMs - last < (def.cooldownMs ?? 0)) return false;

    const maxVoices = def.maxVoices ?? Number.POSITIVE_INFINITY;
    if ((voiceCount.get(id) ?? 0) >= maxVoices) return false;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.value = def.gain;

    const target = busGains.get(def.bus) ?? master;
    source.connect(gain).connect(target);

    voiceCount.set(id, (voiceCount.get(id) ?? 0) + 1);
    activeSources.add(source);
    lastPlayedAt.set(id, nowMs);

    source.onended = () => {
      activeSources.delete(source);
      voiceCount.set(id, Math.max(0, (voiceCount.get(id) ?? 1) - 1));
    };

    source.start();
    return true;
  }

  function trigger(name: string): void {
    const id = cfg.triggers[name];
    if (id) play(id);
  }

  function playShot(attr: Attr): boolean {
    const ids = cfg.shots[attr] ?? [];
    if (ids.length === 0) return false;

    const last = attr === 'physical' ? lastPhysical : lastArcane;
    // 随机且避免连续同一变体
    let index = Math.floor(Math.random() * ids.length);
    if (ids.length > 1 && index === last) index = (index + 1) % ids.length;

    if (!play(ids[index])) return false;
    if (attr === 'physical') lastPhysical = index;
    else lastArcane = index;
    return true;
  }

  // ── 移动声：脚步 / 起跳 / 落地 ──────────────────────────────────────────

  function playFootstep(): void {
    const ids = cfg.playerMotion?.footsteps ?? [];
    if (ids.length === 0) return;
    let index = Math.floor(Math.random() * ids.length);
    if (ids.length > 1 && index === lastFootstep) index = (index + 1) % ids.length;
    if (play(ids[index])) lastFootstep = index;
  }

  function update(): void {
    if (!motion || !unlocked || disposed) return;

    const [x, y, z] = motion.pos;
    if (!motionReady) {
      motionReady = true;
      wasGrounded = motion.isGrounded;
      firstLanding = !motion.isGrounded;
      peakY = y;
      prevX = x;
      prevZ = z;
      return;
    }

    const dx = x - prevX;
    const dz = z - prevZ;
    prevX = x;
    prevZ = z;

    if (motion.isGrounded) {
      if (airborne) {
        airborne = false;
        const drop = Math.max(0, peakY - y);
        // 出生落地与台阶吸附的首个落地静默
        if (!firstLanding) {
          const heavy = drop >= (cfg.playerMotion?.heavyLandDropM ?? 1.6);
          const id = heavy ? cfg.playerMotion?.landHeavy : cfg.playerMotion?.landLight;
          if (id) play(id);
        }
        firstLanding = false;
        stepTravel = 0;
      }

      if (!motion.isDead && !motion.isDashing && (dx !== 0 || dz !== 0)) {
        stepTravel += Math.hypot(dx, dz);
        if (stepTravel >= (cfg.playerMotion?.stepLengthM ?? 2.2)) {
          stepTravel = 0;
          playFootstep();
        }
      } else {
        // 静止 / 冲刺不累计步幅
        stepTravel = 0;
      }
    } else {
      // 离地边沿：起跳或走下平台
      if (wasGrounded && !motion.isDead) {
        const id = cfg.playerMotion?.jump;
        if (id) play(id);
      }
      airborne = true;
      peakY = Math.max(peakY, y);
      stepTravel = 0;
    }

    wasGrounded = motion.isGrounded;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  function initState(): void {
    const snap = bus.snapshot();
    lastForm = snap.player.form;
    lastDeaths = -1;
    lastOverheated = false;
    openParts.clear();
    executableParts.clear();
    lastTacticalOpen = false;

    // 解锁时已经暴露的弱点视为「已打开」，只补关闭音，不补打开音
    if (snap.boss.weakness) openParts.add(snap.boss.weakness);

    // 入口血量不当作受击：已经低于阈值时先不武装，等回到阈值上方再重新武装
    const ratio = cfg.lowHealth?.thresholdRatio ?? 0.25;
    const threshold = Math.max(1, Math.ceil(snap.player.maxHp * ratio));
    lowHealthArmed = snap.player.maxHp > 0 ? snap.player.hp > threshold : true;

    // 移动声重新建立基准；解锁时已经站在地面则不再补出生落地音
    motionReady = false;
    wasGrounded = false;
    airborne = false;
    firstLanding = true;
    peakY = 0;
    stepTravel = 0;
    lastFootstep = -1;
    if (motion) {
      prevX = motion.pos[0];
      prevZ = motion.pos[2];
    }
  }

  async function unlock(): Promise<boolean> {
    if (disposed) return false;

    if (!ctx) {
      if (typeof AudioContext === 'undefined') return false;
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = cfg.masterVolume;
      master.connect(ctx.destination);

      const names: BusName[] = ['music', 'sfx', 'ui', 'ambience'];
      for (const name of names) {
        const gain = ctx.createGain();
        gain.gain.value = cfg.buses[name] ?? 1;
        gain.connect(master);
        busGains.set(name, gain);
      }
    }

    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    if (ctx.state !== 'running') return false;

    if (!unlocked) {
      unlocked = true;
      initState();
      preload();
    }
    return true;
  }

  async function suspend(): Promise<void> {
    if (!ctx || ctx.state !== 'running') return;
    try {
      await ctx.suspend();
    } catch {
      // 浏览器拒绝挂起时保持现状
    }
  }

  async function resume(): Promise<void> {
    if (!ctx || !unlocked || ctx.state === 'running') return;
    try {
      await ctx.resume();
    } catch {
      // 需要新的用户手势时由下一次 unlock() 处理
    }
  }

  // ── 事件订阅（只在解锁后响应）───────────────────────────────────────────

  unsubs.push(bus.on('PlayerDamaged', (p) => {
    if (!unlocked) return;
    // 同帧死亡：PlayerDamaged 先于 PlayerDied 发出，死亡音优先
    if (p.amount <= 0 || p.hp <= 0) return;
    trigger('PlayerDamaged');

    // 低血警告：只在下穿阈值时提醒一次，回到阈值上方才重新武装
    const ratio = cfg.lowHealth?.thresholdRatio ?? 0.25;
    const threshold = Math.max(1, Math.ceil(p.maxHp * ratio));
    if (p.hp > threshold) {
      lowHealthArmed = true;
    } else if (lowHealthArmed) {
      lowHealthArmed = false;
      trigger('PlayerLowHealth');
    }
  }));

  unsubs.push(bus.on('PlayerDied', (p) => {
    if (!unlocked) return;
    if (p.deaths === lastDeaths) return;
    lastDeaths = p.deaths;
    // 坠入熔岩用专属音，不叠通用死亡音
    trigger(p.cause === 'lava' ? 'PlayerDiedLava' : 'PlayerDied');
  }));

  unsubs.push(bus.on('PlayerDashed', () => {
    if (!unlocked) return;
    trigger('PlayerDashed');
  }));

  unsubs.push(bus.on('FormSwitched', (p) => {
    if (!unlocked || p.form === lastForm) return;
    lastForm = p.form;
    trigger('FormSwitched');
  }));

  unsubs.push(bus.on('OverheatChanged', (p) => {
    if (!unlocked) return;
    const was = lastOverheated;
    lastOverheated = p.overheated;
    if (p.overheated && !was) trigger('OverheatChanged');
  }));

  unsubs.push(bus.on('ExecutionEnded', (p) => {
    if (!unlocked || p.damage <= 0) return;
    trigger('ExecutionEnded');
  }));

  unsubs.push(bus.on('WeaknessExposed', (p) => {
    if (!unlocked || openParts.has(p.part)) return;
    openParts.add(p.part);
    trigger('WeaknessExposed');
  }));

  unsubs.push(bus.on('WeaknessClosed', (p) => {
    if (!unlocked || !openParts.delete(p.part)) return;
    trigger('WeaknessClosed');
  }));

  unsubs.push(bus.on('WeaknessProgress', (p) => {
    if (!unlocked) return;
    if (p.executable) {
      if (executableParts.has(p.part)) return;
      executableParts.add(p.part);
      trigger('WeaknessExecutable');
    } else {
      executableParts.delete(p.part);
    }
  }));

  unsubs.push(bus.on('ExecutionStarted', () => {
    if (!unlocked) return;
    trigger('ExecutionStarted');
  }));

  unsubs.push(bus.on('TacticalViewChanged', (p) => {
    if (!unlocked || p.open === lastTacticalOpen) return;
    lastTacticalOpen = p.open;
    trigger(p.open ? 'TacticalViewOpened' : 'TacticalViewClosed');
  }));

  // ── 页面隐藏：挂起，避免后台继续出声 ────────────────────────────────────
  function onVisibilityChange(): void {
    if (document.hidden) void suspend();
    else void resume();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  unsubs.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

  return {
    unlock,
    isUnlocked: () => unlocked,
    update,
    play,
    playShot,
    suspend,
    resume,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unlocked = false;

      for (const off of unsubs) off();
      unsubs.length = 0;

      for (const source of activeSources) {
        try {
          source.stop();
        } catch {
          // 已停止的源忽略
        }
      }
      activeSources.clear();
      voiceCount.clear();
      lastPlayedAt.clear();
      buffers.clear();
      busGains.clear();

      void ctx?.close();
      ctx = null;
      master = null;
    },
  };
}
