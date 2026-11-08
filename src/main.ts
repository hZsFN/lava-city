import { App } from './render/App';
import { DebugOverlay } from './ui/DebugOverlay';

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
}

declare global {
  interface Window {
    __WL__?: WlBridge;
    CONFIG?: Record<string, unknown>;
  }
}

// 本地 dev 没有大厅下发的 CONFIG，用最小占位让按键链路可验证
const FALLBACK_CONFIG: Record<string, unknown> = {
  level: 1,
  world: '熔心孤塔',
  nextWorld: '未名世界',
};

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

  const app = new App(host);
  await app.init();

  const overlay = new DebugOverlay(app.backendName);
  let save = readSave();
  overlay.setHp(save?.player.hp ?? null);
  overlay.setMessage('灰盒骨架：WebGPU + TSL 熔岩');

  app.onFrame = (fps) => overlay.setFps(fps);
  app.start();
  document.getElementById('boot-tip')?.classList.add('hidden');

  window.addEventListener('iw-save-ready', (event) => {
    const incoming = (event as CustomEvent<WlSave>).detail;
    if (incoming?.player) {
      save = incoming;
      overlay.setHp(incoming.player.hp);
    }
  });

  const handleRespawn = (): void => {
    const next = window.__WL__?.respawn() ?? null;
    if (!next) {
      overlay.setMessage('未检测到 WL 协议：请在大厅或 mock-runner 内打开');
      return;
    }
    save = next;
    overlay.setHp(next.player.hp);
    overlay.setMessage(`WL.respawn() · 死亡 ${next.player.deaths ?? 0} 次`);
  };

  const handleComplete = (): void => {
    const bridge = window.__WL__;
    if (!bridge) {
      overlay.setMessage('未检测到 WL 协议，无法交接');
      return;
    }
    save = save ?? readSave();
    if (!save) {
      overlay.setMessage('没有可交接的存档');
      return;
    }
    try {
      const result = bridge.completeLevel(window.CONFIG ?? FALLBACK_CONFIG, save, {
        exitHook: '熔心仍在跳动，塔外的潮声已隐约可闻……',
      });
      overlay.setMessage(result ? 'WL.completeLevel() 已提交交接' : 'WL.completeLevel() 已调用（缺道具/线索/下一关地址）');
    } catch (error) {
      overlay.setMessage('交接失败：' + (error instanceof Error ? error.message : String(error)));
    }
  };

  window.addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'KeyR') {
      event.preventDefault();
      handleRespawn();
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      event.preventDefault();
      handleComplete();
    }
  });

  window.addEventListener('pagehide', () => app.dispose(), { once: true });
}

void boot().catch((error: unknown) => {
  console.error('[boot] 启动失败', error);
  const tip = document.getElementById('boot-tip');
  if (tip) tip.textContent = '启动失败：' + (error instanceof Error ? error.message : String(error));
});
