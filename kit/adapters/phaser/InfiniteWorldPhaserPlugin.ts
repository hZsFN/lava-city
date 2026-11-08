import Phaser from 'phaser';

export class InfiniteWorldPlugin extends Phaser.Plugins.BasePlugin {
  public save: any = null;
  private modern = false;

  private onMessage = (event: MessageEvent) => {
    if (this.modern) return;
    const data = event.data;
    if (event.source === window.parent && data?.save && (data.type === 'IW_INIT_SAVE' || data.type === 'iw-init')) {
      this.save = data.save;
      this.game.events.emit('save-ready', this.save, data.history || [], data.config || {});
    }
  };

  init() {
    const wl = (window as any).WL;
    this.modern = !!(wl && typeof wl.ready === 'function');
    if (this.modern) {
      wl.ready().then((save: any) => {
        this.save = save;
        this.game.events.emit('save-ready', save, wl.readHistory?.() || [], (window as any).CONFIG || {});
      }).catch((error: any) => {
        this.game.events.emit('handoff-error', String(error?.message || error));
      });
      return;
    }
    window.addEventListener('message', this.onMessage);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_READY' }, '*');
    } else if (wl?.readSave) {
      this.save = wl.readSave();
      this.game.events.emit('save-ready', this.save, wl.readHistory?.() || [], {});
    }
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    super.destroy();
  }

  consumeItem(type: string): any | null {
    if (!this.save?.items) return null;
    const index = this.save.items.findIndex((item: any) => item.type === type);
    return index === -1 ? null : this.save.items.splice(index, 1)[0];
  }

  completeWithItemIds(acquiredItemIds: string[]) {
    if (!this.save) throw new Error('尚未收到宿主存档');
    const wl = (window as any).WL;
    if (wl?.complete) {
      wl.complete(this.save, { acquiredItemIds })
        .then((receipt: any) => this.game.events.emit('handoff-result', receipt))
        .catch((error: any) => this.game.events.emit('handoff-error', String(error?.message || error)));
    } else if (wl?.completeLevel) {
      wl.completeLevel((window as any).CONFIG || {}, this.save, { acquiredItemIds });
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_SAVE', save: this.save, acquiredItemIds }, '*');
    }
  }

  completeLevel(exitHook: string, items: any[], clues: any[]) {
    if (!this.save) throw new Error('尚未收到宿主存档');
    const nextSave = { ...this.save, exit_hook: exitHook, items, clues };
    const wl = (window as any).WL;
    if (wl?.completeLevel) {
      wl.completeLevel((window as any).CONFIG || {}, nextSave, {
        exitHook,
        nextUrl: (window as any).CONFIG?.nextUrl || window.location.href
      });
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_SAVE', save: nextSave }, '*');
    }
  }

  failLevel(reason = '角色力竭') {
    const wl = (window as any).WL;
    if (wl?.fail) {
      wl.fail(reason, this.save, { acquiredItemIds: [] })
        .then((receipt: any) => this.game.events.emit('handoff-result', receipt))
        .catch((error: any) => this.game.events.emit('handoff-error', String(error?.message || error)));
    } else if (wl?.failLevel) {
      wl.failLevel(reason, this.save, (window as any).CONFIG || {});
    } else if (window.parent !== window) {
      window.parent.postMessage({ type: 'IW_FAIL', reason, fallenSave: this.save }, '*');
    }
  }
}
