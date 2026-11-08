import { describe, expect, it } from 'vitest';
import { FrameInput } from '../../../src/game/FrameInput';

const idle = { lightPressed: false, lightHeld: false, heavyPressed: false, heavyHeld: false };
describe('render-to-fixed-step input buffering', () => {
  it('preserves a press through multiple render frames with no logic step', () => {
    const input = new FrameInput();
    input.queue({ ...idle, lightPressed: true, lightHeld: true }, true);
    input.queue({ ...idle, lightHeld: true }, false);
    expect(input.weapon.lightPressed).toBe(true);
    expect(input.toggle).toBe(true);
    input.consumeEdges();
    expect(input.weapon.lightPressed).toBe(false);
    expect(input.toggle).toBe(false);
  });
  it('keeps held attacks across all catch-up steps, with exactly one press edge', () => {
    const input = new FrameInput();
    input.queue({ lightPressed: true, lightHeld: true, heavyPressed: true, heavyHeld: true }, false);
    let presses = 0;
    let heldTime = 0;
    for (let step = 0; step < 6; step += 1) {
      if (input.weapon.heavyPressed) presses += 1;
      if (input.weapon.heavyHeld) heldTime += 1 / 60;
      input.consumeEdges();
    }
    expect(presses).toBe(1);
    expect(heldTime).toBeCloseTo(0.1);
    input.queue(idle, false);
    expect(input.weapon.heavyHeld).toBe(false);
  });
  it('clears all queued and held input when focus is lost', () => {
    const input = new FrameInput();
    input.queue({ lightPressed: true, lightHeld: true, heavyPressed: true, heavyHeld: true }, true);
    input.reset();
    expect(input.weapon).toEqual(idle);
    expect(input.toggle).toBe(false);
  });
});
