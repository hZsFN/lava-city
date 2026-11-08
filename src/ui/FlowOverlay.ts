// src/ui/FlowOverlay.ts
// ============================================================================
// M4-01 演出层（纯 DOM，不引框架）
// ----------------------------------------------------------------------------
// 负责：黑屏 / 苏醒模糊 / 旁白与 Boss 对话框 / 教程书提示与纸页 / 失败黑屏 /
//       传送白光。全部是覆盖层，不阻塞游戏逻辑，也不接管输入。
// ============================================================================

export interface NarrationView {
  text: string;
  /** 'boss' 走屏幕下方对话框；其他走画面中央白字 */
  speaker: string | null;
  speakerName: string;
  opacity: number;
}

export interface TutorialPageView {
  text: string;
  index: number;
  total: number;
  hint: string;
  opacity: number;
}

const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

export class FlowOverlay {
  private readonly black: HTMLDivElement;
  private readonly blur: HTMLDivElement;
  private readonly white: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private readonly dialogName: HTMLDivElement;
  private readonly dialogText: HTMLDivElement;
  private readonly prompt: HTMLDivElement;
  private readonly pages: HTMLDivElement;
  private readonly pageText: HTMLDivElement;
  private readonly pageMeta: HTMLDivElement;
  private readonly fail: HTMLDivElement;
  private readonly failText: HTMLDivElement;

  private lastBlack = Number.NaN;
  private lastBlur = Number.NaN;
  private lastWhite = Number.NaN;
  private lastVignette = Number.NaN;
  private lastCenter = '';
  private lastCenterOpacity = Number.NaN;
  private lastDialogKey = '';
  private lastDialogOpacity = Number.NaN;
  private lastPrompt = '';
  private lastPageKey = '';
  private lastPageOpacity = Number.NaN;
  private lastFailBlack = Number.NaN;
  private lastFailTextOpacity = Number.NaN;
  private lastFailText = '';

  constructor() {
    const root = document.createElement('div');
    root.id = 'flow-overlay';
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:40',
      'pointer-events:none',
      'user-select:none',
      `font-family:${FONT}`,
      'overflow:hidden',
    ].join(';');

    this.black = layer('background:#000');
    this.blur = layer('background:rgba(0,0,0,0.28);backdrop-filter:blur(0px);-webkit-backdrop-filter:blur(0px)');
    this.vignette = layer('background:radial-gradient(circle at 50% 55%, rgba(0,0,0,0) 38%, rgba(60,6,0,0.82) 100%)');
    this.white = layer('background:#fff');

    this.center = document.createElement('div');
    this.center.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:42%',
      'transform:translate(-50%,-50%)',
      'max-width:76vw',
      'text-align:center',
      'color:#f3eee6',
      'font-size:23px',
      'letter-spacing:0.22em',
      'line-height:1.9',
      'text-shadow:0 0 18px rgba(0,0,0,0.9), 0 2px 6px rgba(0,0,0,0.8)',
      'opacity:0',
      'transition:opacity 120ms linear',
      'white-space:pre-wrap',
    ].join(';');

    this.dialog = document.createElement('div');
    this.dialog.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:9%',
      'transform:translateX(-50%)',
      'min-width:min(560px, 62vw)',
      'max-width:76vw',
      'padding:14px 26px 16px',
      'border-left:2px solid #7d1f12',
      'background:linear-gradient(90deg, rgba(8,4,5,0.88), rgba(8,4,5,0.62) 70%, rgba(8,4,5,0.2))',
      'opacity:0',
    ].join(';');

    this.dialogName = document.createElement('div');
    this.dialogName.style.cssText =
      'color:#8e2a19;font-size:12px;letter-spacing:0.34em;margin-bottom:6px';

    this.dialogText = document.createElement('div');
    this.dialogText.style.cssText =
      'color:#f4efe6;font-size:21px;line-height:1.8;letter-spacing:0.12em;white-space:pre-wrap';

    this.dialog.append(this.dialogName, this.dialogText);

    this.prompt = document.createElement('div');
    this.prompt.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:26%',
      'transform:translateX(-50%)',
      'padding:7px 18px',
      'border:1px solid rgba(232,214,184,0.5)',
      'border-radius:2px',
      'background:rgba(8,5,5,0.55)',
      'color:#f0e4cd',
      'font-size:14px',
      'letter-spacing:0.22em',
      'opacity:0',
      'transition:opacity 180ms ease',
    ].join(';');

    this.pages = document.createElement('div');
    this.pages.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'transform:translate(-50%,-50%)',
      'width:min(640px, 72vw)',
      'min-height:180px',
      'padding:30px 42px 24px',
      'background:linear-gradient(160deg, rgba(238,226,200,0.16), rgba(196,168,128,0.1))',
      'border:1px solid rgba(240,224,194,0.34)',
      'box-shadow:0 18px 60px rgba(0,0,0,0.55), inset 0 0 60px rgba(255,205,140,0.05)',
      'opacity:0',
      'transition:opacity 180ms ease',
    ].join(';');

    this.pageText = document.createElement('div');
    this.pageText.style.cssText =
      'color:#f4ecdc;font-size:19px;line-height:2;letter-spacing:0.08em;white-space:pre-wrap';

    this.pageMeta = document.createElement('div');
    this.pageMeta.style.cssText =
      'margin-top:18px;color:rgba(240,224,194,0.55);font-size:11px;letter-spacing:0.26em;text-align:right';

    this.pages.append(this.pageText, this.pageMeta);

    this.fail = layer('background:#000');
    this.fail.style.display = 'none';

    this.failText = document.createElement('div');
    this.failText.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      'transform:translate(-50%,-50%)',
      'color:#e9e3d8',
      'font-size:22px',
      'letter-spacing:0.3em',
      'opacity:0',
      'white-space:nowrap',
    ].join(';');

    root.append(
      this.black,
      this.blur,
      this.vignette,
      this.center,
      this.dialog,
      this.prompt,
      this.pages,
      this.fail,
      this.failText,
      this.white,
    );
    document.body.appendChild(root);
  }

  setBlack(alpha: number): void {
    if (alpha === this.lastBlack) return;
    this.lastBlack = alpha;
    this.black.style.opacity = String(clamp01(alpha));
    this.black.style.display = alpha > 0.001 ? 'block' : 'none';
  }

  setBlur(px: number, tint = 0.28): void {
    if (px === this.lastBlur) return;
    this.lastBlur = px;
    if (px <= 0.01) {
      this.blur.style.display = 'none';
      return;
    }
    this.blur.style.display = 'block';
    this.blur.style.background = `rgba(0,0,0,${clamp01(tint)})`;
    const value = `blur(${px.toFixed(2)}px)`;
    this.blur.style.backdropFilter = value;
    this.blur.style.setProperty('-webkit-backdrop-filter', value);
  }

  setWhite(alpha: number): void {
    if (alpha === this.lastWhite) return;
    this.lastWhite = alpha;
    this.white.style.opacity = String(clamp01(alpha));
    this.white.style.display = alpha > 0.001 ? 'block' : 'none';
  }

  setVignette(alpha: number): void {
    if (alpha === this.lastVignette) return;
    this.lastVignette = alpha;
    this.vignette.style.opacity = String(clamp01(alpha));
    this.vignette.style.display = alpha > 0.001 ? 'block' : 'none';
  }

  setNarration(view: NarrationView | null): void {
    const opacity = view ? clamp01(view.opacity) : 0;
    const isBoss = view?.speaker === 'boss';
    if (isBoss) {
      const key = `${view?.speakerName ?? ''}|${view?.text ?? ''}`;
      if (key !== this.lastDialogKey) {
        this.lastDialogKey = key;
        this.dialogName.textContent = view?.speakerName ?? '';
        this.dialogText.textContent = view?.text ?? '';
      }
      if (opacity !== this.lastDialogOpacity) {
        this.lastDialogOpacity = opacity;
        this.dialog.style.opacity = String(opacity);
      }
      if (this.lastCenterOpacity !== 0) {
        this.lastCenterOpacity = 0;
        this.center.style.opacity = '0';
      }
      return;
    }

    const text = view?.text ?? '';
    if (text !== this.lastCenter) {
      this.lastCenter = text;
      this.center.textContent = text;
    }
    if (opacity !== this.lastCenterOpacity) {
      this.lastCenterOpacity = opacity;
      this.center.style.opacity = String(opacity);
    }
    if (this.lastDialogOpacity !== 0) {
      this.lastDialogOpacity = 0;
      this.dialog.style.opacity = '0';
    }
  }

  setPrompt(text: string | null): void {
    const next = text ?? '';
    if (next === this.lastPrompt) return;
    this.lastPrompt = next;
    this.prompt.textContent = next;
    this.prompt.style.opacity = next ? '1' : '0';
  }

  setPages(view: TutorialPageView | null): void {
    const opacity = view ? clamp01(view.opacity) : 0;
    if (view) {
      const key = `${view.index}|${view.text}`;
      if (key !== this.lastPageKey) {
        this.lastPageKey = key;
        this.pageText.textContent = view.text;
        this.pageMeta.textContent = `${view.index + 1} / ${view.total}    ${view.hint}`;
      }
    }
    if (opacity !== this.lastPageOpacity) {
      this.lastPageOpacity = opacity;
      this.pages.style.opacity = String(opacity);
      this.pages.style.display = opacity > 0.001 ? 'block' : 'none';
    }
  }

  setFail(black: number, textOpacity: number, text: string): void {
    if (black !== this.lastFailBlack) {
      this.lastFailBlack = black;
      this.fail.style.display = black > 0.001 ? 'block' : 'none';
      this.fail.style.opacity = String(clamp01(black));
    }
    if (text !== this.lastFailText) {
      this.lastFailText = text;
      this.failText.textContent = text;
    }
    if (textOpacity !== this.lastFailTextOpacity) {
      this.lastFailTextOpacity = textOpacity;
      this.failText.style.opacity = String(clamp01(textOpacity));
    }
  }

  get root(): HTMLElement {
    return this.black.parentElement as HTMLElement;
  }
}

function layer(css: string): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:absolute',
    'inset:0',
    'opacity:0',
    'display:none',
    css,
  ].join(';');
  return el;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
