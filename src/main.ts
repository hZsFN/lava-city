import * as THREE from 'three/webgpu';
import { App } from './render/App';
import { DebugOverlay } from './ui/DebugOverlay';
import { Hud } from './ui/Hud';
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
import flowCfgJson from './core/config/flow.json';
import playerCfgJson from './core/config/player.json';

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
  }
}

const flowCfg = flowCfgJson as unknown as FlowConfig;

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

  function resolveBossHit(rangeM: number): WeaponHit | null {
    const aim = input.aim();
    const cp = Math.cos(aim.pitch);
    aimDir
      .set(-Math.sin(aim.yaw) * cp, Math.sin(aim.pitch), -Math.cos(aim.yaw) * cp)
      .normalize();
    raycaster.set(app.camera.position, aimDir);
    raycaster.far = Number.isFinite(rangeM) ? rangeM : 60;
    const hit = raycaster.intersectObject(boss.root, true)[0];
    if (!hit) return null;
    const p = hit.point;
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

  const hud = new Hud();
  const overlay = new DebugOverlay(app.backendName);
  overlay.root.style.display = debug ? 'block' : 'none';
  overlay.root.style.right = '18px';
  overlay.root.style.top = '84px';
  overlay.root.style.bottom = 'auto';
  overlay.setHp(game.snapshot().player.hp);
  overlay.setMessage('熔心孤塔 · 点击画面锁定鼠标，WASD 移动');

  // ── 5. 事件接线 ──────────────────────────────────────────────────────────
  // TEMP-BOSS-PROBE 排查「Boss 不打人」，验完删
  window.setInterval(() => {
    const b = bossRef;
    if (!b) return;
    const st = b.state;
    const pp = game.playerPos();
    const dist = Math.hypot(pp[0] - b.root.position.x, pp[2] - b.root.position.z);
    const snap = game.snapshot();
    console.info(`[probe] phase=${snap.phase} bossVis=${b.root.visible} y=${b.root.position.y.toFixed(1)} skill=${st.skill ?? '-'} hp=${snap.player.hp}/${snap.player.maxHp} dist=${dist.toFixed(1)}`);
  }, 1000);
  game.bus.on('BossSkillStart', (p) => {
    console.info(`[probe] skillStart ${p.skill} ${p.stage}`);
  });
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

  // Boss 死亡（塔/调试伤害）→ 时间轴进入 victory 演出
  game.bus.on('BossHpChanged', (p) => {
    if (p.hp <= 0 && (lastPhase === 'boss1' || lastPhase === 'boss2')) {
      game.timeline.notifyBossDefeated();
    }
  });

  // 塔的伤害落到 Boss 身上；阶段 I 留 1 血，保证 2:20 转阶段一定发生
  game.bus.on('TowerTargetHit', (p) => {
    if (!show.bossDamageAllowed()) return;
    const bossNow = bossRef;
    if (!bossNow || bossNow.isDead()) return;
    let amount = p.amount;
    if (lastPhase === 'boss1') amount = Math.min(amount, bossNow.state.hp - 1);
    if (amount > 0) bossNow.takeDamage(amount, p.attr);
  });

  // Boss 技能命中：近距离直接扣 1 点（血量接力规则）
  game.bus.on('BossSkillStart', (p) => {
    if (p.stage !== 'active') return;
    // 只有近身三招算命中；汲取/石柱/吐息交给后续战斗票
    if (p.skill !== 'rockSweep' && p.skill !== 'leapSlam' && p.skill !== 'lavaCharge') return;
    if (!show.bossCanHurtPlayer()) return;
    const b = bossRef;
    if (!b) return;
    const pp = game.playerPos();
    const dx = pp[0] - b.root.position.x;
    const dz = pp[2] - b.root.position.z;
    if (Math.hypot(dx, dz) <= 10) game.player.takeHit(p.skill);
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
      game.tick(dt);
      boss.update(dt * 1000);
      combat.update(dt, { weapon: pendingWeapon ?? NO_WEAPON, toggleForm: pendingToggle });
      pendingWeapon = null;
      pendingToggle = false;
      demoStep(dt);
    }
    view.sync();
    show.update(dt, fps);
  }

  app.onTick = (dt) => {
    pendingWeapon = input.weaponInput();
    pendingToggle = input.consumeFormSwitch();
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

    hud.update(show.hudView(fps));
    overlay.setHp(game.snapshot().player.hp);
  };

  app.onFrame = (value) => {
    fps = value;
  };

  // ── 8. 调试快捷键 ────────────────────────────────────────────────────────
  let motes = game.snapshot().motes;
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
    const kindByDigit: Record<string, TowerKind> = {
      Digit1: 'ballista',
      Digit2: 'rune',
      Digit3: 'frost',
      Digit4: 'quake',
      Digit5: 'totem',
    };
    const kind = kindByDigit[event.code];
    if (kind) {
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

  // ── 10. ?t= 快进（逐段截图/验收用）───────────────────────────────────────
  if (jumpTo !== null && jumpTo > 0) {
    const cap = Math.min(flowCfg.matchLengthSec + flowCfg.rage.swallowAfterSec, jumpTo);
    const frames = Math.floor(cap * 60);
    for (let i = 0; i < frames; i += 1) stepLogic(LOGIC_DT);
    hud.update(show.hudView(fps));
  }

  // ── 11. 启动 ──────────────────────────────────────────────────────────────
  hud.update(show.hudView(fps));
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
