// src/audio/AudioPlayer.ts
// ============================================================================
// M5-02 音频播放器（Web Audio API + AudioBuffer，全程序化控制）
// ----------------------------------------------------------------------------
// 设计要点：
//   1. **不在模块顶层 new AudioContext**。构造函数只挂手势监听；首次
//      pointerdown / keydown 才创建 AudioContext 并 resume。
//   2. 67 个文件分批解码：环境 2 → BGM 9 → 战斗 26 → 塔 11 → 界面 8 → Boss 11。
//   3. 每次 play() 新建 AudioBufferSourceNode（播完自动回收）；同时最多 16 个
//      一次性声部，超出时丢弃最旧的非关键音效（见 soundMap.CRITICAL_SFX）。
//   4. 同一音效 50 ms 内不重复播放。
//   5. BGM 换轨 0.8 s 交叉淡化；转场轨不循环，播完自动接阶段 II。
//   6. U 键静音（localStorage 持久化；M 让位给建模查看器），document.hidden 时 suspend。
//
// 接线方式（S0 在 main.ts 里一行即可）：
//   const audio = new AudioPlayer({ bus: game.bus, bossPosition: () => [...] });
//   // 可选：每帧调用 audio.update(dtSec)；不调也有内部 200 ms 时钟负责倒计时/告警。
// ============================================================================

import type { Bus, MatchPhase, Vec3 } from '../core/events';
import uiJson from '../core/config/ui.json';
import flowJson from '../core/config/flow.json';
import {
  AMBIENCE,
  AMBIENT_NAMES,
  bgmCueForTrack,
  BGM_BY_PHASE,
  BGM_CROSSFADE_SEC,
  BGM_NAMES,
  CRITICAL_SFX,
  DEDUPE_MS,
  DEFEAT_CUE,
  MAX_VOICES,
  SFX_GAIN,
  SFX_GROUP_NAMES,
  SFX_GROUP_OF,
  SFX_ROTATIONS,
  SKILL_SFX,
  SOUND_FILE,
  TOTAL_SOUNDS,
  TOWER_SFX_BY_KIND,
} from './soundMap';
import type {
  BgmCue,
  BgmName,
  PlayableSound,
  SfxGroup,
  SfxName,
  SoundName,
} from './soundMap';

// ── 配置读取 ───────────────────────────────────────────────────────────────

export interface AudioVolumes {
  /** 主音量 */
  master: number;
  /** BGM / 环境音量 */
  music: number;
  /** 音效音量 */
  sfx: number;
}

const DEFAULT_VOLUMES: AudioVolumes = { master: 0.8, music: 0.5, sfx: 0.8 };

const UI_AUDIO = (uiJson as { audio?: Partial<AudioVolumes> }).audio;

const FLOW = flowJson as { matchLengthSec?: number; core?: { maxHp?: number } };

/** 一局总时长（倒计时音效的基准） */
const MATCH_LENGTH_SEC = typeof FLOW.matchLengthSec === 'number' ? FLOW.matchLengthSec : 270;

/** 塔心满血兜底（CoreHpChanged 一定带 maxHp，这里只防构造早于首个事件） */
const CORE_MAX_FALLBACK = typeof FLOW.core?.maxHp === 'number' ? FLOW.core.maxHp : 1000;

const MUTE_STORAGE_KEY = 'lava-city.audio.muted';

// ── 对外接口 ───────────────────────────────────────────────────────────────

export interface AudioPlayerOptions {
  bus: Bus;
  /** 覆盖 ui.json 的 audio 段（测试/调试用） */
  volumes?: Partial<AudioVolumes>;
  /**
   * Boss 世界坐标。弱点暴露与 Boss 技能靠它做左右定位。
   * 不传时退回 window.__boss（S0 尚未接线也能用）。
   */
  bossPosition?: () => Vec3 | null;
  /** 是否绑定 U 键静音，默认 true */
  muteKey?: boolean;
}

export interface AudioStats {
  unlocked: boolean;
  contextState: string;
  muted: boolean;
  loaded: number;
  total: number;
  loading: number;
  failed: number;
  decodedMB: number;
  activeOneShots: number;
  peakOneShots: number;
  droppedByCap: number;
  droppedByDedupe: number;
  played: number;
  groups: Record<SfxGroup, GroupState>;
  bgm: BgmName | null;
  loops: string[];
}

type GroupState = 'idle' | 'loading' | 'ready';

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  name: SfxName;
  critical: boolean;
}

interface LoopVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface BgmVoice {
  name: BgmName;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** 播放器：Web Audio 图在 unlock() 时才建立，构造阶段零音频资源 */
export class AudioPlayer {
  private readonly bus: Bus;
  private readonly options: AudioPlayerOptions;
  private readonly volumes: AudioVolumes;
  private readonly muteKeyEnabled: boolean;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;

  private unlocked = false;
  private disposed = false;
  private muted = false;
  private ended = false;

  private readonly buffers = new Map<SoundName, AudioBuffer>();
  private readonly loading = new Map<SoundName, Promise<AudioBuffer | null>>();
  private readonly groupState: Record<SfxGroup, GroupState> = {
    combat: 'idle',
    towers: 'idle',
    ui: 'idle',
    boss: 'idle',
  };
  private readonly groupLoads = new Map<SfxGroup, Promise<void>>();

  private readonly lastPlayedAt = new Map<SfxName, number>();
  private readonly rotationCursor = new Map<string, number>();
  private readonly voices: Voice[] = [];
  private readonly loops = new Map<string, LoopVoice>();
  private readonly wantedLoops = new Set<string>();

  private bgm: BgmVoice | null = null;
  private bgmToken = 0;
  private lavaGain: GainNode | null = null;
  private lavaBaseY: number | null = null;

  private phase: MatchPhase;
  private coreHp = 0;
  private coreMaxHp = CORE_MAX_FALLBACK;
  private lowHealthOn = false;
  private executable = false;
  private wasOverheated = false;

  private clockSec = 0;
  private anchorClockSec = 0;
  private anchorMatchSec = 0;
  private lastTimerAt = 0;
  private lastCountdownSec = -1;
  private lastCoreWarnAt = -Infinity;

  private lastPos: Vec3 | null = null;
  private airborne = false;
  private airMaxY = 0;
  private stepAccum = 0;

  private peakVoices = 0;
  private droppedByCap = 0;
  private droppedByDedupe = 0;
  private playedCount = 0;
  private failedLoads = 0;

  private readonly unsubs: Array<() => void> = [];
  private timer: number | null = null;

  private readonly onGesture = (): void => {
    void this.unlock();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    // M 让位给「熔岩巨人建模」查看器，静音改到 U
    if (!this.muteKeyEnabled || event.code !== 'KeyU') return;
    this.setMuted(!this.muted);
  };

  private readonly onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      // 切走时把一次性声部全部停掉，回来不会补播/堆积
      this.stopAllOneShots();
      if (this.ctx && this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => undefined);
      }
      return;
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  };

  constructor(options: AudioPlayerOptions) {
    this.options = options;
    this.bus = options.bus;
    this.muteKeyEnabled = options.muteKey !== false;
    this.volumes = readVolumes(options.volumes);

    const snap = options.bus.snapshot();
    this.phase = snap.phase;
    this.anchorMatchSec = snap.tSec;
    this.lavaBaseY = snap.lavaY;
    this.coreHp = snap.coreHp;
    this.muted = readMuted();

    this.wire();

    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.onGesture);
      window.addEventListener('keydown', this.onGesture);
      window.addEventListener('keydown', this.onKeyDown);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.lastTimerAt = performance.now();
      // 200 ms 时钟：倒计时 / 塔心告警 / 静音前也照常推进阶段时间锚
      this.timer = window.setInterval(() => this.tickClock(), 200);
    }
  }

  // ── 对外 ──────────────────────────────────────────────────────────────────

  /** 首次用户手势后创建 AudioContext；重复调用是安全的 */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch {
          // 手势外 resume 会被拒绝，等下一次手势
        }
      }
      return;
    }

    const Ctor = audioContextCtor();
    if (!Ctor) return;

    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(ctx.destination);
    this.applyVolumes(true);

    this.unlocked = true;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Chrome 在用户手势内通常直接 running；失败时保留 unlocked，下个手势重试
      }
    }

    await this.prepareCore();
  }

  /**
   * 播放一次性音效。别名 `physical-shot` / `arcane-shot` / `footstep`
   * 会按 a/b 或 01..04 轮播。未加载时先触发该组解码，本次不响。
   */
  play(name: PlayableSound, options: { gain?: number; spatial?: boolean } = {}): void {
    if (this.disposed || !this.unlocked || !this.ctx || this.muted) return;

    const resolved = this.resolveName(name);
    const now = performance.now();
    const last = this.lastPlayedAt.get(resolved);
    if (last !== undefined && now - last < DEDUPE_MS) {
      this.droppedByDedupe += 1;
      return;
    }
    this.lastPlayedAt.set(resolved, now);

    const buffer = this.buffers.get(resolved);
    if (!buffer) {
      void this.ensureGroup(SFX_GROUP_OF[resolved]);
      return;
    }

    if (this.voices.length >= MAX_VOICES && !this.evictOldestNonCritical()) return;

    const spatial = options.spatial ?? isSpatialSfx(resolved);
    this.startVoice(resolved, buffer, options.gain ?? SFX_GAIN[resolved], spatial);
  }

  /** 每帧调用可选；内部已有 200 ms 时钟，不调也能工作 */
  update(_dtSec: number): void {
    // 预留：外部驱动时以外部时钟为准，避免 200 ms 定时器叠加。
    // 目前所有节奏音都由 tickClock() 负责，这里保持空实现以免重复触发。
  }

  setVolumes(next: Partial<AudioVolumes>): void {
    if (typeof next.master === 'number' && Number.isFinite(next.master)) {
      this.volumes.master = clamp01(next.master);
    }
    if (typeof next.music === 'number' && Number.isFinite(next.music)) {
      this.volumes.music = clamp01(next.music);
    }
    if (typeof next.sfx === 'number' && Number.isFinite(next.sfx)) {
      this.volumes.sfx = clamp01(next.sfx);
    }
    this.applyVolumes(false);
  }

  getVolumes(): AudioVolumes {
    return { ...this.volumes };
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    writeMuted(muted);
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const param = this.master.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(muted ? 0 : this.volumes.master, now + 0.15);
  }

  isMuted(): boolean {
    return this.muted;
  }

  stats(): AudioStats {
    let decodedBytes = 0;
    for (const buffer of this.buffers.values()) {
      decodedBytes += buffer.length * buffer.numberOfChannels * 4;
    }
    return {
      unlocked: this.unlocked,
      contextState: this.ctx?.state ?? 'none',
      muted: this.muted,
      loaded: this.buffers.size,
      total: TOTAL_SOUNDS,
      loading: this.loading.size,
      failed: this.failedLoads,
      decodedMB: Math.round((decodedBytes / (1024 * 1024)) * 10) / 10,
      activeOneShots: this.voices.length,
      peakOneShots: this.peakVoices,
      droppedByCap: this.droppedByCap,
      droppedByDedupe: this.droppedByDedupe,
      played: this.playedCount,
      groups: { ...this.groupState },
      bgm: this.bgm?.name ?? null,
      loops: [...this.loops.keys()],
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;

    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.onGesture);
      window.removeEventListener('keydown', this.onGesture);
      window.removeEventListener('keydown', this.onKeyDown);
      document.removeEventListener('visibilitychange', this.onVisibility);
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
    }

    this.stopAllLoops();
    this.stopAllOneShots();
    this.bgmToken += 1;
    if (this.bgm) {
      try {
        this.bgm.source.stop();
      } catch {
        // 已停止
      }
      this.bgm = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
  }

  // ── 事件接线 ──────────────────────────────────────────────────────────────

  private wire(): void {
    const bus = this.bus;

    this.unsubs.push(
      // ── P0 ──
      bus.on('WeaknessExposed', () => {
        this.executable = false;
        this.play('sfx-weakness-open', { spatial: true });
      }),
      bus.on('WeaknessClosed', () => {
        this.executable = false;
        this.play('sfx-weakness-close', { spatial: true });
      }),
      bus.on('WeaknessProgress', (p) => {
        if (p.executable && !this.executable) this.play('sfx-execution-ready');
        this.executable = p.executable;
      }),
      bus.on('ExecutionStarted', () => this.play('sfx-execution')),
      bus.on('PlayerDamaged', (p) => {
        this.play('sfx-hit');
        this.syncLowHealth(p.hp);
      }),
      // 契约里玩家受击走 PlayerDamaged；若未来补 DamageDealt{target:'player'}，50 ms 去重会合并
      bus.on('DamageDealt', (p) => {
        if (p.target === 'player') this.play('sfx-hit');
      }),
      bus.on('PlayerDied', () => {
        this.play('sfx-player-death');
        this.lowHealthOn = false;
        this.stopLoop('low-health');
      }),

      // ── 玩家 ──
      bus.on('PlayerDashed', () => this.play('sfx-dash')),
      bus.on('FormSwitched', () => this.play('sfx-form-switch')),
      bus.on('OverheatChanged', (p) => {
        if (p.overheated && !this.wasOverheated) this.play('sfx-overheat');
        this.wasOverheated = p.overheated;
      }),
      bus.on('FreezeFull', () => this.play('sfx-freeze')),
      bus.on('PlayerSpawned', (p) => this.resetTrackedPosition(p.pos)),
      bus.on('PlayerRespawned', (p) => this.resetTrackedPosition(p.pos)),
      bus.on('PlayerMoved', (p) => this.onPlayerMoved(p.pos)),

      // ── Boss ──
      bus.on('BossSpawned', () => this.play('sfx-boss-windup', { spatial: true })),
      bus.on('BossSkillStart', (p) => {
        if (p.stage === 'recovery') return;
        const cue = SKILL_SFX[p.skill];
        if (!cue) return;
        if (p.stage === 'windup') {
          if (cue.windup) this.play(cue.windup, { spatial: true });
          return;
        }
        if (cue.active) this.play(cue.active, { spatial: true });
        if (cue.loop) this.startLoop(`skill:${p.skill}`, cue.loop, cue.loopGain ?? 0.35);
      }),
      bus.on('BossSkillEnd', (p) => this.stopLoop(`skill:${p.skill}`)),
      bus.on('BossSkillInterrupted', (p) => {
        this.stopLoop(`skill:${p.skill}`);
        this.play('sfx-boss-interrupted', { spatial: true });
      }),

      // ── 塔 ──
      bus.on('TowerPlaced', () => this.play('sfx-tower-build')),
      bus.on('TowerUpgraded', () => this.play('sfx-tower-upgrade')),
      bus.on('TowerDestroyed', (p) => {
        this.play(p.reason === 'sold' ? 'sfx-tower-sell' : 'sfx-tower-destroy');
      }),
      bus.on('TowerSlotStateChanged', (p) => {
        if (p.state === 'open') this.play('sfx-slot-unlock');
        else if (p.state === 'submerged') this.play('sfx-slot-submerged');
      }),
      bus.on('TowerTargetHit', (p) => {
        const sfx = TOWER_SFX_BY_KIND[p.kind];
        if (sfx) this.play(sfx);
      }),

      // ── 界面 / 环境 / 流程 ──
      bus.on('TacticalViewChanged', (p) => {
        this.play(p.open ? 'sfx-tactical-open' : 'sfx-tactical-close');
      }),
      bus.on('CoreHpChanged', (p) => {
        this.coreHp = p.hp;
        this.coreMaxHp = p.maxHp;
      }),
      bus.on('LavaLevelChanged', (p) => this.onLavaLevel(p.y)),
      bus.on('MatchPhaseChanged', (p) => this.onPhase(p.phase, p.tSec)),
      bus.on('MatchEnded', (p) => {
        this.ended = true;
        this.stopAllLoops();
        // 胜利保持 victory（escape 已渐弱到 0，不重播）；失败换 defeat
        if (p.result === 'lose') this.switchBgm(DEFEAT_CUE, BGM_CROSSFADE_SEC);
      }),
    );
  }

  // ── 阶段 / BGM ────────────────────────────────────────────────────────────

  private onPhase(phase: MatchPhase, tSec: number): void {
    this.phase = phase;
    this.anchorMatchSec = tSec;
    this.anchorClockSec = this.clockSec;

    if (phase === 'ended') return;
    this.preloadForPhase(phase);

    if (phase === 'escape') {
      const cue = BGM_BY_PHASE.escape;
      this.fadeOutBgm(cue?.fadeOutSec ?? 10);
      return;
    }

    const cue = BGM_BY_PHASE[phase];
    if (cue) this.switchBgm(cue, BGM_CROSSFADE_SEC);
  }

  private preloadForPhase(phase: MatchPhase): void {
    if (!this.ctx) return;
    if (phase === 'wake' || phase === 'tutorial') {
      void this.ensureGroup('combat');
      return;
    }
    if (phase === 'prep') {
      void this.ensureGroup('combat');
      void this.ensureGroup('towers');
      void this.ensureGroup('ui');
      return;
    }
    if (phase === 'boss1' || phase === 'transition' || phase === 'boss2' || phase === 'rage') {
      void this.ensureGroup('combat');
      void this.ensureGroup('towers');
      void this.ensureGroup('ui');
      void this.ensureGroup('boss');
    }
  }

  private switchBgm(cue: BgmCue, fadeSec: number): void {
    const ctx = this.ctx;
    const musicBus = this.musicBus;
    if (!ctx || !musicBus) return;

    const token = ++this.bgmToken;

    const begin = (buffer: AudioBuffer | null): void => {
      if (!buffer || this.disposed || token !== this.bgmToken) return;

      const current = this.bgm;
      if (current && current.name === cue.track) {
        this.rampGain(current.gain, cue.gain, fadeSec);
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = cue.loop !== false;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(cue.gain, ctx.currentTime + Math.max(0.01, fadeSec));
      source.connect(gain);
      gain.connect(musicBus);

      if (current) {
        // 旧轨线性降到 0 再 stop —— 交叉淡化 0.8 s
        this.rampGain(current.gain, 0, fadeSec);
        stopLater(current.source, ctx, fadeSec + 0.05);
      }

      const voice: BgmVoice = { name: cue.track, source, gain };
      this.bgm = voice;

      if (cue.next) {
        const next = bgmCueForTrack(cue.next);
        source.onended = () => {
          if (this.disposed || this.phase !== 'transition') return;
          if (this.bgm !== voice) return;
          this.switchBgm(next, BGM_CROSSFADE_SEC);
        };
      }

      source.start();
    };

    const ready = this.buffers.get(cue.track);
    if (ready) begin(ready);
    else void this.loadOne(cue.track).then(begin);
  }

  private fadeOutBgm(seconds: number): void {
    const ctx = this.ctx;
    const current = this.bgm;
    if (!ctx || !current) return;
    this.bgmToken += 1;
    this.rampGain(current.gain, 0, seconds);
    stopLater(current.source, ctx, seconds + 0.25);
    this.bgm = null;
  }

  // ── 解码 / 分批加载 ──────────────────────────────────────────────────────

  private async prepareCore(): Promise<void> {
    // BGM 9 + 环境 2 先齐：环境先解码（小），再逐批解码 BGM
    await Promise.all(AMBIENT_NAMES.map((name) => this.loadOne(name)));
    if (this.disposed) return;

    this.startAmbience();
    await this.loadNames(BGM_NAMES, 2);
    if (this.disposed) return;

    this.applyPhaseBgm();
    this.syncLowHealth(this.bus.snapshot().player.hp);

    // 其余音效按当前阶段按需解
    this.preloadForPhase(this.phase);
  }

  private applyPhaseBgm(): void {
    if (this.ended) return;
    if (this.phase === 'escape') {
      const cue = BGM_BY_PHASE.escape;
      this.fadeOutBgm(cue?.fadeOutSec ?? 10);
      return;
    }
    const cue = BGM_BY_PHASE[this.phase];
    if (cue) this.switchBgm(cue, 0.4);
  }

  private ensureGroup(group: SfxGroup): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    if (this.groupState[group] === 'ready') return Promise.resolve();

    const running = this.groupLoads.get(group);
    if (running) return running;

    this.groupState[group] = 'loading';
    const job = this.loadNames(SFX_GROUP_NAMES[group], 4).then(() => {
      this.groupState[group] = 'ready';
      this.groupLoads.delete(group);
    });
    this.groupLoads.set(group, job);
    return job;
  }

  private async loadNames(names: readonly SoundName[], concurrency = 3): Promise<void> {
    const queue = [...names];
    const workers: Promise<void>[] = [];
    const count = Math.max(1, Math.min(concurrency, queue.length));
    for (let i = 0; i < count; i += 1) {
      workers.push((async () => {
        for (;;) {
          const next = queue.shift();
          if (!next || this.disposed) return;
          await this.loadOne(next);
        }
      })());
    }
    await Promise.all(workers);
  }

  private loadOne(name: SoundName): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return Promise.resolve(null);

    const ready = this.buffers.get(name);
    if (ready) return Promise.resolve(ready);

    const pending = this.loading.get(name);
    if (pending) return pending;

    const url = SOUND_FILE[name];
    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        const buffer = await ctx.decodeAudioData(data);
        this.buffers.set(name, buffer);
        return buffer;
      } catch (error) {
        this.failedLoads += 1;
        console.warn('[audio] 加载/解码失败', url, error);
        return null;
      } finally {
        this.loading.delete(name);
      }
    })();

    this.loading.set(name, job);
    return job;
  }

  // ── 一次性声部 ────────────────────────────────────────────────────────────

  private resolveName(name: PlayableSound): SfxName {
    const table = SFX_ROTATIONS as Record<string, readonly SfxName[] | undefined>;
    const rotation = table[name];
    if (rotation && rotation.length > 0) {
      const index = this.rotationCursor.get(name) ?? 0;
      const pick = rotation[index % rotation.length];
      this.rotationCursor.set(name, (index + 1) % rotation.length);
      return pick;
    }
    return name as SfxName;
  }

  /** 16 声部打满：丢掉最旧的非关键音效；全是关键时丢弃新音效 */
  private evictOldestNonCritical(): boolean {
    let victim = -1;
    for (let i = 0; i < this.voices.length; i += 1) {
      if (!this.voices[i].critical) {
        victim = i;
        break;
      }
    }
    if (victim < 0) {
      this.droppedByCap += 1;
      return false;
    }
    const [voice] = this.voices.splice(victim, 1);
    this.droppedByCap += 1;
    this.fadeStop(voice, 0.02);
    return true;
  }

  private startVoice(name: SfxName, buffer: AudioBuffer, gainValue: number, spatial: boolean): void {
    const ctx = this.ctx;
    const sfxBus = this.sfxBus;
    if (!ctx || !sfxBus) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    source.connect(gain);

    let tail: AudioNode = gain;
    if (spatial) {
      const panner = this.makePanner();
      if (panner) {
        gain.connect(panner);
        tail = panner;
      }
    }
    tail.connect(sfxBus);

    const voice: Voice = { source, gain, name, critical: CRITICAL_SFX.has(name) };
    source.onended = () => {
      const index = this.voices.indexOf(voice);
      if (index >= 0) this.voices.splice(index, 1);
    };

    this.voices.push(voice);
    this.playedCount += 1;
    this.peakVoices = Math.max(this.peakVoices, this.voices.length);

    source.start();
  }

  private fadeStop(voice: Voice, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      try {
        voice.source.stop();
      } catch {
        // 已停止
      }
      return;
    }
    this.rampGain(voice.gain, 0, seconds);
    stopLater(voice.source, ctx, seconds + 0.02);
  }

  private stopAllOneShots(): void {
    for (const voice of this.voices) this.fadeStop(voice, 0.02);
    this.voices.length = 0;
  }

  /** 弱点 / Boss 技能按 Boss 相对玩家方位做左右定位，40 m 外衰减到 0 */
  private makePanner(): PannerNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const boss = this.bossPos();
    if (!boss) return null;

    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'linear';
    panner.refDistance = 1;
    panner.maxDistance = 40;
    panner.rolloffFactor = 1;
    panner.positionX.value = boss[0];
    panner.positionY.value = boss[1];
    panner.positionZ.value = boss[2];

    const player = this.bus.snapshot().player;
    const listener = ctx.listener;
    listener.positionX.value = player.pos[0];
    listener.positionY.value = player.pos[1];
    listener.positionZ.value = player.pos[2];
    listener.forwardX.value = -Math.sin(player.yaw);
    listener.forwardY.value = 0;
    listener.forwardZ.value = -Math.cos(player.yaw);
    listener.upX.value = 0;
    listener.upY.value = 1;
    listener.upZ.value = 0;

    return panner;
  }

  private bossPos(): Vec3 | null {
    const fromOption = this.options.bossPosition?.();
    if (fromOption) return fromOption;
    // 兜底：S0 已经把 Boss 挂在 window.__boss；接线后可改用 bossPosition 显式注入
    const global = globalThis as {
      __boss?: { root?: { position?: { x: number; y: number; z: number } } };
    };
    const pos = global.__boss?.root?.position;
    return pos ? [pos.x, pos.y, pos.z] : null;
  }

  // ── 循环声部（低血 / 火焰）──────────────────────────────────────────────

  private startLoop(key: string, name: SfxName, gainValue: number): void {
    this.wantedLoops.add(key);

    const begin = (): void => {
      if (!this.wantedLoops.has(key) || !this.unlocked || this.disposed) return;
      if (this.loops.has(key)) return;
      const ctx = this.ctx;
      const sfxBus = this.sfxBus;
      const buffer = this.buffers.get(name);
      if (!ctx || !sfxBus || !buffer) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(gainValue, ctx.currentTime + 0.2);
      source.connect(gain);
      gain.connect(sfxBus);
      source.start();

      this.loops.set(key, { source, gain });
    };

    if (this.buffers.has(name)) begin();
    else void this.loadOne(name).then(begin);
  }

  private stopLoop(key: string): void {
    this.wantedLoops.delete(key);
    const loop = this.loops.get(key);
    if (!loop) return;
    this.loops.delete(key);

    const ctx = this.ctx;
    if (!ctx) {
      try {
        loop.source.stop();
      } catch {
        // 已停止
      }
      return;
    }
    this.rampGain(loop.gain, 0, 0.15);
    stopLater(loop.source, ctx, 0.2);
  }

  private stopAllLoops(): void {
    for (const key of [...this.loops.keys()]) this.stopLoop(key);
    this.wantedLoops.clear();
  }

  private syncLowHealth(hp: number): void {
    const shouldLoop = hp > 0 && hp <= 1;
    if (shouldLoop && !this.lowHealthOn) {
      this.lowHealthOn = true;
      this.startLoop('low-health', 'sfx-player-low-health', SFX_GAIN['sfx-player-low-health']);
      return;
    }
    if (!shouldLoop && this.lowHealthOn) {
      this.lowHealthOn = false;
      this.stopLoop('low-health');
    }
  }

  // ── 环境 / 时钟 ──────────────────────────────────────────────────────────

  private startAmbience(): void {
    const ctx = this.ctx;
    const musicBus = this.musicBus;
    if (!ctx || !musicBus) return;

    const lavaBuffer = this.buffers.get(AMBIENCE.lava.name);
    if (lavaBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = lavaBuffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = this.lavaAmbienceGain();
      source.connect(gain);
      gain.connect(musicBus);
      source.start();
      this.lavaGain = gain;
    }

    const towerBuffer = this.buffers.get(AMBIENCE.tower.name);
    if (towerBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = towerBuffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = AMBIENCE.tower.gain;
      source.connect(gain);
      gain.connect(musicBus);
      source.start();
    }
  }

  private lavaAmbienceGain(): number {
    const { gain, floodGain, riseToMaxM } = AMBIENCE.lava;
    if (this.lavaBaseY === null) return gain;
    const snapY = this.bus.snapshot().lavaY;
    const k = clamp01((snapY - this.lavaBaseY) / Math.max(0.001, riseToMaxM));
    return gain + (floodGain - gain) * k;
  }

  private onLavaLevel(y: number): void {
    if (this.lavaBaseY === null) this.lavaBaseY = y;
    const ctx = this.ctx;
    const node = this.lavaGain;
    if (!ctx || !node) return;
    const { gain, floodGain, riseToMaxM } = AMBIENCE.lava;
    const k = clamp01((y - this.lavaBaseY) / Math.max(0.001, riseToMaxM));
    const target = gain + (floodGain - gain) * k;
    const now = ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(target, now + 0.8);
  }

  private resetTrackedPosition(pos: Vec3): void {
    this.lastPos = pos;
    this.airborne = false;
    this.airMaxY = pos[1];
    this.stepAccum = 0;
  }

  private onPlayerMoved(pos: Vec3): void {
    const prev = this.lastPos;
    this.lastPos = pos;
    if (!prev) return;

    const dx = pos[0] - prev[0];
    const dz = pos[2] - prev[2];
    const dy = pos[1] - prev[1];
    const horizontal = Math.hypot(dx, dz);

    // 传送/复活：不进脚步累计
    if (horizontal > 8) {
      this.stepAccum = 0;
      return;
    }

    if (!this.airborne && dy > 0.04) {
      this.airborne = true;
      this.airMaxY = pos[1];
      this.play('sfx-jump');
    }

    if (this.airborne) {
      if (pos[1] > this.airMaxY) this.airMaxY = pos[1];
      if (pos[1] <= 0.02 && dy <= 0) {
        const fall = this.airMaxY - pos[1];
        this.airborne = false;
        this.play(fall > 1.5 ? 'sfx-land-heavy' : 'sfx-land-light');
      }
      return;
    }

    if (pos[1] > 0.06) return;
    this.stepAccum += horizontal;
    if (this.stepAccum >= 2.2) {
      this.stepAccum = 0;
      this.play('footstep');
    }
  }

  /** 200 ms 时钟：只做倒计时与塔心告警；document.hidden 时不累计 */
  private tickClock(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.5, Math.max(0, (now - this.lastTimerAt) / 1000));
    this.lastTimerAt = now;
    if (typeof document !== 'undefined' && document.hidden) return;

    this.clockSec += dt;
    this.tickCountdown();
    this.tickCoreWarning();
  }

  private matchElapsed(): number {
    return Math.max(0, this.anchorMatchSec + (this.clockSec - this.anchorClockSec));
  }

  private tickCountdown(): void {
    if (!this.unlocked || this.ended) return;
    if (this.phase === 'victory' || this.phase === 'escape' || this.phase === 'ended') return;

    const remaining = MATCH_LENGTH_SEC - this.matchElapsed();
    if (!(remaining > 0) || remaining > 30) {
      this.lastCountdownSec = -1;
      return;
    }

    const whole = Math.ceil(remaining);
    if (whole === this.lastCountdownSec) return;
    this.lastCountdownSec = whole;
    this.play(whole <= 10 ? 'sfx-countdown-final' : 'sfx-countdown-tick');
  }

  private tickCoreWarning(): void {
    if (!this.unlocked || this.ended || this.coreMaxHp <= 0 || this.coreHp <= 0) return;
    if (this.coreHp / this.coreMaxHp >= 0.3) return;

    const now = performance.now();
    if (now - this.lastCoreWarnAt < 3000) return;
    this.lastCoreWarnAt = now;
    this.play('sfx-core-warning', { gain: SFX_GAIN['sfx-core-warning'] });
  }

  // ── 增益工具 ──────────────────────────────────────────────────────────────

  private applyVolumes(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.musicBus || !this.sfxBus) return;

    const seconds = immediate ? 0 : 0.15;
    setParam(this.master.gain, this.muted ? 0 : this.volumes.master, ctx, seconds);
    setParam(this.musicBus.gain, this.volumes.music, ctx, seconds);
    setParam(this.sfxBus.gain, this.volumes.sfx, ctx, seconds);
  }

  private rampGain(node: GainNode, value: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    setParam(node.gain, value, ctx, seconds);
  }
}

// ── 模块级工具 ─────────────────────────────────────────────────────────────

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return host.AudioContext ?? host.webkitAudioContext ?? null;
}

function readVolumes(overrides?: Partial<AudioVolumes>): AudioVolumes {
  const merged = { ...DEFAULT_VOLUMES, ...pickVolumes(UI_AUDIO), ...pickVolumes(overrides) };
  return {
    master: clamp01(merged.master),
    music: clamp01(merged.music),
    sfx: clamp01(merged.sfx),
  };
}

function pickVolumes(raw?: Partial<AudioVolumes>): Partial<AudioVolumes> {
  const out: Partial<AudioVolumes> = {};
  if (!raw) return out;
  if (typeof raw.master === 'number' && Number.isFinite(raw.master)) out.master = raw.master;
  if (typeof raw.music === 'number' && Number.isFinite(raw.music)) out.music = raw.music;
  if (typeof raw.sfx === 'number' && Number.isFinite(raw.sfx)) out.sfx = raw.sfx;
  return out;
}

function readMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
    }
  } catch {
    // 沙箱禁用 localStorage：静音只在本次会话生效
  }
}

function isSpatialSfx(name: SfxName): boolean {
  return name === 'sfx-weakness-open' || name === 'sfx-weakness-close' || name.startsWith('sfx-boss-');
}

function setParam(param: AudioParam, value: number, ctx: AudioContext, seconds: number): void {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  if (seconds > 0) param.linearRampToValueAtTime(value, now + seconds);
  else param.value = value;
}

function stopLater(source: AudioBufferSourceNode, ctx: AudioContext, delaySec: number): void {
  try {
    source.stop(ctx.currentTime + Math.max(0, delaySec));
  } catch {
    // 已经停止或已调度过 stop
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
