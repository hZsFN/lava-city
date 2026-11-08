import { App } from './render/App';
import { DebugOverlay } from './ui/DebugOverlay';
import { createGame } from './game/GameLoop';
import { createGameView } from './game/GameView';
import { IgnisBoss } from './boss/IgnisBoss';
import { createInput } from './game/Input';
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
  failLevel?(reason: string): void;
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
    };
  }
}

// 本地 dev 没有大厅下发的 CONFIG，用最小占位让按键链路可验证
const FALLBACK_CONFIG: Record<string, unknown> = {
  level: 1,
  world: '熔心孤塔',
  nextWorld: '未名世界',
};

/** 出口钩子：通关时留给下一关的一句话（设计文档 §3 / EXIT-HOOK） */
const EXIT_HOOK = '熔心仍在跳动，塔外的潮声已隐约可闻……';

function readSave(): WlSave | null {
  try {
    return window.__WL__?.save() ?? null;
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const host = document.getElementById('app');
  if (!host) throw new Error('index.html 缺少 #app 容器');

  // ── 1. 渲染器 ────────────────────────────────────────────────────────────
  const app = new App(host);
  await app.init();

  // ── 2. 逻辑（三路交付物的整合）──────────────────────────────────────────
  const input = createInput(app.canvas);
  // 血量接力规则：入口血量从存档读，注入逻辑层；读不到才退回 config 兜底值
  let save = readSave();
  const game = createGame({
    input,
    playerHp: save ? { hp: save.player.hp, maxHp: save.player.max_hp } : undefined,
  });

  // ── 3. 表现层 ────────────────────────────────────────────────────────────
  const view = createGameView({
    scene: app.scene,
    camera: app.camera,
    bus: game.bus,
    game,
  });

  // ── 4. 接线：渲染帧 → 逻辑推进 → 表现同步 ──────────────────────────────
  // ── Boss：进阶段 I 时登场，之后每逻辑帧更新 ───────────────────────────────
  const boss = new IgnisBoss(game.bus);
  let bossAttached = false;
  const attachBoss = (): void => {
    if (bossAttached) return;
    bossAttached = true;
    boss.attachTo(app.scene);
  };
  game.bus.on('MatchPhaseChanged', (p) => {
    if (p.phase === 'boss1' || p.phase === 'transition' || p.phase === 'boss2' || p.phase === 'rage') {
      attachBoss();
    }
  });
  attachBoss();
  boss.root.position.set(0, 0, 11);
  (window as unknown as Record<string, unknown>).__boss = boss;

  app.onTick = (dt) => {
    game.tick(dt);
    boss.update(dt * 1000);
  };
  app.onSync = () => { view.sync(); };

  // ── 5. 调试浮层 ──────────────────────────────────────────────────────────
  const overlay = new DebugOverlay(app.backendName);
  overlay.setHp(game.snapshot().player.hp);
  overlay.setMessage('熔心孤塔 · 点击画面锁定鼠标，WASD 移动');

  // 血量归零：唯一出口是 WL.failLevel（不做复活、不回血）
  let failed = false;
  game.bus.on('PlayerDied', (p) => {
    if (failed) return;
    failed = true;
    overlay.setHp(0);
    overlay.setMessage(`倒下：${p.cause}`);
    try {
      window.__WL__?.failLevel?.('被熔渊之主击倒，倒在塔心前');
    } catch (error) {
      console.error('[boot] failLevel 失败', error);
    }
  });

  let lastPhase = 'wake';
  game.bus.on('MatchPhaseChanged', (p) => {
    lastPhase = p.phase;
    overlay.setMessage(`${phaseLabel(p.phase)} · ${p.tSec.toFixed(1)}s`);
  });
  void lastPhase;

  app.onFrame = (fps) => {
    overlay.setFps(fps);
    overlay.setHp(game.snapshot().player.hp);
  };

  // ── 6. 局终处理：胜利/失败 → WL 交接 ────────────────────────────────────
  game.bus.on('MatchEnded', (p) => {
    if (failed) return; // 已因血量归零判定失败，避免重复提交
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

  // ── 7. 调试快捷键 ────────────────────────────────────────────────────────
  let motes = 6;
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
    } else if (event.code === 'KeyM') {
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

  // ── 8. 暴露调试 API（QA 与 Playwright 用）────────────────────────────────
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
  };

  // ── 9. 启动 ──────────────────────────────────────────────────────────────
  app.start();
  document.getElementById('boot-tip')?.classList.add('hidden');

  window.addEventListener('pagehide', () => {
    input.dispose();
    view.dispose();
    app.dispose();
  }, { once: true });
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    wake: '苏醒',
    prep: '准备期',
    boss1: '阶段 I 岩甲',
    transition: '转阶段',
    boss2: '阶段 II 熔火',
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
