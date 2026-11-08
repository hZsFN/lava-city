// src/main.ts
// ============================================================================
// 启动接线（S0 维护）
// ----------------------------------------------------------------------------
// 渲染器 → 逻辑 → 表现层 → 音频 → Boss / 战斗 → 事件接线 → 调试 API
//
// 视角只有一条链路：InputHandle.aim()（只读、无副作用）→ GameView / 射线判定。
// ============================================================================

import * as THREE from 'three/webgpu';
import { App } from './render/App';
import { DebugOverlay } from './ui/DebugOverlay';
import { createGame, LOGIC_DT } from './game/GameLoop';
import { createGameView } from './game/GameView';
import { IgnisBoss } from './boss/IgnisBoss';
import { createInput } from './game/Input';
import { CombatController } from './game/CombatController';
import { createAudioManager } from './audio/AudioManager';
import playerCfgJson from './core/config/player.json';
import type { Attr, BodyPart, MatchPhase } from './core/events';
import type { WeaponHit } from './player/weaponTypes';
import type { FormSwitchConfig } from './player/FormSwitch';
import type { MagicWeaponConfig, PhysicalWeaponConfig } from './player/weaponTypes';
import type { TowerKind } from './towers/types';

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
      /** 平台交接状态（验收证据用） */
      handoff: () => { done: boolean; result: 'win' | 'fail' | null };
    };
    __boss?: IgnisBoss;
  }
}

/**
 * Boss 登场参数：与 flow.json 的 bossSpawn 段同值。
 * 该段还没进入 FlowConfig / config 合同，先在这里固定，合同补齐后再改读配置。
 */
const BOSS_SPAWN = {
  mouthPos: [0, 0, 11] as [number, number, number],
  riseSec: 1.5,
  fromY: -9,
  toY: 0,
  fromScale: 0.85,
  toScale: 1,
};

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

  // ── 1. 渲染器 ────────────────────────────────────────────────────────────
  const app = new App(host);
  await app.init();

  // ── 2. 逻辑（三路交付物的整合）──────────────────────────────────────────
  const input = createInput(app.canvas);

  // 血量接力规则：入口血量从存档读（?hp= 可覆盖），注入逻辑层；读不到才退回 config 兜底值
  let save = readSave();
  const hpOverride = queryNumber('hp');
  const hp = hpOverride !== null
    ? {
        hp: Math.max(0, Math.floor(hpOverride)),
        maxHp: Math.max(save?.player.max_hp ?? 1, Math.floor(hpOverride)),
      }
    : save
      ? { hp: save.player.hp, maxHp: save.player.max_hp }
      : undefined;

  // Boss 实例在 game 之后创建，但塔的 bossState 闭包会在逻辑帧里才取值
  let bossRef: IgnisBoss | null = null;

  const game = createGame({
    input,
    playerHp: hp,
    // 塔的目标是 Boss 的真实位置与弱点；未登场（隐藏/死亡）时返回 null
    bossState: () => {
      const boss = bossRef;
      if (!boss || !boss.root.visible || boss.isDead()) return null;
      const st = boss.state;
      const part = st.weakness;
      return {
        pos: [boss.root.position.x, boss.root.position.y, boss.root.position.z],
        weakness: part,
        weaknessAttr: part ? boss.weaknessAttr(part) : null,
        skill: st.skill,
        taunted: false,
      };
    },
  });

  // ── 3. 表现层 ────────────────────────────────────────────────────────────
  const view = createGameView({
    scene: app.scene,
    camera: app.camera,
    bus: game.bus,
    game,
    aim: () => input.aim(),
  });

  // ── 3.5 音频：P2-A 事件音效（首次用户手势后解锁）──────────────────────
  const audio = createAudioManager({ bus: game.bus, motion: game.player });
  const unlockAudio = (): void => {
    void audio.unlock().then((ok) => {
      if (!ok) return;
      window.removeEventListener('pointerdown', unlockAudio, true);
      window.removeEventListener('keydown', unlockAudio, true);
    });
  };
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);

  // ── 3.6 Boss：先藏起来，进阶段 I 时从熔岩口登场，之后每帧更新 ───────────
  const boss = new IgnisBoss(game.bus);
  boss.attachTo(app.scene);
  boss.root.position.set(...BOSS_SPAWN.mouthPos);
  boss.hideForShow();
  bossRef = boss;
  window.__boss = boss;

  // ── 4. 玩家战斗：鼠标 → 武器 → 相机射线 → Boss 结算（方案一）────────────
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
      // 方案一：抗性/减抗由 Boss 自己算，这里只占位
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
      // Boss 的弱点常量是局部坐标，必须先把命中点转进 boss 局部空间
      const local = boss.root.worldToLocal(new THREE.Vector3(o.point[0], o.point[1], o.point[2]));
      boss.takeDamage(o.baseDamage, o.attr, [local.x, local.y, local.z]);
    },
  });

  const NO_WEAPON = { lightPressed: false, lightHeld: false, heavyPressed: false, heavyHeld: false };

  // ── 5. 固定步长驱动 ──────────────────────────────────────────────────────
  app.onTick = (dt) => {
    const steps = game.tick(dt);
    boss.update(dt * 1000);
    audio.update();

    // 武器按逻辑步推进：一帧补了多步时，边沿输入只喂第一步
    if (steps > 0) {
      const weapon = input.weaponInput();
      const toggle = input.consumeFormSwitch();
      for (let i = 0; i < steps; i += 1) {
        combat.update(LOGIC_DT, {
          weapon: i === 0 ? weapon : NO_WEAPON,
          toggleForm: i === 0 ? toggle : false,
        });
      }
    }
  };
  app.onSync = () => { view.sync(); };

  // ── 6. 调试浮层 ──────────────────────────────────────────────────────────
  const overlay = new DebugOverlay(app.backendName);
  overlay.setHp(game.snapshot().player.hp);
  overlay.setMessage('熔心孤塔 · 点击画面锁定鼠标，WASD 移动');

  // 平台交接状态（window.__game.handoff）
  let handoffDone = false;
  let handoffResult: 'win' | 'fail' | null = null;

  // 血量归零：唯一出口是 WL.failLevel（不做复活、不回血）
  let failed = false;
  game.bus.on('PlayerDied', (p) => {
    if (failed) return;
    failed = true;
    handoffDone = true;
    handoffResult = 'fail';
    overlay.setHp(0);
    overlay.setMessage(`倒下：${p.cause}`);
    try {
      window.__WL__?.failLevel?.('被熔渊之主击倒，倒在塔心前');
    } catch (error) {
      console.error('[boot] failLevel 失败', error);
    }
  });

  // Boss 登场：进阶段 I 时从熔岩口升到地面
  game.bus.on('MatchPhaseChanged', (p) => {
    overlay.setMessage(`${phaseLabel(p.phase)} · ${p.tSec.toFixed(1)}s`);
    if (p.phase === 'boss1') {
      boss.beginSpawn({
        durMs: BOSS_SPAWN.riseSec * 1000,
        fromY: BOSS_SPAWN.fromY,
        toY: BOSS_SPAWN.toY,
        fromScale: BOSS_SPAWN.fromScale,
        toScale: BOSS_SPAWN.toScale,
      });
    }
  });

  // Boss 死亡（塔/调试伤害）→ 时间轴进入 victory 演出
  game.bus.on('BossHpChanged', (p) => {
    const phase = game.timeline.phase();
    if (p.hp <= 0 && (phase === 'boss1' || phase === 'boss2')) game.timeline.notifyBossDefeated();
  });

  // 塔的伤害落到 Boss 身上；阶段 I 留 1 血，保证转阶段一定发生
  game.bus.on('TowerTargetHit', (p) => {
    const bossNow = bossRef;
    if (!bossNow || bossNow.isDead()) return;
    let amount = p.amount;
    if (game.timeline.phase() === 'boss1') amount = Math.min(amount, bossNow.state.hp - 1);
    if (amount > 0) bossNow.takeDamage(amount, p.attr);
  });

  // Boss 技能命中：近距离直接扣 1 点（血量接力规则）
  game.bus.on('BossSkillStart', (p) => {
    if (p.stage !== 'active') return;
    // 只有近身三招算命中；汲取/石柱/吐息交给后续战斗票
    if (p.skill !== 'rockSweep' && p.skill !== 'leapSlam' && p.skill !== 'lavaCharge') return;
    const b = bossRef;
    if (!b || game.isOver()) return;
    const pp = game.playerPos();
    const dx = pp[0] - b.root.position.x;
    const dz = pp[2] - b.root.position.z;
    if (Math.hypot(dx, dz) <= 10) game.player.takeHit(p.skill);
  });

  // ── 7. 局终处理：胜利/失败 → WL 交接 ────────────────────────────────────
  game.bus.on('MatchEnded', (p) => {
    if (failed) return; // 已因血量归零判定失败，避免重复提交
    handoffDone = true;
    handoffResult = p.result === 'win' ? 'win' : 'fail';
    overlay.setMessage(
      p.result === 'win'
        ? `通关！${p.tSec.toFixed(1)}s · ${p.reason}`
        : `失败：${reasonLabel(p.reason)} · ${p.tSec.toFixed(1)}s`,
    );

    if (p.result === 'win') {
      const bridge = window.__WL__;
      save = save ?? readSave();
      if (bridge && save) {
        try {
          bridge.completeLevel(window.CONFIG ?? FALLBACK_CONFIG, save, { exitHook: EXIT_HOOK });
        } catch (error) {
          console.error('[boot] completeLevel 失败', error);
        }
      }
    } else if (window.__WL__?.failLevel) {
      try {
        window.__WL__.failLevel(reasonLabel(p.reason));
      } catch (error) {
        console.error('[boot] failLevel 失败', error);
      }
    }
  });

  app.onFrame = (fps) => {
    overlay.setFps(fps);
    overlay.setHp(game.snapshot().player.hp);
  };

  // ── 8. 调试快捷键 ────────────────────────────────────────────────────────
  let motes = game.snapshot().motes;
  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;

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
      // 原来是 KeyM，让位给音频静音
      motes += 10;
      game.setMotes(motes);
      overlay.setMessage(`熔核补给 +10（当前 ${motes}）`);
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      const bridge = window.__WL__;
      save = save ?? readSave();
      if (bridge && save) {
        try {
          bridge.completeLevel(window.CONFIG ?? FALLBACK_CONFIG, save, { exitHook: EXIT_HOOK });
          overlay.setMessage('WL.completeLevel() 已提交交接');
        } catch (error) {
          overlay.setMessage('交接失败：' + (error instanceof Error ? error.message : String(error)));
        }
      }
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
    handoff: () => ({ done: handoffDone, result: handoffResult }),
  };

  // ── 10. 启动 ──────────────────────────────────────────────────────────────
  app.start();
  document.getElementById('boot-tip')?.classList.add('hidden');

  window.addEventListener('pagehide', () => {
    window.removeEventListener('pointerdown', unlockAudio, true);
    window.removeEventListener('keydown', unlockAudio, true);
    audio.dispose();
    input.dispose();
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
