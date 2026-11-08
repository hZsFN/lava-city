// src/game/Input.ts
// ============================================================================
// 整合层 · 输入（S0 维护）
// ----------------------------------------------------------------------------
// 键盘 + Pointer Lock 鼠标视角 → PlayerInput。
//
// 设计取舍：
//   · 不引 PointerLockControls（避免多一个依赖），自己算 yaw/pitch
//   · 点击画布锁定指针，ESC 解锁
//   · 没有锁定时仍然接受 WASD（方便本地调试）
// ============================================================================

import type { PlayerInput } from '../player/PlayerController';
import type { InputSource } from './GameLoop';

const KEY = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  dash: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
} as const;

/** 鼠标灵敏度：弧度 / 像素 */
const MOUSE_SENSITIVITY = 0.0022;

export interface InputHandle extends InputSource {
  /** 销毁：解绑所有监听 */
  dispose(): void;
  /** 当前是否已锁定指针 */
  isLocked(): boolean;
  /** 本帧是否有"切换形态"的边沿触发（供调试用） */
  consumeFormSwitch(): boolean;
  /** 本帧是否有"击破"的边沿触发 */
  consumeExecute(): boolean;
}

export function createInput(canvas: HTMLCanvasElement): InputHandle {
  const pressed = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let locked = false;

  // 边沿触发标记：按下时置 true，被消费后置 false
  let edgeDash = false;
  let edgeJump = false;
  let edgeFormSwitch = false;
  let edgeExecute = false;

  function has(codes: readonly string[]): boolean {
    return codes.some((c) => pressed.has(c));
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    pressed.add(e.code);

    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') edgeDash = true;
    else if (e.code === 'Space') edgeJump = true;
    else if (e.code === 'KeyQ') edgeFormSwitch = true;
    else if (e.code === 'KeyF') edgeExecute = true;
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    pressed.delete(e.code);
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!locked) return;
    yaw -= e.movementX * MOUSE_SENSITIVITY;
    pitch -= e.movementY * MOUSE_SENSITIVITY;
    // 俯仰限制 ±85°
    const limit = (85 * Math.PI) / 180;
    pitch = Math.max(-limit, Math.min(limit, pitch));
  };

  const onPointerLockChange = (): void => {
    locked = document.pointerLockElement === canvas;
  };

  const onClick = (): void => {
    if (!locked) void canvas.requestPointerLock();
  };

  // 失焦时清空按键，避免"卡键"
  const onBlur = (): void => {
    pressed.clear();
    edgeDash = edgeJump = edgeFormSwitch = edgeExecute = false;
  };

  canvas.addEventListener('click', onClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('blur', onBlur);
  document.addEventListener('pointerlockchange', onPointerLockChange);

  return {
    sample(): PlayerInput {
      const forward = (has(KEY.forward) ? 1 : 0) - (has(KEY.back) ? 1 : 0);
      const right = (has(KEY.right) ? 1 : 0) - (has(KEY.left) ? 1 : 0);

      const input: PlayerInput = {
        moveX: right,
        moveZ: forward,
        yaw,
        jump: edgeJump,
        dash: edgeDash,
      };

      // 边沿触发只生效一帧
      edgeDash = false;
      edgeJump = false;
      return input;
    },

    isLocked: () => locked,

    consumeFormSwitch(): boolean {
      const v = edgeFormSwitch;
      edgeFormSwitch = false;
      return v;
    },

    consumeExecute(): boolean {
      const v = edgeExecute;
      edgeExecute = false;
      return v;
    },

    dispose(): void {
      canvas.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    },
  };
}
