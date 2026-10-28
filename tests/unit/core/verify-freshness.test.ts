import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StateTransitionIR } from '../../../src/idt/core/ir-schema.js';
import {
  checkTopologyFreshness,
  verifyCases,
} from '../../../src/idt/core/verify.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

describe('checkTopologyFreshness', () => {
  it('returns null when the inputs digest matches', () => {
    assert.equal(
      checkTopologyFreshness(
        { inputsDigest: digestA, generatedAt: '2026-10-27T02:06:00.000Z' },
        digestA,
      ),
      null,
    );
  });

  it('reports a stale-topology error when the digest differs', () => {
    const finding = checkTopologyFreshness(
      { inputsDigest: digestA, generatedAt: '2026-10-27T02:06:00.000Z' },
      digestB,
      'caida',
    );
    assert.ok(finding);
    assert.equal(finding.level, 'error');
    assert.equal(finding.code, 'stale-topology');
    assert.equal(finding.flowId, 'caida');
    assert.match(finding.message, /idt:sync/);
    assert.match(finding.message, /2026-10-27T02:06:00\.000Z/);
  });

  it('warns when the topology omits inputsDigest', () => {
    const finding = checkTopologyFreshness(
      { generatedAt: '2026-10-01T00:00:00.000Z' },
      digestA,
      'caida',
    );
    assert.ok(finding);
    assert.equal(finding.level, 'warning');
    assert.equal(finding.code, 'stale-topology');
    assert.match(finding.message, /旧|无法判断|重新/);
  });
});

describe('stale topology still runs the rest of verify', () => {
  it('keeps both stale-topology and missing-element findings', () => {
    const ir: StateTransitionIR = {
      flowId: 'flow_aabbccddee',
      intent: '打开首页',
      oracle: 'regression-lock',
      description: '首页可用',
      initialRoute: '/home',
      setup: { notes: [] },
      unresolved: [],
      stages: [
        {
          stageIndex: 0,
          stageName: '首页',
          routePattern: '/home',
          actions: [
            {
              actionType: 'CLICK',
              targetRole: 'button',
              targetName: '提交',
              timeoutMs: 5000,
              triggersRequest: false,
            },
          ],
          invariants: { network: [] },
        },
      ],
    };
    const topology = {
      inputsDigest: digestA,
      generatedAt: '2026-10-27T02:06:00.000Z',
      routes: {
        '/home': { elements: [{ role: 'button', name: '保存' }] },
      },
    } as const;

    const stale = checkTopologyFreshness(topology, digestB, 'demo');
    const caseFindings = verifyCases(
      topology as any,
      [{ flowId: ir.flowId, ir, specContent: 'CURRENT' }],
      { emit: () => 'CURRENT' },
    );
    const findings = [stale, ...caseFindings].filter(Boolean);

    assert.equal(
      findings.some((f) => f && f.code === 'stale-topology' && f.level === 'error'),
      true,
    );
    assert.equal(
      findings.some((f) => f && f.code === 'missing-element'),
      true,
    );
  });
});
