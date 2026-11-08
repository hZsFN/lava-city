import type { BackendName } from '../render/App';

/** 右下角调试浮层：FPS + 当前 save.player.hp。 */
export class DebugOverlay {
  readonly root: HTMLDivElement;
  private readonly fpsEl: HTMLSpanElement;
  private readonly hpEl: HTMLSpanElement;
  private readonly messageEl: HTMLDivElement;

  constructor(backend: BackendName) {
    const root = document.createElement('div');
    this.root = root;
    root.style.cssText = [
      'position:fixed',
      'right:14px',
      'bottom:14px',
      'z-index:20',
      'min-width:176px',
      'padding:10px 12px',
      'border:1px solid rgba(255,138,76,0.28)',
      'border-radius:8px',
      'background:rgba(10,6,8,0.78)',
      'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
      'color:#d8d2c8',
      'font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'letter-spacing:0.04em',
      'pointer-events:none',
      'user-select:none',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '调试';
    title.style.cssText = 'color:#ff8a4c;margin-bottom:4px;letter-spacing:0.16em';

    const fpsRow = document.createElement('div');
    fpsRow.textContent = 'FPS  ';
    this.fpsEl = document.createElement('span');
    this.fpsEl.textContent = '--';
    this.fpsEl.style.color = '#8ee6b0';
    fpsRow.appendChild(this.fpsEl);

    const hpRow = document.createElement('div');
    hpRow.textContent = 'HP   ';
    this.hpEl = document.createElement('span');
    this.hpEl.textContent = '--';
    this.hpEl.style.color = '#ff6b5a';
    hpRow.appendChild(this.hpEl);

    const backendRow = document.createElement('div');
    backendRow.textContent = '后端  ';
    const backendEl = document.createElement('span');
    backendEl.textContent = backend;
    backendEl.style.color = '#7fb8ff';
    backendRow.appendChild(backendEl);

    const hintRow = document.createElement('div');
    hintRow.textContent = 'R 重生 · Enter 通关';
    hintRow.style.cssText = 'margin-top:4px;color:#7f7468';

    this.messageEl = document.createElement('div');
    this.messageEl.style.cssText = 'margin-top:4px;color:#c9a26a;min-height:1em';

    root.append(title, fpsRow, hpRow, backendRow, hintRow, this.messageEl);
    document.body.appendChild(root);
  }

  setFps(fps: number): void {
    this.fpsEl.textContent = fps.toFixed(1);
  }

  setHp(hp: number | null): void {
    this.hpEl.textContent = hp === null ? '--（无存档）' : String(hp);
  }

  setMessage(text: string): void {
    this.messageEl.textContent = text;
  }
}
