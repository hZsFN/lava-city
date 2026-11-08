import type { Bus, BodyPart } from '../core/events';
import { skillTell } from '../game/feelRules';

/**
 * M 键：全屏查看「熔岩巨人 · 霸王版」建模（public/models/surtr/SurtrRig.html，离线自带 three）。
 *
 * 原 HTML 预览界面原样保留（机位按钮 / 阶段切换 / 弱点开关都能用），
 * 外面叠一块实时 Boss 状态面板：血量、阶段、当前技能、弱点、减益。
 * iframe 懒加载：第一次按 M 才拉 0.77 MB 的页面；之后阶段/弱点变化直接驱动预览页，不重载。
 */

const SRC = `${import.meta.env.BASE_URL}models/surtr/SurtrRig.html`;
const PART_LABEL: Record<BodyPart, string> = { core: '胸口熔心', back: '背部火山口', kneeL: '左膝熔核', kneeR: '右膝熔核' };

const CSS = `
.mv-root{position:fixed;inset:0;z-index:10001;display:none;background:#07050a}
.mv-root.on{display:block;animation:mv-in .2s ease-out}
@keyframes mv-in{from{opacity:0}to{opacity:1}}
.mv-root iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.mv-stat{position:absolute;left:22px;top:50%;transform:translateY(-50%);width:250px;padding:14px 16px;border-radius:10px;
  background:rgba(14,7,5,.82);border:1px solid rgba(255,122,47,.45);box-shadow:0 0 30px rgba(255,80,20,.18);
  color:#f3d9c4;font:500 12px/1.6 system-ui,"Microsoft YaHei",sans-serif;pointer-events:none}
.mv-stat h3{margin:0 0 8px;font-size:15px;letter-spacing:.14em;color:#ff9a5c}
.mv-row{display:flex;justify-content:space-between;gap:10px}.mv-row b{color:#ffe2c8;font-weight:700}
.mv-hp{height:8px;margin:4px 0 10px;border-radius:4px;background:rgba(255,255,255,.08);overflow:hidden}
.mv-hp i{display:block;height:100%;background:linear-gradient(90deg,#ff4a1a,#ffb347);transition:width .25s}
.mv-hp.p2 i{background:linear-gradient(90deg,#ffb347,#fff0a8)}
.mv-close{position:absolute;left:22px;top:18px;padding:8px 14px;border-radius:8px;border:1px solid #ff8a4c;
  background:rgba(20,10,6,.85);color:#ffd0a0;font:600 13px/1 system-ui,sans-serif;cursor:pointer}
`;

export interface ModelViewerOptions {
  bus: Bus;
  /** 打开/关闭时通知整合层（冻结逻辑、交还指针锁） */
  onToggle: (open: boolean) => void;
}

export class ModelViewer {
  private readonly root = document.createElement('div');
  private readonly stat = document.createElement('div');
  private iframe: HTMLIFrameElement | null = null;
  private frameReady = false;
  private synced: { phase: 1 | 2; weak: boolean } | null = null;
  private open = false;
  private timer = 0;

  constructor(private readonly opts: ModelViewerOptions) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root.className = 'mv-root';
    this.stat.className = 'mv-stat';
    const close = document.createElement('button');
    close.className = 'mv-close';
    close.textContent = '✕ 返回战斗 (M)';
    close.addEventListener('click', () => this.toggle(false));
    this.root.append(this.stat, close);
    document.body.appendChild(this.root);
  }

  get isOpen(): boolean { return this.open; }

  toggle(on = !this.open): void {
    if (on === this.open) return;
    this.open = on;
    this.root.classList.toggle('on', on);
    if (on) {
      this.ensureFrame();
      this.render();
      this.timer = window.setInterval(() => this.render(), 200);
    } else {
      window.clearInterval(this.timer);
    }
    this.opts.onToggle(on);
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.root.remove();
  }

  private ensureFrame(): void {
    if (this.iframe) return;
    const phase = this.opts.bus.snapshot().boss.phase;
    const f = document.createElement('iframe');
    f.title = '熔岩巨人 · 霸王版';
    // 焦点在 iframe 里时 M / Esc 也要能关（同源，可直接挂监听）
    f.addEventListener('load', () => {
      this.frameReady = true;
      this.synced = { phase, weak: false };
      f.contentWindow?.addEventListener('keydown', (e) => {
        if (e.code === 'KeyM' || e.code === 'Escape') this.toggle(false);
      });
    });
    f.src = `${SRC}?phase=${phase}&view=hero`;
    this.root.prepend(f);
    this.iframe = f;
  }

  /**
   * 把 Boss 实时状态推进预览页（同源 DOM 直驱，不重载页面）：
   * 阶段变了 → 点预览页自带的阶段按钮（有过渡动画）；弱点开/合 → 勾/取消弱点判定球。
   * 只在游戏侧状态「变化」时推一次，玩家在预览页里手动切换不会被每帧覆盖。
   */
  private syncFrame(phase: 1 | 2, weak: boolean): void {
    const doc = this.frameReady ? this.iframe?.contentDocument : null;
    if (!doc || !this.synced) return;
    if (this.synced.phase !== phase) {
      const shownII = (doc.getElementById('phaseState')?.textContent ?? '').includes('II');
      if (shownII !== (phase === 2)) doc.getElementById('phaseBtn')?.click();
      this.synced.phase = phase;
    }
    if (this.synced.weak !== weak) {
      const chk = doc.getElementById('weakChk') as HTMLInputElement | null;
      if (chk && chk.checked !== weak) {
        chk.checked = weak;
        chk.dispatchEvent(new Event('change'));
      }
      this.synced.weak = weak;
    }
  }

  private render(): void {
    const b = this.opts.bus.snapshot().boss;
    const pct = b.maxHp > 0 ? Math.max(0, Math.min(100, (b.hp / b.maxHp) * 100)) : 0;
    const skill = b.skill ? (skillTell(b.skill)?.name ?? b.skill) : '巡游';
    const weak = b.weakness ? PART_LABEL[b.weakness] : '无';
    const alive = b.maxHp > 0;
    this.syncFrame(b.phase, b.weakness !== null);
    this.stat.innerHTML = `
      <h3>苏尔特 · Boss 状态</h3>
      <div class="mv-row"><span>阶段</span><b>${b.phase === 2 ? 'II · 熔火形态' : 'I · 岩甲形态'}</b></div>
      <div class="mv-row"><span>血量</span><b>${alive ? `${Math.ceil(b.hp)} / ${b.maxHp}` : '未登场'}</b></div>
      <div class="mv-hp${b.phase === 2 ? ' p2' : ''}"><i style="width:${pct}%"></i></div>
      <div class="mv-row"><span>当前动作</span><b>${skill}</b></div>
      <div class="mv-row"><span>暴露弱点</span><b>${weak}</b></div>
      <div class="mv-row"><span>全高</span><b>14.78 m</b></div>
      <div style="margin-top:8px;color:#9b8573">预览页按钮可切机位 / 阶段 / 弱点；Space 切阶段，1–7 切机位</div>`;
  }
}
