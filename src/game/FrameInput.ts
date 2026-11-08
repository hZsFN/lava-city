import type { WeaponInput } from '../player/weaponTypes';

/** Buffers render-frame input until fixed steps consume it. Held state survives catch-up. */
export class FrameInput {
  readonly weapon: WeaponInput = {
    lightPressed: false, lightHeld: false, heavyPressed: false, heavyHeld: false,
  };
  toggle = false;

  queue(weapon: WeaponInput, toggle: boolean): void {
    this.weapon.lightPressed ||= weapon.lightPressed;
    this.weapon.heavyPressed ||= weapon.heavyPressed;
    this.weapon.lightHeld = weapon.lightHeld;
    this.weapon.heavyHeld = weapon.heavyHeld;
    this.toggle ||= toggle;
  }

  consumeEdges(): void {
    this.weapon.lightPressed = false;
    this.weapon.heavyPressed = false;
    this.toggle = false;
  }

  reset(): void {
    this.consumeEdges();
    this.weapon.lightHeld = false;
    this.weapon.heavyHeld = false;
  }
}
