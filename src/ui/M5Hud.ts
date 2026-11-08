// src/ui/hud.ts
// ============================================================================
// M5-01 · HUD 与结算页
// ----------------------------------------------------------------------------
// 约定：
//   · 原生 DOM + CSS，不 import three、不持有任何 3D 对象；
//   · 数据只有两个入口：事件总线（on）与 bus.snapshot()；
//   · 事件回调只写内部状态 + 入待刷队列，DOM 只在 flush() 里改，
//     flush() 由整帧唯一的 app.onSync 调用，因此每帧最多刷一次；
//   · 颜色 / 字号 / 动效时长全部来自 config/ui.json，属性色来自 visual.json。
//
// 数据来源划分：
//   轮询 snapshot：玩家 hp/maxHp/form/overheat、Boss hp/maxHp/phase、熔核
//   事件驱动：破绽值/暴露部位、debuff 层数、冻结进度、战术视图、
//             击破次数、伤害构成、局终结果、阶段锚点
// ============================================================================

import type {
  Attr,
  BodyPart,
  Bus,
  EventName,
  Events,
  MatchPhase,
  Snapshot,
} from '../core/events';
import uiJson from '../core/config/ui.json';
import visualJson from '../core/config/visual.json';
import flowJson from '../core/config/flow.json';
import bossJson from '../core/config/boss.json';
import './hud.css';

// ── 配置 ────────────────────────────────────────────────────────────────────

interface UiConfig {
  weaknessIndicator: {
    edgePulse: boolean;
    worldArrow: boolean;
    facingDeg: number;
    remindSec: number;
  };
  settlement: { grades: string[]; restartSec: number };
  theme: {
    colors: Record<string, string>;
    font: { family: string; sizes: Record<string, number> };
    durations: Record<string, number>;
    layout: Record<string, number>;
    opacity: Record<string, number>;
  };
}

interface BossConfig {
  phases: Array<{
    phase: 1 | 2;
    name: string;
    hp: number;
    resist: { physical: number; arcane: number };
  }>;
}

const UI = uiJson as unknown as UiConfig;
const VISUAL = visualJson as unknown as { attributes: Record<Attr, string> };
const FLOW = flowJson as unknown as { matchLengthSec: number; motes: { start: number } };
const BOSS = bossJson as unknown as BossConfig;

const ATTR_COLOR: Record<Attr, string> = {
  arcane: VISUAL.attributes.arcane,
  physical: VISUAL.attributes.physical,
};

const PLATINUM = UI.theme.colors.platinum;

const PHASE_LABEL: Record<MatchPhase, string> = {
  wake: '醒来',
  tutorial: '阅读',
  prep: '准备',
  boss1: '岩甲形态',
  boss2: '熔火形态',
  transition: '转变',
  victory: '守护成功',
  escape: '传送',
  rage: '熔岩吞没',
  ended: '结算',
};

const FORM_LABEL: Record<Attr, string> = {
  arcane: '法术',
  physical: '物理',
};

const REASON_LABEL: Record<string, string> = {
  player_out_of_lives: '你的血耗尽了',
  core_destroyed: '塔心被摧毁',
  timeout: '熔岩吞没了塔顶',
  lava_swallowed: '熔岩吞没了塔顶',
  boss_defeated: '伊格纳斯倒下了',
};

const PHYSICAL_ICON = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"',
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<path d="M4 20l7.2-7.2"/><path d="M9.4 14.6l-2-2 5-5 2 2z"/><path d="M13 7l4-3 3 3-3 4z"/>',
  '</svg>',
].join('');

const ARCANE_ICON = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"',
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<path d="M12 21V9.5"/><circle cx="12" cy="6.2" r="2.8"/>',
  '<path d="M6.5 3.5l1.2 1.4M17.5 3.5l-1.2 1.4M4.8 8.4l1.7.5M19.2 8.4l-1.7.5"/>',
  '</svg>',
].join('');

const FLAME_ICON = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"',
  ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
  '<path d="M12 3c2.2 3.6 4.6 5.6 4.6 8.6a4.6 4.6 0 0 1-9.2 0c0-1.6.7-2.9 1.9-4.1',
  '.4 1.5 1.1 2.2 2 2.6.4-2.3.1-4.4-.3-7.1z"/></svg>',
].join('');

type Section =
  | 'player'
  | 'overheat'
  | 'timer'
  | 'boss'
  | 'debuffs'
  | 'weakness'
  | 'resources'
  | 'settlement'
  | 'arrow';

type DemoKind = 'hp1' | 'weakness' | 'transition' | 'win' | 'lose';

interface WeaknessState {
  part: BodyPart;
  attr: Attr;
}

interface DebuffState {
  sunder: number;
  scorch: number;
  freeze: number;
  freezeMax: number;
}

interface DamageState {
  tower: number;
  player: number;
  execution: number;
}

interface EndState {
  result: 'win' | 'lose';
  reason: string;
  tSec: number;
}

interface ScreenDirection {
  x: number;
  y: number;
  behind: boolean;
}

export interface HudDeps {
  bus: Bus;
  host?: HTMLElement;
}

export class M5Hud {
  private readonly bus: Bus;
  private readonly root: HTMLDivElement;

  // ── 待刷队列：事件回调只入队，flush 统一消费 ──────────────────────────────
  private readonly pending = new Set<Section>();

  // ── 事件侧状态 ────────────────────────────────────────────────────────────
  private phase: MatchPhase = 'wake';
  private phaseStartSec = 0;
  private phaseStartWall = performance.now();
  private clockRunning = true;
  private clockSource: (() => number) | null = null;
  private currentForm: Attr = 'physical';

  private weakness: WeaknessState | null = null;
  private weaknessValue = 0;
  private weaknessMax = 100;
  private executable = false;

  private debuffs: DebuffState = { sunder: 0, scorch: 0, freeze: 0, freezeMax: 0 };
  private sunderAttr: Attr = 'physical';
  private scorchAttr: Attr = 'arcane';

  private motes = 0;
  private tacticalPoints = 0;

  private executions = 0;
  private damage: DamageState = { tower: 0, player: 0, execution: 0 };
  private ended: EndState | null = null;

  private screenDir: ScreenDirection | null = null;

  // ── 动画触发时刻 ──────────────────────────────────────────────────────────
  private formPopAt = -1;
  private phaseFlashAt = -1;
  private crosshairHitAt = -1;
  private motePopAt = -1;
  private notFacingSince = performance.now();

  // ── DOM ───────────────────────────────────────────────────────────────────
  private readonly clockEl: HTMLDivElement;
  private readonly phaseEl: HTMLDivElement;
  private readonly hpValueEl: HTMLSpanElement;
  private readonly hpTrackEl: HTMLDivElement;
  private readonly hpFillEl: HTMLDivElement;
  private readonly formIconEl: HTMLDivElement;
  private readonly formNameEl: HTMLDivElement;
  private readonly overheatWrapEl: HTMLDivElement;
  private readonly overheatFillEl: HTMLDivElement;

  private readonly bossPanelEl: HTMLDivElement;
  private readonly bossFillEl: HTMLDivElement;
  private readonly bossPhaseEl: HTMLSpanElement;
  private readonly bossBarsEl: HTMLDivElement;
  private readonly resistPhysicalEl: HTMLDivElement;
  private readonly resistArcaneEl: HTMLDivElement;
  private readonly debuffSunderEl: HTMLDivElement;
  private readonly debuffSunderNumEl: HTMLSpanElement;
  private readonly debuffScorchEl: HTMLDivElement;
  private readonly debuffScorchNumEl: HTMLSpanElement;
  private readonly debuffFreezeEl: HTMLDivElement;
  private readonly debuffFreezeNumEl: HTMLSpanElement;

  private readonly crosshairEl: HTMLDivElement;
  private readonly ringEl: HTMLDivElement;
  private readonly execEl: HTMLDivElement;

  private readonly arrowEl: HTMLDivElement;
  private readonly moteNumEl: HTMLSpanElement;
  private readonly tactEl: HTMLDivElement;
  private readonly tactNumEl: HTMLSpanElement;

  private readonly endEl: HTMLDivElement;
  private readonly endTitleEl: HTMLHeadingElement;
  private readonly endSubEl: HTMLParagraphElement;
  private readonly endGradeEl: HTMLDivElement;
  private readonly endReasonEl: HTMLParagraphElement;
  private readonly damageFills: Record<keyof DamageState, HTMLDivElement>;
  private readonly damagePcts: Record<keyof DamageState, HTMLSpanElement>;

  // ── 变化检测缓存 ──────────────────────────────────────────────────────────
  private readonly textCache = new Map<string, string>();
  private pollSig = '';
  private lastArrowAngle = Number.NEGATIVE_INFINITY;
  private lastArrowX = Number.NEGATIVE_INFINITY;
  private lastArrowY = Number.NEGATIVE_INFINITY;

  // ── 截图演示态（?hudDemo=hp1|weakness|transition|win|lose）────────────────
  private readonly demo: DemoKind | null;
  private demoTimerSec = 0;
  private demoWeakness: WeaknessState | null = null;
  private demoProgress = 0;
  private demoExecutable = false;
  private demoDebuffs: DebuffState = { sunder: 0, scorch: 0, freeze: 0, freezeMax: 0 };
  private demoDir: ScreenDirection | null = null;

  private readonly unsubs: Array<() => void> = [];

  constructor(deps: HudDeps) {
    this.bus = deps.bus;
    this.demo = readDemoKind();

    this.root = document.createElement('div');
    this.root.className = 'hud-root';
    applyTheme(this.root);

    // 1. 左下角：玩家
    const playerEl = document.createElement('div');
    playerEl.className = 'hud-player';

    const hpLineEl = document.createElement('div');
    hpLineEl.className = 'hud-hp-line';
    const hpLabelEl = document.createElement('span');
    hpLabelEl.textContent = 'HP';
    this.hpValueEl = document.createElement('span');
    this.hpValueEl.className = 'hud-hp-value';
    this.hpValueEl.textContent = '-- / --';
    hpLineEl.append(hpLabelEl, this.hpValueEl);

    this.hpTrackEl = document.createElement('div');
    this.hpTrackEl.className = 'hud-hp-track';
    this.hpFillEl = document.createElement('div');
    this.hpFillEl.className = 'hud-hp-fill';
    this.hpTrackEl.appendChild(this.hpFillEl);

    const formEl = document.createElement('div');
    formEl.className = 'hud-form';
    this.formIconEl = document.createElement('div');
    this.formIconEl.className = 'hud-form-icon';
    this.formIconEl.innerHTML = PHYSICAL_ICON;
    this.formNameEl = document.createElement('div');
    this.formNameEl.className = 'hud-form-name';
    this.formNameEl.textContent = FORM_LABEL.physical;
    formEl.append(this.formIconEl, this.formNameEl);

    this.overheatWrapEl = document.createElement('div');
    this.overheatWrapEl.className = 'hud-overheat';
    const overheatTrackEl = document.createElement('div');
    overheatTrackEl.className = 'hud-overheat-track';
    this.overheatFillEl = document.createElement('div');
    this.overheatFillEl.className = 'hud-overheat-fill';
    overheatTrackEl.appendChild(this.overheatFillEl);
    this.overheatWrapEl.appendChild(overheatTrackEl);

    playerEl.append(hpLineEl, this.hpTrackEl, formEl, this.overheatWrapEl);

    // 2. 顶部中央：倒计时
    const timerEl = document.createElement('div');
    timerEl.className = 'hud-timer';
    this.clockEl = document.createElement('div');
    this.clockEl.className = 'hud-clock';
    this.clockEl.textContent = '4:30';
    this.phaseEl = document.createElement('div');
    this.phaseEl.className = 'hud-phase';
    this.phaseEl.textContent = PHASE_LABEL.wake;
    timerEl.append(this.clockEl, this.phaseEl);

    // 3. 顶部：Boss 双段血条
    this.bossPanelEl = document.createElement('div');
    this.bossPanelEl.className = 'hud-boss';

    const bossHeadEl = document.createElement('div');
    bossHeadEl.className = 'hud-boss-head';
    const bossNameEl = document.createElement('span');
    bossNameEl.className = 'hud-boss-name';
    bossNameEl.textContent = 'IGNIS · 伊格纳斯';
    this.bossPhaseEl = document.createElement('span');
    this.bossPhaseEl.className = 'hud-boss-phase';
    this.bossPhaseEl.textContent = '阶段 I';
    bossHeadEl.append(bossNameEl, this.bossPhaseEl);

    const bossRowEl = document.createElement('div');
    bossRowEl.className = 'hud-boss-row';
    this.resistPhysicalEl = document.createElement('div');
    this.resistPhysicalEl.className = 'hud-resist physical';
    this.resistPhysicalEl.textContent = '物';
    this.resistPhysicalEl.title = '物理抗性';
    this.resistArcaneEl = document.createElement('div');
    this.resistArcaneEl.className = 'hud-resist arcane';
    this.resistArcaneEl.textContent = '法';
    this.resistArcaneEl.title = '法术抗性';

    this.bossBarsEl = document.createElement('div');
    this.bossBarsEl.className = 'hud-boss-bars';
    const currentBarEl = document.createElement('div');
    currentBarEl.className = 'hud-boss-bar';
    this.bossFillEl = document.createElement('div');
    this.bossFillEl.className = 'hud-boss-fill';
    currentBarEl.appendChild(this.bossFillEl);
    const nextBarEl = document.createElement('div');
    nextBarEl.className = 'hud-boss-bar';
    const nextFillEl = document.createElement('div');
    nextFillEl.className = 'hud-boss-next';
    nextBarEl.appendChild(nextFillEl);
    this.bossBarsEl.append(currentBarEl, nextBarEl);
    bossRowEl.append(this.resistPhysicalEl, this.bossBarsEl, this.resistArcaneEl);

    const debuffsEl = document.createElement('div');
    debuffsEl.className = 'hud-debuffs';
    this.debuffSunderEl = document.createElement('div');
    this.debuffSunderEl.className = 'hud-debuff sunder';
    const sunderDot = document.createElement('i');
    sunderDot.className = 'hud-dot';
    this.debuffSunderNumEl = document.createElement('span');
    this.debuffSunderNumEl.className = 'num';
    this.debuffSunderEl.append(
      sunderDot,
      document.createTextNode('碎甲 ×'),
      this.debuffSunderNumEl,
    );
    this.debuffScorchEl = document.createElement('div');
    this.debuffScorchEl.className = 'hud-debuff scorch';
    const scorchDot = document.createElement('i');
    scorchDot.className = 'hud-dot';
    this.debuffScorchNumEl = document.createElement('span');
    this.debuffScorchNumEl.className = 'num';
    this.debuffScorchEl.append(
      scorchDot,
      document.createTextNode('灼烙 ×'),
      this.debuffScorchNumEl,
    );
    this.debuffFreezeEl = document.createElement('div');
    this.debuffFreezeEl.className = 'hud-debuff freeze';
    const freezeDot = document.createElement('i');
    freezeDot.className = 'hud-dot';
    this.debuffFreezeNumEl = document.createElement('span');
    this.debuffFreezeNumEl.className = 'num';
    this.debuffFreezeEl.append(
      freezeDot,
      document.createTextNode('冻结 '),
      this.debuffFreezeNumEl,
    );
    debuffsEl.append(this.debuffSunderEl, this.debuffScorchEl, this.debuffFreezeEl);

    this.bossPanelEl.append(bossHeadEl, bossRowEl, debuffsEl);

    // 4. 屏幕中央：准星 + 破绽环
    const centerEl = document.createElement('div');
    centerEl.className = 'hud-center';
    this.ringEl = document.createElement('div');
    this.ringEl.className = 'hud-ring';
    this.crosshairEl = document.createElement('div');
    this.crosshairEl.className = 'hud-crosshair';
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const line = document.createElement('i');
      line.className = side;
      this.crosshairEl.appendChild(line);
    }
    this.execEl = document.createElement('div');
    this.execEl.className = 'hud-exec';
    this.execEl.textContent = '[F] 击破';
    centerEl.append(this.ringEl, this.crosshairEl, this.execEl);

    // 5. 屏幕边缘：弱点方向箭头
    this.arrowEl = document.createElement('div');
    this.arrowEl.className = 'hud-arrow';

    // 6. 右下角：熔核 + 战术点
    const resEl = document.createElement('div');
    resEl.className = 'hud-res';
    const motePillEl = document.createElement('div');
    motePillEl.className = 'hud-pill hud-mote';
    const flameEl = document.createElement('span');
    flameEl.innerHTML = FLAME_ICON;
    this.moteNumEl = document.createElement('span');
    this.moteNumEl.className = 'hud-mote-num';
    this.moteNumEl.textContent = '0';
    motePillEl.append(flameEl, this.moteNumEl);

    this.tactEl = document.createElement('div');
    this.tactEl.className = 'hud-pill hud-tact';
    const diamondEl = document.createElement('span');
    diamondEl.className = 'hud-diamond';
    this.tactNumEl = document.createElement('span');
    this.tactNumEl.className = 'hud-tact-num';
    this.tactNumEl.textContent = '0';
    this.tactEl.append(diamondEl, this.tactNumEl);
    resEl.append(motePillEl, this.tactEl);

    // 7. 结算页
    this.endEl = document.createElement('div');
    this.endEl.className = 'hud-end';
    const endPanelEl = document.createElement('div');
    endPanelEl.className = 'hud-end-panel';
    this.endTitleEl = document.createElement('h1');
    this.endTitleEl.className = 'hud-end-title';
    this.endSubEl = document.createElement('p');
    this.endSubEl.className = 'hud-end-sub';
    this.endGradeEl = document.createElement('div');
    this.endGradeEl.className = 'hud-end-grade';
    this.endReasonEl = document.createElement('p');
    this.endReasonEl.className = 'hud-end-reason';

    const damageEl = document.createElement('div');
    damageEl.className = 'hud-damage';
    this.damageFills = {
      tower: document.createElement('div'),
      player: document.createElement('div'),
      execution: document.createElement('div'),
    };
    this.damagePcts = {
      tower: document.createElement('span'),
      player: document.createElement('span'),
      execution: document.createElement('span'),
    };
    const rows: Array<[keyof DamageState, string]> = [
      ['tower', '塔'],
      ['player', '普攻'],
      ['execution', '击破'],
    ];
    for (const [key, label] of rows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'hud-damage-row';
      const nameEl = document.createElement('span');
      nameEl.textContent = label;
      const trackEl = document.createElement('div');
      trackEl.className = 'hud-damage-track';
      this.damageFills[key].className = `hud-damage-fill ${key}`;
      trackEl.appendChild(this.damageFills[key]);
      this.damagePcts[key].textContent = '0%';
      rowEl.append(nameEl, trackEl, this.damagePcts[key]);
      damageEl.appendChild(rowEl);
    }

    const restartEl = document.createElement('button');
    restartEl.className = 'hud-end-btn';
    restartEl.type = 'button';
    restartEl.textContent = '再来一局';
    restartEl.addEventListener('click', () => window.location.reload());

    endPanelEl.append(
      this.endTitleEl,
      this.endSubEl,
      this.endGradeEl,
      this.endReasonEl,
      damageEl,
      restartEl,
    );
    this.endEl.appendChild(endPanelEl);

    this.root.append(
      playerEl,
      timerEl,
      this.bossPanelEl,
      centerEl,
      this.arrowEl,
      resEl,
      this.endEl,
    );
    (deps.host ?? document.body).appendChild(this.root);

    if (this.demo) {
      document.body.classList.add('hud-demo');
      this.applyDemo();
    } else {
      this.bindEvents();
      this.phaseStartSec = this.bus.snapshot().tSec;
      this.phaseStartWall = performance.now();
      this.phase = this.bus.snapshot().phase;
      // 开局熔核由 flow.json 决定；后续只认 MoteCountChanged。
      this.motes = FLOW.motes.start;
    }
    this.markAll();
  }

  /** 由整合层每帧（app.onSync）调用：消费队列，每帧最多刷一次 DOM。 */
  flush(): void {
    const now = performance.now();

    if (this.demo) {
      this.renderDemo(now);
      this.pending.clear();
      return;
    }

    const snap = this.bus.snapshot();
    const sig = [
      snap.player.hp,
      snap.player.maxHp,
      snap.player.form,
      snap.player.overheat,
      snap.boss.hp,
      snap.boss.maxHp,
      snap.boss.phase,
    ].join('|');

    if (sig !== this.pollSig) {
      this.pollSig = sig;
      this.pending.add('player');
      this.pending.add('overheat');
      this.pending.add('boss');
      this.pending.add('resources');
    }

    for (const section of this.pending) this.renderSection(section, snap, now);
    this.pending.clear();

    // 时间驱动，不依赖事件：倒计时与边缘箭头每帧最多更新一次。
    this.renderTimer(now);
    this.renderArrow(now);
  }

  /** 整合层把弱点在屏幕空间的方向喂进来（HUD 自身不碰 3D）。 */
  setWeaknessDirection(dir: ScreenDirection | null): void {
    this.screenDir = dir;
  }

  /** 倒计时改读逻辑时钟（暂停时停表、?speed 时同步加速）；不设则退回墙钟外推。 */
  setClockSource(fn: (() => number) | null): void {
    this.clockSource = fn;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.root.remove();
    document.body.classList.remove('hud-demo');
  }

  // ── 事件绑定：只写状态 + 入队 ─────────────────────────────────────────────

  private bindEvents(): void {
    const on = <K extends EventName>(name: K, fn: (p: Events[K]) => void): void => {
      this.unsubs.push(this.bus.on(name, fn));
    };

    on('MatchPhaseChanged', (p) => {
      this.phase = p.phase;
      this.phaseStartSec = p.tSec;
      this.phaseStartWall = performance.now();
      this.clockRunning = p.phase !== 'ended';
      this.pending.add('timer');
      this.pending.add('boss');
    });

    on('MatchEnded', (p) => {
      this.ended = { result: p.result, reason: p.reason, tSec: p.tSec };
      this.clockRunning = false;
      this.pending.add('settlement');
    });

    on('WeaknessExposed', (p) => {
      this.weakness = { part: p.part, attr: p.attr };
      this.weaknessValue = 0;
      this.weaknessMax = 100;
      this.executable = false;
      this.notFacingSince = performance.now();
      this.pending.add('weakness');
    });

    on('WeaknessClosed', (p) => {
      if (this.weakness?.part !== p.part) return;
      this.weakness = null;
      this.weaknessValue = 0;
      this.executable = false;
      this.pending.add('weakness');
    });

    on('WeaknessProgress', (p) => {
      if (this.weakness?.part !== p.part) return;
      this.weaknessValue = p.value;
      this.weaknessMax = Math.max(1, p.max);
      this.executable = p.executable;
      this.pending.add('weakness');
    });

    on('DebuffStackChanged', (p) => {
      if (p.kind === 'sunder') {
        this.debuffs.sunder = p.stacks;
        this.sunderAttr = p.attr;
      } else {
        this.debuffs.scorch = p.stacks;
        this.scorchAttr = p.attr;
      }
      this.pending.add('debuffs');
    });

    on('FreezeProgressChanged', (p) => {
      this.debuffs.freeze = p.value;
      this.debuffs.freezeMax = Math.max(1, p.max);
      this.pending.add('debuffs');
    });

    on('MoteCountChanged', (p) => {
      if (p.motes !== this.motes) this.motePopAt = performance.now();
      this.motes = p.motes;
      this.pending.add('resources');
    });

    on('TacticalViewChanged', () => {
      this.pending.add('resources');
    });

    on('ExecutionEnded', (p) => {
      this.executions += 1;
      this.tacticalPoints = this.executions;
      this.damage.execution += Math.max(0, p.damage);
      this.pending.add('settlement');
      this.pending.add('resources');
    });

    on('TowerTargetHit', (p) => {
      this.damage.tower += Math.max(0, p.amount);
    });

    on('DamageDealt', (p) => {
      if (p.target !== 'boss') return;
      this.damage.player += Math.max(0, p.amount);
      if (
        p.part &&
        this.weakness &&
        p.part === this.weakness.part &&
        p.attr === this.weakness.attr
      ) {
        this.crosshairHitAt = performance.now();
        this.pending.add('weakness');
      }
    });

    on('FormSwitched', () => {
      this.formPopAt = performance.now();
      this.pending.add('player');
      this.pending.add('weakness');
      this.pending.add('arrow');
    });

    on('PlayerDamaged', () => this.pending.add('player'));
    on('PlayerDied', () => this.pending.add('player'));
    on('BossSpawned', () => this.pending.add('boss'));
    on('BossHpChanged', () => this.pending.add('boss'));
    on('BossPhaseChanged', () => {
      this.phaseFlashAt = performance.now();
      this.pending.add('boss');
    });
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  private renderSection(section: Section, snap: Snapshot, now: number): void {
    switch (section) {
      case 'player':
        this.renderPlayer(snap);
        break;
      case 'overheat':
        this.renderOverheat(snap);
        break;
      case 'timer':
        this.renderTimer(now);
        break;
      case 'boss':
        this.renderBoss(snap);
        break;
      case 'debuffs':
        this.renderDebuffs();
        break;
      case 'weakness':
        this.renderWeakness();
        break;
      case 'resources':
        this.renderResources();
        break;
      case 'settlement':
        this.renderSettlement();
        break;
      case 'arrow':
        this.renderArrow(now);
        break;
      default:
        break;
    }
  }

  private renderPlayer(snap: Snapshot): void {
    const { hp, maxHp, form } = snap.player;
    this.currentForm = form;
    // 血量内部是浮点（每次受击 -0.1），显示取整，别让 2.9 这种露出来
    this.setText('hp', this.hpValueEl, `${Math.max(0, Math.round(hp))} / ${Math.max(0, Math.round(maxHp))}`);

    const pct = maxHp > 0 ? Math.min(100, Math.max(0, (hp / maxHp) * 100)) : 0;
    this.setWidth('hp', this.hpFillEl, pct);

    const low = hp <= 1;
    if (this.hpTrackEl.classList.contains('low') !== low) {
      this.hpTrackEl.classList.toggle('low', low);
    }

    const color = ATTR_COLOR[form];
    if (this.formIconEl.style.color !== color) this.formIconEl.style.color = color;
    if (this.formIconEl.dataset.form !== form) {
      this.formIconEl.dataset.form = form;
      this.formIconEl.innerHTML = form === 'arcane' ? ARCANE_ICON : PHYSICAL_ICON;
    }
    this.setText('form', this.formNameEl, FORM_LABEL[form]);

    if (this.formPopAt > 0) {
      this.restartAnimation(this.formIconEl, 'pop');
      this.formPopAt = -1;
    }
  }

  private renderOverheat(snap: Snapshot): void {
    const arcane = snap.player.form === 'arcane';
    this.overheatWrapEl.classList.toggle('active', arcane);
    const ratio = Math.min(1, Math.max(0, snap.player.overheat));
    this.setWidth('overheat', this.overheatFillEl, ratio * 100);
    this.overheatFillEl.classList.toggle('full', ratio >= 1);
  }

  private renderTimer(now: number): void {
    if (this.ended) {
      this.setClock(this.ended.tSec, true);
      this.setText('phase', this.phaseEl, PHASE_LABEL.ended);
      return;
    }

    const elapsed = !this.clockRunning
      ? this.phaseStartSec
      : this.clockSource
        ? Math.max(this.phaseStartSec, this.clockSource())
        : this.phaseStartSec + (now - this.phaseStartWall) / 1000;
    this.setClock(elapsed, false);
    this.setText('phase', this.phaseEl, PHASE_LABEL[this.phase]);
  }

  private setClock(elapsedSec: number, frozen: boolean): void {
    const total = FLOW.matchLengthSec;
    // 开场（醒来 16s + 读教程 24s + 准备 10s）不占倒计时：
    // 玩家读完剧情抬头，钟应该还是 4:30，而不是剩 3:2x。
    const INTRO_SEC = 50;
    const combatElapsed = Math.max(0, elapsedSec - INTRO_SEC);
    const remain = Math.max(0, total - Math.min(combatElapsed, total));
    const seconds = frozen ? Math.max(0, Math.floor(remain)) : Math.ceil(remain);
    const text = formatClock(seconds);
    this.setText('clock', this.clockEl, text);

    this.clockEl.classList.toggle('warn', remain < 60 && remain >= 30);
    this.clockEl.classList.toggle('danger', remain < 30);
  }

  private renderBoss(snap: Snapshot): void {
    const phase = snap.boss.phase;
    // Boss 模块尚未发首个 BossHpChanged 时（快照 maxHp=0），按阶段与 boss.json 补全初始血条。
    const inFight =
      this.phase === 'boss1' ||
      this.phase === 'transition' ||
      this.phase === 'boss2' ||
      this.phase === 'rage';
    const cfg = BOSS.phases.find((p) => p.phase === phase) ?? BOSS.phases[0];
    const fallback = inFight && snap.boss.maxHp <= 0 ? cfg.hp : 0;
    const hp = snap.boss.maxHp > 0 ? snap.boss.hp : fallback;
    const maxHp = snap.boss.maxHp > 0 ? snap.boss.maxHp : fallback;

    const visible = maxHp > 0;
    if (this.bossPanelEl.style.visibility !== (visible ? 'visible' : 'hidden')) {
      this.bossPanelEl.style.visibility = visible ? 'visible' : 'hidden';
    }
    if (!visible) return;

    const pct = Math.min(100, Math.max(0, (hp / maxHp) * 100));
    this.setWidth('boss', this.bossFillEl, pct);
    this.setText('bossPhase', this.bossPhaseEl, phase === 2 ? '阶段 II' : '阶段 I');

    const resist = cfg.resist;
    const physical = resist.physical;
    const arcane = resist.arcane;
    this.resistPhysicalEl.classList.toggle('lit', physical >= 0.5);
    this.resistArcaneEl.classList.toggle('lit', arcane >= 0.5);
    this.resistPhysicalEl.title = `物理抗性 ${Math.round(physical * 100)}%`;
    this.resistArcaneEl.title = `法术抗性 ${Math.round(arcane * 100)}%`;

    if (this.phaseFlashAt > 0) {
      this.restartAnimation(this.bossBarsEl, 'flash');
      this.phaseFlashAt = -1;
    }
  }

  private renderDebuffs(): void {
    const d = this.debuffs;
    this.debuffSunderEl.style.color = ATTR_COLOR[this.sunderAttr];
    this.debuffScorchEl.style.color = ATTR_COLOR[this.scorchAttr];
    this.debuffSunderEl.classList.toggle('show', d.sunder > 0);
    this.setText('sunder', this.debuffSunderNumEl, String(d.sunder));
    this.debuffScorchEl.classList.toggle('show', d.scorch > 0);
    this.setText('scorch', this.debuffScorchNumEl, String(d.scorch));

    const freezePct = d.freezeMax > 0 ? Math.round((d.freeze / d.freezeMax) * 100) : 0;
    this.debuffFreezeEl.classList.toggle('show', freezePct > 0);
    this.setText('freeze', this.debuffFreezeNumEl, `${freezePct}%`);
  }

  private renderWeakness(): void {
    const weak = this.weakness;
    const show = weak !== null;
    this.ringEl.classList.toggle('show', show);
    if (!weak) {
      this.execEl.classList.remove('show');
      this.crosshairEl.classList.remove('matched');
      return;
    }

    const ratio = this.weaknessMax > 0 ? this.weaknessValue / this.weaknessMax : 0;
    const deg = Math.round(Math.min(1, Math.max(0, ratio)) * 360);
    this.ringEl.style.setProperty(
      '--hud-ring-color',
      this.executable ? PLATINUM : ATTR_COLOR[weak.attr],
    );
    this.ringEl.style.setProperty('--hud-ring-deg', `${deg}deg`);
    this.ringEl.classList.toggle('full', this.executable);

    const matched = this.currentForm === weak.attr;
    this.crosshairEl.classList.toggle('matched', matched);
    this.crosshairEl.style.setProperty('--hud-attr-current', ATTR_COLOR[weak.attr]);

    this.execEl.classList.toggle('show', this.executable);

    if (this.crosshairHitAt > 0) {
      this.restartAnimation(this.crosshairEl, 'hit');
      this.crosshairHitAt = -1;
    }
  }

  private renderResources(): void {
    this.setText('motes', this.moteNumEl, String(this.motes));
    if (this.motePopAt > 0) {
      this.restartAnimation(this.moteNumEl, 'pop');
      this.motePopAt = -1;
    }

    const showTact = this.tacticalPoints > 0;
    this.tactEl.classList.toggle('show', showTact);
    this.setText('tact', this.tactNumEl, String(this.tacticalPoints));
  }

  private renderSettlement(): void {
    const end = this.ended;
    if (!end) {
      this.endEl.classList.remove('show');
      return;
    }

    const win = end.result === 'win';
    this.endTitleEl.textContent = win ? '守护成功' : '塔心熄灭';
    this.endTitleEl.classList.toggle('lose', !win);
    this.endSubEl.textContent = `用时 ${formatClock(Math.floor(end.tSec))} · 击破 ${this.executions} 次`;

    const grade = this.gradeFor(end);
    this.endGradeEl.textContent = grade;
    this.endGradeEl.className = `hud-end-grade grade-${grade}`;
    this.endReasonEl.textContent = win ? '' : (REASON_LABEL[end.reason] ?? '力竭');

    const total = this.damage.tower + this.damage.player + this.damage.execution;
    const keys: Array<keyof DamageState> = ['tower', 'player', 'execution'];
    for (const key of keys) {
      const value = this.damage[key];
      const pct = total > 0 ? Math.round((value / total) * 100) : 0;
      this.damageFills[key].style.width = `${total > 0 ? (value / total) * 100 : 0}%`;
      this.damagePcts[key].textContent = `${pct}%`;
    }

    this.endEl.classList.add('show');
  }

  private renderArrow(now: number): void {
    const weak = this.weakness;
    const dir = this.screenDir;
    const show = weak !== null && dir !== null;
    this.arrowEl.classList.toggle('show', show);
    if (!weak || !dir) return;

    const nx = dir.behind ? -dir.x : dir.x;
    const ny = dir.behind ? -dir.y : dir.y;
    const length = Math.hypot(nx, ny);
    if (length < 1e-6) {
      this.arrowEl.style.visibility = 'hidden';
      return;
    }
    this.arrowEl.style.visibility = 'visible';

    const ux = nx / length;
    const uy = -ny / length; // 屏幕坐标 y 向下
    const margin = UI.theme.layout.edgeMargin;
    const halfW = Math.max(1, window.innerWidth / 2 - margin);
    const halfH = Math.max(1, window.innerHeight / 2 - margin);
    const scale = Math.min(
      halfW / Math.max(Math.abs(ux), 1e-6),
      halfH / Math.max(Math.abs(uy), 1e-6),
    );
    const x = window.innerWidth / 2 + ux * scale;
    const y = window.innerHeight / 2 + uy * scale;
    const angle = Math.atan2(ux, -uy);

    if (Math.abs(x - this.lastArrowX) > 0.5 || Math.abs(y - this.lastArrowY) > 0.5) {
      this.arrowEl.style.left = `${x}px`;
      this.arrowEl.style.top = `${y}px`;
      this.lastArrowX = x;
      this.lastArrowY = y;
    }
    if (Math.abs(angle - this.lastArrowAngle) > 0.002) {
      this.arrowEl.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
      this.lastArrowAngle = angle;
    }

    this.arrowEl.style.setProperty('--hud-arrow-color', ATTR_COLOR[weak.attr]);
    const matched = this.currentForm === weak.attr;
    this.arrowEl.classList.toggle('dim', !matched);

    const facing =
      !dir.behind && Math.abs(angle) <= (UI.weaknessIndicator.facingDeg * Math.PI) / 180;
    if (facing) {
      this.notFacingSince = now;
      return;
    }

    if (
      UI.weaknessIndicator.edgePulse &&
      now - this.notFacingSince >= UI.weaknessIndicator.remindSec * 1000
    ) {
      this.restartAnimation(this.arrowEl, 'pulse');
      this.notFacingSince = now;
    }
  }

  // ── 结算评级（票面规则）───────────────────────────────────────────────────

  private gradeFor(end: EndState): 'S' | 'A' | 'B' | 'C' {
    if (end.result === 'lose') return 'C';
    if (end.tSec < 210) return 'S';
    if (end.tSec < 240) return 'A';
    return 'B';
  }

  // ── 演示态（只用于验收截图，不影响正常游戏）──────────────────────────────

  private applyDemo(): void {
    this.ended = null;
    this.weakness = null;
    this.demoWeakness = null;
    this.demoProgress = 0;
    this.demoExecutable = false;
    this.demoDebuffs = { sunder: 0, scorch: 0, freeze: 0, freezeMax: 100 };
    this.demoDir = null;
    this.demoTimerSec = FLOW.matchLengthSec;
    this.executions = 0;
    this.tacticalPoints = 0;
    this.damage = { tower: 0, player: 0, execution: 0 };
    this.motes = 6;

    switch (this.demo) {
      case 'hp1':
        this.phase = 'wake';
        this.playerOverride = { hp: 1, maxHp: 100, form: 'physical', overheat: 0 };
        this.bossOverride = { hp: 0, maxHp: 0, phase: 1 };
        this.demoTimerSec = 270;
        break;
      case 'weakness':
        this.phase = 'boss1';
        this.playerOverride = { hp: 64, maxHp: 100, form: 'physical', overheat: 0.42 };
        this.bossOverride = { hp: 860, maxHp: 1400, phase: 1 };
        this.demoWeakness = { part: 'core', attr: 'physical' };
        this.demoProgress = 0.5;
        this.demoDebuffs = { sunder: 2, scorch: 1, freeze: 40, freezeMax: 100 };
        this.demoDir = { x: 0.55, y: 0.35, behind: false };
        this.demoTimerSec = 195;
        this.motes = 9;
        break;
      case 'transition':
        this.phase = 'transition';
        this.playerOverride = { hp: 48, maxHp: 100, form: 'physical', overheat: 0.2 };
        this.bossOverride = { hp: 1400, maxHp: 1400, phase: 2 };
        this.demoWeakness = { part: 'back', attr: 'arcane' };
        this.demoProgress = 0;
        this.demoDir = { x: -0.6, y: 0.2, behind: false };
        this.demoTimerSec = 140;
        this.motes = 11;
        break;
      case 'win':
        this.phase = 'ended';
        this.playerOverride = { hp: 37, maxHp: 100, form: 'physical', overheat: 0 };
        this.bossOverride = { hp: 0, maxHp: 1400, phase: 2 };
        this.demoTimerSec = 0;
        this.executions = 3;
        this.tacticalPoints = 3;
        this.damage = { tower: 1280, player: 1560, execution: 504 };
        this.ended = { result: 'win', reason: 'boss_defeated', tSec: 198 };
        this.motes = 14;
        break;
      case 'lose':
        this.phase = 'ended';
        this.playerOverride = { hp: 0, maxHp: 100, form: 'physical', overheat: 0 };
        this.bossOverride = { hp: 980, maxHp: 1400, phase: 2 };
        this.demoTimerSec = 0;
        this.executions = 1;
        this.tacticalPoints = 1;
        this.damage = { tower: 820, player: 690, execution: 168 };
        this.ended = { result: 'lose', reason: 'core_destroyed', tSec: 156 };
        this.motes = 7;
        break;
      default:
        break;
    }
  }

  private playerOverride: Partial<Snapshot['player']> | null = null;
  private bossOverride: Partial<Snapshot['boss']> | null = null;

  private renderDemo(now: number): void {
    const base = this.bus.snapshot();
    const snap: Snapshot = {
      ...base,
      player: { ...base.player, ...(this.playerOverride ?? {}) },
      boss: { ...base.boss, ...(this.bossOverride ?? {}) },
      motes: this.motes,
    };

    this.weakness = this.demoWeakness;
    this.weaknessValue = this.demoProgress * 100;
    this.weaknessMax = 100;
    this.executable = this.demoExecutable;
    this.debuffs = this.demoDebuffs;
    this.screenDir = this.demoDir;
    this.phase = this.ended ? 'ended' : this.phase;

    this.renderPlayer(snap);
    this.renderOverheat(snap);
    this.renderBoss(snap);
    this.renderDebuffs();
    this.renderWeakness();
    this.renderResources();
    this.renderSettlement();
    this.renderDemoClock();
    this.renderArrow(now);

    if (this.demo === 'transition' && !this.bossBarsEl.classList.contains('flash-demo')) {
      this.bossBarsEl.classList.add('flash-demo');
    }
  }

  private renderDemoClock(): void {
    const remain = this.demoTimerSec;
    this.setText('clock', this.clockEl, formatClock(Math.max(0, Math.ceil(remain))));
    this.clockEl.classList.toggle('warn', remain < 60 && remain >= 30);
    this.clockEl.classList.toggle('danger', remain < 30 && remain > 0);
    this.setText('phase', this.phaseEl, PHASE_LABEL[this.phase]);
  }

  // ── 小工具 ────────────────────────────────────────────────────────────────

  private markAll(): void {
    const all: Section[] = [
      'player',
      'overheat',
      'timer',
      'boss',
      'debuffs',
      'weakness',
      'resources',
      'settlement',
      'arrow',
    ];
    for (const key of all) this.pending.add(key);
  }

  private setText(key: string, el: HTMLElement, text: string): void {
    if (this.textCache.get(key) === text) return;
    this.textCache.set(key, text);
    el.textContent = text;
  }

  private setWidth(key: string, el: HTMLElement, pct: number): void {
    const value = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
    if (this.textCache.get(`w:${key}`) === value) return;
    this.textCache.set(`w:${key}`, value);
    el.style.width = value;
  }

  private restartAnimation(el: HTMLElement, cls: string): void {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
}

// ── 主题注入：config/ui.json + visual.json → CSS 变量 ────────────────────────

function applyTheme(root: HTMLElement): void {
  const { colors, font, durations, layout, opacity } = UI.theme;

  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(`--hud-c-${camelToKebab(key)}`, value);
  }
  root.style.setProperty('--hud-font-family', font.family);
  for (const [key, value] of Object.entries(font.sizes)) {
    root.style.setProperty(`--hud-fs-${camelToKebab(key)}`, `${value}px`);
  }
  for (const [key, value] of Object.entries(durations)) {
    root.style.setProperty(
      `--hud-dur-${camelToKebab(key.replace(/Ms$/, ''))}`,
      `${value}ms`,
    );
  }
  for (const [key, value] of Object.entries(layout)) {
    root.style.setProperty(`--hud-l-${camelToKebab(key)}`, `${value}px`);
  }
  for (const [key, value] of Object.entries(opacity)) {
    root.style.setProperty(`--hud-op-${camelToKebab(key)}`, String(value));
  }

  root.style.setProperty('--hud-attr-arcane', ATTR_COLOR.arcane);
  root.style.setProperty('--hud-attr-physical', ATTR_COLOR.physical);
}

function camelToKebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function readDemoKind(): DemoKind | null {
  const raw = new URLSearchParams(window.location.search).get('hudDemo');
  if (raw === 'hp1' || raw === 'weakness' || raw === 'transition' || raw === 'win' || raw === 'lose') {
    return raw;
  }
  return null;
}
