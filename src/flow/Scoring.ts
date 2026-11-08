// src/flow/Scoring.ts
// ============================================================================
// 评分（T-M2-03）· B3 实现 · 纯函数，无状态、无副作用
// ----------------------------------------------------------------------------
// 规则：按 flow.json 的 score.grades 从高到低匹配第一条满足的；
//       输了（won === false）最高只能 B。
// ============================================================================

import type { FlowConfig, GradeConfig, ScoreInput, ScoreResult } from './types';

/**
 * 把 grades 排成「从高到低」：用时越短越严 → maxSec 升序；
 * 同档再用击破数降序、塔心百分比降序打破平手。不改动入参。
 */
function sortByStrictness(grades: readonly GradeConfig[]): GradeConfig[] {
  return [...grades].sort(
    (a, b) =>
      a.maxSec - b.maxSec ||
      b.minExecutions - a.minExecutions ||
      b.minCorePct - a.minCorePct,
  );
}

/** 输了最高只能 B：S/A 一律压到 B */
function capForLoss(grade: ScoreResult['grade']): ScoreResult['grade'] {
  if (grade === 'S' || grade === 'A') return 'B';
  return grade;
}

export function computeScore(input: ScoreInput, flowCfg: FlowConfig): ScoreResult {
  const { tSec, executions, coreHpPct, deaths, won } = input;

  const grades = sortByStrictness(flowCfg.score.grades);
  let grade: ScoreResult['grade'] = 'C';

  for (const g of grades) {
    if (tSec <= g.maxSec && executions >= g.minExecutions && coreHpPct >= g.minCorePct) {
      grade = g.grade;
      break;
    }
  }

  if (!won) grade = capForLoss(grade);

  return {
    grade,
    breakdown: {
      timeSec: tSec,
      executions,
      coreHpPct,
      deaths,
      won: won ? 1 : 0,
    },
  };
}
