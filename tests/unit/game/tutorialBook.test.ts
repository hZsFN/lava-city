import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { TutorialBook } from '../../../src/game/TutorialBook';
import type { FlowConfig } from '../../../src/flow/types';
import flowJson from '../../../src/core/config/flow.json';

const flowCfg = flowJson as unknown as FlowConfig;
const cfg = flowCfg.tutorial;
const spawn = flowCfg.playerSpawn;

function makeBook(): TutorialBook {
  return new TutorialBook(new THREE.Scene(), cfg, spawn);
}

describe('game/TutorialBook · 不强制、不暂停', () => {
  it('靠近时 near=true；按 E 打开阅读态，三页后自主消散', () => {
    const book = makeBook();
    book.update(1 / 60, 0, 'tutorial', spawn, false);
    expect(book.view().near).toBe(true);
    expect(book.view().reading).toBe(false);

    expect(book.interact()).toBe(true);
    expect(book.view().reading).toBe(true);
    expect(book.view().pageIndex).toBe(0);

    book.interact();
    expect(book.view().pageIndex).toBe(1);

    book.interact();
    expect(book.view().pageIndex).toBe(2);
    expect(book.view().reading).toBe(true);

    // 最后一页停留 lastPageHoldSec 后自动化成火星
    for (let i = 0; i < 40; i += 1) {
      book.update(0.1, 2 + i * 0.1, 'tutorial', spawn, false);
    }
    expect(book.view().reading).toBe(false);
    expect(book.isVisible()).toBe(false);
    book.dispose();
  });

  it('不按 E：24 s 到点自动消散，流程不需要玩家操作', () => {
    const book = makeBook();
    book.update(0.1, 0, 'tutorial', spawn, false);
    expect(book.isVisible()).toBe(true);

    for (let i = 0; i < 250; i += 1) {
      book.update(0.1, i * 0.1, 'tutorial', spawn, false);
    }
    expect(book.isVisible()).toBe(false);
    book.dispose();
  });

  it('离开 3.5 m 后自动合上书页', () => {
    const book = makeBook();
    book.update(1 / 60, 0, 'tutorial', spawn, false);
    book.interact();
    expect(book.view().reading).toBe(true);

    book.update(1 / 60, 0.1, 'tutorial', [spawn[0], spawn[1], spawn[2] - 6], false);
    expect(book.view().reading).toBe(false);
    book.dispose();
  });
});
