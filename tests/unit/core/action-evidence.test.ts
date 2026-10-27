import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import { findEvidenceGaps } from '../../../src/idt/core/action-evidence.js';

function makeIr(stages: StateTransitionIR['stages']): StateTransitionIR {
  return {
    flowId: 'flow_0123456789',
    intent: '测试动作证据',
    oracle: 'regression-lock',
    description: '动作证据测试',
    initialRoute: stages[0].routePattern,
    setup: { notes: [] },
    unresolved: [],
    stages,
  };
}

function makeStage(
  actionType: 'CLICK' | 'FILL' | 'SELECT' | 'CHECK',
  invariants: StateTransitionIR['stages'][number]['invariants'] = { network: [] },
  stageIndex = 0,
): StateTransitionIR['stages'][number] {
  return {
    stageIndex,
    stageName: `阶段${stageIndex}`,
    routePattern: `/page-${stageIndex}`,
    actions: [{
      actionType,
      targetRole: actionType === 'FILL' ? 'textbox' : 'button',
      targetName: '操作',
      ...(actionType === 'FILL' || actionType === 'SELECT' ? { inputValue: '值' } : {}),
      timeoutMs: 5000,
      triggersRequest: false,
    }],
    invariants,
  };
}

describe('findEvidenceGaps', () => {
  it('returns a CLICK stage with no network, navigating routeGuard, or domDelta', () => {
    assert.deepEqual(findEvidenceGaps(makeIr([makeStage('CLICK')])), [
      { stageIndex: 0, stageName: '阶段0' },
    ]);
  });

  it('does not return a stage with a network contract', () => {
    const stage = makeStage('CLICK', {
      network: [{
        method: 'POST', urlPattern: '/api/save', expectedStatus: 200, responseType: 'json',
      }],
    });
    assert.deepEqual(findEvidenceGaps(makeIr([stage])), []);
  });

  it('does not return a stage whose routeGuard navigates elsewhere', () => {
    const stage = makeStage('CLICK', {
      network: [], routeGuard: { targetUrlPattern: '/other' },
    });
    assert.deepEqual(findEvidenceGaps(makeIr([stage])), []);
  });

  it('returns a stage whose routeGuard only points back to the same page', () => {
    const stage = makeStage('CLICK', {
      network: [], routeGuard: { targetUrlPattern: '^/page-0$' },
    });
    assert.deepEqual(findEvidenceGaps(makeIr([stage])), [
      { stageIndex: 0, stageName: '阶段0' },
    ]);
  });

  it('does not return a stage with domDelta evidence', () => {
    const stage = makeStage('CHECK', {
      network: [], domDelta: { appearedRole: 'status', appearedName: '已保存' },
    });
    assert.deepEqual(findEvidenceGaps(makeIr([stage])), []);
  });

  it('does not require hard evidence for FILL alone', () => {
    assert.deepEqual(findEvidenceGaps(makeIr([makeStage('FILL')])), []);
  });

  it('returns every problematic stage with its array index and stage name', () => {
    const stages = [
      makeStage('CLICK', { network: [] }, 0),
      makeStage('FILL', { network: [] }, 1),
      makeStage('SELECT', { network: [] }, 2),
    ];
    assert.deepEqual(findEvidenceGaps(makeIr(stages)), [
      { stageIndex: 0, stageName: '阶段0' },
      { stageIndex: 2, stageName: '阶段2' },
    ]);
  });
});
