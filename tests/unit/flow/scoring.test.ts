import { describe, expect, it } from 'vitest';
import { computeScore } from '../../../src/flow/Scoring';
import type { FlowConfig } from '../../../src/flow/types';
import flowJson from '../../../src/core/config/flow.json';

const flowCfg = flowJson as unknown as FlowConfig;

describe('flow/Scoring · computeScore', () => {
  it('3 击破 + 200 s + 塔心 70% → S', () => {
    const r = computeScore({ tSec: 200, executions: 3, coreHpPct: 70, deaths: 0, won: true }, flowCfg);
    expect(r.grade).toBe('S');
  });

  it('2 击破 + 230 s + 塔心 40% → A', () => {
    const r = computeScore({ tSec: 230, executions: 2, coreHpPct: 40, deaths: 1, won: true }, flowCfg);
    expect(r.grade).toBe('A');
  });

  it('1 击破 + 260 s + 塔心 5% → B', () => {
    const r = computeScore({ tSec: 260, executions: 1, coreHpPct: 5, deaths: 1, won: true }, flowCfg);
    expect(r.grade).toBe('B');
  });

  it('0 击破 + 塔心 0% → C', () => {
    const r = computeScore({ tSec: 270, executions: 0, coreHpPct: 0, deaths: 2, won: false }, flowCfg);
    expect(r.grade).toBe('C');
  });

  it('输了最高只能 B：S 档数据但 won=false → B', () => {
    const r = computeScore({ tSec: 200, executions: 3, coreHpPct: 70, deaths: 0, won: false }, flowCfg);
    expect(r.grade).toBe('B');
  });

  it('输了最高只能 B：A 档数据但 won=false → B', () => {
    const r = computeScore({ tSec: 230, executions: 2, coreHpPct: 40, deaths: 1, won: false }, flowCfg);
    expect(r.grade).toBe('B');
  });

  it('breakdown 含全部口径字段', () => {
    const r = computeScore({ tSec: 200, executions: 3, coreHpPct: 70, deaths: 1, won: true }, flowCfg);
    expect(r.breakdown).toMatchObject({
      timeSec: 200,
      executions: 3,
      coreHpPct: 70,
      deaths: 1,
      won: 1,
    });
  });

  it('边界：恰好 tSec=210 + 3 击破 + 60% → S（含等号）', () => {
    const r = computeScore({ tSec: 210, executions: 3, coreHpPct: 60, deaths: 0, won: true }, flowCfg);
    expect(r.grade).toBe('S');
  });

  it('边界：S 档超时 1 s → A', () => {
    const r = computeScore({ tSec: 211, executions: 3, coreHpPct: 70, deaths: 0, won: true }, flowCfg);
    expect(r.grade).toBe('A');
  });

  it('不修改 flowCfg（纯函数）', () => {
    const snapshot = JSON.stringify(flowCfg.score.grades);
    computeScore({ tSec: 100, executions: 5, coreHpPct: 100, deaths: 0, won: true }, flowCfg);
    expect(JSON.stringify(flowCfg.score.grades)).toBe(snapshot);
  });
});
