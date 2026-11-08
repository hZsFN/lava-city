import * as THREE from 'three/webgpu';
import { App } from './render/App';
import { DebugOverlay } from './ui/DebugOverlay';
import { M5Hud } from './ui/M5Hud';
import { createGame, LOGIC_DT } from './game/GameLoop';
import type { InputSource } from './game/GameLoop';
import { createGameView } from './game/GameView';
import { IgnisBoss } from './boss/IgnisBoss';
import { createInput } from './game/Input';
import { FlowDirector } from './game/FlowDirector';
import { CombatController } from './game/CombatController';
import { AudioPlayer } from './audio/AudioPlayer';
import type { AudioStats } from './audio/AudioPlayer';
import type { TowerKind } from './towers/types';
import type { Attr, BodyPart, MatchPhase } from './core/events';
import type { FlowConfig } from './flow/types';
import type { FormSwitchConfig } from './player/FormSwitch';
import type { MagicWeaponConfig, PhysicalWeaponConfig, WeaponHit, WeaponInput } from './player/weaponTypes';
import { createStoryDirector } from './story/StoryDirector';
import { StoryPresenter } from './ui/StoryPresenter';
import type { StoryConfig } from './story/types';
import flowCfgJson from './core/config/flow.json';
import playerCfgJson from './core/config/player.json';
import towersCfgJson from './core/config/towers.json';
import arenaPropsCfgJson from './core/config/arena-props.json';
import type { ArenaPropsConfig } from './game/ArenaProps';
import storyCfgJson from './core/config/story.json';

interface WlSave {
  level: number;
  player: { hp: number; max_hp: number; deaths?: number };
  items: unknown[];
  clues: string[];
}

interface WlBridge {
  save(): WlSave | null;
  respawn(): WlSave | null;
  completeLevel(config: Record<string, unknown>, save: WlSave, options?: Record<string, unknown>): WlSave | null;
  failLevel?(reason: string, save?: WlSave, config?: Record<string, unknown>): void;
}

declare global {
  interface Window {
    __WL__?: WlBridge;
    CONFIG?: Record<string, unknown>;
    __game?: {
      snapshot: () => unknown;
      placeTower: (slotId: string, kind: string) => boolean;
      replaceTower: (slotId: string, kind: string) => boolean;
      setMotes: (n: number) => void;
      endReason: () => string | null;
      /** 手动推进逻辑（无头测试用；正常游戏由渲染循环驱动） */
      tick: (dtSec: number) => number;
      /** 已推进的逻辑步数累计（诊断用） */
      steps: () => number;
      phase: () => MatchPhase;
      tSec: () => number;
      /** QA：直接扣玩家血（0 血走失败演出） */
      damagePlayer: (n: number) => number;
      /** QA/演示：直接击杀 Boss（会走 victory 演出） */
      killBoss: () => void;
      /** 演出快照：阶段 / 教程书 / 失败状态 */
      flow: () => Record<string, unknown>;
      /** 平台交接状态（验收证据用） */
      handoff: () => { done: boolean; result: 'win' | 'fail' | null };
      /** 音频状态（加载进度 / 声部峰值 / 静音，验收用） */
      audio: () => AudioStats | null;
    };
    __boss?: IgnisBoss;
    /** 剧情层调试句柄（QA / 手动验收用，只读 + force） */
    __story?: {
      state: () => unknown;
      force: (cueId: string) => boolean;
      cueIds: () => string[];
    };
  }
}

const flowCfg = flowCfgJson as unknown as FlowConfig;
const arenaPropsCfg = arenaPropsCfgJson as unknown as ArenaPropsConfig;

// 本地 dev 没有大厅下发的 CONFIG，用最小占位让按键链路可验证
const FALLBACK_CONFIG: Record<string, unknown> = {
  level: 1,
  world: '熔心孤塔',
  nextWorld: '未名世界',
};

/** 出口钩子：通关时留给下一关的一句话（docs/EXIT-HOOK.md 主文案） */
const EXIT_HOOK = '塔心的护罩裂开了。你脚下不是地面，是一段往下沉的石阶——而城市顶端，还有更暗的东西在等着。';

function readSave(): WlSave | null {
  try {
    return window.__WL__?.save() ?? null;
  } catch {
    return null;
  }
}

function queryNumber(name: string): number | null {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function boot(): Promise<void> {
  const host = document.getElementById('app');
  if (!host) throw new Error('index.html 缺少 #app 容器');

  const params = new URLSearchParams(window.location.search);
  const debug = params.get('debug') === '1';
  const demo = params.get('demo') ?? '';
  const speed = Math.max(1, Math.min(24, queryNumber('speed') ?? 1));
  const jumpTo = queryNumber('t');
  const hpOverride = queryNumber('hp');

  // ── 1. 渲染器 ────────────────────────────────────────────────────────────
  const app = new App(host);
  await app.init();

  // ── 2. 逻辑（三路交付物的整合）──────────────────────────────────────────
  const input = createInput(app.canvas);

  // 演出锁定期：不能走、不能转头（镜头由 FlowDirector 接管）
  interface GatedInput extends InputSource {
    locked: boolean;
    frozenYaw: number;
    frozen: boolean;
  }
  const gated: GatedInput = {
    locked: false,
    frozenYaw: 0,
    frozen: false,
    sample() {
      const raw = input.sample();
      if (!this.locked) {
        this.frozen = false;
        return raw;
      }
      if (!this.frozen) {
        this.frozen = true;
        this.frozenYaw = raw.yaw;
      }
      return { moveX: 0, moveZ: 0, yaw: this.frozenYaw, jump: false, dash: false };
    },
  };

  // 血量接力规则：入口血量从存档读，注入逻辑层；读不到才退回 config 兜底值
  let save = readSave();
  const hp = hpOverride !== null
    ? {
        hp: Math.max(0, Math.floor(hpOverride)),
        maxHp: Math.max(save?.player.max_hp ?? 1, Math.floor(hpOverride)),
      }
    : save
      ? { hp: save.player.hp, maxHp: save.player.max_hp }
      : undefined;

  // Boss 实例在 game 之后创建，但塔的 bossState 闭包会在 tick 时才取值
  let bossRef: IgnisBoss | null = null;

  const game = createGame({
    input: gated,
    playerHp: hp,
    bossState: () => {
      const boss = bossRef;
      if (!boss || !boss.root.visible || boss.isDead()) return null;
      const st = boss.state;
      const part = st.weakness;
      return {
        pos: [boss.root.position.x, boss.root.position.y, boss.root.position.z],
        weakness: part,
        weaknessAttr: part ? boss.weaknessAttr(part as BodyPart) : null,
        skill: st.skill,
        taunted: false,
      };
    },
  });
  // 开局熔核（HUD 与建造共用同一份余额）
  game.setMotes(flowCfg.motes.start);

  // ── 3. 表现层 ────────────────────────────────────────────────────────────
  const view = createGameView({
    scene: app.scene,
    camera: app.camera,
    bus: game.bus,
    game,
    aim: () => input.aim(),
  });

  // 场地道具的表现层（M3-04）：12 件跳跃平台 + 台面描边。
  // 位置与逻辑层碰撞箱同源（都读 core/config/arena-props.json），
  // 所以「看得见的台子」和「站得上的台子」不可能对不上。
  // ?boxes=1 打开碰撞箱线框，验收用。
  const arenaPropsView = app.mountArenaProps(arenaPropsCfg, params.get('boxes') === '1');

  const boss = new IgnisBoss(game.bus);
  boss.attachTo(app.scene);
  boss.root.position.set(...flowCfg.bossSpawn.mouthPos);
  boss.hideForShow();
  bossRef = boss;
  window.__boss = boss;

  // ── 3.5 音频（M5-02）─────────────────────────────────────────────────────
  // 构造阶段零音频资源：首次 pointerdown / keydown 才建 AudioContext 并分批解码。
  // M 键静音由 AudioPlayer 自己接管；弱点/Boss 音效的左右定位读 bossPosition。
  // ?audio=0：无头截图/QA 时关闭音频，避免软件音频栈拖慢渲染。
  const audio = params.get('audio') === '0'
    ? null
    : new AudioPlayer({
        bus: game.bus,
        bossPosition: () => {
          const b = bossRef;
          return b ? [b.root.position.x, b.root.position.y, b.root.position.z] : null;
        },
      });

  // ── 3.6 玩家战斗：鼠标 → 武器 → 相机射线 → Boss 结算 ──────────────────────
  const pc = playerCfgJson as unknown as {
    formSwitch: FormSwitchConfig;
    weaponPhysical: PhysicalWeaponConfig;
    weaponMagic: Omit<MagicWeaponConfig, 'overheat'>;
    overheat: MagicWeaponConfig['overheat'];
  };

  let exposed: { part: BodyPart; attr: Attr } | null = null;
  game.bus.on('WeaknessExposed', (p) => { exposed = { part: p.part, attr: p.attr }; });
  game.bus.on('WeaknessClosed', (p) => {
    if (exposed?.part === p.part) exposed = null;
  });

  const raycaster = new THREE.Raycaster();
  const aimDir = new THREE.Vector3();
  const bossBox = new THREE.Box3();
  const bossBoxHit = new THREE.Vector3();
  const partBox = new THREE.Box3();
  /** 包围盒兜底的采样步长（米） */
  const SAMPLE_STEP = 0.25;

  /**
   * Boss 可见网格的世界包围盒。
   * 只算 visible：阶段 II 的网格在阶段 I 是隐藏的，Box3.setFromObject 会把它们也算进来，
   * 判定框被撑大一圈，近战就会隔空打到。
   */
  function bossHurtBox(): THREE.Box3 {
    bossBox.makeEmpty();
    boss.root.updateWorldMatrix(true, true);
    boss.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const geo = mesh.geometry;
      if (!geo) return;
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return;
      partBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
      bossBox.union(partBox);
    });
    return bossBox;
  }

  function resolveBossHit(rangeM: number): WeaponHit | null {
    const aim = input.aim();
    const cp = Math.cos(aim.pitch);
    aimDir
      .set(-Math.sin(aim.yaw) * cp, Math.sin(aim.pitch), -Math.cos(aim.yaw) * cp)
      .normalize();
    const far = Number.isFinite(rangeM) ? rangeM : 60;
    raycaster.set(app.camera.position, aimDir);
    raycaster.far = far;
    const hit = raycaster.intersectObject(boss.root, true)[0];
    let p: THREE.Vector3 | null = null;
    if (hit) {
      p = hit.point;
    } else {
      // 包围盒兜底：Boss 是巨型目标，站在正面平视时射线正好从双腿之间的空隙穿过去
      // （2026-11-08 实测：眼高 1.7 m 平射，140 个网格 0 命中），单点射线永远打不到。
      // 精确命中优先（弱点判定要用真实命中点），落空且朝向 Boss 包围盒时才用它兜底。
      if (!boss.root.visible) return null;
      // 沿射线按 0.25 m 步进采样：只要有一个点落在包围盒里就算打中。
      // 用采样而不是 Ray.intersectBox，是因为玩家可以贴到包围盒内部（巨型 Boss 常见），
      // 那时 intersectBox 返回的是背离摄像机的交点，距离判定会把它当成"太远"。
      const box = bossHurtBox();
      for (let t = SAMPLE_STEP; t <= far; t += SAMPLE_STEP) {
        raycaster.ray.at(t, bossBoxHit);
        if (box.containsPoint(bossBoxHit)) { p = bossBoxHit; break; }
      }
      if (!p) return null;
    }
    return {
      target: 'boss',
      point: [p.x, p.y, p.z],
      pos: [boss.root.position.x, boss.root.position.y, boss.root.position.z],
      weakness: exposed ? { part: exposed.part, attr: exposed.attr } : null,
      // 抗性/减抗由 Boss 自己算，这里只占位
      resist: { resistArcane: 0, resistPhysical: 0 },
      debuffs: { scorch: 0, sunder: 0 },
    };
  }

  const combat = new CombatController({
    bus: game.bus,
    config: {
      formSwitch: pc.formSwitch,
      physical: pc.weaponPhysical,
      magic: { ...pc.weaponMagic, overheat: pc.overheat },
    },
    resolveHit: (q) => resolveBossHit(q.rangeM),
    applyBoss: (o) => {
      if (o.target !== 'boss' || !o.point) return;
      // 弱点常量是局部坐标，先把命中点转进 boss 局部空间
      const local = boss.root.worldToLocal(new THREE.Vector3(o.point[0], o.point[1], o.point[2]));
      boss.takeDamage(o.baseDamage, o.attr, [local.x, local.y, local.z]);
    },
  });

  // 初始形态对齐：CombatController 起手是 player.json 的 formSwitch.initial（physical），
  // 而 events.ts 的快照默认是 arcane —— 不对齐会让 HUD 显示"法术形态"却拿着物理武器。
  game.bus.emit('FormSwitched', { form: pc.formSwitch.initial });

  const NO_WEAPON = { lightPressed: false, lightHeld: false, heavyPressed: false, heavyHeld: false };

  // ── 4. 演出 / HUD ────────────────────────────────────────────────────────
  let handoffDone = false;
  let handoffResult: 'win' | 'fail' | null = null;

  function failToPlatform(reason: string): void {
    if (handoffDone) return;
    handoffDone = true;
    handoffResult = 'fail';
    save = save ?? readSave();
    if (save) save.player.hp = 0;
    try {
      window.__WL__?.failLevel?.(reason, save ?? undefined, window.CONFIG ?? FALLBACK_CONFIG);
    } catch (error) {
      console.error('[boot] failLevel 失败', error);
    }
  }

  function completeToPlatform(): void {
    if (handoffDone) return;
    handoffDone = true;
    handoffResult = 'win';
    const bridge = window.__WL__;
    save = save ?? readSave();
    if (save) save.player.hp = Math.max(1, Math.round(game.snapshot().player.hp));
    if (!bridge || !save) {
      console.warn('[boot] 无 WL 存档，跳过 completeLevel（本地预览）');
      return;
    }
    try {
      bridge.completeLevel(window.CONFIG ?? FALLBACK_CONFIG, save, { exitHook: EXIT_HOOK });
    } catch (error) {
      console.error('[boot] completeLevel 失败', error);
    }
  }

  const show = new FlowDirector({
    scene: app.scene,
    camera: app.camera,
    bus: game.bus,
    game,
    boss,
    flowCfg,
    lava: { setLavaY: (y) => app.setLavaY(y), lavaBaseY: app.lavaBaseY },
    debug,
    onFail: (reason) => failToPlatform(reason),
    audio,
  });

  const hud = new M5Hud({ bus: game.bus });
  const weakScreen = new THREE.Vector3();
  const resolveWeaknessDirection = (): { x: number; y: number; behind: boolean } | null => {
    const snap = game.snapshot();
    if (!snap.boss.weakness) return null;
    const height = snap.boss.phase === 2 ? 7 : 6;
    weakScreen.set(boss.root.position.x, boss.root.position.y + height, boss.root.position.z);
    weakScreen.project(app.camera);
    return { x: weakScreen.x, y: weakScreen.y, behind: weakScreen.z > 1 };
  };
  app.onSync = () => {
    hud.setWeaknessDirection(resolveWeaknessDirection());
    hud.flush();
  };
  const overlay = new DebugOverlay(app.backendName);
  overlay.root.style.display = debug ? 'block' : 'none';
  overlay.root.style.right = '18px';
  overlay.root.style.top = '84px';
  overlay.root.style.bottom = 'auto';
  overlay.setHp(game.snapshot().player.hp);
  overlay.setMessage('熔心孤塔 · 点击画面锁定鼠标，WASD 移动');

  // ── 4.9 剧情层：表里双世界 + 五幕（迷惘·成长·舍弃·决绝·新生）─────────────
  // 纯订阅者：只听 bus 已有事件，不新增契约、不改 events.ts。
  // 逻辑层（StoryDirector）与表现层（StoryPresenter）分离，前者可在 Node 下跑单测。
  // 必须建在 createGame 之后：时间轴在 createGame 内部已发首个 MatchPhaseChanged，
  // 剧情层靠 init 时从快照补读当前阶段来对齐（否则第一幕台词整段不触发）。
  const story = createStoryDirector();
  const storyCfg = storyCfgJson as unknown as StoryConfig;
  story.init({
    bus: game.bus,
    cfg: storyCfg,
    runIndex: 0,
    // 阶段时长交给剧情层，phaseProgress 触发器靠它把进度换算成时间
    phaseDurations: flowCfg.phases.map((p) => ({
      phase: p.phase,
      startSec: p.startSec,
      endSec: p.endSec,
    })),
  });
  const storyView = new StoryPresenter(host, {
    canvas: app.canvas,
    // 表现层时序参数由配置注入（项目铁律：所有数值外置 JSON）
    timing: storyCfg.inner,
  });

  // 调试句柄：控制台可直接看当前 cue / 世界层，或强播某条台词
  window.__story = {
    state: () => story.state(),
    force: (cueId: string) => story.force(cueId),
    cueIds: () => storyCfg.cues.map((c) => c.id),
  };

  // ── 5. 事件接线 ──────────────────────────────────────────────────────────
  let lastPhase: MatchPhase = game.snapshot().phase;
  game.bus.on('MatchPhaseChanged', (p) => {
    lastPhase = p.phase;
    overlay.setMessage(`${phaseLabel(p.phase)} · ${p.tSec.toFixed(1)}s`);

    // Boss 登场：从熔岩口升到地面（flowCfg.bossSpawn 参数见 flow.json）
    if (p.phase === 'boss1') {
      const sp = flowCfg.bossSpawn;
      boss.beginSpawn({
        durMs: sp.riseSec * 1000,
        fromY: sp.fromY,
        toY: sp.toY,
        fromScale: sp.fromScale,
        toScale: sp.toScale,
      });
    }
  });

  // Boss 血量归零：阶段 I → 按血量进转阶段（不等时间轴）；阶段 II → victory
  game.bus.on('BossHpChanged', (p) => {
    if (p.hp > 0) return;
    if (lastPhase === 'boss1') {
      game.timeline.jumpToTransition();
    } else if (lastPhase === 'boss2') {
      game.timeline.notifyBossDefeated();
    }
  });

  // 塔的伤害落到 Boss 身上；阶段 I 留 1 血，保证 2:20 转阶段一定发生
  game.bus.on('TowerTargetHit', (p) => {
    if (!show.bossDamageAllowed()) return;
    const bossNow = bossRef;
    if (!bossNow || bossNow.isDead()) return;
    let amount = p.amount;
    
    if (amount > 0) bossNow.takeDamage(amount, p.attr);
  });

  // Boss 技能命中：按技能各自的判定范围扣 1 点（血量接力规则）
  const SKILL_RANGE: Partial<Record<string, number>> = {
    rockSweep: 12,   // 岩拳横扫：3~12 m 扇形
    leapSlam: 8,     // 跃击：落在玩家位置，落地半径 8 m
    lavaCharge: 10,  // 冲撞：起手时贴身判定
  };
  game.bus.on('BossSkillStart', (p) => {
    if (p.stage !== 'active') return;
    if (!show.bossCanHurtPlayer()) return;
    const b = bossRef;
    if (!b) return;
    const pp = game.playerPos();
    const dx = pp[0] - b.root.position.x;
    const dz = pp[2] - b.root.position.z;
    const dist = Math.hypot(dx, dz);

    // 岩柱：施法时在玩家位置周围升起，判定中心是施法落点
    if (p.skill === 'stonePillars') {
      const c = b.lastCastPos();
      if (Math.hypot(pp[0] - c[0], pp[2] - c[2]) <= 4) game.player.takeHit('stonePillars');
      return;
    }
    // 吐息：正前方 18 m、半角 35° 的锥形
    if (p.skill === 'magmaBreath') {
      const yaw = b.root.rotation.y;
      const len = Math.max(1e-6, dist);
      const dot = (dx * Math.sin(yaw) + dz * Math.cos(yaw)) / len;
      if (dist <= 18 && dot >= Math.cos((35 * Math.PI) / 180)) game.player.takeHit('magmaBreath');
      return;
    }

    const range = SKILL_RANGE[p.skill];
    if (range === undefined) return;
    if (dist <= range) game.player.takeHit(p.skill);
  });

  // 玩家血归零：黑屏 0.6 s →「塔心熄灭了」→ 3 s 后 failLevel（不白屏、不重开）
  game.bus.on('PlayerDied', () => {
    show.startFail(flowCfg.fail.reason);
  });

  // 一局结算：胜利 → completeLevel；失败 → 走同一套失败演出
  game.bus.on('MatchEnded', (p) => {
    overlay.setMessage(
      p.result === 'win'
        ? `通关！${p.tSec.toFixed(1)}s · ${p.reason}`
        : `失败：${reasonLabel(p.reason)} · ${p.tSec.toFixed(1)}s`,
    );
    if (p.result === 'win') completeToPlatform();
    else show.startFail(flowCfg.fail.reason);
  });

  // ── 6. 演示脚本（仅 ?demo= 时启用，用于验收录制）───────────────────────
  let demoAccum = 0;
  let demoKilled = false;
  function demoStep(dt: number): void {
    if (!bossRef) return;
    const t = game.timeline.tSec();
    const phase = game.timeline.phase();

    if (demo === 'failhp') {
      if (t >= flowCfg.demo.failAtSec && !game.player.isDead) game.player.kill('熔岩');
      return;
    }

    if (demo !== 'win') return;

    if (phase === 'boss1' || phase === 'boss2') {
      demoAccum += dt;
      if (demoAccum >= 0.2) {
        demoAccum = 0;
        const from = phase === 'boss1' ? 50 : 155;
        const to = phase === 'boss1' ? 140 : flowCfg.demo.winAtSec;
        const maxHp = bossRef.state.maxHp;
        const target = Math.max(1, Math.round(maxHp * (1 - (t - from) / Math.max(1, to - from))));
        // 用该阶段不抗的属性，保证演示血量按时间轴线性下降
        const attr = phase === 'boss1' ? 'physical' : 'arcane';
        if (bossRef.state.hp > target) bossRef.takeDamage(bossRef.state.hp - target, attr);
      }
    }

    if (!demoKilled && t >= flowCfg.demo.winAtSec && !bossRef.isDead()) {
      demoKilled = true;
      bossRef.takeDamage(1_000_000, 'arcane');
    }
  }

  // ── 7. 固定步长驱动 ──────────────────────────────────────────────────────
  let fps = 60;
  let acc = 0;

  // 每帧只取一次武器输入；一帧补多步时，边沿事件只喂给第一步
  let pendingWeapon: WeaponInput | null = null;
  let pendingToggle = false;

  function stepLogic(dt: number): void {
    gated.locked = show.locksPlayer();
    if (!show.isFailing() && !game.isOver()) {
      // Boss 该打谁：最近的已建塔 > 玩家 > 塔心（塔是实心的，死磕塔心会卡住）
      let target: [number, number, number] = [0, 0, 0];
      let best = Infinity;
      for (const sl of game.towers.slots()) {
        if (sl.state !== 'occupied') continue;
        const p = sl.pos;
        if (!p) continue;
        const d = Math.hypot(p[0] - boss.root.position.x, p[2] - boss.root.position.z);
        if (d < best) { best = d; target = [p[0], p[1] ?? 0, p[2]]; }
      }
      if (best === Infinity) {
        const pp = game.snapshot().player.pos;
        target = [pp[0], pp[1], pp[2]];
      }
      boss.setApproachTarget(target);

      game.tick(dt);

      // 圆盘与圆环之间是熔岩（没有平台），走出去就掉下去
      const pp = game.snapshot().player.pos;
      if (Math.hypot(pp[0], pp[2]) > 24.0 && !game.isOver()) {
        game.player.kill('熔岩');
      }

      boss.update(dt * 1000);
      const outcomes = combat.update(dt, { weapon: pendingWeapon ?? NO_WEAPON, toggleForm: pendingToggle });
      for (const outcome of outcomes) view.onAttack(outcome);
      pendingWeapon = null;
      pendingToggle = false;
      demoStep(dt);
    }
    view.sync();
    show.update(dt, fps);
  }

  app.onTick = (dt) => {
    const w = input.weaponInput();
    // 按下边沿只该喂给第一步逻辑，但前提是这一帧真的有逻辑步。渲染帧快于 60 Hz 时
    // （高刷屏、或卡顿后补帧不足一格）有些帧一个逻辑步都不跑，无条件覆盖会把边沿吞掉，
    // 表现就是"点了没反应"。所以这里改成累积，等某一步真正消费掉再清。
    pendingWeapon = {
      lightPressed: (pendingWeapon?.lightPressed ?? false) || w.lightPressed,
      lightHeld: w.lightHeld,
      heavyPressed: (pendingWeapon?.heavyPressed ?? false) || w.heavyPressed,
      heavyHeld: w.heavyHeld,
    };
    pendingToggle = pendingToggle || input.consumeFormSwitch();
    const real = Math.min(0.1, dt);
    acc += real * speed;
    const budget = Math.max(3, Math.min(160, Math.ceil(real * speed * 60) + 2));
    let steps = 0;
    while (acc >= LOGIC_DT && steps < budget) {
      stepLogic(LOGIC_DT);
      acc -= LOGIC_DT;
      steps += 1;
    }
    if (steps >= budget) acc = 0;

    overlay.setHp(game.snapshot().player.hp);

    // 剧情推进：必须在逻辑推进之后（阶段/血量/熔岩都已更新），
    // 再交给表现层按帧同步（打字机、滤镜过渡都靠 dt）。
    story.update(real);
    storyView.present(story.state(), real);
  };

  app.onFrame = (value) => {
    fps = value;
  };

  // ── 8. 调试快捷键 ────────────────────────────────────────────────────────
  let motes = game.snapshot().motes;
  // 俯视建塔：手上当前选中的塔型（默认弩炮）
  const TOWER_LABEL: Record<TowerKind, string> = {
    ballista: '弩炮',
    rune: '符文',
    frost: '霜冻',
    quake: '震地',
    totem: '图腾',
  };
  let buildKind: TowerKind = 'ballista';

  // 俯视建塔靠真鼠标点塔位，所以进出俯视必须一起处理"指针"：
  //   · 退出 Pointer Lock —— 浏览器才会画出光标
  //   · 关掉 Input 的"点击画布自动锁定" —— 否则点塔位的那一下又把指针锁回去，
  //     光标消失、clientX/Y 冻在屏幕中心，塔位全点歪
  //   · 画布换十字光标 —— 一眼看出现在是在选点
  const setTacticalMode = (on: boolean): void => {
    view.setTactical(on);
    input.setLockAllowed(!on);
    app.canvas.style.cursor = on ? 'crosshair' : '';
    if (on && document.pointerLockElement) document.exitPointerLock();
    overlay.setMessage(
      on
        ? `俯视：点塔位建塔/换塔（旧塔折返 ${Math.round((towersCfgJson.build?.sellRefundRatio ?? 0) * 100)}%）· 1–5 换塔型 · B 返回`
        : '回到第一人称',
    );
  };

  // 俯视切换按钮（键盘之外再给一个入口，避免焦点/输入法吃掉按键）
  const tacBtn = document.createElement('button');
  tacBtn.textContent = '俯视建塔 (B)';
  Object.assign(tacBtn.style, {
    position: 'fixed', right: '18px', top: '16px', zIndex: '30',
    padding: '10px 16px', borderRadius: '8px', cursor: 'pointer',
    border: '1px solid #ff8a4c', background: 'rgba(20,10,6,0.82)',
    color: '#ffb27a', font: '600 14px/1 system-ui, sans-serif',
  });
  tacBtn.addEventListener('click', () => setTacticalMode(!view.isTactical()));
  document.body.appendChild(tacBtn);

  // 建塔面板（右上常驻）：五种塔的伤害/射程/造价 + 特效，当前手上的那一种高亮。
  // 数值全部现读 config/towers.json —— 改平衡不用回来动 UI。
  const KIND_ORDER: readonly TowerKind[] = ['ballista', 'rune', 'frost', 'quake', 'totem'];
  const ATTR_LABEL: Record<string, string> = { physical: '物理', arcane: '奥术', none: '无属性' };
  interface TowerCfgRow {
    name?: string; attr?: string; cost?: number; range?: number; damage?: number;
    intervalSec?: number; sunderHitsPerStack?: number; interruptChance?: number;
    tauntSec?: number; cooldownSec?: number;
  }
  const kindCfg = (kind: TowerKind): TowerCfgRow => towersCfgJson.kinds[kind] as unknown as TowerCfgRow;
  const pct = (v: number | undefined): string => `${Math.round((v ?? 0) * 100)}%`;
  const statLine = (kind: TowerKind): string => {
    const c = kindCfg(kind);
    const dmg = c.damage && c.damage > 0 ? `伤害 ${c.damage}` : '无直伤';
    const rate = c.intervalSec && c.intervalSec > 0 ? ` / ${c.intervalSec}s` : '';
    const attr = ATTR_LABEL[c.attr ?? 'none'] ?? '—';
    return `${attr} · ${dmg}${rate} · 射程 ${c.range ?? '—'} · 造价 ${c.cost ?? '—'}`;
  };
  const effectText = (kind: TowerKind): string => {
    const c = kindCfg(kind);
    const debuff = towersCfgJson.debuff;
    const freeze = towersCfgJson.freeze;
    switch (kind) {
      case 'ballista':
        return `碎甲：每 ${c.sunderHitsPerStack ?? '?'} 次命中 +1 层，每层抗性 -${pct(debuff.resistPerStack)}（最多 ${debuff.maxStacks} 层）`;
      case 'rune':
        return `灼烙：每次命中 +1 层，每层抗性 -${pct(debuff.resistPerStack)}（最多 ${debuff.maxStacks} 层）`;
      case 'frost':
        return `冻结：每次命中 +${freeze.perHit} 冻结值，满 ${freeze.max} 定身 ${freeze.stunSec}s；出射程每秒 -${freeze.decayPerSec}`;
      case 'quake':
        return `打断：Boss 施法时每 ${c.intervalSec}s 掷一次，${pct(c.interruptChance)} 打断`;
      default:
        return `嘲讽：持续 ${c.tauntSec}s（冷却 ${c.cooldownSec}s）—— 阶段 II 让 Boss 转身露背`;
    }
  };

  const buildPanel = document.createElement('div');
  Object.assign(buildPanel.style, {
    // 右下角：上面是 Boss 血条（顶部居中）、下面是熔核药丸，这里是空地
    position: 'fixed', right: '18px', bottom: '60px', zIndex: '30', width: '404px',
    padding: '10px 12px', borderRadius: '8px',
    border: '1px solid rgba(255,138,76,0.5)', background: 'rgba(20,10,6,0.85)',
    color: '#ffd0a8', font: '600 12px/1.55 system-ui, sans-serif', pointerEvents: 'none',
  });
  const buildTitle = document.createElement('div');
  buildTitle.textContent = '建塔 · 1–5 选塔型';
  buildTitle.style.cssText = 'color:#ff9a5c;letter-spacing:.5px;margin-bottom:4px';
  buildPanel.appendChild(buildTitle);

  const kindRows = new Map<TowerKind, HTMLDivElement>();
  KIND_ORDER.forEach((k, i) => {
    const row = document.createElement('div');
    row.textContent = `${i + 1}  ${kindCfg(k).name ?? TOWER_LABEL[k]} · ${statLine(k)}`;
    row.style.cssText = 'padding:1px 6px;border-radius:4px;border-left:3px solid transparent;white-space:nowrap';
    kindRows.set(k, row);
    buildPanel.appendChild(row);
  });

  const buildDetail = document.createElement('div');
  buildDetail.style.cssText =
    'margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,138,76,.25);color:#ffcfa8;white-space:normal;font-weight:500';
  buildPanel.appendChild(buildDetail);

  const refreshBuildPanel = (): void => {
    for (const [k, row] of kindRows) {
      const on = k === buildKind;
      row.style.background = on ? 'rgba(255,138,76,0.22)' : 'transparent';
      row.style.color = on ? '#ffe6cf' : '#c5a189';
      row.style.borderLeftColor = on ? '#ff8a4c' : 'transparent';
    }
    buildDetail.textContent = `特效 · ${effectText(buildKind)}`;
  };
  refreshBuildPanel();
  document.body.appendChild(buildPanel);

  // 跳过开场剧情 → Boss 立刻登场
  const skipBtn = document.createElement('button');
  skipBtn.textContent = '跳过开场 ▶ 直接开打';
  Object.assign(skipBtn.style, {
    position: 'fixed', right: '18px', top: '62px', zIndex: '30',
    padding: '10px 16px', borderRadius: '8px', cursor: 'pointer',
    border: '1px solid #ffb27a', background: 'rgba(40,16,8,0.88)',
    color: '#ffd0a0', font: '600 14px/1 system-ui, sans-serif',
  });
  const doSkip = (): void => {
    game.timeline.jumpToBoss1();
    skipBtn.remove();
    overlay.setMessage('开场跳过 · 伊格纳斯正在上来');
  };
  skipBtn.addEventListener('click', doSkip);
  document.body.appendChild(skipBtn);

  // 俯视时鼠标点击塔位 → 建塔；已被占用的塔位则以"最新点下去的那种塔"为准换塔
  // （旧塔按 sellRefundRatio 折价返还；同种塔不动，免得白吃一次折价）
  app.canvas.addEventListener('mousedown', (event) => {
    if (!view.isTactical() || event.button !== 0) return;
    const slotId = view.pickTowerSlot(event.clientX, event.clientY);
    if (!slotId) return;
    const slot = game.towers.slots().find((s2) => s2.slotId === slotId);
    if (!slot || (slot.state !== 'open' && slot.state !== 'occupied')) {
      overlay.setMessage(`${slotId} 不可建（${slot?.state ?? '未知'}）`);
      return;
    }
    const label = TOWER_LABEL[buildKind];

    if (slot.state === 'occupied') {
      const cur = game.towers.list().find((t) => t.id === slot.towerId);
      if (cur && cur.kind === buildKind) {
        overlay.setMessage(`${slotId} 已经是${label}了`);
        return;
      }
      const refund = cur
        ? Math.floor(cur.investedCost * (towersCfgJson.build?.sellRefundRatio ?? 0))
        : 0;
      const ok = game.replaceTower(slotId, buildKind);
      overlay.setMessage(
        ok
          ? `${slotId} 换塔：${cur ? TOWER_LABEL[cur.kind] : '旧塔'} → ${label}（折返 ${refund}，熔核 ${game.towers.motes()}）`
          : `换塔失败：折返 ${refund} 后仍买不起${label}（造价 ${kindCfg(buildKind).cost ?? '?'}）`,
      );
      return;
    }

    const ok = game.placeTower(slotId, buildKind);
    overlay.setMessage(
      ok ? `在 ${slotId} 建了 ${label}（熔核 ${game.towers.motes()}）` : '建塔失败：熔核不足',
    );
  });

  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;

    // E：教程书翻阅（不暂停游戏）
    if (event.code === 'KeyE') {
      if (show.interact()) {
        const view = show.flowSnapshot();
        overlay.setMessage(`教程书 · 第 ${(Number(view.bookPage) || 0) + 1} 页`);
      }
      return;
    }

    // 1-5：在最近的一个 open 塔位上建对应塔
    // Tab：切换俯视战术视角（选点建塔）
    if (event.code === 'Space') {
      const ph = game.snapshot().phase;
      if (ph === 'wake' || ph === 'tutorial' || ph === 'prep') {
        event.preventDefault();
        game.timeline.jumpToBoss1();
        skipBtn.remove();
        overlay.setMessage('开场跳过 · 伊格纳斯正在上来');
        return;
      }
    }

    if (event.code === 'KeyB') {
      event.preventDefault();
      setTacticalMode(!view.isTactical());
      return;
    }

    const kindByDigit: Record<string, TowerKind> = {
      Digit1: 'ballista',
      Digit2: 'rune',
      Digit3: 'frost',
      Digit4: 'quake',
      Digit5: 'totem',
    };
    const kind = kindByDigit[event.code];
    if (kind) {
      // 俯视：只切换"手上拿的塔型"，真正建造靠点击塔位
      if (view.isTactical()) {
        buildKind = kind;
        refreshBuildPanel();
        overlay.setMessage(
          `已选塔型：${TOWER_LABEL[kind]} · ${statLine(kind)} · 点击青色塔位放置/替换`,
        );
        return;
      }
      // 第一人称：保留原来的"一键建到第一个空位"快捷方式
      const openSlot = game.towers.slots().find((s) => s.state === 'open');
      if (!openSlot) {
        overlay.setMessage('没有可用的开放塔位');
        return;
      }
      const ok = game.placeTower(openSlot.slotId, kind);
      overlay.setMessage(
        ok ? `在 ${openSlot.slotId} 建了 ${kind}（熔核 ${game.towers.motes()}）`
           : `建塔失败：熔核不足或塔位不可用`,
      );
      return;
    }

    if (event.code === 'KeyR') {
      const next = window.__WL__?.respawn() ?? null;
      if (!next) {
        overlay.setMessage('未检测到 WL 协议：请在大厅或 mock-runner 内打开');
        return;
      }
      save = next;
      overlay.setHp(next.player.hp);
      overlay.setMessage(`WL.respawn() · 死亡 ${next.player.deaths ?? 0} 次`);
    } else if (event.code === 'KeyN') {
      // 原来是 KeyM，让位给音频静音（票面要求 M 兼作静音键）
      motes += 10;
      game.setMotes(motes);
      overlay.setMessage(`熔核补给 +10（当前 ${motes}）`);
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      completeToPlatform();
      overlay.setMessage('WL.completeLevel() 已提交交接');
    } else if (event.code === 'KeyK' && debug) {
      bossRef?.takeDamage(1_000_000, 'arcane');
      overlay.setMessage('调试：Boss 击杀');
    } else if (event.code === 'KeyJ' && debug) {
      game.player.kill('调试');
    }
  });

  // ── 9. 暴露调试 API（QA 与 Playwright 用）────────────────────────────────
  let totalSteps = 0;
  window.__game = {
    snapshot: () => game.snapshot(),
    placeTower: (slotId, kind) => game.placeTower(slotId, kind as TowerKind),
    replaceTower: (slotId, kind) => game.replaceTower(slotId, kind as TowerKind),
    setMotes: (n) => game.setMotes(n),
    endReason: () => (game.timeline.result()?.reason ?? null),
    tick: (dtSec) => {
      const n = game.tick(dtSec);
      totalSteps += n;
      return n;
    },
    steps: () => totalSteps,
    phase: () => game.timeline.phase(),
    tSec: () => game.timeline.tSec(),
    damagePlayer: (n) => game.player.takeDamage(n, 'debug'),
    killBoss: () => bossRef?.takeDamage(1_000_000, 'arcane'),
    flow: () => show.flowSnapshot(),
    handoff: () => ({ done: handoffDone, result: handoffResult }),
    audio: () => audio?.stats() ?? null,
  };

  // 场地道具诊断句柄（验收截图用）：平台件数 / 台面高度 / draw call / 碰撞箱线框开关。
  (window.__game as unknown as Record<string, unknown>).props = {
    stats: () => arenaPropsView.stats(),
    setBoxes: (visible: boolean) => arenaPropsView.setCollisionBoxesVisible(visible),
    config: () => arenaPropsCfg.instances,
  };

  // ── 10. ?t= 快进（逐段截图/验收用）───────────────────────────────────────
  if (jumpTo !== null && jumpTo > 0) {
    const cap = Math.min(flowCfg.matchLengthSec + flowCfg.rage.swallowAfterSec, jumpTo);
    const frames = Math.floor(cap * 60);
    for (let i = 0; i < frames; i += 1) stepLogic(LOGIC_DT);
    hud.flush();
  }

  // ── 11. 启动 ──────────────────────────────────────────────────────────────
  hud.flush();
  app.start();
  document.getElementById('boot-tip')?.classList.add('hidden');

  window.addEventListener('pagehide', () => {
    input.dispose();
    show.dispose();
    audio?.dispose();
    view.dispose();
    app.dispose();
  }, { once: true });
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    wake: '苏醒',
    tutorial: '教程',
    prep: '准备期',
    boss1: '阶段 I 岩甲',
    transition: '转阶段',
    boss2: '阶段 II 熔火',
    victory: '胜利',
    escape: '传送',
    rage: '狂暴',
    ended: '结算',
  };
  return map[phase] ?? phase;
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    boss_defeated: 'Boss 被击败',
    core_destroyed: '塔心被摧毁',
    player_out_of_lives: '力竭',
    timeout: '熔岩吞没',
    lava_swallowed: '熔岩吞没',
  };
  return map[reason] ?? reason;
}

void boot().catch((error: unknown) => {
  console.error('[boot] 启动失败', error);
  const tip = document.getElementById('boot-tip');
  if (tip) {
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    tip.innerHTML = '<pre style="max-width:90vw;white-space:pre-wrap;font-size:12px;">启动失败：' +
      (error instanceof Error ? error.message : String(error)) + '\n\n' + stack + '</pre>';
  }
});
