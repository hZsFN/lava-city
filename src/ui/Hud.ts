// src/ui/Hud.ts
// ============================================================================
// M4-01 HUD（纯 DOM 覆盖层，不引 UI 框架）
// ----------------------------------------------------------------------------
// 左上：血条（hp/max_hp，可能只有 1 格）
// 左中：熔核数
// 顶部中央：倒计时（4:30 → 0:00，最后 30 s 变红闪烁）
// 顶部下方：Boss 双段血条（阶段 I 蓝边 / 阶段 II 白金边）
// 右下：当前形态 + 过热条
// 屏幕边缘：弱点暴露方向脉冲
// 每帧只调用一次 update()。
// ============================================================================

import type { Attr, Snapshot } from '../core/events';

export interface HudView {
  snap: Snapshot;
  matchLengthSec: number;
  /** 当前匹配秒数（时间轴实时值；snap.tSec 只在阶段切换时更新） */
  nowSec: number;
  /** Boss 登场后才有值 */
  boss: { hp: number; maxHp: number; phase: 1 | 2 } | null;
  /** 弱点方向脉冲（0..1）：左/右边缘强度 */
  weakness: { attr: Attr; left: number; right: number } | null;
  debug: { fps: number; phase: string; tSec: number } | null;
}

const ARCANE = '#4aa8ff';
const PHYSICAL = '#f2ead6';
const EMBER = '#ff8a4c';
const RED = '#e0483a';

export class Hud {
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLDivElement;
  private readonly hpBlock: HTMLDivElement;
  private readonly moteCount: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly clockSub: HTMLDivElement;
  private readonly bossWrap: HTMLDivElement;
  private readonly bossFill1: HTMLDivElement;
  private readonly bossFill2: HTMLDivElement;
  private readonly bossRow1: HTMLDivElement;
  private readonly bossRow2: HTMLDivElement;
  private readonly formName: HTMLDivElement;
  private readonly formDot: HTMLDivElement;
  private readonly formPanel: HTMLDivElement;
  private readonly overheatFill: HTMLDivElement;
  private readonly overheatText: HTMLDivElement;
  private readonly edgeLeft: HTMLDivElement;
  private readonly edgeRight: HTMLDivElement;
  private readonly debugEl: HTMLDivElement;

  private lastHp = Number.NaN;
  private lastMaxHp = Number.NaN;
  private lastMotes = Number.NaN;
  private lastClock = '';
  private lastClockUrgent = false;
  private lastClockPrep = false;
  private lastBossVisible = false;
  private lastBoss1 = Number.NaN;
  private lastBoss2 = Number.NaN;
  private lastBossPhase = 0;
  private lastForm: Attr | null = null;
  private lastOverheat = Number.NaN;
  private lastEdge = '';

  constructor() {
    const root = document.createElement('div');
    root.id = 'hud';
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:35',
      'pointer-events:none',
      'user-select:none',
      'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif',
      'color:#efe7da',
    ].join(';');

    // ── 左上：血条 ──────────────────────────────────────────────────────────
    this.hpBlock = document.createElement('div');
    this.hpBlock.style.cssText = 'position:absolute;left:22px;top:20px;width:250px';

    const hpLabel = document.createElement('div');
    hpLabel.textContent = '生 命';
    hpLabel.style.cssText =
      'font-size:10px;letter-spacing:0.36em;color:rgba(239,231,218,0.5);margin-bottom:5px';

    const hpTrack = document.createElement('div');
    hpTrack.style.cssText = [
      'position:relative',
      'height:13px',
      'background:rgba(20,10,8,0.85)',
      'border:1px solid rgba(224,72,58,0.5)',
      'box-shadow:inset 0 0 12px rgba(0,0,0,0.8), 0 0 14px rgba(224,72,58,0.14)',
    ].join(';');

    this.hpFill = document.createElement('div');
    this.hpFill.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'bottom:0',
      'width:100%',
      'background:linear-gradient(90deg, #7d1a13, #e0483a 65%, #ff8a6a)',
      'box-shadow:0 0 12px rgba(224,72,58,0.55)',
      'transition:width 160ms linear',
    ].join(';');

    this.hpText = document.createElement('div');
    this.hpText.style.cssText = [
      'position:absolute',
      'right:6px',
      'top:50%',
      'transform:translateY(-50%)',
      'font:10px/1 ui-monospace,Consolas,monospace',
      'letter-spacing:0.08em',
      'color:#fff4ee',
      'text-shadow:0 1px 2px #000',
    ].join(';');

    hpTrack.append(this.hpFill, this.hpText);
    this.hpBlock.append(hpLabel, hpTrack);

    // ── 左中：熔核 ──────────────────────────────────────────────────────────
    const moteRow = document.createElement('div');
    moteRow.style.cssText =
      'position:absolute;left:22px;top:78px;display:flex;align-items:center;gap:11px';

    const diamond = document.createElement('div');
    diamond.style.cssText = [
      'width:13px',
      'height:13px',
      'transform:rotate(45deg)',
      'background:linear-gradient(135deg,#ffb070,#ff5a12)',
      'box-shadow:0 0 14px rgba(255,122,42,0.8)',
    ].join(';');

    this.moteCount = document.createElement('div');
    this.moteCount.textContent = '0';
    this.moteCount.style.cssText =
      'font:16px/1 ui-monospace,Consolas,monospace;color:#ffc190;text-shadow:0 0 12px rgba(255,122,42,0.5)';

    const moteLabel = document.createElement('div');
    moteLabel.textContent = '熔核';
    moteLabel.style.cssText =
      'font-size:10px;letter-spacing:0.28em;color:rgba(239,231,218,0.42);margin-left:2px';

    // 经济系统已移除，熔核不显示（元素仍构建但不入 DOM）
    moteRow.append(diamond, this.moteCount, moteLabel);

    // ── 顶部中央：倒计时 ────────────────────────────────────────────────────
    const clockWrap = document.createElement('div');
    clockWrap.style.cssText = 'position:absolute;left:50%;top:16px;transform:translateX(-50%);text-align:center';

    this.clock = document.createElement('div');
    this.clock.textContent = '4:30';
    this.clock.style.cssText = [
      'font:600 42px/1 ui-monospace,SFMono-Regular,Consolas,monospace',
      'letter-spacing:0.14em',
      'color:#f0e6d6',
      'text-shadow:0 0 22px rgba(255,122,42,0.35), 0 2px 4px #000',
    ].join(';');

    this.clockSub = document.createElement('div');
    this.clockSub.textContent = '熔心熄灭前';
    this.clockSub.style.cssText =
      'margin-top:4px;font-size:9px;letter-spacing:0.4em;color:rgba(239,231,218,0.4)';

    clockWrap.append(this.clock, this.clockSub);

    // ── 顶部下方：Boss 双段血条 ─────────────────────────────────────────────
    this.bossWrap = document.createElement('div');
    this.bossWrap.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:104px',
      'transform:translateX(-50%)',
      'width:min(600px, 54vw)',
      'display:none',
    ].join(';');

    const bossTitle = document.createElement('div');
    bossTitle.textContent = '熔 渊 之 主 · 伊 格 纳 斯';
    bossTitle.style.cssText =
      'font-size:9px;letter-spacing:0.42em;color:rgba(239,231,218,0.45);text-align:center;margin-bottom:5px';

    const row1 = this.bossRow('阶段 I · 岩甲', ARCANE);
    const row2 = this.bossRow('阶段 II · 熔火', PHYSICAL);
    this.bossRow1 = row1.row;
    this.bossFill1 = row1.fill;
    this.bossRow2 = row2.row;
    this.bossFill2 = row2.fill;

    this.bossWrap.append(bossTitle, this.bossRow1, this.bossRow2);

    // ── 右下：形态 + 过热 ──────────────────────────────────────────────────
    this.formPanel = document.createElement('div');
    this.formPanel.style.cssText = [
      'position:absolute',
      'right:22px',
      'bottom:20px',
      'width:210px',
      'padding:10px 12px 12px',
      'background:rgba(10,6,6,0.55)',
      'border:1px solid rgba(239,231,218,0.12)',
      'border-right:2px solid rgba(74,168,255,0.8)',
    ].join(';');

    const formRow = document.createElement('div');
    formRow.style.cssText = 'display:flex;align-items:center;gap:8px';

    this.formDot = document.createElement('div');
    this.formDot.style.cssText =
      'width:9px;height:9px;border-radius:50%;background:#4aa8ff;box-shadow:0 0 12px #4aa8ff';

    this.formName = document.createElement('div');
    this.formName.textContent = '法术形态 · 地脉法杖';
    this.formName.style.cssText = 'font-size:12px;letter-spacing:0.14em;color:#cfe6ff';

    formRow.append(this.formDot, this.formName);

    const heatLabel = document.createElement('div');
    heatLabel.textContent = '过 热';
    heatLabel.style.cssText =
      'margin-top:10px;font-size:9px;letter-spacing:0.32em;color:rgba(239,231,218,0.4)';

    const heatTrack = document.createElement('div');
    heatTrack.style.cssText =
      'position:relative;height:5px;margin-top:4px;background:rgba(20,12,10,0.9);border:1px solid rgba(255,138,76,0.25)';

    this.overheatFill = document.createElement('div');
    this.overheatFill.style.cssText =
      'position:absolute;left:0;top:0;bottom:0;width:0%;background:linear-gradient(90deg,#ffb070,#ff5a12)';

    heatTrack.appendChild(this.overheatFill);

    this.overheatText = document.createElement('div');
    this.overheatText.textContent = '0%';
    this.overheatText.style.cssText =
      'margin-top:4px;font:9px/1 ui-monospace,Consolas,monospace;color:rgba(255,193,144,0.6);text-align:right';

    this.formPanel.append(formRow, heatLabel, heatTrack, this.overheatText);

    // ── 屏幕边缘：弱点脉冲 ──────────────────────────────────────────────────
    this.edgeLeft = edge('left');
    this.edgeRight = edge('right');

    // ── 调试角标 ────────────────────────────────────────────────────────────
    this.debugEl = document.createElement('div');
    this.debugEl.style.cssText = [
      'position:absolute',
      'right:18px',
      'top:16px',
      'padding:6px 9px',
      'background:rgba(8,5,5,0.62)',
      'border:1px solid rgba(255,138,76,0.22)',
      'font:10px/1.5 ui-monospace,Consolas,monospace',
      'color:#c9b79b',
      'letter-spacing:0.06em',
      'display:none',
    ].join(';');

    root.append(
      this.hpBlock,
      clockWrap,
      this.bossWrap,
      this.formPanel,
      this.edgeLeft,
      this.edgeRight,
      this.debugEl,
    );
    document.body.appendChild(root);
  }

  update(v: HudView): void {
    const { snap } = v;

    if (snap.player.hp !== this.lastHp || snap.player.maxHp !== this.lastMaxHp) {
      this.lastHp = snap.player.hp;
      this.lastMaxHp = snap.player.maxHp;
      const pct = snap.player.maxHp > 0 ? (snap.player.hp / snap.player.maxHp) * 100 : 0;
      this.hpFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      this.hpText.textContent = `${Math.round(snap.player.hp)} / ${snap.player.maxHp}`;
    }

    if (snap.motes !== this.lastMotes) {
      this.lastMotes = snap.motes;
      this.moteCount.textContent = String(snap.motes);
    }

    const remain = Math.max(0, v.matchLengthSec - v.nowSec);
    const label = `${Math.floor(remain / 60)}:${String(Math.floor(remain % 60)).padStart(2, '0')}`;
    if (label !== this.lastClock) {
      this.lastClock = label;
      this.clock.textContent = label;
    }
    const urgent = remain <= 30;
    if (urgent !== this.lastClockUrgent) {
      this.lastClockUrgent = urgent;
      this.clock.style.color = urgent ? RED : '#f0e6d6';
      this.clock.style.animation = urgent ? 'hud-blink 0.9s steps(2, end) infinite' : 'none';
      ensureBlinkKeyframes();
    }
    const prep = snap.phase === 'prep';
    if (prep !== this.lastClockPrep) {
      this.lastClockPrep = prep;
      this.clock.style.color = urgent ? RED : prep ? EMBER : '#f0e6d6';
      this.clockSub.textContent = prep ? '准备期 · 熔岩口在翻涌' : '熔心熄灭前';
    }

    const boss = v.boss;
    const visible = boss !== null && boss.maxHp > 0;
    if (visible !== this.lastBossVisible) {
      this.lastBossVisible = visible;
      this.bossWrap.style.display = visible ? 'block' : 'none';
    }
    if (boss) {
      const f1 = boss.phase === 1 ? (boss.hp / Math.max(1, boss.maxHp)) * 100 : 0;
      const f2 = boss.phase === 2 ? (boss.hp / Math.max(1, boss.maxHp)) * 100 : 0;
      if (Math.abs(f1 - this.lastBoss1) > 0.05) {
        this.lastBoss1 = f1;
        this.bossFill1.style.width = `${f1}%`;
      }
      if (Math.abs(f2 - this.lastBoss2) > 0.05) {
        this.lastBoss2 = f2;
        this.bossFill2.style.width = `${f2}%`;
      }
      if (boss.phase !== this.lastBossPhase) {
        this.lastBossPhase = boss.phase;
        this.bossRow1.style.opacity = boss.phase === 1 ? '1' : '0.32';
        this.bossRow2.style.opacity = boss.phase === 2 ? '1' : '0.32';
        this.bossRow2.style.boxShadow = boss.phase === 2 ? '0 0 18px rgba(242,234,214,0.28)' : 'none';
      }
    }

    if (snap.player.form !== this.lastForm) {
      this.lastForm = snap.player.form;
      const arcane = snap.player.form === 'arcane';
      this.formName.textContent = arcane ? '法术形态 · 地脉法杖' : '物理形态 · 熔岩重锤';
      this.formName.style.color = arcane ? '#cfe6ff' : '#f6efdc';
      this.formDot.style.background = arcane ? ARCANE : PHYSICAL;
      this.formDot.style.boxShadow = `0 0 12px ${arcane ? ARCANE : PHYSICAL}`;
      this.formPanel.style.borderRightColor = arcane ? ARCANE : PHYSICAL;
    }

    const heat = Math.round(snap.player.overheat);
    if (heat !== this.lastOverheat) {
      this.lastOverheat = heat;
      this.overheatFill.style.width = `${Math.max(0, Math.min(100, heat))}%`;
      this.overheatText.textContent = `${heat}%`;
    }

    const w = v.weakness;
    const edgeKey = w ? `${w.attr}|${w.left.toFixed(2)}|${w.right.toFixed(2)}` : '';
    if (edgeKey !== this.lastEdge) {
      this.lastEdge = edgeKey;
      if (!w) {
        this.edgeLeft.style.opacity = '0';
        this.edgeRight.style.opacity = '0';
      } else {
        const color = w.attr === 'arcane' ? ARCANE : PHYSICAL;
        this.edgeLeft.style.background = `linear-gradient(90deg, ${hexAlpha(color, 0.55)}, transparent 78%)`;
        this.edgeRight.style.background = `linear-gradient(270deg, ${hexAlpha(color, 0.55)}, transparent 78%)`;
        this.edgeLeft.style.opacity = String(Math.max(0, Math.min(1, w.left)));
        this.edgeRight.style.opacity = String(Math.max(0, Math.min(1, w.right)));
      }
    }

    if (v.debug) {
      this.debugEl.style.display = 'block';
      this.debugEl.textContent =
        `${v.debug.phase}  ${v.debug.tSec.toFixed(2)}s\n` +
        `fps ${v.debug.fps.toFixed(0)}  hp ${Math.round(snap.player.hp)}  boss ${
          boss ? `${Math.round(boss.hp)}/${boss.maxHp} P${boss.phase}` : '--'
        }`;
    } else if (this.debugEl.style.display !== 'none') {
      this.debugEl.style.display = 'none';
    }
  }

  private bossRow(label: string, color: string): { row: HTMLDivElement; fill: HTMLDivElement } {
    const row = document.createElement('div');
    row.style.cssText =
      'position:relative;height:8px;margin-top:4px;background:rgba(14,9,9,0.9);border:1px solid ' +
      hexAlpha(color, 0.55);

    const fill = document.createElement('div');
    fill.style.cssText =
      `position:absolute;left:0;top:0;bottom:0;width:100%;background:linear-gradient(90deg, ${hexAlpha(color, 0.45)}, ${color});transition:width 120ms linear`;

    const tag = document.createElement('div');
    tag.textContent = label;
    tag.style.cssText =
      'position:absolute;left:0;top:-13px;font-size:8px;letter-spacing:0.24em;color:' +
      hexAlpha(color, 0.62);

    row.append(fill, tag);
    return { row, fill };
  }
}

function edge(side: 'left' | 'right'): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'top:0',
    'bottom:0',
    'width:110px',
    side === 'left' ? 'left:0' : 'right:0',
    'opacity:0',
    'mix-blend-mode:screen',
    'filter:blur(2px)',
  ].join(';');
  return el;
}

function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

let blinkInjected = false;
function ensureBlinkKeyframes(): void {
  if (blinkInjected) return;
  blinkInjected = true;
  const style = document.createElement('style');
  style.textContent = '@keyframes hud-blink{0%,100%{opacity:1}50%{opacity:0.35}}';
  document.head.appendChild(style);
}
