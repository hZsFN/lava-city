import type { Bus, Events, EventName } from '../core/events';
import { formatDamage, hurtFlashStrength, skillTell } from '../game/feelRules';

/**
 * 手感层：受击红闪、低血心跳、命中标记、伤害飘字、暂停菜单。
 *
 * 纯订阅者 + 纯 DOM：只听 bus 上已有事件，不改契约、不碰 3D。
 * 飘字走固定大小的节点池，战斗高峰也不会频繁建/删 DOM。
 */

const STYLE_ID = 'game-feel-style';
const POOL_SIZE = 18;

const CSS = `
.gf-root{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:system-ui,"Microsoft YaHei",sans-serif}
.gf-hurt{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 45%,rgba(200,20,0,.55) 100%);transition:opacity .45s ease-out}
.gf-low{position:absolute;inset:0;opacity:0;background:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 55%,rgba(150,0,0,.45) 100%)}
.gf-low.on{animation:gf-beat 1.1s ease-in-out infinite}
@keyframes gf-beat{0%,100%{opacity:.25}18%{opacity:.85}36%{opacity:.35}52%{opacity:.7}}
.gf-mark{position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;opacity:0}
.gf-mark::before,.gf-mark::after{content:"";position:absolute;left:50%;top:0;width:2px;height:100%;margin-left:-1px;background:currentColor;border-radius:1px;box-shadow:0 0 6px currentColor}
.gf-mark::before{transform:rotate(45deg)}.gf-mark::after{transform:rotate(-45deg)}
.gf-mark.hit{animation:gf-mark .22s ease-out}
@keyframes gf-mark{0%{opacity:1;transform:scale(1.35)}100%{opacity:0;transform:scale(.85)}}
.gf-num{position:absolute;left:50%;top:50%;opacity:0;font-weight:800;font-size:18px;letter-spacing:.02em;white-space:nowrap;
  text-shadow:0 0 6px rgba(0,0,0,.9),0 2px 2px rgba(0,0,0,.8);will-change:transform,opacity}
.gf-num.go{animation:gf-num .85s cubic-bezier(.2,.7,.3,1) forwards}
.gf-num.weak{font-size:26px;color:#ffd36b}.gf-num.crit{font-size:24px}
@keyframes gf-num{0%{opacity:0;transform:translate(var(--dx),0) scale(.6)}15%{opacity:1;transform:translate(var(--dx),-14px) scale(1.15)}
  100%{opacity:0;transform:translate(calc(var(--dx) * 1.6),-64px) scale(.9)}}
.gf-tell{position:absolute;left:50%;top:22%;transform:translateX(-50%);display:none;min-width:220px;padding:8px 18px 10px;border-radius:8px;
  text-align:center;background:rgba(60,8,0,.72);border:1px solid rgba(255,90,40,.8);box-shadow:0 0 24px rgba(255,60,20,.45);color:#ffe0cc}
.gf-tell.on{display:block;animation:gf-tell-in .16s ease-out}
.gf-tell b{display:block;font-size:20px;letter-spacing:.12em;color:#ffb07a}.gf-tell span{font-size:12px;color:#ffd0b0;letter-spacing:.08em}
.gf-tell i{display:block;height:3px;margin-top:6px;border-radius:2px;background:#ff6a2a;transform-origin:left}
.gf-tell.on i{animation:gf-drain var(--dur,1s) linear forwards}
@keyframes gf-tell-in{from{opacity:0;transform:translate(-50%,-8px) scale(1.08)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes gf-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
.gf-toasts{position:absolute;left:50%;top:14%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px}
.gf-toast{padding:6px 14px;border-radius:6px;background:rgba(20,10,6,.86);border:1px solid rgba(255,138,76,.5);color:#ffe0c8;
  font-size:13px;white-space:nowrap;animation:gf-toast 2.4s ease forwards}
.gf-toast.good{border-color:#ffd36b;color:#ffe9a8;font-weight:700;font-size:15px}
@keyframes gf-toast{0%{opacity:0;transform:translateY(-6px)}8%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
#app canvas.gf-shake{animation:gf-shake var(--shake-ms,260ms) cubic-bezier(.36,.07,.19,.97)}
@keyframes gf-shake{10%,90%{transform:translate(calc(var(--shake) * -.4),0)}20%,80%{transform:translate(calc(var(--shake) * .7),calc(var(--shake) * .3))}
  30%,50%,70%{transform:translate(calc(var(--shake) * -1),calc(var(--shake) * -.4))}40%,60%{transform:translate(var(--shake),calc(var(--shake) * .4))}}
@media (prefers-reduced-motion:reduce){#app canvas.gf-shake{animation:none}}
.gf-pause{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;pointer-events:auto;
  background:radial-gradient(circle at 50% 45%,rgba(40,12,4,.72),rgba(5,3,6,.9));backdrop-filter:blur(3px)}
.gf-pause.on{display:flex;animation:gf-fade .18s ease-out}
@keyframes gf-fade{from{opacity:0}to{opacity:1}}
.gf-card{min-width:360px;max-width:min(520px,90vw);padding:26px 30px;border-radius:12px;border:1px solid rgba(255,138,76,.55);
  background:linear-gradient(180deg,rgba(36,14,6,.95),rgba(18,8,5,.95));box-shadow:0 0 40px rgba(255,90,30,.25);color:#ffd8bc}
.gf-card h2{margin:0 0 4px;font-size:24px;letter-spacing:.2em;color:#ff9a5c;text-align:center}
.gf-card .sub{margin:0 0 18px;text-align:center;color:#b88d72;font-size:12px;letter-spacing:.1em}
.gf-keys{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;margin-bottom:20px}
.gf-keys kbd{justify-self:end;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,178,122,.5);background:rgba(255,138,76,.12);
  color:#ffd0a0;font:600 12px/1.5 ui-monospace,Consolas,monospace;white-space:nowrap}
.gf-btn{display:block;width:100%;padding:11px 0;border-radius:8px;border:1px solid #ff8a4c;background:rgba(255,120,50,.18);
  color:#ffe2cc;font:700 15px/1 system-ui,sans-serif;letter-spacing:.15em;cursor:pointer;transition:background .15s,transform .1s}
.gf-btn:hover{background:rgba(255,120,50,.34)}.gf-btn:active{transform:scale(.98)}
`;

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', '移动'], ['鼠标', '转向 / 瞄准'], ['左键 / 右键', '轻击 / 重击'], ['Q', '切换物理 / 法术形态'], ['F', '处决（弱点槽满时）'],
  ['Space', '跳跃（开场时跳过剧情）'], ['Shift', '冲刺'], ['B', '俯视建塔'], ['1 – 5', '选择塔型'],
  ['E', '翻阅教程书'], ['M', '查看熔岩巨人建模 + Boss 状态'], ['U', '静音'], ['P / Esc', '暂停 / 继续'],
];

export interface GameFeelOptions {
  bus: Bus;
  /** 点击「继续」时调用（整合层负责恢复逻辑与重新锁定指针） */
  onResume: () => void;
}

export class GameFeel {
  private readonly root = document.createElement('div');
  private readonly hurt = document.createElement('div');
  private readonly low = document.createElement('div');
  private readonly mark = document.createElement('div');
  private readonly pool: HTMLDivElement[] = [];
  private readonly pauseEl = document.createElement('div');
  private readonly tell = document.createElement('div');
  private readonly toasts = document.createElement('div');
  private readonly unsubs: Array<() => void> = [];
  private poolIdx = 0;
  private hurtTimer = 0;
  private paused = false;

  constructor(private readonly opts: GameFeelOptions) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    this.root.className = 'gf-root';
    this.hurt.className = 'gf-hurt';
    this.low.className = 'gf-low';
    this.mark.className = 'gf-mark';
    this.tell.className = 'gf-tell';
    this.toasts.className = 'gf-toasts';
    this.root.append(this.low, this.hurt, this.mark, this.tell, this.toasts);
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const n = document.createElement('div');
      n.className = 'gf-num';
      n.addEventListener('animationend', () => n.classList.remove('go'));
      this.pool.push(n);
      this.root.appendChild(n);
    }
    this.mark.addEventListener('animationend', () => this.mark.classList.remove('hit'));
    this.buildPause();
    document.body.append(this.root, this.pauseEl);
    this.bind();
  }

  get isPaused(): boolean { return this.paused; }

  setPaused(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    this.pauseEl.classList.toggle('on', on);
  }

  /** 玩家可见的短提示（最多同时 3 条，2.4 s 自动淡出） */
  toast(text: string, good = false): void {
    const el = document.createElement('div');
    el.className = good ? 'gf-toast good' : 'gf-toast';
    el.textContent = text;
    el.addEventListener('animationend', () => el.remove());
    this.toasts.appendChild(el);
    while (this.toasts.childElementCount > 3) this.toasts.firstElementChild?.remove();
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    window.clearTimeout(this.hurtTimer);
    this.root.remove();
    this.pauseEl.remove();
  }

  private buildPause(): void {
    this.pauseEl.className = 'gf-pause';
    const card = document.createElement('div');
    card.className = 'gf-card';
    const h = document.createElement('h2');
    h.textContent = '暂停';
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = '熔心孤塔 · 时间已凝固';
    const keys = document.createElement('div');
    keys.className = 'gf-keys';
    for (const [k, d] of KEYS) {
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      const span = document.createElement('span');
      span.textContent = d;
      keys.append(kbd, span);
    }
    const btn = document.createElement('button');
    btn.className = 'gf-btn';
    btn.textContent = '继续战斗';
    btn.addEventListener('click', () => this.opts.onResume());
    card.append(h, sub, keys, btn);
    this.pauseEl.appendChild(card);
  }

  private bind(): void {
    const on = <K extends EventName>(name: K, fn: (p: Events[K]) => void): void => {
      this.unsubs.push(this.opts.bus.on(name, fn));
    };
    on('PlayerDamaged', (p) => {
      this.hurt.style.transition = 'none';
      this.hurt.style.opacity = String(hurtFlashStrength(p.amount, p.maxHp));
      window.clearTimeout(this.hurtTimer);
      this.hurtTimer = window.setTimeout(() => {
        this.hurt.style.transition = '';
        this.hurt.style.opacity = '0';
      }, 60);
      this.setLow(p.hp, p.maxHp);
      this.shake(6, 260);
    });
    on('BossSkillStart', (p) => {
      // 落地/冲撞的震屏：不管有没有打中玩家都给，告诉玩家"这一下很重"
      if (p.stage === 'active' && (p.skill === 'leapSlam' || p.skill === 'lavaCharge')) this.shake(9, 380);
    });
    on('BossPhaseChanged', () => this.shake(12, 600));
    on('PlayerDied', () => this.low.classList.remove('on'));
    on('PlayerRespawned', () => this.low.classList.remove('on'));
    on('BossSkillStart', (p) => {
      if (p.stage !== 'windup') { this.tell.classList.remove('on'); return; }
      const t = skillTell(p.skill);
      if (!t) return;
      this.tell.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = `⚠ ${t.name}`;
      const s = document.createElement('span');
      s.textContent = t.hint;
      this.tell.append(b, s, document.createElement('i'));
      this.tell.style.setProperty('--dur', `${Math.max(100, p.durationMs)}ms`);
      this.restart(this.tell, 'on');
    });
    on('BossSkillEnd', () => this.tell.classList.remove('on'));
    on('BossSkillInterrupted', (p) => {
      this.tell.classList.remove('on');
      this.toast(p.by === 'freeze' ? '冻结打断！' : '打断！', true);
    });
    on('FreezeFull', () => this.toast('Boss 被冻住了', true));
    on('KneeBroken', (p) => this.toast(`${p.side === 'L' ? '左' : '右'}膝甲破碎！`, true));
    on('DamageDealt', (p) => {
      if (p.target !== 'boss') return;
      this.popNumber(p.amount, Boolean(p.part), p.isCrit, p.attr === 'arcane' ? '#9fd4ff' : '#fff2e0');
    });
  }

  private setLow(hp: number, maxHp: number): void {
    const low = hp > 0 && (hp <= 1 || (maxHp > 0 && hp / maxHp <= 0.25));
    this.low.classList.toggle('on', low);
  }

  private popNumber(amount: number, weak: boolean, crit: boolean, color: string): void {
    const text = formatDamage(amount);
    if (!text) return;
    this.mark.style.color = weak ? '#ffd36b' : '#ffffff';
    this.restart(this.mark, 'hit');

    const n = this.pool[this.poolIdx];
    this.poolIdx = (this.poolIdx + 1) % this.pool.length;
    n.textContent = weak ? `${text}!` : text;
    n.className = `gf-num${weak ? ' weak' : crit ? ' crit' : ''}`;
    if (!weak) n.style.color = color;
    else n.style.removeProperty('color');
    n.style.marginLeft = `${18 + Math.random() * 22}px`;
    n.style.marginTop = `${-30 - Math.random() * 20}px`;
    n.style.setProperty('--dx', `${(Math.random() - 0.3) * 40}px`);
    this.restart(n, 'go');
  }

  /** 画布整体抖动（CSS transform，不碰相机，不影响逻辑与瞄准射线） */
  private shake(px: number, ms: number): void {
    const canvas = document.querySelector<HTMLCanvasElement>('#app canvas');
    if (!canvas) return;
    canvas.style.setProperty('--shake', `${px}px`);
    canvas.style.setProperty('--shake-ms', `${ms}ms`);
    canvas.addEventListener('animationend', () => canvas.classList.remove('gf-shake'), { once: true });
    this.restart(canvas, 'gf-shake');
  }

  /** 重新触发 CSS 动画：移除类 → 强制回流 → 加回 */
  private restart(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
}
