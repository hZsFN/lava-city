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
/** 单个 mousemove 事件允许的最大位移（CSS 像素）。超过它一定是浏览器的
 *  累积尖峰（pointer lock 刚获得、主线程卡顿后补发），直接用会把视角甩飞。 */
const MAX_MOVE_STEP = 90;
/** 两个事件间隔超过这个毫秒数，说明中间卡过帧，这一发的位移不可信 */
const MOVE_GAP_MS = 100;

export interface InputHandle extends InputSource {
  /**
   * 只读当前视角（yaw/pitch），不消费任何边沿触发。
   * 相机必须用这个而不是 player.yaw —— 后者只在固定步长逻辑帧里更新，
   * 渲染帧率与 60Hz 不同步时相机会隔帧才更新一次，转视角就是一顿一顿的。
   */
  aim(): { yaw: number; pitch: number };
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
  // HMR 保护：改代码时模块会被重新执行，若不先解绑，每热更新一次就多绑
  // 一套 window 监听，鼠标位移被重复累加进 yaw —— 表现就是视角越转越快、
  // 忽然跳向别的方向。这里保证全局只有一个活着的 Input。
  const g = window as unknown as { __lavaInput?: { dispose(): void } };
  if (g.__lavaInput) {
    try { g.__lavaInput.dispose(); } catch { /* 旧实例已失效，忽略 */ }
    g.__lavaInput = undefined;
  }

  const pressed = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let locked = false;
  /** 刚拿到 pointer lock 时要丢弃的事件数 */
  let lockGrace = 0;
  let lastMoveTs = 0;

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
    // ① 刚锁定：浏览器会补发一段"从上次位置到这里"的累积位移，必须丢掉
    if (lockGrace > 0) {
      lockGrace -= 1;
      lastMoveTs = e.timeStamp;
      return;
    }
    // ② 卡过帧：这一发带着整段延迟期间的总位移，同样丢掉
    const prevTs = lastMoveTs;
    const nowTs = e.timeStamp;
    lastMoveTs = nowTs;
    if (prevTs > 0 && nowTs - prevTs > MOVE_GAP_MS) return;

    // ③ 单步钳制：剩下的正常事件里也不允许出现跳变
    const dx = Math.max(-MAX_MOVE_STEP, Math.min(MAX_MOVE_STEP, e.movementX));
    const dy = Math.max(-MAX_MOVE_STEP, Math.min(MAX_MOVE_STEP, e.movementY));
    yaw -= dx * MOUSE_SENSITIVITY;
    pitch -= dy * MOUSE_SENSITIVITY;
    // 俯仰限制 ±85°
    const limit = (85 * Math.PI) / 180;
    pitch = Math.max(-limit, Math.min(limit, pitch));
  };

  const onPointerLockChange = (): void => {
    const nowLocked = document.pointerLockElement === canvas;
    if (nowLocked && !locked) {
      lockGrace = 2;
      lastMoveTs = 0;
    }
    locked = nowLocked;
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

  const handle: InputHandle = {
    aim(): { yaw: number; pitch: number } {
      return { yaw, pitch };
    },

    sample(): PlayerInput {
      const forward = (has(KEY.forward) ? 1 : 0) - (has(KEY.back) ? 1 : 0);
      const right = (has(KEY.right) ? 1 : 0) - (has(KEY.left) ? 1 : 0);

      const input: PlayerInput = {
        moveX: right,
        moveZ: forward,
        yaw,
        pitch,
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

  g.__lavaInput = handle;
  return handle;
}
