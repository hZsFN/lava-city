import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInput, type InputHandle } from '../../../src/game/Input';

function emit(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const event = new Event(type);
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
}

describe('input focus and pointer-lock recovery', () => {
  let win: EventTarget;
  let doc: EventTarget & { pointerLockElement: unknown; hidden: boolean; exitPointerLock: () => void };
  let canvas: EventTarget;
  let input: InputHandle;
  beforeEach(() => {
    win = new EventTarget();
    canvas = new EventTarget();
    doc = Object.assign(new EventTarget(), {
      pointerLockElement: null as unknown, hidden: false,
      exitPointerLock: () => { doc.pointerLockElement = null; emit(doc, 'pointerlockchange'); },
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    input = createInput(canvas as HTMLCanvasElement);
    doc.pointerLockElement = canvas;
    emit(doc, 'pointerlockchange');
  });
  afterEach(() => { input.dispose(); vi.unstubAllGlobals(); });

  for (const cause of ['blur', 'hidden', 'unlock', 'tactical'] as const) {
    it(`clears held buttons and unconsumed edges on ${cause}`, () => {
      emit(win, 'keydown', { code: 'KeyW' });
      emit(win, 'keydown', { code: 'Space' });
      emit(win, 'keydown', { code: 'KeyQ' });
      emit(win, 'mousedown', { button: 0 });
      emit(win, 'mousedown', { button: 2 });
      if (cause === 'blur') emit(win, 'blur');
      if (cause === 'hidden') { doc.hidden = true; emit(doc, 'visibilitychange'); }
      if (cause === 'unlock') doc.exitPointerLock();
      if (cause === 'tactical') input.setLockAllowed(false);
      expect(input.sample()).toMatchObject({ moveZ: 0, jump: false, dash: false });
      expect(input.consumeFormSwitch()).toBe(false);
      expect(input.weaponInput()).toEqual({ lightPressed: false, lightHeld: false, heavyPressed: false, heavyHeld: false });
    });
  }
  it('responds to a small mouse move after idle, but drops a delayed large spike', () => {
    emit(win, 'mousemove', { movementX: 0, movementY: 0, timeStamp: 10 });
    emit(win, 'mousemove', { movementX: 0, movementY: 0, timeStamp: 20 });
    emit(win, 'mousemove', { movementX: 5, movementY: 0, timeStamp: 1000 });
    expect(input.aim().yaw).toBeCloseTo(-0.011);
    emit(win, 'mousemove', { movementX: 900, movementY: 0, timeStamp: 2000 });
    expect(input.aim().yaw).toBeCloseTo(-0.011);
  });
  it('consumes a click edge once while preserving a held attack', () => {
    emit(win, 'mousedown', { button: 0 });
    expect(input.weaponInput()).toMatchObject({ lightPressed: true, lightHeld: true });
    expect(input.weaponInput()).toMatchObject({ lightPressed: false, lightHeld: true });
    emit(win, 'mouseup', { button: 0 });
    expect(input.weaponInput().lightHeld).toBe(false);
  });
});
