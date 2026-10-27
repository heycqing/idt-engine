import type { StateTransitionIR } from './ir-schema.js';
import { exactRoute } from './route-pattern.js';

/** 需要硬证据的动作。FILL 没有副作用，不在此列。 */
export const ACTIONS_NEEDING_EVIDENCE = new Set(['CLICK', 'CHECK', 'SELECT']);

export interface EvidenceGap {
  stageIndex: number;
  stageName: string;
}

/**
 * 返回「有需要硬证据的动作、却一条证据都没有」的 stage。
 * 三选一：网络契约 / 真的跳到别处的 routeGuard / domDelta。
 */
export function findEvidenceGaps(ir: StateTransitionIR): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];

  for (const stage of ir.stages) {
    const hasInteractive = stage.actions.some((a) =>
      ACTIONS_NEEDING_EVIDENCE.has(a.actionType),
    );
    if (hasInteractive) {
      const hasNetwork =
        stage.invariants.network && stage.invariants.network.length > 0;
      const guardPattern = stage.invariants.routeGuard?.targetUrlPattern;
      const hasNavigatingRouteGuard =
        guardPattern !== undefined &&
        exactRoute(guardPattern) !== exactRoute(stage.routePattern);
      const hasDomDelta = Boolean(stage.invariants.domDelta);
      if (!hasNetwork && !hasNavigatingRouteGuard && !hasDomDelta) {
        gaps.push({
          stageIndex: stage.stageIndex,
          stageName: stage.stageName,
        });
      }
    }
  }

  return gaps;
}
