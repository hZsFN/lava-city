// src/ui/StoryPresenter.ts
// ============================================================================
// 剧情表现层 · 表世界（橙红熔岩·现世）↔ 里世界（冷青·记忆回廊）
// ----------------------------------------------------------------------------
// 实现 src/story/types.ts 的 StoryPresenter 契约（只读状态 → DOM 呈现）。
//
// 关键技术选择：**不碰 three.js 场景，不改 src/render/**。
// 里世界的画面变色全部靠 canvas 元素的 CSS filter 完成，因此：
//   · WebGPU 与 WebGL2 回退两条路同时生效（都是同一个 <canvas>）；
//   · 零侵入渲染管线（不新增 pass、不改 PostFX、不改材质）；
//   · dispose() 会把 canvas.style.filter 还原成构造时保存的原值。
//
// 层次（全部 position:fixed + pointer-events:none）：
//   z-index 11  里世界冷青暗角 + 结晶化静态渐变层
//   z-index 12  上下黑边 letterbox
//   z-index 13  字幕 / 进入里世界的冷白闪
//   （DebugOverlay 在 20，始终压在最上层）
//
// ----------------------------------------------------------------------------
// 时长来源说明
// ----------------------------------------------------------------------------
// 里世界的过渡与结晶化参数（enterFadeMs / exitFadeMs / crystalPerVisit /
// crystalMax）**由 opts.timing 注入**：整合层（src/main.ts）传 story.json 的
// StoryConfig.inner 段即可。省略 opts.timing 时回落到 DEFAULT_TIMING
// （与 story.json 默认 inner 段一致：480 / 620 / 0.16 / 0.72），
// 所以单独用 devPreview() 在控制台验证时不需要任何配置。
// 其余表现参数（打字机 28ms/字、淡入 200、淡出 300、黑边 8vh / 200ms、
// 冷白闪 120ms）属于表现层自身的固定节奏，不属于剧情配置，保留为本地常量。
//
// ----------------------------------------------------------------------------
// 手动验证（dev 模式，浏览器控制台；需要 `npm run dev` 起的页面）
// ----------------------------------------------------------------------------
// 因为本文件尚未被 main.ts 接线，这里导出了一个纯调试用的 devPreview()：
// 它会自己建一个假 state + rAF 循环，把 StoryPresenter 挂到 #app 和游戏 canvas 上。
//
//   const { devPreview } = await import('/src/ui/StoryPresenter.ts');
//   const p = devPreview();          // 自动找 #app 与 #app canvas
//
//   // ① 里世界一闪：canvas 冷青滤镜 + 120ms 冷白闪 + 上下黑边 + 结晶化 +1
//   p.inner();
//   // ② 再进两次，边缘越来越「玻璃化」（0.16 → 0.32 → 0.48 …上限 0.72）
//   p.inner(); p.inner();
//   // ③ 打字机：引路人橙字，每 28ms 露 1 字
//   p.cue('引路人', '火会记得每一个走进来的人。');
//   // ④ 旁白：无 speaker → 灰白斜体
//   p.cue(null, '塔心在黑暗里轻轻跳动。');
//   // ⑤ 伊格纳斯绿字 + 强制压黑边
//   p.cue('伊格纳斯', '别回头。', { letterbox: true });
//   // ⑥ 换行：\n 占 1 个打字机字符位，露到它就换行（逐行 textContent，不拼 innerHTML）
//   p.cue('引路人', '火会记得每一个\n走进来的人。');
//   // ⑦ 卸载：移除全部 DOM 并还原 canvas 滤镜
//   p.stop();
//
// 验证「还原」：p.stop() 后在控制台执行
//   document.querySelector('#app canvas').style.filter   // 应回到原值（通常是空串）
// ============================================================================

import type {
  StoryCue,
  StoryPresenter as StoryPresenterContract,
  StoryState,
  StoryWorld,
} from '../story/types';

/** 里世界滤镜本体（只作用于 canvas 元素，不碰渲染管线）。 */
const INNER_FILTER = 'saturate(0.3) contrast(1.28) hue-rotate(148deg) brightness(0.86)';
/** 打字机：每 28ms 露 1 字。 */
const TYPE_INTERVAL_MS = 28;
/** 打字机兜底：shownMs 超过 1200ms 直接全露。 */
const TYPE_FULL_MS = 1200;
/** 字幕淡入毫秒。 */
const SUB_FADE_IN_MS = 200;
/** 字幕淡出毫秒。 */
const SUB_FADE_OUT_MS = 300;
/** 黑边展开高度。 */
const LETTERBOX_HEIGHT = '8vh';
/** 黑边展开/收起过渡毫秒。 */
const LETTERBOX_TRANSITION_MS = 200;
/** 进入里世界时的冷白闪时长。 */
const FLASH_MS = 120;
/** 说话人配色（未登记的说话人用暖白兜底）。 */
const SPEAKER_COLORS: Record<string, string> = {
  引路人: '#ff8a4c',
  伊格纳斯: '#8ee6b0',
};
/** 旁白颜色。 */
const NARRATION_COLOR = '#d8d2c8';

/** 表现层时序参数（构造后固定）。 */
interface PresenterTiming {
  enterFadeMs: number;
  exitFadeMs: number;
  crystalPerVisit: number;
  crystalMax: number;
}

/** 与 story.json 默认 inner 段一致的兜底值（devPreview 单独使用时用）。 */
const DEFAULT_TIMING: PresenterTiming = {
  enterFadeMs: 480,
  exitFadeMs: 620,
  crystalPerVisit: 0.16,
  crystalMax: 0.72,
};

/** 构造选项。 */
export interface StoryPresenterOptions {
  /** 游戏主 canvas。省略时优雅降级：只做叠加层，不改任何滤镜。 */
  canvas?: HTMLCanvasElement;
  /** 里世界过渡与结晶化参数（来自 story.json 的 inner 段）。 */
  timing?: {
    enterFadeMs: number;
    exitFadeMs: number;
    crystalPerVisit: number;
    crystalMax: number;
  };
}

/** 新建一个已设好 cssText 的 div。 */
function div(cssText: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = cssText;
  return el;
}

/**
 * 剧情表现层：字幕 + 里世界视觉。
 *
 * 每帧由整合层调用 present(state, dtSec)；state 只读，本类不保存剧情逻辑，
 * 只把「当前 cue / 世界层 / 已显示毫秒」翻译成 DOM 样式。
 */
export class StoryPresenter implements StoryPresenterContract {
  private readonly timing: PresenterTiming;

  private readonly root: HTMLDivElement;
  private readonly tintEl: HTMLDivElement;
  private readonly crystalEdge: HTMLDivElement;
  private readonly crystalCorners: HTMLDivElement;
  private readonly crystalSheen: HTMLDivElement;
  private readonly crystalFrame: HTMLDivElement;
  private readonly letterboxTop: HTMLDivElement;
  private readonly letterboxBottom: HTMLDivElement;
  private readonly subtitleEl: HTMLDivElement;
  private readonly speakerEl: HTMLDivElement;
  private readonly textEl: HTMLDivElement;
  /** 正文按 \n 拆出来的行容器（逐行 textContent 填充，绝不用 innerHTML）。 */
  private readonly lineEls: HTMLDivElement[] = [];
  private readonly flashEl: HTMLDivElement;

  private readonly canvas: HTMLCanvasElement | null;
  /** 构造时 canvas 的 filter 原值（dispose 必须还原）。 */
  private readonly canvasFilterOriginal: string;
  /** 构造时 canvas 的 transition 原值（dispose 必须还原）。 */
  private readonly canvasTransitionOriginal: string;

  private readonly motionQuery: MediaQueryList | null;
  private reducedMotion: boolean;
  private disposed = false;

  private lastWorld: StoryWorld = 'surface';
  private lastCueId: string | null = null;
  private lastText = '';
  private pendingClear = false;
  private clearTimerMs = 0;
  private lastIntensity = -1;
  private lastLetterbox: boolean | null = null;

  constructor(host: HTMLElement, opts: StoryPresenterOptions = {}) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.canvas = opts.canvas ?? null;
    this.canvasFilterOriginal = this.canvas ? this.canvas.style.filter : '';
    this.canvasTransitionOriginal = this.canvas ? this.canvas.style.transition : '';

    // 减少动态效果：关掉打字机与冷白闪（直接全显）。
    this.motionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    this.reducedMotion = this.motionQuery?.matches ?? false;
    this.motionQuery?.addEventListener('change', this.handleMotionChange);

    const layer = 'position:fixed;pointer-events:none;user-select:none;';

    this.root = div('position:fixed;inset:0;pointer-events:none;');

    // ① 里世界冷青暗角 + 极轻 blur。opacity 由 world 驱动，过渡时长 = enterFadeMs。
    this.tintEl = div(
      layer +
        'inset:0;z-index:11;opacity:0;transition:opacity ' +
        this.timing.enterFadeMs +
        'ms ease;' +
        'background:radial-gradient(ellipse at 50% 46%,rgba(120,208,232,0) 32%,' +
        'rgba(96,186,214,0.18) 68%,rgba(34,104,138,0.44) 100%);' +
        'backdrop-filter:blur(1px);-webkit-backdrop-filter:blur(1px);',
    );

    // ② 结晶化：3~4 个静态渐变层，只改 opacity，绝不每帧重绘 canvas。
    this.crystalEdge = div(
      layer +
        'inset:0;z-index:11;opacity:0;transition:opacity 520ms ease;' +
        'background:radial-gradient(ellipse at 50% 50%,rgba(150,220,245,0) 46%,' +
        'rgba(168,232,252,0.22) 74%,rgba(214,246,255,0.52) 100%);',
    );
    this.crystalCorners = div(
      layer +
        'inset:0;z-index:11;opacity:0;transition:opacity 520ms ease;' +
        'background:' +
        'radial-gradient(circle at 0% 0%,rgba(206,246,255,0.44),rgba(206,246,255,0) 30%),' +
        'radial-gradient(circle at 100% 0%,rgba(206,246,255,0.40),rgba(206,246,255,0) 28%),' +
        'radial-gradient(circle at 0% 100%,rgba(206,246,255,0.36),rgba(206,246,255,0) 26%),' +
        'radial-gradient(circle at 100% 100%,rgba(206,246,255,0.44),rgba(206,246,255,0) 30%);',
    );
    this.crystalSheen = div(
      layer +
        'inset:0;z-index:11;opacity:0;transition:opacity 520ms ease;' +
        'background:linear-gradient(116deg,rgba(214,248,255,0) 40%,rgba(214,248,255,0.13) 46%,' +
        'rgba(214,248,255,0) 52%,rgba(214,248,255,0) 60%,rgba(214,248,255,0.09) 66%,' +
        'rgba(214,248,255,0) 72%);',
    );
    // 边缘「玻璃化」：细碎亮边 + inset 阴影，强度随 intensity 增长。
    this.crystalFrame = div(
      layer +
        'inset:0;z-index:11;opacity:0;transition:opacity 520ms ease;' +
        'border:1px solid rgba(206,246,255,0.14);' +
        'box-shadow:inset 0 0 0 rgba(0,0,0,0);' +
        'background:repeating-linear-gradient(90deg,rgba(226,250,255,0.20) 0 1px,' +
        'rgba(0,0,0,0) 1px 9px);' +
        '-webkit-mask-image:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 40%,#000 78%);' +
        'mask-image:radial-gradient(ellipse at 50% 50%,rgba(0,0,0,0) 40%,#000 78%);',
    );

    // ③ 黑边 letterbox。
    this.letterboxTop = div(
      'position:fixed;left:0;right:0;top:0;height:0;z-index:12;background:#000;' +
        'pointer-events:none;transition:height ' +
        LETTERBOX_TRANSITION_MS +
        'ms ease;',
    );
    this.letterboxBottom = div(
      'position:fixed;left:0;right:0;bottom:0;height:0;z-index:12;background:#000;' +
        'pointer-events:none;transition:height ' +
        LETTERBOX_TRANSITION_MS +
        'ms ease;',
    );

    // ④ 字幕：屏幕下方居中、黑边上方。
    this.subtitleEl = div(
      'position:fixed;left:50%;transform:translateX(-50%);bottom:4.6vh;z-index:13;' +
        'width:min(720px,calc(100vw - 96px));max-width:720px;text-align:center;' +
        'pointer-events:none;opacity:0;' +
        'transition:opacity ' +
        SUB_FADE_IN_MS +
        'ms ease,bottom ' +
        LETTERBOX_TRANSITION_MS +
        'ms ease;',
    );
    this.speakerEl = div(
      'font:600 12px/1.6 ui-sans-serif,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'letter-spacing:0.2em;margin-bottom:8px;display:none;color:' +
        NARRATION_COLOR +
        ';' +
        'text-shadow:0 1px 8px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.85);',
    );
    // 正文是「行容器」：每行一个 div，\n 在打字机里占 1 个字符位，到点就换行。
    this.textEl = div(
      'font:400 19px/1.9 ui-serif,"Songti SC","Noto Serif SC",Georgia,serif;' +
        'letter-spacing:0.03em;color:' +
        NARRATION_COLOR +
        ';font-style:italic;' +
        'text-shadow:0 2px 12px rgba(0,0,0,0.95),0 0 3px rgba(0,0,0,0.9),0 1px 1px rgba(0,0,0,0.9);',
    );
    this.subtitleEl.append(this.speakerEl, this.textEl);

    // ⑤ 进入里世界时的一次冷白闪（opacity 动画，120ms）。
    this.flashEl = div(
      layer +
        'inset:0;z-index:13;opacity:0;' +
        'background:radial-gradient(circle at 50% 50%,rgba(232,250,255,0.92),' +
        'rgba(186,230,255,0.44) 58%,rgba(150,208,240,0) 100%);',
    );

    this.root.append(
      this.tintEl,
      this.crystalEdge,
      this.crystalCorners,
      this.crystalSheen,
      this.crystalFrame,
      this.letterboxTop,
      this.letterboxBottom,
      this.subtitleEl,
      this.flashEl,
    );
    host.appendChild(this.root);
  }

  /** 每帧调用。state 只读；dtSec 只用于字幕淡出后的清空计时。 */
  present(state: StoryState, dtSec: number): void {
    if (this.disposed) return;
    this.syncWorld(state);
    this.syncCrystal(state.innerVisits);
    this.syncLetterbox(state);
    this.syncSubtitle(state, dtSec);
  }

  /** 移除全部 DOM 并还原 canvas 的 filter / transition。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.motionQuery?.removeEventListener('change', this.handleMotionChange);
    if (this.canvas) {
      this.canvas.style.filter = this.canvasFilterOriginal;
      this.canvas.style.transition = this.canvasTransitionOriginal;
    }
    this.root.remove();
  }

  private readonly handleMotionChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    if (this.reducedMotion) {
      // 立刻收掉闪白；打字机在下一帧直接全显。
      this.flashEl.style.opacity = '0';
      this.lastText = '';
    }
  };

  /** 世界层切换：canvas 滤镜 + 冷青叠加层 + 进入时闪白。只在变化时写样式。 */
  private syncWorld(state: StoryState): void {
    const world = state.world;
    if (world === this.lastWorld) return;

    const entering = world === 'inner';
    this.lastWorld = world;

    if (this.canvas) {
      this.canvas.style.transition =
        `filter ${entering ? this.timing.enterFadeMs : this.timing.exitFadeMs}ms ease`;
      this.canvas.style.filter = entering ? INNER_FILTER : this.canvasFilterOriginal;
    }
    this.tintEl.style.transition =
      `opacity ${entering ? this.timing.enterFadeMs : this.timing.exitFadeMs}ms ease`;
    this.tintEl.style.opacity = entering ? '1' : '0';
    if (entering) this.flash();
  }

  /** 结晶化：intensity = min(innerVisits * crystalPerVisit, crystalMax)，只改静态层 opacity。 */
  private syncCrystal(innerVisits: number): void {
    const intensity = Math.min(
      innerVisits * this.timing.crystalPerVisit,
      this.timing.crystalMax,
    );
    if (Math.abs(intensity - this.lastIntensity) < 0.004) return;
    this.lastIntensity = intensity;

    const t = intensity;
    this.crystalEdge.style.opacity = (t * 0.9).toFixed(3);
    this.crystalCorners.style.opacity = (t * 0.8).toFixed(3);
    this.crystalSheen.style.opacity = (t * 0.7).toFixed(3);
    this.crystalFrame.style.opacity = t.toFixed(3);
    this.crystalFrame.style.borderColor = `rgba(206,246,255,${(0.10 + 0.34 * t).toFixed(3)})`;
    this.crystalFrame.style.boxShadow =
      `inset 0 0 ${Math.round(24 + 96 * t)}px rgba(178,236,255,${(0.10 + 0.26 * t).toFixed(3)})`;
  }

  /** 黑边：cue.letterbox === true 或 world === 'inner' 时展开到 8vh。 */
  private syncLetterbox(state: StoryState): void {
    const open = state.cue?.letterbox === true || state.world === 'inner';
    if (open === this.lastLetterbox) return;
    this.lastLetterbox = open;

    const height = open ? LETTERBOX_HEIGHT : '0px';
    this.letterboxTop.style.height = height;
    this.letterboxBottom.style.height = height;
    this.subtitleEl.style.bottom = open ? 'calc(8vh + 34px)' : '4.6vh';
  }

  /** 字幕：cue 变化 → 换文本；同一 cue 内按 shownMs 做打字机；cue 为 null 淡出并清空。 */
  private syncSubtitle(state: StoryState, dtSec: number): void {
    const cue = state.cue;

    if (cue) {
      this.pendingClear = false;
      this.clearTimerMs = 0;

      if (cue.id !== this.lastCueId) {
        this.lastCueId = cue.id;
        this.lastText = '';
        this.applySpeaker(cue.speaker ?? null);
        // 注意：不能用 textEl.textContent='' —— 那会把缓存的 lineEls 摘出 DOM。
        this.renderText('');
        this.fadeSubtitle(true);
      }

      const chars = Array.from(cue.text);
      const revealed =
        this.reducedMotion || state.shownMs >= TYPE_FULL_MS
          ? chars.length
          : Math.min(chars.length, Math.max(0, Math.floor(state.shownMs / TYPE_INTERVAL_MS)));
      // \n 也是 Array.from 里的 1 个字符位，露到它就换行。
      const slice = chars.slice(0, revealed).join('');
      if (slice !== this.lastText) {
        this.lastText = slice;
        this.renderText(slice);
      }
      return;
    }

    // cue === null：先淡出，再清空（300ms 后）。
    if (this.lastCueId !== null) {
      this.lastCueId = null;
      this.fadeSubtitle(false);
      this.pendingClear = true;
      this.clearTimerMs = SUB_FADE_OUT_MS;
    }
    if (this.pendingClear) {
      this.clearTimerMs -= dtSec * 1000;
      if (this.clearTimerMs <= 0) {
        this.pendingClear = false;
        this.lastText = '';
        this.renderText('');
        this.speakerEl.textContent = '';
        this.speakerEl.style.display = 'none';
      }
    }
  }

  /**
   * 把已露出的文本按 \n 拆行渲染。
   * 只用 textContent 逐段填充（不拼 innerHTML），因此文本里的 < & 不会破坏 DOM。
   */
  private renderText(text: string): void {
    const lines = text.split('\n');
    while (this.lineEls.length < lines.length) {
      const lineEl = div('display:block;');
      this.lineEls.push(lineEl);
      this.textEl.appendChild(lineEl);
    }
    for (let i = 0; i < this.lineEls.length; i += 1) {
      const lineEl = this.lineEls[i];
      const value = i < lines.length ? lines[i] : '';
      if (lineEl.textContent !== value) lineEl.textContent = value;
      lineEl.style.display = i < lines.length ? 'block' : 'none';
    }
  }

  /** 说话人一行 + 正文配色。无 speaker = 旁白：灰白斜体。 */
  private applySpeaker(speaker: string | null): void {
    if (speaker === null || speaker === '') {
      this.speakerEl.style.display = 'none';
      this.textEl.style.color = NARRATION_COLOR;
      this.textEl.style.fontStyle = 'italic';
      return;
    }

    const color = SPEAKER_COLORS[speaker] ?? '#e6dccb';
    this.speakerEl.textContent = speaker;
    this.speakerEl.style.display = 'block';
    this.speakerEl.style.color = color;
    this.textEl.style.color = color;
    this.textEl.style.fontStyle = 'normal';
  }

  private fadeSubtitle(visible: boolean): void {
    this.subtitleEl.style.transition =
      `opacity ${visible ? SUB_FADE_IN_MS : SUB_FADE_OUT_MS}ms ease,` +
      `bottom ${LETTERBOX_TRANSITION_MS}ms ease`;
    this.subtitleEl.style.opacity = visible ? '1' : '0';
  }

  /** 120ms 冷白闪：先瞬时推到高透明度，再用 CSS transition 回到 0。 */
  private flash(): void {
    if (this.reducedMotion) return;
    const el = this.flashEl;
    el.style.transition = 'none';
    el.style.opacity = '0.62';
    // 强制一次回流，让下面的 transition 从 0.62 起步，否则会被合并掉。
    void el.offsetWidth;
    el.style.transition = `opacity ${FLASH_MS}ms ease-out`;
    el.style.opacity = '0';
  }
}

// ============================================================================
// dev 专用：控制台手动验证手柄（不参与正式接线，不影响游戏逻辑）
// 用法见文件头注释；生产构建不会自动调用它。
// ============================================================================

/** devPreview() 返回的手柄。 */
export interface StoryPreviewHandle {
  /** 进里世界（冷白闪 + 冷青滤镜 + 结晶化 +visits），3.2s 后自动回落表世界。 */
  inner(visits?: number): void;
  /** 播一条字幕；speaker 传 null 即旁白。 */
  cue(
    speaker: string | null,
    text: string,
    options?: { world?: StoryWorld; letterbox?: boolean; durationMs?: number },
  ): void;
  /** 清空字幕（走淡出）。 */
  clear(): void;
  /** 停止 rAF、卸载 DOM 并还原 canvas 滤镜。 */
  stop(): void;
}

interface DevStoryState {
  cue: StoryCue | null;
  shownMs: number;
  world: StoryWorld;
  innerMsLeft: number;
  innerVisits: number;
  played: string[];
  runIndex: number;
}

/**
 * 在浏览器控制台里跑一段假剧情，用来肉眼验收表现层。
 * 不依赖 StoryDirector（那个是纯逻辑层），只喂 StoryState。
 */
export function devPreview(options: StoryPresenterOptions = {}): StoryPreviewHandle {
  const host = document.getElementById('app') ?? document.body;
  const canvas = options.canvas ?? document.querySelector<HTMLCanvasElement>('#app canvas') ?? undefined;
  const presenter = new StoryPresenter(host, canvas ? { ...options, canvas } : options);

  const state: DevStoryState = {
    cue: null,
    shownMs: 0,
    world: 'surface',
    innerMsLeft: 0,
    innerVisits: 0,
    played: [],
    runIndex: 0,
  };

  let seq = 0;
  let last = 0;
  let raf = 0;
  let running = true;

  const frame = (time: number): void => {
    if (!running) return;
    const dt = last === 0 ? 0 : Math.min((time - last) / 1000, 0.1);
    last = time;

    if (state.cue) {
      state.shownMs += dt * 1000;
      if (state.shownMs >= state.cue.durationMs) {
        state.cue = null;
        state.shownMs = 0;
      }
    }
    if (state.world === 'inner') {
      state.innerMsLeft = Math.max(0, state.innerMsLeft - dt * 1000);
      if (state.innerMsLeft === 0) state.world = 'surface';
    }

    presenter.present(state, dt);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    inner(visits = 1): void {
      state.world = 'inner';
      state.innerMsLeft = 3200;
      state.innerVisits += visits;
    },
    cue(speaker, text, cueOptions = {}): void {
      seq += 1;
      const durationMs = cueOptions.durationMs ?? 4200;
      const world = cueOptions.world ?? 'surface';
      state.cue = {
        id: `dev-${seq}`,
        trigger: { kind: 'event', event: 'WeaknessExposed' },
        priority: 10,
        durationMs,
        world,
        speaker: speaker ?? undefined,
        text,
        letterbox: cueOptions.letterbox,
        holdInnerMs: 0,
      };
      state.shownMs = 0;
      state.world = world;
      if (world === 'inner') {
        state.innerMsLeft = durationMs;
        state.innerVisits += 1;
      }
    },
    clear(): void {
      state.cue = null;
      state.shownMs = 0;
    },
    stop(): void {
      running = false;
      cancelAnimationFrame(raf);
      presenter.dispose();
    },
  };
}
