// src/flow/MatchRunner.ts
// ============================================================================
// 无头跑一局（T-M2-03）· B3 实现
// ----------------------------------------------------------------------------
// 固定 1/60 步长推进 MatchTimeline 直到结算或超过 maxSec，返回遥测记录。
// 纯 Node：无 DOM、无渲染、无 three。给 QA / 平衡机器人 / 本票验收用。
// ============================================================================

import type { Bus } from '../core/events';
import type { FlowConfig, MatchTimeline, TelemetryRecord } from './types';
import { createTelemetry } from '../telemetry/Telemetry';

/** 固定步长：与设计口径一致，一帧 1/60 s */
export const FIXED_DT_SEC = 1 / 60;

export interface RunnerDeps {
  bus: Bus;
  timeline: MatchTimeline;
  /** 评分/阶段配置；不传则用仓库内 flow.json */
  flowCfg?: FlowConfig;
  /** 遥测种子（写进记录，便于回放） */
  seed?: number;
  /** 可选：每帧被调用，用来驱动塔 / Boss / 玩家的桩 */
  onTick?: (dtSec: number, snapshot: unknown) => void;
}

export interface MatchRunner {
  /** 以固定 1/60 步长跑完一局，返回遥测 */
  runToEnd(maxSec?: number): TelemetryRecord;
}

export function createMatchRunner(deps: RunnerDeps): MatchRunner {
  const { bus, timeline, flowCfg, seed = 1, onTick } = deps;

  function runToEnd(maxSec = 300): TelemetryRecord {
    const telemetry = createTelemetry(seed, { flowCfg, bus, timeline });

    const limit = Math.max(0, maxSec);
    let elapsed = 0;

    // 先判上限再推进：保证总推进时长不超过 maxSec
    while (timeline.result() === null && elapsed + FIXED_DT_SEC <= limit + 1e-9) {
      timeline.update(FIXED_DT_SEC);
      elapsed += FIXED_DT_SEC;
      if (onTick) onTick(FIXED_DT_SEC, bus.snapshot());
    }

    return telemetry.record();
  }

  return { runToEnd };
}
